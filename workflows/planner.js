const path = require('node:path');
const fs = require('node:fs');
const { writeJson, hash, fileHash } = require('../services/aliyun/io');
const { validateScript } = require('../services/aliyun/schema');
const { generatedBriefPath } = require('../services/brief');
const { CONTRACT_RULES, CONTRACT_SHAPE } = require('./shot-contract');
// Bumped whenever the review rules change, so an old verdict on unchanged words is not reused silently.
const REVIEW_RULES_VERSION = 2;

// The planner model owns every authoring and judgement step: material analysis, production brief,
// script, shot and prompt design, performance instructions, quality judgement and rework advice.
// The local program only assembles requests, validates shapes, stores evidence and enforces gates.
const PLANNER_ROLES = '素材分析与制作简报、脚本生成与修订、分镜与提示词、表演指令、质量判断、返工意见、阶段决策';
const NO_AUTHORITY = '你没有修改状态、批准、计费或重试的权限：只输出JSON内容，不得声称已批准或已修复，不得输出金额。';

function materialPrompt(production, character, registered) {
  return '你是本片的美术与选角分析模型。只依据所附素材客观分析，不要编造未提供的设定。' + NO_AUTHORITY +
    '角色：' + character.name + '（id ' + character.id + '），已登记特征：' + registered.traits + '。' +
    '请给出可直接用于分镜与配音的结论。仅输出JSON：{"id":"' + character.id + '","visualAnalysis":"脸型、发型、服装、配色、武器、画风与可用角度","voiceAnalysis":"参考语音的音色、语速与情绪特征"}。' +
    '语音无法判断时写明无法判断，不要猜测。';
}
function briefPrompt(production, characters) {
  return '你是本片的制作简报模型。根据用户故事、风格、时长目标与角色分析，产出可直接执行的制作简报。' + NO_AUTHORITY +
    '仅输出JSON：{"storySummary":"故事因果与主题的简要复述","shotGuidance":"给编剧的执行要求：镜头数量与类型倾向、每镜时长范围、必须完整保留的关键台词、动作与转场要求、禁止事项"}。' +
    '不要改写用户故事的原意，不要新增用户未指定的角色。素材数据：' +
    JSON.stringify({ description: production.description, style: production.style,
      targetDurationSeconds: production.targetDurationSeconds, maxDurationSeconds: production.maxDurationSeconds,
      narrator: production.narrator || null, requiredQuotes: production.requiredQuotes || [], ending: production.ending || null,
      characters });
}
function scriptPrompt(production, characters, brief) {
  return '你是本片的编剧与分镜模型。按制作简报写出可实际生成的脚本，严格输出JSON。保持故事原意，不编造用户未指定的武将。' + NO_AUTHORITY +
    '总长尽量接近目标但不得超过上限；通常6至10个镜头。说话镜头只出现一位说话武将，台词尽量12至28个汉字，必须是该角色实际说出的话。' +
    'action/cutaway必须5秒且有首尾帧，不含台词；两位武将对话交替切换单人镜头。最多两个具名人物同框。' +
    '时间稍后按真实语音重算。不得添加字幕、标志或水印到生成画面。' +
    '结构：{"title":"标题","shots":[{"id":"shot01","type":"dialogue或action或cutaway","characters":["角色id"],' +
    '"speaker":"说话角色id，非对话用null","text":"实际台词，非对话为空字符串","emotion":"情绪描述",' +
    '"scene":"首帧画面、角色位置、机位、景别、环境、光线","action":"连续动作及镜头运动",' +
    '"endScene":"尾帧画面，不需要时为空字符串","needsLastFrame":false,"duration":5}]}。' +
    'dialogue时duration整数2至15，needsLastFrame按需；其他镜头duration必须5、needsLastFrame必须true。' +
    '每个镜头还必须给出动作约束字段（生成与审核共用同一份，不得只写形容词）：' + CONTRACT_SHAPE + '。' +
    CONTRACT_RULES.map((rule, index) => (index + 1) + '）' + rule).join('') +
    '同场景的相邻镜头必须把上一镜的结束状态接到本镜的起始状态（cut=continuous），换场景或跳时间时写cut=scene或time并说明。' +
    (production.narrator ? '本片只有指定narrator的人声。narration为画外旁白，duration固定5、needsLastFrame为true，每段台词15至22字并确保正常情绪朗读5秒内；dialogue只用于该角色本人开口的关键句。无声人物不说话。主体镜头总时长必须为片尾图片和黑屏预留时间。' : '') +
    '素材数据：' + JSON.stringify({ description: production.description, brief, style: production.style,
      targetDurationSeconds: production.targetDurationSeconds, maxDurationSeconds: production.maxDurationSeconds,
      narrator: production.narrator || null, ending: production.ending || null, requiredQuotes: production.requiredQuotes || [],
      characters: production.characters.map(c => ({ id: c.id, name: c.name, speaks: c.speaks !== false, traits: characters[c.id].traits })) });
}
function revisionPrompt(script, instructions) {
  return '你是本片的编剧与分镜模型。按导演指令修订现有脚本，严格输出与输入同结构的JSON（title 与 shots）。' + NO_AUTHORITY +
    '只改指令要求的部分；未涉及镜头的 id、类型、台词与画面保持原样；不得增删用户未要求的角色；不得添加字幕或水印要求。' +
    '导演指令：' + instructions + '。现有脚本：' + JSON.stringify(script);
}
function reworkPrompt(target, issues, checker = null) {
  return '你是本片的质量与返工决策模型。下面是一次自动检查未通过的目标、问题清单与执行该检查的模型，请给出最小范围、可执行的返工方向。' + NO_AUTHORITY +
    '仅输出JSON：{"advice":"具体要重做哪一步、提示词或参数如何改","scope":"speech或frames或video或script","requiresPaidRetry":true或false,"userAction":"需要用户做什么决定"}。' +
    '目标与问题：' + JSON.stringify({ target, issues, checkedBy: checker });
}
// Independent content review of a script. Structural validation is not a content review, so this is a
// separate request by the same planner model and its verdict is bound to the script digest.
function scriptReviewPrompt(production, brief, script) {
  return '你是本片的独立审核模型，不是编剧。只审核并记录结论，不要改写脚本。' + NO_AUTHORITY +
    '审核三点：①上下文连贯：叙事因果、角色身份与原作设定是否矛盾、镜头之间是否跳脱、关键台词或名言是否被误用；' +
    '②预计时长：按每段台词正常语速估算单镜与全片时长，检查是否超出用户上限，并指出偏长或偏短的镜头；' +
    '③动作约束与衔接：逐镜检查 startState/endState/beats 是否在该镜头时长内可实现、是否只安排了一个主动作、' +
    '同场景相邻镜头是否写清了承接（持物、视线、运动方向、位置），是否把整场动作塞进一个镜头。' + CONTRACT_RULES.map((rule, index) => (index + 1) + '）' + rule).join('') +
    '仅输出JSON：{"verdict":"pass或revise或uncertain","summary":"给用户的简要结论","contextIssues":[],"durationIssues":[],' +
    '"estimatedDurationSeconds":数值,"longShots":["镜头id，必须是已有镜头"],"advice":"若需修订，写出最小修订方向"}。' +
    '素材数据：' + JSON.stringify({ description: production.description, style: production.style,
      targetDurationSeconds: production.targetDurationSeconds, maxDurationSeconds: production.maxDurationSeconds,
      requiredQuotes: production.requiredQuotes || [], ending: production.ending || null,
      storySummary: brief?.storySummary || null, shotGuidance: brief?.shotGuidance || null,
      characters: production.characters.map(c => ({ id: c.id, name: c.name, speaks: c.speaks !== false })),
      shots: script.shots.map(s => ({ id: s.id, type: s.type, duration: s.duration, speaker: s.speaker, text: s.text,
        emotion: s.emotion, characters: s.characters, scene: s.scene, action: s.action,
        endScene: s.endScene || null, needsLastFrame: s.needsLastFrame,
        videoScene: s.videoScene || null, videoAction: s.videoAction || null,
        startState: s.startState || null, endState: s.endState || null, primaryAction: s.primaryAction || null,
        beats: s.beats || null, cut: s.cut || null, handoff: s.handoff || null,
        speechRate: s.speechRate ?? null, speechLeadSeconds: s.speechLeadSeconds ?? null })) });
}
// The review is bound to the actual review input: a different script, prompt version or production
// context produces a different digest, so an old verdict is never reused silently.
function reviewInputDigest(production, brief, script, promptVersion) {
  return hash({ script: hash(script), promptVersion, reviewRulesVersion: REVIEW_RULES_VERSION,
    brief: brief ? hash(brief) : null,
    style: production.style, description: hash(production.description),
    targetDurationSeconds: production.targetDurationSeconds, maxDurationSeconds: production.maxDurationSeconds,
    requiredQuotes: production.requiredQuotes || [], ending: production.ending || null });
}
// Turns a stored advisory into a concrete revision instruction (new prompt wording or script patch) that
// the existing controlled redo/revise machinery can execute.
function reworkInstructionPrompt(production, script, target, advice) {
  const shotId = target.replace(/^(frames|video|speech)-/, '');
  const shot = script?.shots?.find(s => s.id === shotId) || null;
  return '你是本片的返工执行模型。下面是已经记录在案的返工意见与当前镜头内容，请把它转成最小范围的修订指令。' + NO_AUTHORITY +
    '只允许修改 patch 中列出的字段，未列出的字段必须保持原样。仅输出JSON：' +
    '{"shotId":"' + shotId + '","scope":"speech或frames或video或script","patch":{"scene":"可选","action":"可选","endScene":"可选",' +
    '"lastFrameDirection":"可选","videoScene":"可选","videoAction":"可选","startState":"可选：起始静止状态","endState":"可选：结束静止状态",' +
    '"primaryAction":"可选：本镜唯一主动作","handoff":"可选：与上一镜的承接","text":"可选","emotion":"可选"},' +
    '"speechInstruction":"可选：给配音模型的表演指令","rationale":"为什么这样改"}。' +
    '若问题出在首尾目标本身（姿态跨度过大、与约束矛盾、在该时长内不可实现），改 startState/endState/primaryAction/handoff，不要要求重做视频；' +
    '只有目标正确而画面不符时才要求重做画面。' +
    '数据：' + JSON.stringify({ style: production.style, target, recordedAdvice: advice, currentShot: shot });
}

function plannerCents(context) { return context.config.planner?.reservationCents; }

async function analyzeMaterials(context, { models, state, log = () => {} }) {
  const production = context.production;
  const missing = production.characters.filter(c => !state.characters?.[c.id]?.original);
  if (missing.length) throw new Error('MATERIAL_ANALYSIS_REQUIRES_REGISTERED_CHARACTERS:' + missing.map(c => c.id).join(','));
  const characters = [];
  for (const c of production.characters) {
    const registered = state.characters[c.id];
    const audio = context.config.planner?.includeVoiceSample !== false && c.speaks !== false ? registered.sample : null;
    if (audio && path.extname(audio).toLowerCase() !== '.wav') throw new Error('MATERIAL_ANALYSIS_AUDIO_MUST_BE_WAV:' + c.id);
    const { json } = await models.plan('plan-material-' + c.id, { purpose: 'material-analysis',
      prompt: materialPrompt(production, c, registered), images: [registered.original, registered.front].filter(Boolean).slice(0, 2),
      audio, reservationCents: plannerCents(context) });
    if (json?.id !== c.id || typeof json.visualAnalysis !== 'string' || !json.visualAnalysis.trim() ||
        typeof json.voiceAnalysis !== 'string' || !json.voiceAnalysis.trim())
      throw new Error('MATERIAL_ANALYSIS_SHAPE_INVALID:' + c.id);
    characters.push({ id: c.id, imageSha256: fileHash(c.image),
      voiceSha256: c.speaks === false ? null : fileHash(c.voiceSample),
      frontSha256: c.frontImage ? fileHash(c.frontImage) : null,
      visualAnalysis: json.visualAnalysis, voiceAnalysis: json.voiceAnalysis });
    log('素材分析完成：' + c.name);
  }
  const { json } = await models.plan('plan-brief', { purpose: 'production-brief',
    prompt: briefPrompt(production, characters), reservationCents: plannerCents(context) });
  if (typeof json?.storySummary !== 'string' || !json.storySummary.trim() ||
      typeof json?.shotGuidance !== 'string' || !json.shotGuidance.trim()) throw new Error('BRIEF_SHAPE_INVALID');
  return { generatedBy: context.config.planner?.model, generatedAt: new Date().toISOString(), roles: PLANNER_ROLES,
    productionId: production.id, descriptionHash: hash(production.description),
    storySummary: json.storySummary, shotGuidance: json.shotGuidance, characters };
}

async function generateScript(context, { models, state, log = () => {} }) {
  if (!state.brief) throw new Error('BRIEF_REQUIRED_FOR_SCRIPT');
  // A registered controlled recovery runs under its own operation number (plan-script-retry-<n>) while the
  // unit stays "script": the original uncertain attempt keeps the first generation and this one is a rework.
  // Without a recovery decision the ordinary id is used and the duplicate protection stays fully in force.
  const recovery = state.scriptPlanRecovery;
  const operationId = typeof recovery?.retryOperation === 'string' && recovery.retryOperation ? recovery.retryOperation : 'plan-script';
  if (operationId !== 'plan-script') log('按已登记的恢复决策使用受控重试操作号：' + operationId);
  const { json } = await models.plan(operationId, { purpose: 'script',
    prompt: scriptPrompt(context.production, state.characters, state.brief), reservationCents: plannerCents(context) });
  log('模型已产出脚本');
  return validateScript(json, context.production);
}

async function reviewScript(context, { models, state, log = () => {} }) {
  if (!state.script) throw new Error('SCRIPT_REQUIRED');
  const scriptHash = hash(state.script);
  const promptVersion = context.config.planner?.promptVersion;
  const inputDigest = reviewInputDigest(context.production, state.brief, state.script, promptVersion);
  // The operation id carries the digest of the actual review input (script + prompt version + production
  // context), so a changed script, prompt version or context is always reviewed fresh.
  const { json } = await models.plan('plan-script-review-' + inputDigest.slice(0, 12), { purpose: 'script-review',
    prompt: scriptReviewPrompt(context.production, state.brief, state.script), reservationCents: plannerCents(context) });
  const shotIds = new Set(state.script.shots.map(s => s.id));
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim());
  if (!['pass', 'revise', 'uncertain'].includes(json?.verdict) || typeof json.summary !== 'string' || !json.summary.trim() ||
      !strings(json.contextIssues) || !strings(json.durationIssues) || !strings(json.longShots) ||
      json.longShots.some(id => !shotIds.has(id)) ||
      !Number.isFinite(json.estimatedDurationSeconds) || json.estimatedDurationSeconds <= 0)
    throw new Error('SCRIPT_REVIEW_SHAPE_INVALID');
  if (json.advice !== undefined && json.advice !== null && typeof json.advice !== 'string')
    throw new Error('SCRIPT_REVIEW_SHAPE_INVALID');
  log('脚本独立审核：' + json.verdict + '（输入摘要 ' + inputDigest.slice(0, 12) + '）');
  return { model: context.config.planner?.model, promptVersion, reviewInputDigest: inputDigest,
    verdict: json.verdict, summary: json.summary, contextIssues: json.contextIssues, durationIssues: json.durationIssues,
    estimatedDurationSeconds: json.estimatedDurationSeconds, longShots: json.longShots,
    advice: typeof json.advice === 'string' ? json.advice : null, scriptHash, at: new Date().toISOString() };
}

const REWORK_PATCH_FIELDS = ['scene', 'action', 'endScene', 'lastFrameDirection', 'videoScene', 'videoAction', 'text', 'emotion',
  // The action contract is patchable as text, so a wrong start/end goal can be corrected before money is
  // spent on another video; enum fields (cut) and the beats list go through script revision instead.
  'startState', 'endState', 'primaryAction', 'handoff'];

async function planReworkInstruction(context, { models, state, target, operationId = null, log = () => {} }) {
  const entries = state.reworkAdvice?.[target];
  if (!Array.isArray(entries) || !entries.length) throw new Error('REWORK_ADVICE_REQUIRED:' + target);
  const advice = [...entries].reverse().find(entry => typeof entry.advice === 'string') || entries[entries.length - 1];
  const shotId = target.replace(/^(frames|video|speech)-/, '');
  // A resumable rework pins the operation id to its job id, so a retry never rebuilds a different request
  // under the same operation number.
  const { json } = await models.plan(operationId || 'plan-rework-instruction-' + target + '-r' + entries.length,
    { purpose: 'rework-instruction',
      // The request number may differ per attempt, but the *budget* is bound to the logical target and the
      // edit revision, so the automatic flow cannot turn a rewritten prompt version or a slightly different
      // advice text into unlimited new paid review units.
      checkBudgetKey: 'rework-instruction|' + target + '|pv' + (context.config.planner?.promptVersion ?? 0) +
        '|rev' + (state.editRevision || 0) + '|adv' + hash(advice.advice || '').slice(0, 8),
      prompt: reworkInstructionPrompt(context.production, state.script, target, advice), reservationCents: plannerCents(context) });
  if (json?.shotId !== shotId || !['speech', 'frames', 'video', 'script'].includes(json.scope) || typeof json.rationale !== 'string' ||
      !json.rationale.trim() || !json.patch || typeof json.patch !== 'object' || Array.isArray(json.patch))
    throw new Error('REWORK_INSTRUCTION_SHAPE_INVALID');
  const patch = {};
  for (const [key, value] of Object.entries(json.patch)) {
    if (!REWORK_PATCH_FIELDS.includes(key) || typeof value !== 'string' || !value.trim() || value.length > 1800)
      throw new Error('REWORK_PATCH_INVALID:' + key);
    patch[key] = value;
  }
  if (typeof json.speechInstruction !== 'string' && json.speechInstruction !== undefined && json.speechInstruction !== null)
    throw new Error('REWORK_INSTRUCTION_SHAPE_INVALID');
  log('返工指令已生成：' + target + '（' + Object.keys(patch).join('/') + '）');
  return { shotId, scope: json.scope, patch, rationale: json.rationale,
    speechInstruction: typeof json.speechInstruction === 'string' && json.speechInstruction.trim() ? json.speechInstruction.trim() : null,
    basedOn: advice, at: new Date().toISOString() };
}

async function planRevision(context, { models, state, instructions, log = () => {} }) {
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 1000) throw new Error('REVISION_INSTRUCTIONS_REQUIRED');
  if (!state.script) throw new Error('SCRIPT_REQUIRED');
  const { json } = await models.plan('plan-revision-r' + (state.editRevision || 0), { purpose: 'script-revision',
    prompt: revisionPrompt(state.script, instructions.trim()), reservationCents: plannerCents(context) });
  log('模型已按指令产出修订稿');
  return validateScript(json, context.production);
}

async function adviseRework(context, { models, state, target, issues, checker = null, log = () => {} }) {
  const attempt = (state.reworkAdvice?.[target] || []).length;
  const { json } = await models.plan('plan-rework-' + target + '-r' + attempt, { purpose: 'rework-advice',
    // Advice is a paid check, not a generation: its own budget is bound to the target and the edit revision,
    // so advice cannot be requested forever just because a rework ran out of generation rounds.
    checkBudgetKey: 'rework-advice|' + target + '|pv' + (context.config.planner?.promptVersion ?? 0) + '|rev' + (state.editRevision || 0),
    prompt: reworkPrompt(target, issues, checker), reservationCents: plannerCents(context) });
  if (typeof json?.advice !== 'string' || !json.advice.trim()) throw new Error('REWORK_ADVICE_SHAPE_INVALID');
  log('返工建议已生成：' + target);
  return { model: context.config.planner?.model, advice: json.advice, scope: typeof json.scope === 'string' ? json.scope : null,
    requiresPaidRetry: json.requiresPaidRetry === true, userAction: typeof json.userAction === 'string' ? json.userAction : null,
    checkedBy: checker, at: new Date().toISOString() };
}

// The brief lives inside the job; a superseded file is archived rather than silently overwritten.
function recordBrief(context, directory, brief) {
  const target = generatedBriefPath(directory);
  if (fs.existsSync(target)) {
    const history = path.join(directory, 'brief-history');
    fs.mkdirSync(history, { recursive: true });
    fs.copyFileSync(target, path.join(history, 'brief-' + Date.now() + '.json'));
  }
  writeJson(target, brief);
  return target;
}

module.exports = { PLANNER_ROLES, REWORK_PATCH_FIELDS, adviseRework, analyzeMaterials, briefPrompt, generateScript,
  materialPrompt, planReworkInstruction, planRevision, recordBrief, reviewInputDigest, reviewScript, revisionPrompt,
  reworkInstructionPrompt, reworkPrompt, scriptPrompt, scriptReviewPrompt };
