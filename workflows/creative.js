const fs = require('fs');
const { hash, fileHash, writeJson } = require('../services/aliyun/io');
const { timelineSubtitles, FINAL_PROFILE } = require('../services/aliyun/media');
const { QUALITY_RULES_VERSION } = require('../services/aliyun/quality');
const { characterBible, creativeDigests, directorScript, durationLedger, frameRequest, actionRequest, invalidations, requirementBrief,
  sceneBible, scriptFromStoryboard, storyboard, storyboardTimeline, videoExecutionPlan, voicePlan } = require('../services/aliyun/creative');

// The planner model authors every word here; this module assembles the requests, validates the structure,
// enforces the order (requirements → director script → bibles → voice plan → accepted audio → storyboard)
// and keeps each artefact versioned. No request is sent for a stage whose prerequisites are missing.
const NO_AUTHORITY = '你没有修改状态、批准、计费或重试的权限：只输出JSON内容，不得声称已批准或已修复，不得输出金额。';

function requirementsPrompt(production, brief) {
  return '你是本片的需求整理模型。把用户要求整理成可执行的约束包，不新增用户没有要求的事件。' + NO_AUTHORITY +
    '区分四类信息：必须保留项（台词/人物/事件/动作/结局，逐条给稳定id）、可扩展项（说明服务于哪一项：人物动机/事件因果/情绪递进/可信空间与生活状态/动作与转场铺垫）、' +
    '未知信息、明确冲突（给可执行选项，不得静默解决）。台词属必须保留项时原文逐字照抄。' +
    '仅输出JSON：{"mustKeep":[{"id":"mk1","kind":"line或character或event或action或ending","text":"原文或要点","source":"user或reference或verified或creative或fixture","refs":[],"analyzedRefs":[],"verifiedBy":null或{"kind":"manifest-declaration或user-confirmation或local-measurement","ref":"清单里真实存在的字段路径","detail":"核实方式"},"note":null}],' +
    '"style":"画风与影像风格","aspect":"16:9","targetSeconds":数值,"maxSeconds":数值,"prohibitions":[],' +
    '"expandable":[{"area":"可扩展的环境/道具/表演/过渡/群演","serves":"服务于哪一项"}],"unknowns":[],' +
    '"conflicts":[{"issue":"冲突描述","options":["可执行选项"],"status":"open或resolved","basis":{"kind":"measured或user-decision或hard-limit或estimate或unknown","detail":"依据"},"resolution":null}]}。' +
    '来源规则：user=用户明确指定；reference=来自具体参考素材（refs 列出素材，analyzedRefs 只列真正看过的，没看过就不要写）；' +
    'verified=有本地可核对的依据（verifiedBy 必填，ref 写清单里真实存在的字段路径，不得自行宣称已核实）；creative=为叙事与画面提出的创作补充；fixture=离线夹具，不代表用户素材或真实事实。' +
    '时长规则：没有实测音频时只能给估计，估计要写依据与不确定性；不得凭字数或固定五秒判定台词必然冲突，也不得据此删词、改词或加速；basis.kind 为 estimate 或 unknown 的冲突必须保持 status=open。' +
    '用户故事与已知信息：' + JSON.stringify({ description: production.description, style: production.style,
      targetDurationSeconds: production.targetDurationSeconds, maxDurationSeconds: production.maxDurationSeconds,
      narrator: production.narrator || null, requiredQuotes: production.requiredQuotes || [], ending: production.ending || null,
      characters: production.characters.map(c => ({ id: c.id, name: c.name, speaks: c.speaks !== false })), brief: brief || null });
}
function directorPrompt(production, requirements, brief) {
  return '你是本片的导演与分镜编剧。按需求约束包写出完整导演脚本：每个叙事段落都要写清叙事目标、人物进入状态与动机、起因-行动-反应-结果、' +
    '可表演的表演过程（语气、停顿、呼吸、视线、表情、身体姿态，禁止只写“悲壮”“坚定”这类标签）、空间关系与关键道具、台词/旁白/内心独白/环境声/无声留白、' +
    '整体镜头意图、结束状态与下一段承接、创作补充与未知项。所有必须保留项都要落到段落或台词里（用covers列出id）。不要固定镜头数量，也不要把整场动作塞进一个镜头。' + NO_AUTHORITY +
    '仅输出JSON：{"title":"片名","theme":"主题与因果","segments":[{"id":"seg01","purpose":"叙事目标","covers":["mk1"],"characters":["角色id"],' +
    '"entry":{"state":"进入状态","motivation":"动机"},"beats":{"cause":"起因","action":"行动","reaction":"反应","result":"结果"},' +
    '"performance":{"tone":"语气","pauses":["停顿"],"breath":"呼吸","gaze":"视线","expression":"表情","posture":"身体姿态"},' +
    '"space":"空间关系","props":["关键道具"],"spoken":[{"id":"ln01","speaker":"角色id","kind":"dialogue或narration或inner","text":"原文","covers":["mk1"]}],' +
    '"ambience":["环境声"],"silence":["无声留白"],"shotIntent":"镜头意图","endState":"结束状态","nextHandoff":"下一段承接","creative":["创作补充"],"unknown":["未知项"]}]}。' +
    '数据：' + JSON.stringify({ description: production.description, style: production.style, requirements, brief: brief || null,
      characters: production.characters.map(c => ({ id: c.id, name: c.name, speaks: c.speaks !== false })),
      targetDurationSeconds: production.targetDurationSeconds, maxDurationSeconds: production.maxDurationSeconds,
      userApprovedScript: production.approvedScript || null });
}function characterBiblePrompt(production, registered) {
  return '你是本片的美术设定模型。为每个已登记角色建立人物设定集：只写参考图中可确认的内容，看不清或被遮挡的部分放进unknown，不得编造。' + NO_AUTHORITY +
    '仅输出JSON：{"entries":[{"id":"角色id","name":"角色名","version":1,"refs":["参考图路径"],' +
    '"confirmed":{"face":"容貌","hair":"发型","costume":"服装","accessories":"配饰","weapon":"武器","palette":"可见颜色","materials":"材质与结构"},' +
    '"weaponSide":"武器佩戴/持握位置与左右手关系","unknown":["看不清或被遮挡的部分"],' +
    '"source":"user或reference或verified或creative或fixture","status":"provided或analyzed或unverified或creative",' +
    '"analyzedRefs":["真正看过的素材"],"verifiedBy":null或{"kind":"manifest-declaration或user-confirmation或local-measurement","ref":"清单里真实存在的字段路径或本地文件","detail":"核实方式"}}]}。' +
    '来源与确认状态是两件事：user=用户明确提供；reference=来自具体参考素材（refs 必填；只有真看过图片才写 status=analyzed 并在 analyzedRefs 里列出看过的素材，否则写 unverified）；' +
    'verified=有本地可核对的依据（verifiedBy 必填，ref 必须是清单里真实存在的字段路径，不得自行宣称已核实）；creative=为画面提出的创作补充；fixture=离线夹具，不代表用户素材或真实事实，不得当作真实任务的默认外观。' +
    '数据：' + JSON.stringify({ style: production.style, characters: production.characters.map(c => ({ id: c.id, name: c.name,
      image: c.image, front: c.frontImage || null, traits: registered[c.id]?.traits || c.traits || '' })) });
}
function sceneBiblePrompt(production, requirements, director) {
  return '你是本片的美术与场景设定模型。为导演脚本中出现的每个场景建立独立场景设定：空间尺度与方位、入口与道路、建筑结构与材料、使用状态（磨损/修补/潮湿）、陈设与通行空间、' +
    '光源位置方向冷暖与覆盖、天气风向、人员分布与活动路线、场景边界与远处地形天空、固定内容与允许变化的内容。不要泛化词，也不要为显得细致随意编数。' + NO_AUTHORITY +
    '仅输出JSON：{"entries":[{"id":"场景id","name":"场景名","version":1,"refs":["该场景的参考素材（如有）"],' +
    '"source":"user或reference或verified或creative或fixture","status":"provided或analyzed或unverified或creative",' +
    '"analyzedRefs":[],"verifiedBy":null或{"kind":"user-confirmation或local-measurement或manifest-declaration","ref":"必须保留项id或本地文件","detail":"核实方式"},' +
    '"scale":"空间尺度关系",' +
    '"directions":{"north":"方位基准","entrance":"入口","roads":["主路/支路"]},"structures":[],"materials":[],"wear":[],"props":[],' +
    '"light":{"position":"","direction":"","warmth":"","coverage":""},"weather":"","wind":"","people":[],"boundary":[],"fixed":[],"variable":[]}]}。' +
    '来源与确认状态是两件事：用户口述或用户素材写明的内容才写 user/reference；只有真看过参考图才写 status=analyzed 并在 analyzedRefs 里列出看过的素材；' +
    '为画面补的细节写 source=creative（status=creative），不要写成用户指定或历史事实；离线夹具写 fixture，不得当作真实任务默认值。' +
    '数据：' + JSON.stringify({ style: production.style, requirements: requirements ? { prohibitions: requirements.prohibitions, expandable: requirements.expandable } : null,
      segments: director.segments.map(segment => ({ id: segment.id, space: segment.space, props: segment.props, shotIntent: segment.shotIntent })) });
}
function voicePlanPrompt(production, director) {
  return '你是本片的配音导演。为导演脚本中的每一句朗读文本安排表演：语气、停顿、呼吸、无声留白，并单独列出“不要朗读”的表演说明。文本逐字照抄，不得改写、不得新增对白。' + NO_AUTHORITY +
    '仅输出JSON：{"lines":[{"id":"与导演脚本一致的line id","speaker":"角色id","kind":"dialogue或narration或inner","text":"原文逐字",' +
    '"performance":{"tone":"","pauses":[""],"breath":"","silence":[""]},"notSpoken":["不要朗读的表演说明"],' +
    '"durationEstimate":{"method":"character-rate或reading-aloud-rate或model-reading","seconds":数值,"uncertaintySeconds":数值,"rate":每秒字数,"characters":字数,"basis":"估计依据"}或null}]}。' +
    'durationEstimate 是估计：必须写清方法与不确定性，绝不能被当成实测时长；没有实测音频时不得凭字数或固定五秒断言台词超时，也不得据此删词、改词或加速。' +
    '数据：' + JSON.stringify({ narrator: production.narrator || null,
      lines: director.segments.flatMap(segment => segment.spoken.map(line => ({ id: line.id, speaker: line.speaker, kind: line.kind, text: line.text,
        context: { purpose: segment.purpose, performance: segment.performance, silence: segment.silence } }))) });
}function storyboardPrompt(creative, { lines, durations, vendorSeconds }) {
  return '你是本片的分镜师。已经拿到用户接受的真实配音，请依据实测时长、句意、情绪、动作、留白与场景安排最终分镜。' + NO_AUTHORITY +
    '规则：①每一句被接受的音频必须被精确覆盖（sourceStart=0 起、sourceEnd=实测时长止，中间不重叠不留缝），可以一句跨多镜，也可以一镜包含多句或无声区间；' +
    '②成片时长必须等于所载音频时长之和，如需变速必须显式声明 speed 与 paceNote，禁止静默加速或截断；③供应商离散时长写在 vendor.modelSeconds，与成片时长不同时必须写明 coverage 与 note；' +
    '④每个入画人物都要单独描述（位置、朝向、姿态重心、手部与持物、视线表情、遮挡可见范围、服饰装备状态），群演也要分别交代位置与动作；⑤首帧和尾帧各自只写一个静止时刻，' +
    '禁止把整段动作塞进一帧；⑥连续切镜的起始状态必须等于上一镜的结束状态。' +
    // ⑦-⑩: the frame structure the validator enforces and the request assembler expands. The instruction, the
    // example below and the validator must stay in step: the text names each field the code requires.
    '⑦每一帧（first 与 last 各自独立）必须给出 visibleEnvironment：本帧可见的环境与空间层次，逐条具体写清可见建筑与陈设、' +
    '材料与使用痕迹、前中后景与遮挡关系、道路与通行空间、光线与天气、适用的远景。不得复制整个场景设定，也不得只写「案几与竹简」' +
    '一类空泛背景；本帧确实没有可见环境时，按画面类型给出与镜头内容一致的列表，不用空列表代替规划。' +
    '⑧extraCast 逐人列出本帧可辨认的其他人物（守卫、巡逻队员、杂役等）：每人必须有 id（非空、帧内唯一、跨首尾帧与跨镜稳定不变的' +
    '身份标识，label 只用于显示、group 只用于分组，都不能代替 id；排序变化不得改变身份），并给出 label、group、position、facing、' +
    'posture、hands、props、gaze、action、visible、costume（留空表示沿用共用服饰）。极远景只写可辨的分组、朝向与装备轮廓，' +
    '不编造不可辨的眉眼；允许有依据的入画与出画，不要求每个镜头都是同一批人。' +
    '⑨crowdCostume 写共用群演服饰（各人可引用；最终请求会把它在每个人身上逐一展开，个体差异写在各人的 costume 里）；' +
    'creativeAdditions 写本片新增、参考图中没有的物件（例如剧情新增的竹简）。' +
    '⑩offscreen 写画外影响（不在画内、只影响光照或声音的内容，并明确它不在画内）；人物外观只能来自适用参考与设定集，' +
    '不得把测试或夹具设定当作真实资料。' +
    '⑪首帧与尾帧的人物状态必须分别输出：固定外观不携带默认姿态、视线或位置，位置/朝向/姿态/手部与持物/视线与表情/遮挡与可见范围/服饰状态都用每帧的 castState（按人物 id 对应已确认角色）分别给出；不得先写起始状态再用后文纠正。' +
    '⑫光照与人物可见性按当前画面确定：每帧给出 light（本帧实际适用的光源与色温，例如外景用夜间环境光与营火，不得机械沿用室内案面照明）；' +
    '一个人物仍在该故事空间内，不代表每帧都必须入画——不入画时从该帧的入画人物与参考需求中排除，不要为了连续性强行保留。' +
    '⑬额外人物的共用服饰写 crowdCostume（衣着装备），武器与道具属于个人，写在各自的 props 与 hands 里；共用服饰不等于共用武器。' +
    '⑭图片提示词只描述这一个静止瞬间（头朝哪、脚落在哪、手停在哪），转身过程、行走、水面晃动与衣料飘动一律写入独立的动作提示词，不得写进帧的 action 字段。' +
    '⑮每帧的人物清单（主角 castState 与 extraCast）必须与该帧构图一致：构图里看不到正脸或坐姿时，不得在人物描述里保留正脸或坐姿。' +
    '仅输出JSON：{"audioBinding":"与输入一致","unusedAudio":[{"id":"","reason":""}],"shots":[{"id":"shot01","purpose":"","covers":["mk1"],' +
    '"segments":[{"lineId":"","sourceStart":0,"sourceEnd":1.2}],"start":0,"end":3.2,"vendor":{"modelSeconds":5,"coverage":"fit或extra或trim或direct","note":""},' +
    '"characters":[{"id":"","position":"","facing":"","posture":"","hands":"","props":[],"gaze":"","occlusion":"","costume":""}],' +
    '"scene":{"id":"","version":输入版本},"startState":"","endState":"","camera":"","transition":"continuous或scene或time",' +
    '"first":{"moment":"单一静止时刻","composition":"景别机位与画面内容","bans":[]},"last":{"moment":"","composition":"","bans":[]},' +
    '"action":{"phases":["起势","主动作","收势"],"speed":1,"secondary":[],"settle":"","continuity":[],"paceNote":null},"drivingLine":"需要口型的line id或null"}]}。' +
    '数据：' + JSON.stringify({ audioBinding: creative.audioBinding, lines, durations, vendorSeconds,
      director: creative.directorScript, characters: creative.characters, scenes: creative.scenes,
      sceneVersion: creative.scenes?.version, requirements: creative.requirements });
}
// The lines and their measured durations come from the voice plan and the ACCEPTED audio only.
function audioLines(creative) {
  return (creative?.voicePlan?.lines || []).map(line => ({ id: line.id, speaker: line.speaker, kind: line.kind, text: line.text }));
}
// Running times come from the ACCEPTED audio only. An estimate is reported as an estimate and is never
// promoted into the measured map, so nothing downstream can mistake "估计" for "实测".
function measuredDurations(creative) {
  const ledger = durationLedger(creative);
  const measured = {}, byLine = {};
  for (const line of ledger.lines) { byLine[line.id] = line.basis; if (line.basis === 'measured') measured[line.id] = line.seconds; }
  return { measured, missing: ledger.lines.filter(line => line.basis !== 'measured').map(line => line.id),
    basis: { byLine, measured: ledger.measured, estimated: ledger.estimated, unknown: ledger.unknown,
      lines: Object.fromEntries(ledger.lines.map(line => [line.id, line])) } };
}
function audioFiles(creative) {
  const files = {};
  for (const line of creative?.voicePlan?.lines || []) files[line.id] = creative?.audio?.[line.id]?.file || null;
  return files;
}// The authority record of the creative package: the digest of everything that was AUTHORED. It is written when
// the package is authored or re-planned and by the controlled revision entry only, so a package edited outside
// those two paths can be told apart from an authorised revision instead of being treated as one.
function recordCreativeAuthority(creative, { by, reason = null } = {}) {
  creative.digests = creativeDigests(creative);
  creative.authority = { at: new Date().toISOString(), by, reason, digest: hash(creative.digests),
    revision: (creative.revisions || []).length };
  return creative.authority;
}
function creativeAuthority(creative) {
  if (!creative?.authority?.digest) return { confirmed: false, reason: 'unrecorded', digest: null };
  const digest = hash(creativeDigests(creative));
  return { confirmed: digest === creative.authority.digest, digest,
    reason: digest === creative.authority.digest ? 'matches' : 'changed-outside-a-controlled-entry',
    recorded: { ...creative.authority } };
}
// Authoring: each stage is validated locally and persisted with its own digest before the next one starts,
// so an interrupted run resumes instead of rebuilding requests (the operations layer keeps the round budget).
async function authorCreative(context, { models, state, log = () => {} }) {
  const { production, config } = context;
  const production_ = production;
  const cents = config.planner?.reservationCents;
  state.creative ||= { version: 1 };
  const creative = state.creative;
  if (!creative.requirements) {
    const { json } = await models.plan('plan-requirements', { purpose: 'creative-requirements',
      prompt: requirementsPrompt(production_, state.brief), reservationCents: cents });
    creative.requirements = requirementBrief(json, production_);
    creative.digests = creativeDigests(creative);
    log('需求约束包已生成：必须保留 ' + creative.requirements.mustKeep.length + ' 项，冲突 ' + creative.requirements.conflicts.length + ' 项');
  }
  if (!creative.directorScript) {
    const { json } = await models.plan('plan-director-script', { purpose: 'creative-director-script',
      prompt: directorPrompt(production_, creative.requirements, state.brief), reservationCents: cents });
    creative.directorScript = directorScript(json, { requirements: creative.requirements,
      characterIds: production_.characters.map(c => c.id) });
    creative.digests = creativeDigests(creative);
    log('导演脚本已生成：' + creative.directorScript.segments.length + ' 段');
  }
  if (!creative.characters) {
    const { json } = await models.plan('plan-character-bible', { purpose: 'creative-character-bible',
      prompt: characterBiblePrompt(production_, state.characters || {}), reservationCents: cents });
    creative.characters = characterBible(json, { production: production_ });
    creative.digests = creativeDigests(creative);
    log('人物设定集已生成：' + creative.characters.entries.length + ' 人');
  }
  if (!creative.scenes) {
    const { json } = await models.plan('plan-scene-bible', { purpose: 'creative-scene-bible',
      prompt: sceneBiblePrompt(production_, creative.requirements, creative.directorScript), reservationCents: cents });
    creative.scenes = sceneBible(json, { production: production_, requirements: creative.requirements });
    creative.digests = creativeDigests(creative);
    log('场景设定集已生成：' + creative.scenes.entries.length + ' 个场景');
  }
  if (!creative.voicePlan) {
    const { json } = await models.plan('plan-voice-plan', { purpose: 'creative-voice-plan',
      prompt: voicePlanPrompt(production_, creative.directorScript), reservationCents: cents });
    creative.voicePlan = voicePlan(json, { director: creative.directorScript,
      characterIds: production_.characters.map(c => c.id), requirements: creative.requirements });
    creative.digests = creativeDigests(creative);
    log('配音计划已生成：' + creative.voicePlan.lines.length + ' 句（含不朗读的表演说明）');
  }
  // The running-time ledger and the package authority are recorded together with the authored package: the
  // ledger says which durations are measured, estimated or unknown, an estimate-only risk is recorded as OPEN
  // (no word is deleted, reworded or sped up), and the authority digest is what a controlled revision compares
  // itself against.
  creative.durationEstimates = Object.fromEntries(creative.voicePlan.lines.map(line => [line.id, line.durationEstimate || null]));
  creative.durationLedger = durationLedger(creative, { maxSeconds: production_.maxDurationSeconds,
    targetSeconds: production_.targetDurationSeconds });
  recordCreativeAuthority(creative, { by: 'authoring' });
  log('时长台账：实测 ' + creative.durationLedger.measured.ids.length + ' 句 / 估计 ' +
    creative.durationLedger.estimated.ids.length + ' 句 / 未知 ' + creative.durationLedger.unknown.length +
    ' 句；待处理时长冲突 ' + creative.durationLedger.conflicts.length + ' 项');
  return creative;
}
// The storyboard is only planned after the audio is ACCEPTED and every line has a MEASURED duration. An
// estimate is never a substitute: a line that only carries an estimated running time stops the flow here
// (with zero planning requests) instead of being scheduled as if the measurement already existed.
function requireAcceptedAudio(state) {
  const creative = state.creative;
  if (!creative?.voicePlan) throw new Error('STORYBOARD_REQUIRES_VOICE_PLAN');
  const acceptance = creative.acceptance;
  if (!acceptance || acceptance.status !== 'accepted') throw new Error('STORYBOARD_REQUIRES_ACCEPTED_AUDIO: 尚未接受配音，不得安排最终分镜');
  const binding = hash(audioLines(creative).map(line => ({ id: line.id, text: line.text, file: creative.audio?.[line.id]?.file ? fileHash(creative.audio[line.id].file) : null })));
  if (acceptance.binding !== binding) throw new Error('STORYBOARD_AUDIO_CHANGED: 已接受的配音与当前音频不一致，需重新试听验收');
  const { measured, missing, basis } = measuredDurations(creative);
  if (missing.length) {
    const estimated = basis.lines[missing[0]]?.basis === 'estimated';
    throw new Error('STORYBOARD_REQUIRES_MEASURED_AUDIO:' + missing.join(',') + (estimated
      ? '：这些台词目前只有估计时长（' + (basis.lines[missing[0]]?.method || '未写明方法') + '），估计不能替代实测；生成并接受真实配音后再安排最终分镜'
      : '：缺少本地实测时长，不得用估计或固定时长替代'));
  }
  if (acceptance.measuredBy && !/ffprobe/.test(String(acceptance.measuredBy)))
    throw new Error('STORYBOARD_REQUIRES_MEASURED_AUDIO:验收记录的时长来源不是本地实测（' + acceptance.measuredBy + '），不得用于最终分镜');
  return { measured, binding, basis };
}
async function planStoryboard(context, { models, state, log = () => {} }) {
  const { config, production } = context;
  const { measured, binding, basis } = requireAcceptedAudio(state);
  const creative = state.creative;
  const vendorSeconds = [2, 3, 4, 5, 6, 8, 10];
  // The running-time ledger is recorded before the storyboard is planned. A MEASURED total beyond the user's
  // hard limit is recorded as an OPEN conflict and stops the flow for an explicit decision: nothing is trimmed,
  // reworded or sped up automatically, and an estimate never produces that decision at all.
  const ledger = durationLedger(creative, { maxSeconds: production.maxDurationSeconds, targetSeconds: production.targetDurationSeconds });
  creative.durationLedger = ledger;
  const gating = ledger.conflicts.filter(conflict => conflict.gating);
  if (gating.length) {
    const detail = gating.map(conflict => conflict.note + '（实测 ' + conflict.measuredSeconds + ' 秒 > 硬性上限 ' + conflict.maxSeconds +
      ' 秒；可选：' + conflict.options.join('；') + '）').join('；');
    log('实测总时长超出硬性片长，已记录为待处理冲突并停在这里：' + detail);
    throw new Error('CREATIVE_DURATION_EXCEEDS_HARD_LIMIT:' + detail);
  }
  // The operation number is derived from WHAT is being planned, never from a counter, and it covers the whole INPUT
  // this request carries (the same live objects the prompt is built from, never a cached copy of them): the accepted
  // audio and its measured running times, the acting words and goals (voice plan and director script), the settings
  // the per-frame text is written against (the character bible and the scene bible, with their own revision numbers),
  // and the requirement brief the planner may not contradict. A scene or equipment revision, a reworded line, a new
  // take or a changed requirement set therefore lands on its OWN number instead of reusing the number of the
  // superseded plan — and the operations layer refuses a changed input under an old number (OPERATION_INPUT_CHANGED),
  // so an unchanged number really does mean an unchanged input. The same input always lands on the same number: it is
  // reused from the record instead of being paid for a second time. Whether the run may go on at all is decided by
  // the authorisation, the operation records and the shared check ledger, never by this number.
  const operation = 'plan-storyboard-' + hash({ binding, measured, lines: audioLines(creative),
    voicePlan: creative.voicePlan || null, plan: creative.directorScript || null,
    characters: creative.characters || null, scenes: creative.scenes || null,
    sceneVersion: creative.scenes?.version ?? null, requirements: creative.requirements || null }).slice(0, 12);
  const { json } = await models.plan(operation, {
    purpose: 'creative-storyboard', reservationCents: config.planner?.reservationCents,
    prompt: storyboardPrompt({ ...creative, audioBinding: binding }, { lines: audioLines(creative), durations: measured, vendorSeconds }) });
  const board = storyboard(json, { durations: measured, acceptedBinding: binding, lines: audioLines(creative),
    characters: creative.characters, scenes: creative.scenes, sceneVersion: creative.scenes?.version,
    allowedVendorSeconds: vendorSeconds, maxSeconds: production.maxDurationSeconds, requirements: creative.requirements,
    // What the durations in this request really are: the accepted audio's own measurements (ffprobe), never an
    // estimate and never an unrecorded number.
    durationSource: { basis: 'measured', measuredBy: creative.acceptance?.measuredBy || 'ffprobe@acceptance',
      lines: measured, perLine: basis.byLine } });
  const timeline = storyboardTimeline(board, { durations: measured, audioFiles: audioFiles(creative),
    titles: Object.fromEntries(creative.voicePlan.lines.map(line => [line.id, line.text])), ending: production.ending || null,
    durationSource: { basis: 'measured', measuredBy: creative.acceptance?.measuredBy || 'ffprobe@acceptance',
      lines: measured } });
  creative.storyboard = board;
  creative.timeline = timeline;
  recordCreativeAuthority(creative, { by: 'storyboard-plan' });
  // A controlled re-plan is CONSUMED by this successful planning: the record of why it was needed moves to history
  // together with the operation that carried it out, so no later run can believe a re-plan is still outstanding (and
  // a retry of an unchanged input is reused from its record instead of being planned and paid for again). The reason,
  // the superseded shots and the previous binding are all kept, never deleted: only their "still pending" meaning ends.
  if (creative.storyboardReplan) {
    (creative.storyboardReplanHistory ||= []).push({ ...creative.storyboardReplan,
      completedAt: new Date().toISOString(), operation, completedBy: 'storyboard-plan',
      completedShots: board.shots.length, note: '该受控重新规划已由本次分镜请求完成：原因与旧分镜信息保留在此，不再处于待执行状态' });
    delete creative.storyboardReplan;
  }
  log('最终分镜已生成：' + board.shots.length + ' 镜，成片 ' + timeline.contentSeconds + ' 秒，音频床 ' + timeline.audioBed.length + ' 条');
  return { board, timeline };
}
// The shot objects the existing pipeline consumes come from the storyboard, with the assembled requests.
function scriptForPipeline(context, state) {
  const creative = state.creative;
  if (!creative?.storyboard || !creative?.timeline) throw new Error('STORYBOARD_REQUIRED');
  return scriptFromStoryboard(creative.storyboard, { title: creative.directorScript.title,
    characters: creative.characters, scenes: creative.scenes, style: context.production.style });
}

// Speech is generated per VOICE LINE, not per shot. This placeholder only drives that stage; the final
// storyboard replaces it before any frame or video work starts.
function creativePlaceholderScript(context, state) {
  const lines = audioLines(state.creative);
  return { title: state.creative.directorScript?.title || 'creative', creativePlaceholder: true,
    shots: lines.map(line => ({ id: line.id, type: line.kind === 'dialogue' ? 'dialogue' : 'narration',
      characters: [line.speaker], speaker: line.speaker, text: line.text, emotion: '',
      scene: '占位：最终分镜在接受音频后生成', endScene: '占位：最终分镜在接受音频后生成', action: '占位：最终分镜在接受音频后生成',
      needsLastFrame: true, duration: 5 })) };
}
function creativePlaceholderTimed(state, durations) {
  const timed = structuredClone(state.script);
  let cursor = 0;
  for (const shot of timed.shots) {
    const measured = durations[shot.id];
    shot.speechDuration = measured || null;
    // Without a measurement this placeholder only keeps the legacy speech stage running: the fixed 5 seconds is
    // marked as an ESTIMATE with its own basis, so nothing downstream can read it as a measured running time,
    // as an established conflict, or as a reason to shorten a line.
    shot.durationBasis = measured ? 'measured' : 'placeholder-estimate';
    shot.duration = measured ? Math.max(2, Math.ceil((measured + 0.3) * 30) / 30) : 5;
    shot.start = cursor; shot.end = cursor + shot.duration; cursor = shot.end;
  }
  timed.totalDuration = cursor;
  return timed;
}
// The film timeline of the creative path comes from the storyboard: durations, audio bed and subtitles.
// The shot objects come from scriptForPipeline (i.e. from the storyboard), never from the placeholder
// script: the creative chain replaces that placeholder before any frame or video work starts, so reading it
// here would pair storyboard slots with ids no asset was ever generated for (and silently take the wrong
// file, or none at all). A shot id that is missing on either side is a hard error, not a repaired guess.
function creativeTimed(context, state) {
  const timeline = state.creative.timeline;
  const script = scriptForPipeline(context, state);
  const slots = new Map(timeline.shots.map(entry => [entry.id, entry]));
  const shots = script.shots.map(shot => {
    const slot = slots.get(shot.id);
    if (!slot) throw new Error('CREATIVE_STORYBOARD_TIMELINE_MISMATCH:' + shot.id);
    slots.delete(shot.id);
    return { ...shot, start: slot.start, end: slot.end, duration: slot.duration, speechDuration: null };
  });
  if (slots.size) throw new Error('CREATIVE_STORYBOARD_TIMELINE_MISMATCH:' + [...slots.keys()].join(','));
  const timed = { title: state.creative.directorScript.title, storyboardTimed: true, creative: true, shots,
    audioBed: timeline.audioBed, subtitles: timeline.subtitles, contentSeconds: timeline.contentSeconds };
  if (context.production.ending) timed.ending = { ...context.production.ending, start: timeline.contentSeconds };
  timed.totalDuration = timeline.totalDuration;
  return timed;
}

// ---------------------------------------------------------------- the final composition (local, offline)
// The last boundary of the creative chain is local: the film is assembled from the accepted audio bed, the
// storyboard timeline, the subtitles and the shot videos that already passed their own check. No provider is
// contacted here and the legacy assembly path is never a fallback.
//
// This planner is the single place that decides whether a film may be built. It is deliberately strict: the
// assembly step can only cut from the head of a take and can only place a bed entry by decoding one source
// window, so anything it cannot express exactly (a retimed line, a partially used accepted take, a window
// that does not match the shot slot) is reported as a blocker instead of being "solved" by trimming, padding,
// retiming or mixing something else on top. A blocker means: no FFmpeg call, no output file, no fallback.
const FINAL_TOLERANCE = 0.02;

function finalCompositionPlan(context, state, { media } = {}) {
  const creative = state.creative;
  if (!creative?.storyboard || !creative?.timeline) throw new Error('CREATIVE_FINAL_REQUIRES_STORYBOARD');
  const blockers = [];
  const block = (code, detail) => blockers.push(detail === undefined ? code : code + ':' + detail);
  // 1) The accepted audio is the only dialogue source of the film, and the storyboard must belong to it.
  let accepted = null;
  try { accepted = requireAcceptedAudio(state); }
  catch (error) { block('CREATIVE_FINAL_AUDIO_UNACCEPTED', error.message); }
  if (accepted && creative.storyboard.audioBinding !== accepted.binding)
    block('CREATIVE_FINAL_AUDIO_BINDING_MISMATCH', '分镜绑定的音频与当前已接受的配音不一致');
  // 2) The film timeline and the shot assets must describe the same shots, with a verdict that still belongs
  // to the current plan, the current take and the current revision.
  const timed = creativeTimed(context, state);
  const shots = [];
  for (const slot of creative.timeline.shots) {
    const shot = timed.shots.find(item => item.id === slot.id) || null;
    const asset = state.assets?.[slot.id] || null;
    if (!shot) { block('CREATIVE_FINAL_SHOT_MISSING', slot.id); continue; }
    if (!asset?.video || !fs.existsSync(asset.video)) { block('CREATIVE_FINAL_VIDEO_MISSING', slot.id); continue; }
    if (asset.videoPause) { block('CREATIVE_FINAL_VIDEO_PAUSED', slot.id + ':' + asset.videoPause.code); continue; }
    if (asset.qualityPause?.stage === 'video') { block('CREATIVE_FINAL_QUALITY_PAUSED', slot.id + ':' + asset.qualityPause.code); continue; }
    const plan = asset.videoPlan, review = asset.videoReview;
    if (!plan) { block('CREATIVE_FINAL_VIDEO_PLAN_MISSING', slot.id); continue; }
    // The SAVED plan is not taken on trust. It is re-derived from the CURRENT storyboard, timeline, anchor frames
    // and applicable audio with the very planner the video stage used, and that plan's digest must still be the
    // plan that was recorded. A reworded action, a moved cut, a replaced frame or a changed accepted take can
    // therefore never pass as the plan of an older request — nothing weaker is invented here, and a plan that
    // cannot even be derived from the current input is a blocker too.
    const boardShot = creative.storyboard.shots.find(item => item.id === slot.id) || null;
    if (!boardShot) { block('CREATIVE_FINAL_VIDEO_PLAN_STALE', slot.id + '：当前分镜里没有这个镜头'); continue; }
    let current = null;
    try {
      current = videoExecutionPlan(boardShot, { timeline: creative.timeline,
        frames: { first: asset.first, last: asset.last },
        audio: boardShot.drivingLine ? creative.audio?.[boardShot.drivingLine] || null : null,
        models: context.config?.models });
    } catch (error) { block('CREATIVE_FINAL_VIDEO_PLAN_STALE', slot.id + '：' + error.message); continue; }
    if (current.digest !== plan.digest)
      { block('CREATIVE_FINAL_VIDEO_PLAN_STALE', slot.id +
        '：记录的视频计划与按当前分镜/时间线/帧素材/适用音频算出的计划不同'); continue; }
    // The binding a verdict was produced with records its components, so they are compared one by one: the
    // same shot, revision, take file, first/last frame and rules version must still hold. Its `contract` part
    // is a hash of this plan's digest plus a note derived only from the plan fields, so the plan digest below
    // covers it. Anything that cannot be proven to belong to the current input is treated as stale.
    const revision = state.revisions?.['video-' + slot.id] || 0;
    const videoHash = fileHash(asset.video), binding = review?.binding || null;
    const fresh = !!binding && binding.shotId === slot.id && binding.revision === revision &&
      binding.video === videoHash && binding.first === plan.keyframes.first.hash && binding.last === plan.keyframes.last.hash &&
      binding.rules === QUALITY_RULES_VERSION && review.revision === revision && review.evidence?.plan === plan.digest &&
      JSON.stringify(review.evidence?.sampling) === JSON.stringify(binding.sampling?.times || null);
    if (!fresh) { block('CREATIVE_FINAL_VIDEO_CHECK_STALE', slot.id); continue; }
    if (review.pass !== true) { block('CREATIVE_FINAL_VIDEO_CHECK_UNACCEPTED', slot.id + ':' + review.verdict); continue; }
    // The film uses the HEAD of a take for exactly the shot's slot (the assembly cuts from zero for that many
    // seconds), so a plan that used another window cannot be assembled here and is never silently re-cut.
    const duration = plan.duration || {};
    if (Number(duration.usageStart) !== 0 || Math.abs(Number(duration.usageSeconds) - slot.duration) > FINAL_TOLERANCE)
      block('CREATIVE_FINAL_USAGE_WINDOW_UNSUPPORTED',
        slot.id + '：计划用量 ' + duration.usageSeconds + ' 秒与镜头槽 ' + slot.duration + ' 秒不一致');
    shots.push({ id: slot.id, start: slot.start, end: slot.end, duration: slot.duration, video: asset.video,
      videoHash, planDigest: plan.digest || null, checkDigest: binding.digest,
      usageSeconds: Number(duration.usageSeconds), requestSeconds: plan.model?.requestSeconds ?? null });
  }
  // 3) The audio bed. Each entry plays ONE source window of ONE accepted take, linearly: the window it plays
  // must be exactly the window the accepted performance is, otherwise words would be dropped, repeated or
  // spoken at the wrong pace — none of which this step may do quietly.
  const ordered = [];
  for (const entry of creative.timeline.audioBed || []) {
    const segments = Array.isArray(entry.segments) ? entry.segments : [];
    if (!entry.file || !fs.existsSync(entry.file)) { block('CREATIVE_FINAL_AUDIO_FILE_MISSING', entry.lineId); continue; }
    // The bed may only play the ACCEPTED take of this line, byte for byte. The declared duration proves nothing
    // about which recording is meant, so the file that will really be decoded is hashed and must be the accepted
    // one: this step derives no audio of its own, and a same-length substitute must never be mixed in as if it
    // were the accepted performance (the hash is also part of the composition's input identity below).
    const acceptedTake = creative.audio?.[entry.lineId] || null;
    if (!acceptedTake?.file || !Number.isFinite(acceptedTake.duration) || acceptedTake.duration <= 0) {
      block('CREATIVE_FINAL_AUDIO_LINE_UNACCEPTED', entry.lineId + '：音频床的这句没有已接受的配音记录');
      continue;
    }
    const acceptedHash = acceptedTake.hash || fileHash(acceptedTake.file);
    const contentHash = fileHash(entry.file);
    if (contentHash !== acceptedHash) {
      block('CREATIVE_FINAL_AUDIO_FILE_MISMATCH',
        entry.lineId + '：音频床要混的文件内容与已接受的配音不同（' + contentHash.slice(0, 12) + ' != ' +
        String(acceptedHash).slice(0, 12) + '）；本轮不派生音频，也不把另一份录音当成本句的配音');
      continue;
    }
    if (!segments.length) { block('CREATIVE_FINAL_AUDIO_SEGMENTS_MISSING', entry.lineId); continue; }
    const sourceStart = Number(segments[0].sourceStart), sourceEnd = Number(segments[segments.length - 1].sourceEnd);
    const measured = Number(entry.durationSeconds);
    if (![sourceStart, sourceEnd, measured].every(Number.isFinite) || measured <= 0)
      { block('CREATIVE_FINAL_AUDIO_RANGE_INVALID', entry.lineId); continue; }
    // The length the timeline declares must be the ACCEPTED length, not merely a plausible number: a bed that
    // claims the right file but the wrong span would place the wrong words.
    if (Math.abs(measured - acceptedTake.duration) > FINAL_TOLERANCE)
      block('CREATIVE_FINAL_AUDIO_DURATION_MISMATCH',
        entry.lineId + '：时间线声明 ' + measured + ' 秒，已接受配音实测 ' + acceptedTake.duration + ' 秒');
    const used = Number((sourceEnd - sourceStart).toFixed(3));
    if (Math.abs(used - measured) > FINAL_TOLERANCE)
      block('CREATIVE_FINAL_AUDIO_TRUNCATED',
        entry.lineId + '：分镜只用到源 ' + sourceStart + '-' + sourceEnd + '（' + used + ' 秒），已接受的配音是 ' +
        measured + ' 秒；未进入成片的尾部不会被丢掉，也不会补静音顶替');
    for (const [index, segment] of segments.entries()) {
      // A retimed segment would need the source played faster or slower, which the bed cannot do.
      if (Math.abs((segment.sourceEnd - segment.sourceStart) - (segment.filmEnd - segment.filmStart)) > FINAL_TOLERANCE) {
        block('CREATIVE_FINAL_AUDIO_RETIME_UNSUPPORTED', entry.lineId);
        break;
      }
      const previous = segments[index - 1];
      if (previous && (Math.abs(segment.filmStart - previous.filmEnd) > FINAL_TOLERANCE ||
        Math.abs(segment.sourceStart - previous.sourceEnd) > FINAL_TOLERANCE || segment.sourceStart <= previous.sourceStart)) {
        block('CREATIVE_FINAL_AUDIO_ORDER_UNSUPPORTED', entry.lineId);
        break;
      }
    }
    const startSeconds = Number(entry.startSeconds);
    if (!Number.isFinite(startSeconds) || startSeconds < 0) { block('CREATIVE_FINAL_AUDIO_PLACEMENT_UNSUPPORTED', entry.lineId); continue; }
    if (startSeconds + measured > timed.totalDuration + FINAL_TOLERANCE)
      block('CREATIVE_FINAL_AUDIO_OUT_OF_RANGE', entry.lineId + '：音频床超出成片时长');
    if (media) {
      // The declared window is compared with the real file: a shorter file would be silently padded by FFmpeg,
      // and a file that is not readable (or silent) is a blocker instead of an exception thrown mid-encode.
      let actual = null;
      try { actual = media.audio(entry.file).duration; }
      catch (error) { block('CREATIVE_FINAL_AUDIO_FILE_INVALID', entry.lineId + ':' + error.message); }
      if (actual !== null && Math.abs(actual - measured) > FINAL_TOLERANCE)
        block('CREATIVE_FINAL_AUDIO_DURATION_MISMATCH', entry.lineId + '：文件实测 ' + actual + ' 秒 != 声明 ' + measured + ' 秒');
    }
    ordered.push({ lineId: entry.lineId, file: entry.file, contentHash, acceptedFile: acceptedTake.file, acceptedHash,
      source: entry.file === acceptedTake.file ? 'accepted-file' : 'identical-copy',
      sourceStart, sourceEnd, startSeconds, durationSeconds: measured,
      segments: segments.map(segment => ({ lineId: segment.lineId, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd,
        filmStart: segment.filmStart, filmEnd: segment.filmEnd })) });
  }
  ordered.sort((left, right) => left.startSeconds - right.startSeconds);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1], entry = ordered[index];
    if (entry.startSeconds < previous.startSeconds + previous.durationSeconds - FINAL_TOLERANCE)
      block('CREATIVE_FINAL_AUDIO_OVERLAP', previous.lineId + '+' + entry.lineId + '：两句会在同一时刻同时发声');
  }
  // 4) Subtitles are validated here, before any FFmpeg call, with the same rule the assembly uses: a cue that
  // overlaps, repeats or falls outside the film is not discovered halfway through an encode.
  const subtitles = timed.subtitles || [];
  try { timelineSubtitles(subtitles); }
  catch (error) { block('CREATIVE_FINAL_SUBTITLES_INVALID', error.message); }
  // 5) The ending card is a real picture too, and it decides the last seconds of the film: its file is checked
  // (and read through the same image gate the assembly applies) and its CONTENT is part of the input identity, so
  // replacing the file at the same path cannot leave an old film looking like the result of the new picture.
  let endingImageHash = null;
  if (timed.ending) {
    const endingImage = timed.ending.image;
    if (!endingImage || !fs.existsSync(endingImage)) block('CREATIVE_FINAL_ENDING_IMAGE_MISSING', String(endingImage));
    else {
      endingImageHash = fileHash(endingImage);
      if (media) { try { media.image(endingImage); } catch (error) { block('CREATIVE_FINAL_ENDING_IMAGE_INVALID', error.message); } }
    }
  }
  // 6) The effective composition parameters of THIS plan: what the local composition will really be told to do.
  // `burn` is not a second opinion about the subtitles — it is exactly the rule the assembly applies to these
  // cues — and `profile` is the encoder's own description (services/aliyun/media.js) that the assembly builds its
  // commands from, so the cache basis cannot drift from the film that is produced.
  const composition = { preview: false,
    burn: subtitles.some(entry => entry?.text && String(entry.text).trim().length > 0), profile: FINAL_PROFILE };
  // The identity of the input: two runs that produce the same film must hash the same, and anything that
  // would change the picture or the sound (a new take, a new plan, a new verdict, a changed bed or timeline, a
  // different ending picture, other composition parameters) must change the hash, so a cached output is never
  // reused for a different film. The version is part of the identity: a digest computed by an older rule set is
  // not "the same input" as one computed by this one.
  const inputDigest = hash({ version: 'creative-final-2', audio: accepted?.binding || null,
    acceptance: accepted ? hash(accepted.measured) : null, storyboard: creative.storyboard.audioBinding || null,
    timeline: hash({ shots: creative.timeline.shots, totalDuration: timed.totalDuration, ending: timed.ending || null }),
    endingImage: endingImageHash, composition, audioBed: ordered, subtitles,
    shots: shots.map(shot => ({ id: shot.id, video: shot.videoHash, plan: shot.planDigest, check: shot.checkDigest })) });
  // The plan and the assembly share ONE validated input: the bed entries, the cues and the ending that were
  // checked above are the very objects media.assemble() receives, never a second read of the raw timeline.
  timed.audioBed = ordered;
  timed.subtitles = subtitles;
  return { timed, shots, audioBed: ordered, subtitles, blockers, inputDigest, composition,
    assets: Object.fromEntries(shots.map(shot => [shot.id, { video: shot.video }])) };
}


module.exports = { audioFiles, audioLines, authorCreative, creativeAuthority, creativePlaceholderScript, creativePlaceholderTimed, creativeTimed, characterBiblePrompt, directorPrompt, finalCompositionPlan, measuredDurations,
  planStoryboard, recordCreativeAuthority, requirementsPrompt, requireAcceptedAudio, sceneBiblePrompt, scriptForPipeline, storyboardPrompt,
  voicePlanPrompt };