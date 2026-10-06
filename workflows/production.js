const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readCache, readJson, writeJson, hash, fileHash, safeId, withLock } = require('../services/aliyun/io');
const { validateProduction, validateScript, timedScript } = require('../services/aliyun/schema');
const { Media } = require('../services/aliyun/media');
const { AliyunClient } = require('../services/aliyun/client');
const { Budget, authorization, estimateCents } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { UnitAttempts, unitForOperation } = require('../services/aliyun/units');
const { loadBrief } = require('../services/brief');
const { Models } = require('../services/aliyun/models');

const { productionPlan } = require('./production-plan');
const { applyLocalEdits } = require('./local-edit');
const { audioAcceptanceBinding } = require('./operations-map');
// One shared standard for both production paths: the same action contract and the same structured review
// rules drive image generation, video generation and every quality check.
const { adjacentCheckPrompt, checkCoverage, checkInputChanged, coverageGap, framesCheckPrompt, normalizeReview, operationRecord, QUALITY_RULES_VERSION, readStoredReview, recordedInput, recordedPrompt,
  repairInstruction, reviewBinding, reviewIsReusable, reworkDecision, samplingPlan, videoCheckPrompt } = require('../services/aliyun/quality');
const { contractDigest, contractPrompt, planContinuity, validateContract, validateScriptPlan } = require('./shot-contract');
const { adviseRework, analyzeMaterials, generateScript, planRevision: planRevisionScript, recordBrief, reviewScript,
  reviewInputDigest } = require('./planner');
const { runCreativeStage } = require('./creative-stage');
const { requireAcceptedAudio } = require('./creative');
const { actionRequest, frameRequest, videoExecutionPlan } = require('../services/aliyun/creative');
const STAGES = ['characters', 'creative', 'script', 'audio', 'storyboard', 'frames', 'video', 'final'];
function loadContext(root, manifestFile) {
  const production = validateProduction(readJson(path.resolve(root, manifestFile)));
  const config = readJson(path.join(root, 'config', 'aliyun.json'));
  const project = readJson(path.join(root, 'config', 'project.json'));
  const directory = path.join(root, 'jobs', 'aliyun', production.id);
  if (config.region !== 'cn-beijing' || !['1080P', '720P'].includes(config.resolution) ||
      !Number.isInteger(config.pollIntervalSeconds) || config.pollIntervalSeconds < 1 || config.pollIntervalSeconds > 60 ||
      !Number.isInteger(config.pollTimeoutSeconds) || config.pollTimeoutSeconds < 0 || config.pollTimeoutSeconds > 3600)
    throw new Error('INVALID_ALIYUN_CONFIG');
  for (const c of production.characters) {
    c.image = path.resolve(root, c.image); if (c.speaks !== false) c.voiceSample = path.resolve(root, c.voiceSample);
    if (c.frontImage) c.frontImage = path.resolve(root, c.frontImage);
  }
  if (production.ending) production.ending.image = path.resolve(root, production.ending.image);
  return { root, production, config, project, directory };
}
// The authoring prompt now lives in workflows/planner.js: the planner model owns brief, script and
// shot wording, so no prompt text here describes an external assistant.
function normalizeTraits(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length && entries.length <= 20 && entries.every(([k,v]) => k.length <= 80 && typeof v === 'string' && v.length <= 1000)) {
      return entries.map(([k,v]) => k + '：' + v).join('；');
    }
  }
  throw new Error('INVALID_CHARACTER_TRAITS');
}
function checkBooleanReport(report, fields) {
  if (!report || fields.some(f => typeof report[f] !== 'boolean') || !Array.isArray(report.issues)) throw new Error('INVALID_VISUAL_REPORT');
  report.issues = report.issues.map(i => {
    if (typeof i === 'string') return i;
    if (i && typeof i === 'object' && !Array.isArray(i) && typeof i.description === 'string' &&
        Object.keys(i).every(k => ['issue','description','severity','status','frame'].includes(k)) && Object.entries(i).every(([k,v]) => k === 'frame' ? Number.isInteger(v) && v >= 0 && v <= 100 : typeof v === 'string'))
      {
        const detail = [i.frame !== undefined ? 'frame ' + i.frame : null, i.status, i.severity, i.issue, i.description].filter(Boolean).join('：');
        if (i.status === 'pass' && !i.severity) { (report.observations ||= []).push(detail); return null; }
        return detail;
      }
    throw new Error('INVALID_VISUAL_REPORT');
  }).filter(i => i !== null);
  // Contradictory success plus findings must go to review, never silently pass.
  if (fields.includes('pass') && report.issues.some(i => i.trim())) report.pass = false;
}
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function reportHtml(state, file) {
  const media = (tag, source) => source && fs.existsSync(source) ? '<' + tag + ' controls src="' + escapeHtml(pathToFileURL(source).href) + '"></' + tag + '>' : '';
  const image = source => source && fs.existsSync(source) ? '<img src="' + escapeHtml(pathToFileURL(source).href) + '">' : '';
  const characters = Object.entries(state.characters || {}).map(([id, c]) =>
    '<article><h2>' + escapeHtml(c.name || id) + '</h2>' + image(c.original) + image(c.front) +
    '<p>' + escapeHtml(c.traits || '') + '</p>' + media('audio', c.sample) + '</article>').join('');
  const shots = (state.timed?.shots || state.script?.shots || []).map(s => {
    const a = state.assets?.[s.id] || {};
    return '<article><h2>' + escapeHtml(s.id + ' · ' + s.duration + '秒') + '</h2><p>' + escapeHtml(s.scene) +
      '</p><p>' + escapeHtml(s.text) + '</p>' + image(a.first) + image(a.last) + media('audio', a.audio) + media('video', a.video) + '</article>';
  }).join('');
  const degradations = (state.qualityDegradations || []).length
    ? '<p>质检降级（未自动重试，须实图复核）：' + state.qualityDegradations.map(d => escapeHtml(d.operation + '（' + d.reason + '）')).join('；') + '</p>' : '';
  fs.writeFileSync(file, '<!doctype html><html lang="zh"><meta charset="utf-8"><title>成片检查</title><style>' +
    'body{font:16px/1.6 "Microsoft YaHei",sans-serif;background:#151923;color:#ecedf0;max-width:1100px;margin:32px auto;padding:20px}' +
    'article{background:#222938;border-radius:12px;padding:20px;margin:18px 0}img{max-width:45%;max-height:360px;object-fit:contain;margin:8px}' +
    'video{width:100%;max-height:600px}audio{display:block;margin:12px 0}p{white-space:pre-wrap}</style>' +
    '<h1>角色、分镜与成片检查</h1><p>自动画面检查不能替代试听和口型验收。这里展示实际本地素材。</p>' +
    (state.pendingReview ? '<p>待确认：' + escapeHtml(state.pendingReview.key) + ' · ' + escapeHtml(state.pendingReview.reason) + '</p>' : '') +
    degradations +
    characters + shots + media('video', state.preview) + media('video', state.output) + '</html>', 'utf8');
}
function loadState(context) {
  const file = path.join(context.directory, 'state.json');
  return fs.existsSync(file) ? readJson(file) : { version: 1, productionId: context.production.id, characters: {}, assets: {}, revisions: {}, approvals: {}, stage: 'new' };
}
function saveState(context, state) {
  writeJson(path.join(context.directory, 'state.json'), state);
  reportHtml(state, path.join(context.directory, 'review.html'));
}
function requestReview(context, state, key, digest, reason) {
  if (state.approvals[key] === digest) return;
  state.pendingReview = { key, digest, reason };
  saveState(context, state);
  throw new Error('REVIEW_REQUIRED:' + key + ': ' + reason + '；查看 review.html 后使用 approve 命令');
}
// A degraded visual check never passes automatically: it is recorded so that a reviewer can see
// which shots were approved without a complete automated report.
function noteDegradation(state, operationId, report) {
  if (!report?.degraded) return;
  state.qualityDegradations ||= [];
  // 新结构的问题项是对象，旧结构是字符串：两者都要能记录，不能把对象拼成 [object Object]。
  const detail = (Array.isArray(report.issues) ? report.issues : [])
    .map(issue => typeof issue === 'string' ? issue : issue?.observed || issue?.detail || issue?.fix || '')
    .filter(Boolean).join('；');
  const entry = { operation: operationId, reason: report.degraded, detail, at: new Date().toISOString() };
  if (!state.qualityDegradations.some(item => item.operation === operationId && item.reason === entry.reason)) state.qualityDegradations.push(entry);
}
function revisedId(state, base) { return base + '-r' + (state.revisions[base] || 0); }

// One provider client for every model call, with no second text provider and no fallback branch: if a
// model call fails, the failure and its evidence are surfaced instead of switching providers.
function providerClient(root, injectedClient) {
  if (injectedClient) return injectedClient;
  require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
  return new AliyunClient({ apiKey: process.env.DASHSCOPE_API_KEY, uploadDirectory: path.join(root, 'jobs', 'aliyun', 'uploads') });
}
// Every performance parameter a request needs must be known before the first paid call of the audio
// stage, so a missing instruction on a later shot cannot surface only after earlier shots were paid for.
function speechReadiness(production, state, config) {
  const models = { ...config.models, ...(state.speechProfile?.models || {}) };
  const supportsInstruction = models.speech === 'qwen-audio-3.0-tts-plus';
  const problems = [];
  for (const s of state.timed?.shots || state.script?.shots || []) {
    if (s.type !== 'dialogue' && s.type !== 'narration') continue;
    const character = state.characters?.[s.speaker];
    if (!character) problems.push({ shotId: s.id, reason: 'SPEAKER_NOT_REGISTERED:' + s.speaker });
    else if (!character.sample) problems.push({ shotId: s.id, reason: 'VOICE_SAMPLE_MISSING' });
    const delivery = state.speechProfile?.delivery?.[s.id] || {};
    const instruction = typeof delivery.instruction === 'string' && delivery.instruction.trim() ? delivery.instruction : null;
    if (s.emotion && supportsInstruction && !instruction)
      problems.push({ shotId: s.id, reason: 'EMOTION_NOT_HANDLED: 该模型支持情绪指令但缺少 instruction' });
    if (delivery.rate !== undefined && (!Number.isFinite(delivery.rate) || delivery.rate < 0.5 || delivery.rate > 2))
      problems.push({ shotId: s.id, reason: 'INVALID_DELIVERY_RATE' });
  }
  return { model: models.speech, supportsInstruction, problems };
}
// A brief is optional input: a valid file (model-generated, or a historical source) is used as data,
// and otherwise the planner model produces it during the run. No author field gates validity.
function productionHashOf(context, fingerprints, brief) {
  const { production, config } = context;
  return hash({ production, fingerprints, intake: brief || null, models: config.models, resolution: config.resolution,
    imageSize: config.imageSize, portraitSize: config.portraitSize,
    endingHash: production.ending ? fileHash(production.ending.image) : null });
}
// A failed automatic check is a user decision, and the planner model supplies the rework direction
// first. The checker that produced the findings is recorded, so a vision-model result is never
// presented as planner output.
async function reviewWithAdvice(context, state, models, key, digest, reason, checker = null) {
  state.reworkAdvice ||= {};
  const list = state.reworkAdvice[key] ||= [];
  const basedOn = { checker: checker?.model || null, kind: checker?.kind || null, operation: checker?.operation || null, issues: reason };
  try { list.push(await adviseRework(context, { models, state, target: key, issues: reason, checker })); }
  catch (error) { list.push({ model: context.config.planner?.model || null, error: error.message, at: new Date().toISOString(), checkedBy: checker }); }
  requestReview(context, state, key, digest, reason);
}

async function runProduction(context, { until = 'final', client: injectedClient, testDouble = false, log = console.log } = {}) {
  if (!STAGES.includes(until)) throw new Error('INVALID_STAGE');
  const { root, production, config, project, directory } = context;
  authorization(root, config, production.id); // Before loading credentials or issuing even an upload.
  const media = new Media(root, project);
  const fingerprints = production.characters.map(c => ({
    id: c.id, image: media.image(c.image).hash, sample: c.speaks === false ? null : media.audio(c.voiceSample, true).hash,
    front: c.frontImage ? media.image(c.frontImage).hash : null
  }));
  const brief = loadBrief(root, production, directory);
  const productionHash = productionHashOf(context, fingerprints, brief?.brief || null);
  return withLock(path.join(root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    if (state.productionHash && state.productionHash !== productionHash) throw new Error('PRODUCTION_INPUT_CHANGED: 已有制作素材或模型配置发生变化；需先核对原任务和费用，禁止换ID绕过不确定提交');
    state.productionHash = productionHash;
    if (!state.brief && brief) { state.brief = brief.brief; state.briefSource = brief.source; }
    const budget = new Budget(root, config, directory);
    const client = providerClient(root, injectedClient);
    // The per-unit round ledger: first generation plus at most three reworks, shared by every entry point.
    const attempts = new UnitAttempts(directory);
    const ops = new Operations(path.join(directory, 'operations'), client, budget, log, config.pollIntervalSeconds, config.pollTimeoutSeconds, attempts);
    const models = new Models(config, ops, media, path.join(directory, 'vision-cache'));
    const speechModels = state.speechProfile ? new Models({ ...config, models: { ...config.models, ...state.speechProfile.models } }, ops, media, path.join(directory, 'vision-cache')) : models;
    const save = () => { state.updatedAt = new Date().toISOString(); state.budget = budget.report();
      state.unitRounds = attempts.summary(); saveState(context, state); };
    const operation = base => revisedId(state, base);
    try {
      // A manifest that explicitly declares the fine creative process runs the new chain and returns before
      // any legacy script/speech/media stage (and before the legacy character registry, which the creative
      // bible replaces). Old tasks (no `creative` marker) are untouched.
      if (production.creative === true) {
        if (until === 'characters') return state;
        return runCreativeStage(context, state, { until, log, media, models, speechModels, attempts, operation, save,
          config, production, budget,
          // A fixture acceptance needs a run-context signal, not just an injected client: an injected stub plus the
          // offline-fixture environment marker, or an explicitly declared test double. A real CLI run has neither.
          injected: testDouble === true || (Boolean(injectedClient) && process.env.CREATIVE_OFFLINE_FIXTURE === '1'),
          framesStage: creativeFramesStage, videoStage: creativeVideoStage });
      }
      for (const c of production.characters) {
        log('检查角色：' + c.name);
        const source = fingerprints.find(f => f.id === c.id);
        const key = hash({ source, traits: c.traits, speechModel: config.models.speech, portraitModel: config.models.portrait });
        const registry = path.join(root, 'jobs', 'aliyun', 'characters', key), registryFile = path.join(registry, 'character.json');
        let cached = readCache(registryFile);
        const prior = state.characters[c.id];
        if (!cached && prior?.accepted && prior.registryFile === registryFile) cached = prior;
        if (!cached && fs.existsSync(registryFile)) throw new Error('CHARACTER_REGISTRY_RECOVERY_REQUIRED:' + c.id);
        if (cached?.accepted) {
          if (!fs.existsSync(cached.original)) media.prepareImage(c.image, cached.original, true);
          if (cached.sample && !fs.existsSync(cached.sample)) media.normalizeAudio(c.voiceSample, cached.sample);
          if (!fs.existsSync(cached.front)) {
            if (c.frontImage) media.prepareImage(c.frontImage, cached.front, true);
            else {
              const raw = path.join(registry, operation('front-' + c.id) + '.png');
              if (fs.existsSync(raw)) media.prepareImage(raw, cached.front, true);
              else throw new Error('CHARACTER_FRONT_RECOVERY_REQUIRED:' + c.id + ': 需恢复已生成正脸，不自动重新生成');
            }
          }
          if (cached.frontHash !== fileHash(cached.front) || cached.originalHash !== fileHash(cached.original) || cached.sampleHash !== (cached.sample ? fileHash(cached.sample) : null)) throw new Error('CHARACTER_CACHE_CHANGED:' + c.id);
          writeJson(registryFile, cached);

          state.characters[c.id] = { ...cached, name: c.name }; continue;
        }
        fs.mkdirSync(registry, { recursive: true });
        const original = media.prepareImage(c.image, path.join(registry, 'original.png'), true);
        const sample = c.speaks === false ? null : media.normalizeAudio(c.voiceSample, path.join(registry, 'reference.wav'));
        const inspectId = operation('inspect-' + c.id);
        const inspection = await models.json(inspectId,
          '检查武将立绘：侧脸可作为身份参考，不因侧脸直接判不可用。判断是否清晰、单一角色、脸部是否适合正面说话。' +
          '只输出{"usable":true,"frontUsable":false,"traits":"可见的脸型、发型、服装、配色、武器、画风特征","issues":[]}，不能确认时保守处理。',
          [original]);
        checkBooleanReport(inspection, ['usable', 'frontUsable']);
        state.characterChecks ||= {};
        state.characterChecks[c.id] = { image: c.image, checkedBy: { model: config.models.vision, kind: 'vision', operation: inspectId,
          role: '辅助视觉检查' }, usable: inspection.usable, frontUsable: inspection.frontUsable,
          issues: inspection.issues, at: new Date().toISOString() };
        inspection.traits = normalizeTraits(inspection.traits);
        if (!inspection.usable) throw new Error('CHARACTER_IMAGE_REJECTED:' + c.id);
        let front = original, generated = false;
        if (c.frontImage) front = media.prepareImage(c.frontImage, path.join(registry, 'provided-front.png'), true);
        else if (c.speaks !== false && !inspection.frontUsable) {
          const raw = await models.image(operation('front-' + c.id),
            '以图1武将为唯一身份参考，补成正面半身像、嘴部清晰无遮挡、简洁背景；保持原图的脸型、发型、盔甲、服饰、配色及国风插画风格。' +
            '未知面部合理推测，不改变角色。特征：' + inspection.traits + '。' + (c.traits || ''), [original], path.join(registry, operation('front-' + c.id) + '.png'), true);
          front = media.prepareImage(raw, path.join(registry, operation('front-normalized-' + c.id) + '.png'), true);
          generated = true;
        }
        if (front !== original) {
          const frontCheckId = operation('front-check-' + c.id);
          const qc = await models.json(frontCheckId,
            '图1是原始身份参考，图2是正面补图。检查身份、发型、服装、配色、画风是否一致，图2是否脸部正面清晰适合说话。' +
            '输出{"identityMatches":true,"frontUsable":true,"issues":[]}。', [original, front]);
          checkBooleanReport(qc, ['identityMatches', 'frontUsable']);
          if (state.characterChecks?.[c.id]) state.characterChecks[c.id].frontCheck = { checkedBy: { model: config.models.vision, kind: 'vision',
            operation: frontCheckId, role: '辅助视觉检查' }, identityMatches: qc.identityMatches, frontUsable: qc.frontUsable, issues: qc.issues };
          state.characters[c.id] = { name: c.name, original, front, sample, traits: inspection.traits + '。' + (c.traits || ''), registryFile };
          if (!qc.identityMatches || !qc.frontUsable) requestReview(context, state, 'character-' + c.id, hash([fileHash(original), fileHash(front)]), qc.issues.join('；') || '正脸一致性待核验');
        }
        const entry = { name: c.name, original, front, sample, traits: inspection.traits + '。' + (c.traits || ''), registryFile,
          originalHash: fileHash(original), frontHash: fileHash(front), sampleHash: sample ? fileHash(sample) : null };
        state.characters[c.id] = entry; save();
        if (generated) requestReview(context, state, 'character-' + c.id, hash([entry.originalHash, entry.frontHash]), '新推测的正脸需要首次入库确认');
        const accepted = { ...entry, accepted: true };
        writeJson(registryFile, accepted); state.characters[c.id] = accepted;
      }
      state.stage = 'characters'; save();
      if (!state.brief) {
        // Material analysis and the production brief are model work; nothing waits for an assistant.
        const analyzed = await analyzeMaterials(context, { models, state, log });
        state.brief = analyzed;
        state.briefFile = recordBrief(context, directory, analyzed);
        state.productionHash = productionHashOf(context, fingerprints, analyzed);
        save();
        log('制作简报已由模型生成：' + state.briefFile);
      }
      if (until === 'characters') return state;
      if (!state.script) {
        const imported = path.join(directory, 'script.json');
        state.script = validateScript(fs.existsSync(imported) ? readJson(imported) :
          await generateScript(context, { models, state, log }), production);
        writeJson(imported, state.script);
      }
      validateScript(state.script, production);
      // Structural contract check before any paid generation: a script that declares action contracts must
      // be coherent (complete fields, key beats that fit the shot length, a declared hand-off). A legacy
      // script without contracts stays valid, and no continuity is claimed for it.
      state.scriptContinuity = validateScriptPlan(state.script.shots);
      save();
      // Independent content review by a separate request: structural validation above is not a content
      // review. The verdict is bound to the digest of the actual review input (script + prompt version +
      // production context), so any revision or prompt change forces a new review, and the run then stops
      // for the user instead of rolling into media generation.
      if (state.scriptReview?.reviewInputDigest !== reviewInputDigest(context.production, state.brief, state.script, config.planner?.promptVersion)) {
        state.scriptReview = await reviewScript(context, { models, state, log });
        save();
      }
      // A script that is still not accepted when its rounds are used up pauses the script unit for the user.
      if (state.scriptReview?.verdict && state.scriptReview.verdict !== 'pass')
        await attempts.markExhausted('script', state.scriptReview.advice || state.scriptReview.summary || '脚本审核未通过');
      state.stage = 'script'; save();
      if (until === 'script') return state;
      if (state.approvals.script !== hash(state.script)) requestReview(context, state, 'script', hash(state.script),
        '脚本与独立审核已完成：请用户检查上下文、预计时长与审核结论后确认再生成配音（approve <清单> script）' +
        '；审核模型=' + state.scriptReview.model + '，结论=' + state.scriptReview.verdict +
        '，预计时长=' + state.scriptReview.estimatedDurationSeconds + '秒' +
        (state.scriptReview.longShots.length ? '，偏长镜头=' + state.scriptReview.longShots.join('/') : '') +
        (state.scriptReview.durationIssues.length ? '，时长问题=' + state.scriptReview.durationIssues.join('；') : '') +
        (state.scriptReview.contextIssues.length ? '，上下文问题=' + state.scriptReview.contextIssues.join('；') : '') +
        (state.scriptReview.verdict === 'pass' ? '' : '，修订方向=' + (state.scriptReview.advice || state.scriptReview.summary)));
      const readiness = speechReadiness(production, state, config);
      if (readiness.problems.length) throw new Error('SPEECH_PERFORMANCE_PARAMS_MISSING: ' +
        readiness.problems.map(p => p.shotId + '（' + p.reason + '）').join('；') + '；本轮未发起任何请求、未新增预留');
      state.speechReadiness = { model: readiness.model, supportsInstruction: readiness.supportsInstruction,
        checkedShots: state.script.shots.filter(s => s.text).map(s => s.id), at: new Date().toISOString() };
      state.costForecast = budget.checkPlan(productionPlan(state, config));
      const durations = {};
      for (const s of state.script.shots) {
        const a = state.assets[s.id] ||= {};
        if (s.type !== 'dialogue' && s.type !== 'narration') continue;
        const c = state.characters[s.speaker];
        const activeSpeechModel = speechModels.config.models.speech;
        let voice = state.speechProfile ? c.voices?.[activeSpeechModel] : c.voice;
        if (!voice) {
          voice = await speechModels.voice(operation('voice-' + s.speaker), c.sample);
          if (state.speechProfile) { c.voices ||= {}; c.voices[activeSpeechModel] = voice; }
          else c.voice = voice;
          writeJson(c.registryFile, c); save();
        }
        const hadDrivingAudio = !!a.audioHash;
        const speechOperation = operation('speech-' + s.id);
        const delivery = state.speechProfile?.delivery?.[s.id] || {};
        const raw = await speechModels.speech(speechOperation, s.text, voice,
          path.join(directory, 'audio', speechOperation + '.wav'), delivery);
        const performed = s.speechRate !== undefined || s.speechLeadSeconds !== undefined
          ? media.performanceAudio(raw, path.join(directory, 'audio', operation('performance-' + s.id) + '.wav'), s.speechRate ?? 1, s.speechLeadSeconds ?? 0) : raw;
        const seconds = media.audio(performed).duration;
        durations[s.id] = seconds;
        a.audio = media.normalizeAudio(performed, path.join(directory, 'audio', operation('driving-' + s.id) + '.wav'), 2);
        a.speechRaw = raw; a.audioHash = fileHash(a.audio);
        // Emotion must either reach the request or be explained in the record; never silently dropped.
        const scriptEmotion = s.emotion || '';
        const supportsInstruction = activeSpeechModel === 'qwen-audio-3.0-tts-plus';
        const instruction = typeof delivery.instruction === 'string' && delivery.instruction.trim() ? delivery.instruction : null;
        if (scriptEmotion && supportsInstruction && !instruction) throw new Error('EMOTION_NOT_HANDLED:' + s.id +
          ': 该语音模型支持情绪指令，但本镜没有 instruction；请补 speechProfile.delivery 或明确说明');
        const opRecord = readCache(path.join(directory, 'operations', speechOperation + '.json'));
        state.audioRecords ||= {};
        state.audioRecords[s.id] = { operation: speechOperation, model: activeSpeechModel, voice,
          text: { digest: [...s.text].slice(0, 40).join(''), hash: hash(s.text), characters: [...s.text].length },
          performance: { scriptEmotion, instruction, rate: s.speechRate ?? 1, hotFix: delivery.hotFix ? 'sent' : 'none',
            emotionHandling: !scriptEmotion ? 'script-has-no-emotion'
              : instruction ? 'instruction-sent'
                : supportsInstruction ? 'instruction-missing-but-explained' : 'model-has-no-instruction-parameter',
            note: scriptEmotion && !instruction && !supportsInstruction
              ? '当前语音模型（' + activeSpeechModel + '）没有情绪指令参数，emotion 未进入请求，仅作为人工复查提示' : null },
          modelParams: { voice, text: s.text, format: 'wav', sampleRate: 24000, languageHints: ['zh'],
            instruction, rate: Number.isFinite(delivery.rate) ? delivery.rate : 1, hotFix: delivery.hotFix ? true : false,
            profile: state.speechProfile ? 'speech-profile' : 'default' },
          localPostProcess: { speechRate: s.speechRate ?? 1, speechLeadSeconds: s.speechLeadSeconds ?? 0,
            drivingAudio: 'normalized 24k mono, minimum 2s' },
          requestId: opRecord?.result?.request_id || null,
          result: { file: a.audio, hash: a.audioHash, durationSeconds: seconds, format: path.extname(a.audio).slice(1) },
          reviewStatus: 'awaiting-user-acceptance', at: new Date().toISOString() };
        if (!hadDrivingAudio) state.audioReview = { status: 'pending', model: activeSpeechModel,
          note: '语音已生成，需试听并明确接受后才能生成视频', at: new Date().toISOString() };
        save();
      }
      state.timed = timedScript(state.script, durations, production);
      writeJson(path.join(directory, 'timeline.json'), state.timed);
      state.stage = 'audio'; save();
      if (until === 'audio') return state;
      // Speech must be explicitly accepted by the user before any video work starts, and the acceptance
      // must still match the audio actually in state: a model success, a decodable file, an auxiliary
      // check or a stale verdict on older audio are never acceptance.
      const needsSpeech = state.timed.shots.some(s => s.text);
      const accepted = state.audioReview?.status === 'accepted';
      const bindingCurrent = accepted && hash(state.audioReview.binding || null) === hash(audioAcceptanceBinding(state));
      if (needsSpeech && !bindingCurrent)
        throw new Error('AUDIO_NOT_ACCEPTED: 当前配音状态为 ' + (state.audioReview?.status || 'pending') +
          (accepted ? '，但验收绑定的音频/脚本已变化' : '') + '；需重新试听后用 accept-audio 明确接受才能生成视频');

      state.costForecast = budget.checkPlan(productionPlan(state, config));
      for (const s of state.timed.shots) {
        const a = state.assets[s.id] ||= {};
        const references = s.characters.flatMap(id => {
          const c = state.characters[id];
          return s.characters.length === 1 ? [...new Set([c.original, c.front])] : [c.front];
        });
        if (!references.length) references.push(state.characters[production.characters[0].id].original);
        const roleMap = s.characters.map(id => id + '：' + state.characters[id].traits).join('；');
        const contractText = contractPrompt(s);
        const prompt = production.style + '。生成横屏16:9分镜首帧。' + s.scene + '。参考人物映射：' + roleMap +
          (s.characters.length
            ? contractText ? '。' + contractText + '保持参考中的身份、发型、服装与画风；武器与道具按上面的脚本约束，不照抄参考图。'
              : '。严格保持参考人物身份、发型、服装、武器和画风。'
            : '。参考图仅用于画风，本镜头不出现任何参考人物。') +
          '不添加文字、字幕、拼图边框。';
        const firstId = operation('first-' + s.id);
        const raw = await models.image(firstId, recordedPrompt(directory, firstId, prompt), references.slice(0, 3),
          path.join(directory, 'frames', firstId + '.png'));
        a.first = media.prepareImage(raw, path.join(directory, 'frames', operation('first-ready-' + s.id) + '.png'));
        if (s.needsLastFrame) {
          const lastReferences = [a.first, ...references].slice(0, 3), lastId = operation('last-' + s.id);
          const lastBase = production.style + '。图1是本镜头首帧，保持其场景、人物位置关系、身份和光线。其余图是人物身份参考。' +
            '仅把动作和构图推进到此结束状态：' + s.endScene + '。前后动作必须连续可实现，不添加文字。' +
            (contractText ? contractText + '尾帧只描述单一静止瞬间。' : '') +
            (s.lastFrameDirection ? '。导演修正：' + s.lastFrameDirection : '');
          const lastRaw = await models.image(lastId, recordedPrompt(directory, lastId, lastBase), lastReferences,
            path.join(directory, 'frames', lastId + '.png'));
          a.last = media.prepareImage(lastRaw, path.join(directory, 'frames', operation('last-ready-' + s.id) + '.png'));
        }
        const frameCheckId = operation('frame-check-' + s.id);
        const frameImages = [...references.slice(0, 2), a.first, ...(a.last ? [a.last] : [])];
        const frameLabels = [...references.slice(0, 2).map((entry, index) => ({ label: '身份参考' + (index + 1) })),
          { label: '目标首帧' }, ...(a.last ? [{ label: '目标尾帧' }] : [])];
        const frameBinding = reviewBinding({ shotId: s.id, revision: state.revisions?.['first-' + s.id] || 0,
          first: fileHash(a.first), last: a.last ? fileHash(a.last) : null,
          contract: contractDigest(s, config.planner?.promptVersion), promptVersion: config.planner?.promptVersion });
        let review = reviewIsReusable(a.frameReview, frameBinding) ? a.frameReview : null;
        if (!review) {
          // Only an input that is proven identical may be reused: a contract shot proves it through the review
          // binding, a legacy shot through the exact input hashes it was sent with.
          const stored = readStoredReview(directory, frameCheckId, { duration: s.duration, imageCount: frameImages.length,
            ...(contractText ? { binding: frameBinding } : { images: frameImages.map(fileHash) }) });
          const basePrompt = '检查图像一致性与明显错误。前面的图是身份/画风参考，最后' + (a.last ? '两张是同一镜头首尾帧' : '一张是分镜首帧') +
            '。核验人物身份、手部、武器、画风、前后场景是否符合：' + s.scene + '。' + s.action + '。';
          if (stored) review = { ...stored.report, reusedFrom: frameCheckId, provenance: stored.provenance,
            coverageGap: coverageGap(stored.spec, frameLabels) };
          else {
            const prompt = recordedPrompt(directory, frameCheckId, basePrompt + (contractText
              ? framesCheckPrompt({ shot: s, images: frameLabels, contract: contractText, docFirst: false })
              : '输出{"pass":true,"issues":[]}。'));
            const frameRecord = operationRecord(directory, frameCheckId);
            if (frameRecord && checkInputChanged(frameRecord, { prompt, images: frameImages.map(fileHash) }))
              throw new Error('FRAME_CHECK_INPUT_CHANGED:' + frameCheckId + ':' +
                '该帧检查已有记录但当前输入不同（已有覆盖 ' + JSON.stringify(checkCoverage(frameRecord)) + '）；不换号、不重绑，需人工核实或用受控修订显式升级');
            // 归一化只有一条入口：新 verdict 结构与旧的 pass/issues 都接受，结构无法解析才报错；降级记录
            // 仍在归一化之后写入，避免新格式被旧校验器先拒绝。
            const answer = await models.json(frameCheckId, prompt, frameImages,
              contractText ? { digest: frameBinding.digest, rules: QUALITY_RULES_VERSION } : null);
            review = normalizeReview(answer, { duration: s.duration, imageCount: frameImages.length });
            noteDegradation(state, frameCheckId, review);
          }
        }
        a.frameReview = { ...review, revision: state.revisions?.['first-' + s.id] || 0, binding: frameBinding,
          producedBy: { model: config.models.vision, kind: 'vision', operation: frameCheckId,
            role: '辅助视觉检查；其结果交规划模型作制作判断' } }; save();
        const frameDecision = reworkDecision(review, { hasLastFrame: !!a.last });
        if (frameDecision.action === 'accept') {
          if (frameDecision.observations?.length) {
            (state.qualityObservations ||= []).push({ operation: frameCheckId, reason: frameDecision.reason,
              issues: frameDecision.observations, at: new Date().toISOString() });
            save();
          }
        } else {
          // Only an evidence-backed material problem spends a round; an unclear result or a wrong target
          // pauses for the user instead, and neither may pass silently.
          const summary = review.issues.map(issue => issue.observed).concat(review.uncovered).join('；') || '分镜画面待检查';
          if (frameDecision.action === 'repair')
            for (const unit of ['first-' + s.id, ...(s.needsLastFrame ? ['last-' + s.id] : [])])
              await attempts.markExhausted(unit, summary);
          else {
            a.qualityPause = { stage: 'frames', code: frameDecision.code, reason: frameDecision.reason, review, at: new Date().toISOString() };
            (state.qualityPauses ||= []).push({ shotId: s.id, stage: 'frames', code: frameDecision.code,
              reason: frameDecision.reason, scope: frameDecision.fixScope, at: a.qualityPause.at });
            save();
          }
          await reviewWithAdvice(context, state, models, 'frames-' + s.id,
            hash([fileHash(a.first), a.last ? fileHash(a.last) : null]), summary,
            { model: config.models.vision, kind: 'vision', operation: frameCheckId, role: '辅助视觉检查' });
        }
      }
      state.preview = media.assemble(state.timed, state.assets, path.join(directory, 'preview', 'revision-' + (state.editRevision || 0)), { preview: true });
      state.stage = 'frames'; save();
      if (until === 'frames') return state;
      state.costForecast = budget.checkPlan(productionPlan(state, config, true));
      for (const s of state.timed.shots) {
        const a = state.assets[s.id];
        // A shot that declares an action contract carries it into the video request; a legacy shot is passed
        // exactly as before, so the input fingerprint of its recorded request cannot change silently.
        const contractText = contractPrompt(s);
        const videoShot = contractText ? { ...s, videoScene: s.videoScene || s.scene,
          videoAction: (s.videoAction || s.action) + '。' + contractText } : s;
        a.video = await models.video(operation('video-' + s.id), videoShot, a.first, a.last, a.audio,
          path.join(directory, 'video', operation('video-' + s.id) + '.mp4'));
        a.videoInfo = media.video(a.video, s.duration, s.type === 'dialogue');
        // A legacy shot keeps the sampling times it was checked with before the upgrade, so its recorded
        // requests stay reproducible (resuming never has to pretend they were made under the new plan).
        const plan = contractText ? samplingPlan(s.duration)
          : { count: 3, times: [0.1, s.duration / 2, Math.max(0.1, s.duration - 0.2)] };
        const frames = media.sampleFramesAt(a.video, path.join(directory, 'video-check', operation(s.id)), plan.times).map(entry => entry.file);
        const videoCheckId = operation('video-check-' + s.id);
        // The target end state is part of the comparison whenever the shot carries a contract; a legacy shot
        // keeps the exact input it was sent with, and the missing comparison is recorded instead of claimed.
        const withTargetEnd = !!contractText && !!a.last;
        const targets = withTargetEnd ? [a.first, ...frames, a.last] : [a.first, ...frames];
        const labels = [{ label: '目标首帧' }, ...plan.times.map(at => ({ label: '视频' + at + '秒抽帧' })),
          ...(withTargetEnd ? [{ label: '目标尾帧' }] : [])];
        const videoBinding = reviewBinding({ shotId: s.id, revision: state.revisions?.['video-' + s.id] || 0,
          first: fileHash(a.first), last: a.last ? fileHash(a.last) : null, video: fileHash(a.video),
          contract: contractDigest(s, config.planner?.promptVersion), promptVersion: config.planner?.promptVersion, sampling: plan });
        let qc = reviewIsReusable(a.videoReview, videoBinding) ? a.videoReview : null;
        if (!qc) {
          const stored = readStoredReview(directory, videoCheckId, { duration: s.duration, imageCount: targets.length,
            sampledTimes: plan.times, actualFrameIndexes: [2, 3, 4],
            ...(withTargetEnd ? { binding: videoBinding } : { images: targets.map(fileHash) }) });
          const legacyPrompt = '图1是目标首帧，随后三张是视频开始、中间、结束的抽帧。检查明显人物变脸、服饰武器畸变、画面破损以及动作是否符合：' +
            s.action + '。这些抽帧不能确认口型或声音，不要宣称已验证口型。输出{"pass":true,"issues":[]}。';
          if (stored) {
            const gap = coverageGap(stored.spec, labels);
            qc = { ...stored.report, reusedFrom: videoCheckId, provenance: stored.provenance, coverageGap: gap,
              missingLastFrameComparison: !!gap };
          } else {
            const prompt = recordedPrompt(directory, videoCheckId, withTargetEnd
              ? videoCheckPrompt({ shot: s, images: labels, duration: s.duration, contract: contractText, docFirst: false })
              : legacyPrompt);
            const videoRecord = operationRecord(directory, videoCheckId);
            if (videoRecord && checkInputChanged(videoRecord, { prompt, images: targets.map(fileHash) }))
              throw new Error('VIDEO_CHECK_INPUT_CHANGED:' + videoCheckId + ':' +
                '该视频检查已有记录但当前输入不同（已有覆盖 ' + JSON.stringify(checkCoverage(videoRecord)) + '）；不换号、不重绑，需人工核实或用受控修订显式升级');
            const answer = await models.json(videoCheckId, prompt, targets,
              withTargetEnd ? { digest: videoBinding.digest, rules: QUALITY_RULES_VERSION } : null);
            // 抽帧检查的证据必须可定位：时间要落在实际抽到的时点上，图序要指向实际抽帧而不是目标图。
            qc = normalizeReview(answer, { duration: s.duration, imageCount: targets.length,
              sampledTimes: plan.times, actualFrameIndexes: [2, 3, 4] });
            noteDegradation(state, videoCheckId, qc);
          }
        }
        a.videoReview = { ...qc, revision: state.revisions?.['video-' + s.id] || 0, binding: videoBinding,
          evidence: { sampling: plan.times, imageCount: targets.length, order: labels.map(label => label.label), coverage: plan.coverage },
          producedBy: { model: config.models.vision, kind: 'vision', operation: videoCheckId,
            role: '辅助视觉检查；其结果交规划模型作制作判断' } }; save();
        const videoDecision = reworkDecision(qc, { hasLastFrame: !!a.last });
        if (videoDecision.action === 'accept') {
          if (videoDecision.observations?.length) {
            (state.qualityObservations ||= []).push({ operation: videoCheckId, reason: videoDecision.reason,
              issues: videoDecision.observations, at: new Date().toISOString() });
            save();
          }
        } else {
          const summary = qc.issues.map(issue => issue.observed).concat(qc.uncovered).join('；') || '视频质量待检查';
          // Only a real video-level problem spends the video round. A problem in the target frames or in the
          // wording pauses here with its recorded scope and minimal fix, so the video is not redone blindly.
          if (videoDecision.action === 'repair' && videoDecision.unit === 'video') await attempts.markExhausted('video-' + s.id, summary);
          else {
            a.qualityPause = { stage: 'video', code: videoDecision.code, reason: videoDecision.reason, review: qc,
              scope: videoDecision.fixScope, fix: videoDecision.action === 'repair' ? repairInstruction(qc) : null,
              at: new Date().toISOString() };
            (state.qualityPauses ||= []).push({ shotId: s.id, stage: 'video', code: videoDecision.code,
              reason: videoDecision.reason, scope: videoDecision.fixScope, at: a.qualityPause.at });
            save();
          }
          await reviewWithAdvice(context, state, models, 'video-' + s.id, fileHash(a.video), summary,
            { model: config.models.vision, kind: 'vision', operation: videoCheckId, role: '辅助视觉检查' });
        }
      }
      // Adjacent-shot continuity, only where the script declares it. A legacy script is never forced into
      // continuity it never declared, and a scene change or time jump is allowed by the declaration itself.
      const continuity = state.scriptContinuity || { mode: 'legacy', pairs: [], gaps: [] };
      state.continuity = { mode: continuity.mode, checkedPairs: continuity.pairs.map(pair => pair.to), gaps: continuity.gaps };
      if (continuity.mode === 'contract' && continuity.pairs.length) {
        state.adjacencyReviews ||= {};
        state.adjacencyDecisions ||= {};
        for (const pair of continuity.pairs) {
          const from = state.timed.shots.find(item => item.id === pair.from), to = state.timed.shots.find(item => item.id === pair.to);
          const fa = state.assets[pair.from], ta = state.assets[pair.to];
          if (!from || !to || !fa?.video || !ta?.video || !fa.last || !ta.first) continue;
          const endSample = media.sampleFramesAt(fa.video, path.join(directory, 'adjacent', pair.to),
            [Math.max(0.03, from.duration - 0.05)], pair.to + '-prev-')[0];
          const startSample = media.sampleFramesAt(ta.video, path.join(directory, 'adjacent', pair.to), [0.03], pair.to + '-next-')[0];
          const images = [fa.last, endSample.file, ta.first, startSample.file];
          const labels = [{ label: '前镜目标尾帧' }, { label: '前镜实际结束' }, { label: '后镜目标首帧' }, { label: '后镜实际开始' }];
          const base = 'adjacent-check-' + pair.to;
          const bindingFor = revision => reviewBinding({ shotId: pair.to, revision,
            first: fileHash(fa.last), last: fileHash(startSample.file), video: fileHash(ta.video),
            contract: contractDigest(to, config.planner?.promptVersion), promptVersion: config.planner?.promptVersion,
            sampling: { count: 2, times: [endSample.at, startSample.at] },
            extra: { kind: 'adjacent', from: pair.from, fromRevision: state.revisions?.['video-' + pair.from] || 0,
              adjacentVideo: fileHash(fa.video), adjacentContract: contractDigest(from, config.planner?.promptVersion),
              adjacentSampling: [endSample.at] } });
          const previous = state.adjacencyReviews[pair.to];
          if (previous && !reviewIsReusable(previous, bindingFor(state.revisions?.[base] || 0))) {
            // 输入变了（例如只换了前镜的实际视频）：走受控修订——丢掉旧结论并推进该检查的修订号，
            // 让新请求落到新的操作号上，既不覆盖历史记录，也不能靠新编号绕开检查次数限制。
            delete state.adjacencyReviews[pair.to];
            state.revisions[base] = (state.revisions?.[base] || 0) + 1;
            save();
          }
          // 操作号、请求证据与状态绑定必须使用同一个修订版本：绑定按推进后的修订号重算。
          const revision = state.revisions?.[base] || 0, binding = bindingFor(revision);
          const checkId = operation(base);
          let report = reviewIsReusable(state.adjacencyReviews[pair.to], binding) ? state.adjacencyReviews[pair.to].report : null;
          // 首次响应与缓存恢复共用同一组校验选项，避免定位规则只在其中一条路径生效。
          const reviewOptions = { duration: to.duration, imageCount: images.length,
            sampledTimes: [endSample.at, startSample.at], actualFrameIndexes: [2, 4] };
          if (!report) {
            const stored = readStoredReview(directory, checkId, { ...reviewOptions, binding });
            if (stored) report = { ...stored.report, provenance: stored.provenance };
            else {
              const prompt = recordedPrompt(directory, checkId,
                adjacentCheckPrompt({ pair: { ...pair, fromDuration: from.duration }, images: labels, duration: to.duration, docFirst: false }));
              const record = operationRecord(directory, checkId);
              if (record && checkInputChanged(record, { prompt, images: images.map(fileHash) }))
                // 已有记录与当前输入不一致：明确暂停，既不重绑也不换号重新请求。
                throw new Error('ADJACENT_CHECK_INPUT_CHANGED:' + checkId + ':' +
                  '该相邻检查已有记录但当前输入不同（已有覆盖 ' + JSON.stringify(checkCoverage(record)) + '）；不换号、不重绑，需人工核实或用受控修订显式升级');
              const answer = await models.json(checkId, prompt, images, { digest: binding.digest, rules: QUALITY_RULES_VERSION });
              report = normalizeReview(answer, reviewOptions);
            }
            state.adjacencyReviews[pair.to] = { report, binding, from: pair.from, revision: binding.revision,
              evidence: { images: labels.map(label => label.label), sampledAt: { previous: endSample.at, current: startSample.at } },
              at: new Date().toISOString() };
            save();
          }
          const decision = reworkDecision(report, { hasLastFrame: !!ta.last });
          const record = { shotId: pair.to, from: pair.from, action: decision.action, code: decision.code,
            reason: decision.reason, scope: decision.fixScope, at: new Date().toISOString() };
          if (decision.action === 'repair') record.fix = repairInstruction(report);
          state.adjacencyDecisions[pair.to] = record; save();
          if (decision.action !== 'accept')
            // A mismatch between neighbours is a local, plan-level matter: it pauses with the recorded
            // minimal fix (redo the affected frames, or the wording) instead of regenerating a video on its
            // own, and it never spends a video round here.
            await reviewWithAdvice(context, state, models, 'frames-' + pair.to,
              hash([fileHash(ta.first), ta.last ? fileHash(ta.last) : null]),
              record.reason + '：' + report.issues.map(item => item.observed).concat(report.uncovered).join('；'),
              { model: config.models.vision, kind: 'vision', operation: checkId, role: '辅助视觉检查' });
        }
      }
      state.stage = 'video'; save();
      if (until === 'video') return state;
      // Local edits are recorded state, not side files: re-apply them here so that a later run
      // cannot silently discard a repaired shot.
      const local = applyLocalEdits(media, state, state.assets, path.join(directory, 'video-local'), log);
      if (Object.keys(local.applied).length) { state.localVideoEdits = local.applied; save(); }
      state.output = media.assemble(state.timed, local.assets, path.join(root, 'output', production.id, ...(state.editRevision ? ['revision-' + state.editRevision] : [])));
      state.stage = 'final'; state.acceptance = 'awaiting_user_playback';
      save(); log('已导出：' + state.output + '；需播放验收口型、音色与动作');
      return state;
    } catch (error) {
      state.lastError = error.message; save(); throw error;
    }
  });
}
// Model-side revision for the CLI: the planner produces the replacement script, then the existing
// revise.js machinery validates it and invalidates exactly the affected assets.
async function planRevision(context, instructions, { client: injectedClient, log = console.log } = {}) {
  const { root, config, directory } = context;
  authorization(root, config, context.production.id);
  return withLock(path.join(root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    const budget = new Budget(root, config, directory);
    const ops = new Operations(path.join(directory, 'operations'), providerClient(root, injectedClient), budget, log,
      config.pollIntervalSeconds, config.pollTimeoutSeconds, new UnitAttempts(directory));
    const models = new Models(config, ops, new Media(root, context.project), path.join(directory, 'vision-cache'));
    return planRevisionScript(context, { models, state, instructions, log });
  });
}
async function approve(context, key) {
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    if (state.pendingReview?.key !== key) throw new Error('NO_MATCHING_PENDING_REVIEW');
    state.approvals[key] = state.pendingReview.digest;
    delete state.pendingReview; saveState(context, state);
  });
}
function doctor(context) {
  const m = new Media(context.root, context.project), issues = [];
  for (const tool of [m.ffmpeg, m.ffprobe]) if (!fs.existsSync(tool)) issues.push('缺少本地工具：' + tool);
  for (const c of context.production.characters) {
    for (const [type, file] of [['image', c.image], ...(c.speaks === false ? [] : [['audio', c.voiceSample]]), ...(c.frontImage ? [['image', c.frontImage]] : [])]) {
      if (!fs.existsSync(file)) { issues.push('缺少素材：' + file); continue; }
      try { if (type === 'image') m.image(file); else m.audio(file, true); } catch (error) { issues.push(error.message); }
    }
  }
  try { authorization(context.root, context.config, context.production.id); } catch (error) { issues.push(error.message); }
  // A brief is optional: it is either already valid on disk or produced by the planner model at run
  // time, so a missing brief is reported as information rather than as a blocking issue.
  const brief = loadBrief(context.root, context.production, context.directory);
  const briefInfo = brief
    ? { file: brief.file, source: brief.source, note: brief.source.role === 'model' ? null : '非模型来源的简报只作数据来源与追溯，不构成运行依赖' }
    : { file: null, source: null, willBeGeneratedBy: context.config.planner?.model || null };
  // A missing price no longer blocks anything: it only means the cost is recorded as unknown.
  const notes = [];
  if (context.config.onlineEnabled === true && !Number.isSafeInteger(context.config.planner?.reservationCents))
    notes.push('PLANNER_PRICE_UNVERIFIED: planner.reservationCents 未填写；调用仍然允许，费用记为未知（不等于 0）');
  if (context.config.maxAttemptsPerAsset !== undefined)
    notes.push('maxAttemptsPerAsset 仅作历史信息；实际规则为「每个制作单元首次生成 + 最多 3 次返工」');
  return { production: context.production.id, onlineEnabled: context.config.onlineEnabled, brief: briefInfo,
    plannerModel: context.config.planner?.model || null, issues, notes, networkRequests: 0 };
}
// ---------------------------------------------------------------- creative frame references
// Capacity comes from the image adapter's own rule (services/aliyun/models.js
// IMAGE_REQUIRES_1_TO_3_REFERENCES) and that is the ONLY limit claimed here: the supplier's own limit has not
// been verified against its documentation, so it is never asserted.
const REFERENCE_LIMIT = 3;
const REFERENCE_LIMIT_BASIS = '图片适配器自身校验 1-3 张（services/aliyun/models.js IMAGE_REQUIRES_1_TO_3_REFERENCES）；供应商上限未核实';
// Necessity is NOT a position and NOT a field name. A reference is REQUIRED only when the manifest itself
// confirms that it covers something this frame must keep; what a picture actually contains is never inferred from
// the field name and no vision request is made to find out. A material whose coverage is undeclared has UNKNOWN
// coverage: it is retained conservatively instead of being treated as spare, and it is never reported as if a
// requirement had been met by a reference.
const REFERENCE_NEED_LABELS = { identity: '身份与容貌', costume: '服饰', weapon: '武器与持物' };
// The manifest declares coverage per material with the SAME field names it already uses. Only the three frame
// needs above can make a material REQUIRED; every other declared word (画风、背景、配饰细节…) is recorded as
// declared coverage that does not by itself keep this frame's must-keep content.
const REFERENCE_COVERAGE_MAP = { identity: ['identity'], face: ['identity'], hair: ['identity'],
  costume: ['costume'], accessories: ['costume'], materials: ['costume'], weapon: ['weapon'],
  palette: [], background: [] };
const REFERENCE_SELECTION_RULE = '必要参考＝已被清单确认覆盖本帧必须保持内容的素材（绝不省略）；' +
  '可选参考＝清单声明为 optional 的素材，以及已确认覆盖范围与本帧必须保持内容无交集的素材；' +
  '容量先满足必要参考，剩余名额按清单声明顺序给可选参考，装不下的逐条记录具体原因；' +
  '尾帧另加本镜首帧作为必要结构锚点，该锚点不作为身份、服饰或武器的覆盖证据；容量＝' + REFERENCE_LIMIT + ' 张';
const REFERENCE_NECESSITY_RULE = '必要性依据「本帧必须保持的内容」与「素材在清单 referenceCoverage 中已确认的覆盖范围」：' +
  '本帧入画角色恒需「身份与容貌」，其本帧服饰文本非空时需「服饰」，本帧持物非空时需「武器与持物」；' +
  '已确认覆盖与本帧必需项有交集 → 必要参考；清单声明 optional 或已确认覆盖与本帧必需项无交集 → 可选参考；' +
  '未声明覆盖范围 → 覆盖范围未经确认，按保守保留处理（不因排列顺序或名次丢弃），也不据此声称任何必需项已被覆盖。' +
  '参考名称只表示清单里的哪个字段，不表示图片内容；不调用视觉接口，也不凭字段名推断图片内容';
// Placeholders. The plan is decided before anything is submitted, so a file that does not exist YET (this
// shot's own first frame, the previous shot's frame) occupies its slot as a logical entry and is filled in later
// without changing the decision. The anchor is a STRUCTURE reference only: it is never counted as evidence that
// identity, costume or weapons were preserved, so it can never be used to drop an original required material.
const OWN_FIRST_FRAME = { id: null, source: 'ownFirstFrame', necessity: 'required', file: null,
  role: '本镜首帧（本镜的结构与人物位置锚点）', purpose: '本镜首尾衔接（必要）', covers: [], coveredNeeds: [],
  coverage: 'anchor', basis: '结构锚点：只作本镜结构与人物位置参考，不作为身份、服饰或武器的覆盖证据' };
const PREVIOUS_FIRST_FRAME = { id: null, source: 'previousShotFirstFrame', necessity: 'optional', file: null,
  role: '画风与材质参考（前镜首帧；只作画风、材质与局部光照参考，不含本镜场景布局，也不得照抄其中的人物与构图）',
  purpose: '画风、材质与局部光照（可选；不证明本镜布局，也不证明群演身份）', covers: [], coveredNeeds: [],
  coverage: 'style', basis: '前镜首帧只作画风、材质与局部光照参考，不覆盖身份、服饰或武器' };
// What material a registered character has is read from the manifest, and its declared coverage is read from the
// manifest's own referenceCoverage field — both are the SAME field names the manifest already uses. The label is
// a slot name only: it never asserts what the picture contains.
function characterMaterials(character) {
  const declared = character.referenceCoverage || {};
  const entries = [];
  for (const [source, label, file] of [['frontImage', '正脸参考', character.frontImage],
    ['image', '立绘参考', character.image]]) {
    if (!file) continue;
    const declaration = declared[source] || null;
    entries.push({ id: character.id, source, file, role: label + '（' + character.id + '）',
      covers: declaration ? [...declaration.covers] : [], declaredOptional: declaration?.optional === true,
      declaredNote: declaration?.note || null,
      basis: declaration ? '清单 referenceCoverage 声明的已确认覆盖：' + declaration.covers.join('、')
        : '清单未声明该素材的覆盖范围（覆盖未知）' });
  }
  return entries;
}
// The must-keep content of ONE frame, read from the very text that frame's request states for that person:
// identity always, costume when this frame carries costume text, weapon when this frame carries props. The
// frame's own text is the evidence on purpose — never the field name of a material.
function frameNeeds(shot, frame, character) {
  const state = (frame.castState || []).find(item => item.id === character.id) || {};
  const cast = (shot.characters || []).find(item => item.id === character.id) || {};
  const costume = state.costume || cast.costume || frame.crowdCostume || null;
  const props = (Array.isArray(state.props) && state.props.length ? state.props : (cast.props || []));
  const needs = ['identity'];
  if (costume) needs.push('costume');
  if (props.length) needs.push('weapon');
  return { needs, evidence: { costume: costume || null, props: [...props] } };
}
function needLabels(needs) { return needs.map(need => REFERENCE_NEED_LABELS[need]).join('、'); }
// Necessity of ONE material in ONE frame. The order of the manifest fields is never consulted: only the declared
// coverage and this frame's must-keep content decide, and an undeclared material keeps its unknown coverage
// instead of being silently treated as spare.
function referenceEntry(material, needs) {
  const mapped = [...new Set(material.covers.flatMap(word => REFERENCE_COVERAGE_MAP[word] || []))];
  const covered = needs.filter(need => mapped.includes(need));
  if (material.declaredOptional) return { ...material, necessity: 'optional', coverage: 'declared', coveredNeeds: covered,
    purpose: '清单声明为可选（明确冗余或非本帧必需）' + (material.declaredNote ? '：' + material.declaredNote : '') +
      '；' + material.basis,
    omissionReason: '清单已声明该素材为可选（明确冗余或非本帧必需）' +
      (material.declaredNote ? '：' + material.declaredNote : '') };
  if (material.covers.length && !covered.length) return { ...material, necessity: 'optional', coverage: 'confirmed',
    coveredNeeds: [], purpose: material.basis + '；与本帧必须保持的内容（' + needLabels(needs) + '）无交集',
    omissionReason: material.basis + '，与本帧必须保持的内容（' + needLabels(needs) + '）无交集' };
  if (covered.length) return { ...material, necessity: 'required', coverage: 'confirmed', coveredNeeds: covered,
    purpose: material.basis + '；本帧必须保持的 ' + needLabels(covered) };
  return { ...material, necessity: 'required', coverage: 'unconfirmed', coveredNeeds: [],
    purpose: material.basis + '；为保证本帧必须保持的 ' + needLabels(needs) + ' 不被静默丢失而保守保留；' +
      '该素材实际包含什么未经确认，不得据此声称身份、服饰或武器已被参考' };
}
function entrySummary(entry) {
  return { id: entry.id, source: entry.source, role: entry.role, purpose: entry.purpose,
    necessity: entry.necessity, coverage: entry.coverage, coveredNeeds: entry.coveredNeeds, file: entry.file || null };
}
function planFrameRecord(frame) {
  return { needs: frame.needs, uncovered: frame.uncovered || [], kept: frame.kept.map(entrySummary),
    omitted: frame.dropped.map(entry => ({ ...entrySummary(entry), reason: entry.omissionReason,
      note: '该素材未附到本帧请求；本帧相关外观只依据文字描述，不因此声称已参考' })) };
}
// One deterministic reference plan per shot, decided ONCE and BEFORE the shot's first media submission: which
// reference each frame receives, which optional reference is left out and why, and whether the required ones fit
// at all. Both frames are decided together, so a last frame that cannot hold its required material stops the shot
// before its first frame is ever submitted. Readability is probed on the very path strings the adapter will
// submit: a required material that cannot be read stops the run before anything is sent, an optional one is left
// out with its reason recorded.
function planShotReferences(shot, { production, previousFrame = null, probe = null }) {
  const frames = [['first', shot.first || {}], ['last', shot.last || {}]];
  const prepared = new Map();
  for (const [kind, frame] of frames) {
    const required = [], optional = [], needs = [];
    for (const cast of shot.characters) {
      const character = (production.characters || []).find(item => item.id === cast.id);
      if (!character) return { error: { code: 'CREATIVE_REFERENCE_UNKNOWN_CHARACTER', detail: cast.id } };
      const materials = characterMaterials(character);
      if (!materials.length) return { error: { code: 'CREATIVE_REFERENCE_MISSING', detail: cast.id } };
      const frameNeed = frameNeeds(shot, frame, character);
      needs.push({ id: cast.id, needs: frameNeed.needs, evidence: frameNeed.evidence });
      // Necessity is decided per material from its declared coverage, or from this frame's must-keep text when
      // nothing is declared. materials[0] gets no special treatment: a position never decides necessity.
      for (const material of materials) {
        const entry = referenceEntry(material, frameNeed.needs);
        (entry.necessity === 'required' ? required : optional).push(entry);
      }
    }
    if (!shot.characters.length) {
      // No registered character is in this frame. The people who ARE in frame (extraCast) have no material of
      // their own, so the previous shot's first frame carries style, materials and local lighting as an OPTIONAL
      // reference whose purpose is limited on purpose.
      if (!previousFrame) return { error: { code: 'CREATIVE_REFERENCE_FOR_ENVIRONMENT_FRAME_REQUIRED',
        detail: shot.id + '：图片适配器要求 1-3 张参考素材，而本镜没有已登记角色的素材、也没有可继承的前镜首帧；' +
          '请提供一张风格参考或调整分镜，不伪造、不上传素材' } };
      optional.push({ ...previousFrame, necessity: 'optional' });
    }
    prepared.set(kind, { required, optional, needs });
  }
  // Readability is probed once per file, on the very path string the adapter will submit.
  const problems = new Map();
  for (const kind of ['first', 'last']) for (const entry of [...prepared.get(kind).required, ...prepared.get(kind).optional]) {
    if (!probe || !entry.file || problems.has(entry.file)) continue;
    try { probe(entry.file); } catch (error) { problems.set(entry.file, error.message); }
  }
  const brokenRequired = [...prepared.get('first').required, ...prepared.get('last').required]
    .filter((entry, index, list) => problems.has(entry.file) && list.findIndex(item => item.file === entry.file) === index);
  if (brokenRequired.length) return { error: { code: 'CREATIVE_REFERENCE_UNREADABLE',
    detail: brokenRequired.map(entry => entry.file + '：' + problems.get(entry.file)).join('；') } };
  const brokenOptional = [];
  for (const kind of ['first', 'last']) prepared.get(kind).optional = prepared.get(kind).optional.filter(entry => {
    if (!problems.has(entry.file)) return true;
    if (brokenOptional.some(item => item.file === entry.file)) return false;
    brokenOptional.push({ ...entrySummary(entry), reason: '可选参考不可读取：' + problems.get(entry.file),
      note: '该素材未附到本帧请求；本帧相关外观只依据文字描述，不因此声称已参考' });
    return false;
  });
  const unconfirmed = [];
  for (const kind of ['first', 'last']) for (const entry of [...prepared.get(kind).required, ...prepared.get(kind).optional]) {
    if (entry.coverage !== 'unconfirmed' || unconfirmed.some(item => item.id === entry.id && item.source === entry.source)) continue;
    unconfirmed.push({ id: entry.id, source: entry.source, file: entry.file, basis: entry.purpose,
      note: '覆盖未知只按保守保留处理：既不说它可丢弃，也不说它已证明了任何必需项；如需按覆盖范围取舍，' +
        '请在清单 referenceCoverage 中声明该素材的已确认覆盖，或把它明确声明为 optional' });
  }
  const declares = kind => prepared.get(kind).required.filter(entry => entry.source !== 'ownFirstFrame')
    .map(entry => entry.id + ' ' + entry.role + '：' + (entry.coverage === 'confirmed'
      ? '已确认覆盖 ' + needLabels(entry.coveredNeeds) : '覆盖未经确认（保守保留）')).join('；');
  // A must-keep item that none of the material ACTUALLY attached to a frame is confirmed to cover is recorded as
  // uncovered: the frame still runs on its text, but nothing claims a reference proved it.
  const uncoveredFor = (kind, kept) => prepared.get(kind).needs.flatMap(item => item.needs
    .filter(need => !kept.some(entry => entry.id === item.id && (entry.coveredNeeds || []).includes(need)))
    .map(need => ({ frame: kind, id: item.id, need, label: REFERENCE_NEED_LABELS[need],
      note: '本帧已附素材里没有任何一张被确认覆盖该必需项：只依据帧文字描述执行，不声称已由参考图保证' })));
  const record = { limit: REFERENCE_LIMIT, limitBasis: REFERENCE_LIMIT_BASIS, selectionRule: REFERENCE_SELECTION_RULE,
    necessityRule: REFERENCE_NECESSITY_RULE,
    needs: { first: prepared.get('first').needs, last: prepared.get('last').needs },
    requiredFirst: prepared.get('first').required.map(entrySummary),
    requiredLast: prepared.get('last').required.map(entrySummary),
    unconfirmed, unreadable: brokenOptional, uncovered: [], first: null, last: null };
  const capacityError = (frameLabel, requiredEntries, extra) => ({ code: 'CREATIVE_REFERENCE_CAPACITY_EXCEEDED',
    detail: shot.id + ' ' + frameLabel + '必要参考 ' + requiredEntries.length + ' 张超过 ' + REFERENCE_LIMIT + ' 张（' +
      declares(frameLabel === '首帧' ? 'first' : 'last') + '）；' + extra +
      '不自动改变人物数量、剧情或用户指定装备，不拼图绕过，也不静默截断或省略必要参考；' +
      '请减少同帧入画人物、把已确认冗余的素材在清单 referenceCoverage 中声明为 optional、提供合并参考或调整分镜' });
  const fit = (kind, anchor) => {
    const { required, optional } = prepared.get(kind);
    const room = Math.max(0, REFERENCE_LIMIT - required.length - anchor.length);
    const kept = [...anchor, ...required, ...optional.slice(0, room)];
    return { needs: prepared.get(kind).needs, kept, dropped: optional.slice(room), uncovered: uncoveredFor(kind, kept) };
  };
  if (prepared.get('first').required.length > REFERENCE_LIMIT) return {
    error: capacityError('首帧', prepared.get('first').required, '本镜首帧本身就装不下，预检在本镜任何媒体提交之前停止；'),
    record: { ...record, uncovered: uncoveredFor('first', prepared.get('first').required),
      firstNeeded: prepared.get('first').required.map(entrySummary) } };
  const first = fit('first', []);
  const lastNeeded = [OWN_FIRST_FRAME, ...prepared.get('last').required];
  if (lastNeeded.length > REFERENCE_LIMIT) return { error: capacityError('尾帧', lastNeeded,
    '首帧本可容纳（' + first.kept.length + ' 张），但尾帧装不下，因此在本镜任何媒体提交之前停止；' +
    '尾帧的本镜首帧锚点只作结构参考，不作为身份、服饰或武器的覆盖证据，因此不能代替上述必要素材；'),
  record: { ...record, first: planFrameRecord(first), last: null,
    uncovered: [...uncoveredFor('first', first.kept), ...uncoveredFor('last', lastNeeded)],
    lastNeeded: lastNeeded.map(entry => ({ id: entry.id, source: entry.source, role: entry.role, purpose: entry.purpose,
      coverage: entry.coverage, coveredNeeds: entry.coveredNeeds })) } };
  const last = fit('last', [OWN_FIRST_FRAME]);
  return { first: first.kept, last: last.kept,
    record: { ...record, uncovered: [...first.uncovered, ...last.uncovered],
      first: planFrameRecord(first), last: planFrameRecord(last) } };
}



// The creative frame stage. It runs from the normal entry, on the same state machine and with the existing
// protections: same operations/round ledger, same recorded prompts, same frame check, same rework decision and
// the same pause behaviour. Only the CONTENT differs: the prompts come from the storyboard's per-frame data and
// the references are the user's own material.
async function creativeFramesStage(context, state, deps) {
  const { log, media, models, attempts, operation, save, config, production } = deps;
  const creative = state.creative, board = creative?.storyboard;
  if (!board) throw new Error('CREATIVE_FRAMES_REQUIRE_STORYBOARD');
  requireAcceptedAudio(state);
  // Media submission re-checks that the acceptance applies to THIS run: a simulated (fixture) acceptance may
  // only be used when the provider client is a test double, so a real media client can never consume it.
  if (state.creative.acceptance.method === 'fixture' && deps.injected !== true)
    throw new Error('CREATIVE_FIXTURE_ACCEPTANCE_IN_REAL_RUN: 模拟接受不能用于真实媒体客户端；请用真实试听后的 accept-creative-audio');
  state.creative.frames ||= {};
  state.creative.actions ||= {};
  // Every shot's reference plan — the 1-3 capacity check of BOTH frames included — is decided HERE, in shot
  // order, before the first media submission of the run. A last frame that cannot hold its required references
  // therefore stops the run with zero image and zero check requests, instead of being discovered only after the
  // first frame of that shot (or of an earlier shot) had already been requested and paid for. All blocked shots
  // are recorded together, so the user sees every problem in one pass.
  const shotOrder = board.shots.map(item => item.id);
  const plans = new Map(), blocked = [];
  for (const shot of board.shots) {
    const asset = state.assets[shot.id] ||= {};
    const previousId = shotOrder[shotOrder.indexOf(shot.id) - 1];
    const plan = planShotReferences(shot, { production, probe: file => media.image(file),
      previousFrame: previousId ? PREVIOUS_FIRST_FRAME : null });
    if (plan.error) {
      asset.referencePlan = plan.record ? { ...plan.record, decidedBeforeAnySubmission: true,
        at: new Date().toISOString() } : null;
      asset.referencePause = { stage: 'frames', code: plan.error.code, detail: plan.error.detail,
        ...(plan.error.code === 'CREATIVE_REFERENCE_MISSING' ? { missing: [plan.error.detail] } : {}),
        at: new Date().toISOString() };
      blocked.push(plan.error.code + '：' + plan.error.detail);
      continue;
    }
    asset.referencePlan = { ...plan.record, decidedBeforeAnySubmission: true, at: new Date().toISOString() };
    plans.set(shot.id, plan);
  }
  save();
  if (blocked.length) {
    log('参考预检未通过，未提交任何图片或检查请求：' + blocked.join('；'));
    return state;
  }
  for (const [index, shot] of board.shots.entries()) {
    const asset = state.assets[shot.id] ||= {};
    const plan = plans.get(shot.id);
    const previousId = shotOrder[index - 1];
    // The placeholders get their real files only now: the previous shot's frame is a real file by the time this
    // shot starts, while this shot's own first frame is resolved after it has been generated.
    const previousFirst = previousId ? state.creative.frames[previousId]?.first || null : null;
    const resolve = entries => entries.map(entry => entry.source === 'ownFirstFrame' ? { ...entry, file: asset.first }
      : entry.source === 'previousShotFirstFrame' ? { ...entry, file: previousFirst } : entry);
    const needsPreviousFrame = [...plan.first, ...plan.last].some(entry => entry.source === 'previousShotFirstFrame');
    if (needsPreviousFrame && !previousFirst) {
      asset.referencePause = { stage: 'frames', code: 'CREATIVE_REFERENCE_FOR_ENVIRONMENT_FRAME_REQUIRED',
        detail: shot.id + '：本镜没有已登记角色的素材，预检时以占位表示的前镜首帧（画风与材质参考）无法回填；' +
          '图片适配器要求 1-3 张参考素材，请提供一张风格参考或调整分镜，不伪造、不上传素材',
        at: new Date().toISOString() };
      save();
      log('前镜画风参考无法回填，停止在 ' + shot.id + '，未提交任何图片或检查请求');
      return state;
    }
    const keptRoles = resolve(plan.first);
    state.creative.actions[shot.id] = actionRequest(shot);
    const styleFirst = (production.style || '') + '。生成横屏16:9分镜首帧（本镜的起始静止状态）。';
    const styleLast = (production.style || '') + '。生成横屏16:9分镜尾帧（本镜的结束静止状态，不是首帧，不要重画起始状态）。';
    const firstId = operation('first-' + shot.id);
    // Reuse is only allowed for the SAME request. The wording this shot would send now is compared with the
    // wording the operation already carries: a re-planned storyboard, a changed reference list or a changed rule
    // set therefore stops the run explicitly instead of silently keeping the frames made from the old wording (and
    // instead of quietly re-generating them).
    const firstAssembled = frameRequest(shot, { characters: creative.characters,
      scenes: creative.scenes, kind: 'first', style: styleFirst, aspect: '16:9', references: keptRoles });
    const storedFirst = recordedPrompt(context.directory, firstId, null);
    if (storedFirst && storedFirst !== firstAssembled) throw new Error('CREATIVE_FRAME_INPUT_CHANGED:' + firstId +
      ':该操作已有记录，但当前分镜/参考/规则组装出的首帧提示词与记录不同；不换号、不重绑、不静默沿用旧帧，也不自动重生成；请用受控修订（新修订号）或先恢复原分镜');
    const firstPrompt = storedFirst || firstAssembled;
    const raw = await models.image(firstId, firstPrompt, keptRoles.map(entry => entry.file),
      path.join(context.directory, 'frames', firstId + '.png'));
    asset.first = media.prepareImage(raw, path.join(context.directory, 'frames', operation('first-ready-' + shot.id) + '.png'));
    // The last frame's plan was fixed before this submission; only the anchor's real file is filled in here.
    const lastRoles = resolve(plan.last);
    const lastId = operation('last-' + shot.id);
    // The capacity of this combination was already decided by the preflight above; the anchor entry only receives
    // the real first-frame file here, so no decision is taken after the first frame was submitted.
    const lastAssembled = frameRequest(shot, { characters: creative.characters,
      scenes: creative.scenes, kind: 'last', style: styleLast, aspect: '16:9', references: lastRoles });
    const storedLast = recordedPrompt(context.directory, lastId, null);
    if (storedLast && storedLast !== lastAssembled) throw new Error('CREATIVE_FRAME_INPUT_CHANGED:' + lastId +
      ':该操作已有记录，但当前分镜/参考/规则组装出的尾帧提示词与记录不同；不换号、不重绑、不静默沿用旧帧，也不自动重生成；请用受控修订（新修订号）或先恢复原分镜');
    const lastPrompt = storedLast || lastAssembled;
    const lastRaw = await models.image(lastId, lastPrompt, lastRoles.map(entry => entry.file),
      path.join(context.directory, 'frames', lastId + '.png'));
    asset.last = media.prepareImage(lastRaw, path.join(context.directory, 'frames', operation('last-ready-' + shot.id) + '.png'));
    const frameCheckId = operation('frame-check-' + shot.id);
    const frameImages = [...keptRoles.slice(0, 2).map(entry => entry.file), asset.first, asset.last];
    const frameLabels = [...keptRoles.slice(0, 2).map((entry, index) => ({ label: entry.role + '（图' + (index + 1) + '）' })),
      { label: '目标首帧' }, { label: '目标尾帧' }];
    // Prompts, references and the storyboard all take part in the binding: change any of them and the old
    // frame review can no longer be reused.
    const binding = reviewBinding({ shotId: shot.id, revision: state.revisions?.['first-' + shot.id] || 0,
      audio: board.audioBinding, first: fileHash(asset.first), last: fileHash(asset.last),
      references: keptRoles.map(entry => ({ role: entry.role, purpose: entry.purpose, hash: fileHash(entry.file) })),
      lastReferences: lastRoles.map(entry => ({ role: entry.role, purpose: entry.purpose, hash: fileHash(entry.file) })),
      prompts: hash([firstPrompt, lastPrompt]),
      promptVersion: config.planner?.promptVersion });
    let review = reviewIsReusable(asset.frameReview, binding) ? asset.frameReview : null;
    if (!review) {
      const stored = readStoredReview(context.directory, frameCheckId, { imageCount: frameImages.length, binding });
      if (stored) review = { ...stored.report, reusedFrom: frameCheckId, provenance: stored.provenance,
        coverageGap: coverageGap(stored.spec, frameLabels) };
      else {
        const prompt = recordedPrompt(context.directory, frameCheckId, '检查这是同一部片子的首尾帧与参考素材，' +
          '核验人物身份、已确认服饰、指定武器与配饰、手部、画风，以及本帧是否按文字描述执行（本帧不出现的人物与画外内容不得被画进来）。' +
          framesCheckPrompt({ shot: { ...shot, scene: shot.scene.id, action: state.creative.actions[shot.id] },
            images: frameLabels, contract: '', docFirst: false }));
        const record = operationRecord(context.directory, frameCheckId);
        if (record && checkInputChanged(record, { prompt, images: frameImages.map(fileHash) }))
          throw new Error('FRAME_CHECK_INPUT_CHANGED:' + frameCheckId +
            ':该帧检查已有记录但当前输入不同；不换号、不重绑，需人工核实或用受控修订显式升级');
        const answer = await models.json(frameCheckId, prompt, frameImages, { digest: binding.digest, rules: QUALITY_RULES_VERSION });
        review = normalizeReview(answer, { duration: shot.filmSeconds, imageCount: frameImages.length });
        noteDegradation(state, frameCheckId, review);
      }
    }
    asset.frameReview = { ...review, revision: state.revisions?.['first-' + shot.id] || 0, binding,
      producedBy: { model: config.models.vision, kind: 'vision', operation: frameCheckId, role: '辅助视觉检查；其结果交规划模型作制作判断' } };
    const frameDecision = reworkDecision(review, { hasLastFrame: true });
    if (frameDecision.action === 'accept') {
      if (frameDecision.observations?.length) {
        (state.qualityObservations ||= []).push({ operation: frameCheckId, reason: frameDecision.reason,
          issues: frameDecision.observations, at: new Date().toISOString() });
      }
    } else {
      const summary = review.issues.map(issue => issue.observed).concat(review.uncovered).join('；') || '分镜画面待检查';
      if (frameDecision.action === 'repair')
        for (const unit of ['first-' + shot.id, 'last-' + shot.id]) await attempts.markExhausted(unit, summary);
      else {
        asset.qualityPause = { stage: 'frames', code: frameDecision.code, reason: frameDecision.reason, review, at: new Date().toISOString() };
        (state.qualityPauses ||= []).push({ shotId: shot.id, stage: 'frames', code: frameDecision.code,
          reason: frameDecision.reason, scope: frameDecision.fixScope, at: asset.qualityPause.at });
      }
      await reviewWithAdvice(context, state, models, 'frames-' + shot.id, hash([fileHash(asset.first), fileHash(asset.last)]), summary,
        { model: config.models.vision, kind: 'vision', operation: frameCheckId, role: '辅助视觉检查' });
    }
    // The three running times stay separate, and the video stage is not wired yet, so nothing is submitted here.
    // The recorded reference list carries the SAME plan the request was built from, including the basis of each
    // material's necessity: the record can be compared with the request instead of being a separate story.
    state.creative.frames[shot.id] = { first: asset.first, last: asset.last, firstPrompt, lastPrompt,
      actionPrompt: state.creative.actions[shot.id],
      references: keptRoles.map(entry => ({ id: entry.id, role: entry.role, purpose: entry.purpose,
        necessity: entry.necessity, coverage: entry.coverage, coveredNeeds: entry.coveredNeeds, hash: fileHash(entry.file) })),
      lastReferences: lastRoles.map(entry => ({ id: entry.id, role: entry.role, purpose: entry.purpose,
        necessity: entry.necessity, coverage: entry.coverage, coveredNeeds: entry.coveredNeeds, hash: fileHash(entry.file) })),
      referencePlan: asset.referencePlan,
      droppedReferences: [...plan.record.unreadable, ...plan.record.first.omitted, ...plan.record.last.omitted],
      supplierSeconds: shot.vendor.modelSeconds, filmSeconds: shot.filmSeconds, coverage: shot.vendor.coverage,
      drivingAudio: shot.drivingLine ? shot.segments.find(fragment => fragment.lineId === shot.drivingLine) : null,
      review: frameDecision.action, at: new Date().toISOString() };
    save();
  }
  state.stage = 'frames';
  save();
  return state;
}
// ---------------------------------------------------------------- the fine creative chain: video
// The adapter branch of one plan. It is DERIVED from the plan, so the model the plan names and the model the
// adapter picks cannot disagree: a driving-audio plan is the i2v request (first frame, optional last frame,
// driving audio), a keyframe plan is the five-second request with both anchors.
function videoShotType(plan) { return plan.branch === 'driving-audio' ? 'dialogue' : 'action'; }
// The request identity of a plan. It is stored with the operation and reused VERBATIM on a resume, so a paid
// request is never rebuilt from a newer plan; a plan whose digest changed stops the run instead.
function planVideoShot(plan) {
  return { type: videoShotType(plan), duration: plan.model.requestSeconds, videoPrompt: plan.prompt.text,
    videoPlan: { version: plan.version, shotId: plan.shotId, branch: plan.branch, digest: plan.digest,
      model: plan.model.id, requestSeconds: plan.model.requestSeconds,
      usage: [plan.duration.usageStart, plan.duration.usageEnd],
      keyframes: [plan.keyframes.first.hash, plan.keyframes.last.hash],
      driving: plan.drivingAudio ? { lineId: plan.drivingAudio.lineId, sourceHash: plan.drivingAudio.sourceHash,
        padToSeconds: plan.drivingAudio.padToSeconds } : null } };
}
// The driving audio of ONE shot: the same source range the film's audio bed plays, copied (never retimed and
// never re-voiced) and placed at the position it is heard at, padded to the provider's input floor with
// silence. The file is the actual input of the lip-sync request, so it is measured and recorded next to the
// plan instead of being claimed.
function buildDrivingAudio(context, media, operation, shot, plan) {
  const driving = plan.drivingAudio;
  media.audio(driving.sourceFile);
  if (fileHash(driving.sourceFile) !== driving.sourceHash)
    throw new Error('CREATIVE_VIDEO_PLAN_AUDIO_CHANGED:' + shot.id +
      '：已接受的配音与视频计划记录的摘要不同；不按旧计划生成口型，请恢复原配音或重新接受后再生成');
  const id = operation('driving-' + shot.id);
  const file = media.drivingAudio(driving.sourceFile, path.join(context.directory, 'audio', id + '.wav'),
    { pieces: driving.pieces, minimumSeconds: driving.minimumSeconds });
  const seconds = media.audio(file).duration;
  if (!Number.isFinite(seconds) || Math.abs(seconds - driving.padToSeconds) > 0.05)
    throw new Error('CREATIVE_VIDEO_PLAN_AUDIO_MISMATCH:' + shot.id + '：拼接出的驱动音频 ' + seconds +
      ' 秒与计划声明的 ' + driving.padToSeconds + ' 秒不一致；不把不一致的输入送进口型请求');
  return { lineId: driving.lineId, file, hash: fileHash(file), seconds, sourceFile: driving.sourceFile,
    sourceHash: driving.sourceHash, pieces: driving.pieces, measuredBy: 'ffprobe@build',
    note: '本地按镜头内偏移拼接源音频的同一区间（复制，不重采样），不足供应商下限用静音补齐；本文件即口型请求的实际输入' };
}

// The video stage of the fine creative chain. Every shot's request comes from ONE decision taken before the
// first video submission of the run (branch, adapter model, requested seconds, complete action prompt, both
// anchor frames, the film window and the position of the driving audio). The record and the request are built
// from that same object, so a claim and a request cannot drift apart, and a resumed run either reuses the
// recorded request verbatim or stops when the plan changed.
async function creativeVideoStage(context, state, deps) {
  const { log, media, models, operation, save, config } = deps;
  const creative = state.creative, board = creative?.storyboard;
  if (!board) throw new Error('CREATIVE_VIDEO_REQUIRE_STORYBOARD');
  requireAcceptedAudio(state);
  // Same gate as the frame stage: a simulated (fixture) acceptance may only be consumed while the provider
  // client is a test double, so a real media client can never consume it.
  if (creative.acceptance.method === 'fixture' && deps.injected !== true)
    throw new Error('CREATIVE_FIXTURE_ACCEPTANCE_IN_REAL_RUN: 模拟接受不能用于真实媒体客户端；请用真实试听后的 accept-creative-audio');
  creative.videos ||= {};
  // 1) Every shot's plan — including the local driving audio it needs — is decided HERE, before the first video
  // submission: a shot that cannot be executed (missing frames, a film slot longer than the supplier request, a
  // lip-sync slot compressed by a declared speed change, an accepted audio that cannot be sliced) stops the run
  // with zero video requests and zero checks instead of being discovered after earlier shots were paid for. All
  // blocked shots are reported together, and a plan whose digest no longer matches the recorded request stops
  // the run as well: the identity of a paid request is never silently rebuilt.
  const plans = new Map(), blocked = [];
  for (const shot of board.shots) {
    const asset = state.assets[shot.id] ||= {};
    try {
      const audio = shot.drivingLine ? creative.audio?.[shot.drivingLine] || null : null;
      const plan = videoExecutionPlan(shot, { timeline: creative.timeline,
        frames: { first: asset.first, last: asset.last }, audio, models: config.models });
      const videoId = operation('video-' + shot.id);
      const recorded = recordedInput(context.directory, videoId, 'shot', null);
      if (recorded && (recorded.videoPlan?.digest !== plan.digest || recorded.type !== videoShotType(plan)))
        throw new Error('CREATIVE_VIDEO_PLAN_CHANGED:' + videoId +
          '：该操作已有记录，但当前分镜/时间线/已接受配音/模型配置算出的视频计划与记录不同；不换号、不重绑、不静默沿用旧视频，也不自动重生成；请用受控修订或先恢复原输入');
      delete asset.videoPause;
      asset.videoPlan = plan;
      asset.videoDriving = plan.drivingAudio ? buildDrivingAudio(context, media, operation, shot, plan) : null;
      plans.set(shot.id, { plan, videoId });
    } catch (error) {
      asset.videoPause = { stage: 'video', code: error.code || 'CREATIVE_VIDEO_PLAN_FAILED', detail: error.message,
        ...(error.detail ? { planDetail: error.detail } : {}), at: new Date().toISOString() };
      blocked.push(error.message);
    }
  }
  save();
  if (blocked.length) {
    log('视频预检未通过，未提交任何视频请求：' + blocked.join('；'));
    return state;
  }
  for (const shot of board.shots) {
    const asset = state.assets[shot.id], { plan, videoId } = plans.get(shot.id), driving = asset.videoDriving;
    // The recorded request identity is reused verbatim; a first run builds it once from the plan above.
    const videoShot = recordedInput(context.directory, videoId, 'shot', null) || planVideoShot(plan);
    const destination = path.join(context.directory, 'video', videoId + '.mp4');
    asset.video = await models.video(videoId, videoShot, plan.keyframes.first.file, plan.keyframes.last.file,
      driving ? driving.file : null, destination);
    // Two different questions, kept apart. (1) Is this file usable as the PICTURE of its slot? It must be decodable
    // and at least as long as the window the film takes from it — always checked here. (2) Does the mouth match the
    // voice? That one belongs to the user's playback, never to a local rule. A lip-sync take's OWN audio track is
    // part of the second question, as an observation only: this project has no evidence that the 口型驱动 branch
    // must return one (docs/TODO.md keeps that unverified), so its absence is recorded instead of being treated as
    // an invalid take, and the film's dialogue always comes from the accepted audio bed.
    asset.videoInfo = media.video(asset.video, plan.duration.usageEnd);
    const supplierTrack = asset.videoInfo.audio ? 'present' : 'absent';
    asset.lipSyncObserved = plan.branch === 'driving-audio'
      ? { branch: plan.branch, lineId: plan.lipSync.lineId, supplierTrack, policy: 'observation-only',
        basis: '本项目没有任何供应商证据说明口型驱动分支必须返回自带音轨（未核实项）：本地不据此判定素材无效',
        effect: supplierTrack === 'present' ? '成片对白仍只来自已接受音频床，这条自带音轨不参与混音'
          : '该素材没有音轨：成片对白仍来自已接受音频床，口型是否对上仍需用户播放验收',
        notProven: ['口型与声音是否对上不能由本地校验或抽帧证明，只能由用户播放验收'], at: new Date().toISOString() }
      : { branch: plan.branch, supplierTrack, policy: 'not-applicable',
        basis: '本镜没有口型驱动，画面人物保持闭口；素材自带音轨不参与成片混音', at: new Date().toISOString() };
    await recordVideoCheck(context, state, deps, shot, asset, plan, videoId, driving);
  }
  state.stage = 'video';
  save();
  return state;
}

// The video quality check of one shot, with the same evidence rules as the legacy video stage: a declared time
// plan, both anchor frames plus three sampled frames, a binding that ties the verdict to the plan, the take and
// the sampling, and the existing rework decision. Only the window the film actually uses is checked, and the
// discarded tail is stated instead of being presented as checked.
async function recordVideoCheck(context, state, deps, shot, asset, plan, videoId, driving) {
  const { log, media, models, attempts, operation, save, config } = deps;
  const sampling = samplingPlan(plan.duration.usageSeconds);
  const timestamp = operation(shot.id);
  const sampled = media.sampleFramesAt(asset.video, path.join(context.directory, 'video-check', timestamp), sampling.times);
  const labels = [{ label: '目标首帧' }, ...sampling.times.map(at => ({ label: '视频' + at + '秒抽帧' })), { label: '目标尾帧' }];
  const targets = [plan.keyframes.first.file, ...sampled.map(entry => entry.file), plan.keyframes.last.file];
  const coverageNote = '本镜成片只用前 ' + plan.duration.usageSeconds + ' 秒（供应商生成 ' + plan.model.requestSeconds +
    ' 秒，末尾 ' + plan.duration.tailDiscardedSeconds + ' 秒不进入成片、也不检查）；' +
    (plan.lipSync.required ? '本镜由 ' + plan.lipSync.lineId + ' 驱动口型，抽帧不能证明口型是否与声音对上；'
      : '本镜没有口型驱动，画中人物必须保持闭口；') +
    (plan.lipSync.required && asset.lipSyncObserved?.supplierTrack === 'absent'
      ? '取回素材没有自带音轨：这只作为观察记录，不据此判定口型素材无效（无供应商契约证据）；' : '') +
    (plan.uncoveredAudio.spans.length ? '本镜还有不驱动口型的音频：' + plan.uncoveredAudio.spans.map(span => span.lineId).join('、') + '；' : '');
  const target = { id: shot.id, scene: shot.scene.id, purpose: shot.purpose, action: plan.prompt.text,
    startState: shot.startState, endState: shot.endState, transition: shot.transition, camera: shot.camera,
    filmSeconds: plan.duration.filmSeconds, requestSeconds: plan.model.requestSeconds, usageSeconds: plan.duration.usageSeconds };
  const checkId = operation('video-check-' + shot.id);
  // The context in which the verdict was produced, not just which pictures were sent: a new plan or a different
  // film window makes an old verdict stale instead of silently reusable.
  const binding = reviewBinding({ shotId: shot.id, revision: state.revisions?.['video-' + shot.id] || 0,
    first: plan.keyframes.first.hash, last: plan.keyframes.last.hash, video: fileHash(asset.video),
    contract: hash({ plan: plan.digest, coverageNote }), promptVersion: config.planner?.promptVersion, sampling });
  let review = reviewIsReusable(asset.videoReview, binding) ? asset.videoReview : null;
  if (!review) {
    const stored = readStoredReview(context.directory, checkId, { duration: plan.duration.usageSeconds,
      imageCount: targets.length, sampledTimes: sampling.times, actualFrameIndexes: [2, 3, 4], binding });
    if (stored) review = { ...stored.report, reusedFrom: checkId, provenance: stored.provenance, coverageGap: coverageGap(stored.spec, labels) };
    else {
      const prompt = recordedPrompt(context.directory, checkId, videoCheckPrompt({ shot: target, images: labels,
        duration: plan.duration.usageSeconds, contract: coverageNote, docFirst: false }));
      const record = operationRecord(context.directory, checkId);
      if (record && checkInputChanged(record, { prompt, images: targets.map(fileHash) }))
        throw new Error('CREATIVE_VIDEO_CHECK_INPUT_CHANGED:' + checkId + ':该视频检查已有记录但当前输入不同（已有覆盖 ' +
          JSON.stringify(checkCoverage(record)) + '）；不换号、不重绑，需人工核实或用受控修订显式升级');
      const answer = await models.json(checkId, prompt, targets, { digest: binding.digest, rules: QUALITY_RULES_VERSION });
      review = normalizeReview(answer, { duration: plan.duration.usageSeconds, imageCount: targets.length,
        sampledTimes: sampling.times, actualFrameIndexes: [2, 3, 4] });
      noteDegradation(state, checkId, review);
    }
  }
  asset.videoReview = { ...review, revision: state.revisions?.['video-' + shot.id] || 0, binding,
    evidence: { plan: plan.digest, sampling: sampling.times, imageCount: targets.length, order: labels.map(label => label.label),
      coverage: sampling.coverage, checkedSeconds: plan.duration.usageSeconds, tailDiscardedSeconds: plan.duration.tailDiscardedSeconds,
      supplierTrack: asset.lipSyncObserved?.supplierTrack || null },
    producedBy: { model: config.models.vision, kind: 'vision', operation: checkId, role: '辅助视觉检查；其结果交规划模型作制作判断' } };
  const decision = reworkDecision(review, { hasLastFrame: true });
  if (decision.action === 'accept') {
    if (decision.observations?.length)
      (state.qualityObservations ||= []).push({ operation: checkId, reason: decision.reason, issues: decision.observations, at: new Date().toISOString() });
  } else {
    const summary = review.issues.map(issue => issue.observed).concat(review.uncovered).join('；') || '视频质量待检查';
    // Only an evidence-backed problem in the video itself spends a video round; a problem in the target frames or
    // in the wording pauses here with its recorded scope and minimal fix, exactly like the legacy video stage.
    if (decision.action === 'repair' && decision.unit === 'video') await attempts.markExhausted('video-' + shot.id, summary);
    else {
      asset.qualityPause = { stage: 'video', code: decision.code, reason: decision.reason, review, scope: decision.fixScope,
        fix: decision.action === 'repair' ? repairInstruction(review) : null, at: new Date().toISOString() };
      (state.qualityPauses ||= []).push({ shotId: shot.id, stage: 'video', code: decision.code, reason: decision.reason,
        scope: decision.fixScope, at: asset.qualityPause.at });
    }
    // A rejected or unclear video never passes silently: the existing controlled path stops the run for the user
    // (review.html + approve), and no completion record is written for this shot.
    await reviewWithAdvice(context, state, models, 'video-' + shot.id, fileHash(asset.video), summary,
      { model: config.models.vision, kind: 'vision', operation: checkId, role: '辅助视觉检查' });
  }
  state.creative.videos[shot.id] = { plan, digest: plan.digest, operation: videoId,
    file: asset.video, hash: fileHash(asset.video), info: asset.videoInfo, lipSyncObserved: asset.lipSyncObserved || null,
    request: { operation: videoId, endpoint: plan.branch === 'driving-audio'
        ? '/api/v1/services/aigc/video-generation/video-synthesis'
        : '/api/v1/services/aigc/image2video/video-synthesis',
      model: plan.model.id, role: plan.model.role, type: videoShotType(plan), prompt: plan.prompt.text,
      promptBasis: plan.prompt.basis, requestSeconds: plan.model.requestSeconds, resolution: config.resolution,
      media: plan.branch === 'driving-audio' ? ['first_frame', 'last_frame', 'driving_audio'] : ['first_frame_url', 'last_frame_url'],
      keyframes: [plan.keyframes.first.hash, plan.keyframes.last.hash],
      drivingAudio: driving ? { lineId: driving.lineId, file: driving.file, hash: driving.hash, seconds: driving.seconds } : null,
      basis: '请求直接由视频计划生成（模型/秒数/提示词/锚点/驱动音频同源），原始请求体与结论见 operations/' + videoId + '.json' },
    usage: { start: plan.duration.usageStart, end: plan.duration.usageEnd, seconds: plan.duration.usageSeconds,
      supplierSeconds: plan.duration.supplierSeconds, tailDiscardedSeconds: plan.duration.tailDiscardedSeconds, basis: plan.duration.basis },
    lipSync: plan.lipSync, uncoveredAudio: plan.uncoveredAudio, drivingAudio: driving,
    check: { operation: checkId, verdict: review.verdict, pass: review.pass, review: decision.action,
      sampledTimes: sampling.times, imageCount: targets.length, coverage: sampling.coverage,
      ...(review.reusedFrom ? { reusedFrom: review.reusedFrom } : {}),
      note: '抽帧只覆盖上面的时刻；口型与声音是否真的对上只能由人验收' },
    at: new Date().toISOString() };
  save();
  log('镜头视频已生成并通过既有检查：' + shot.id + '（' + plan.branch + '，成片用 ' + plan.duration.usageSeconds + ' 秒）');
}

module.exports = { checkBooleanReport, noteDegradation, normalizeTraits, loadContext, loadState, saveState, runProduction,
  planRevision, providerClient, productionHashOf, speechReadiness, approve, doctor, reportHtml, STAGES,
  planShotReferences, characterMaterials, REFERENCE_COVERAGE_MAP, REFERENCE_LIMIT };
