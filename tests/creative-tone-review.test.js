// The AUTOMATIC TONE review of the creative chain, exercised offline with an injected client and synthetic audio.
// No provider is contacted, no upload, no real task, no acceptance record of a real production is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { characterBible, directorScript, requirementBrief, sceneBible, storyboard, storyboardTimeline, staleSettingShots,
  voicePlan } = require('../services/aliyun/creative');
const { audioLines } = require('../workflows/creative');
const { recordAcceptance } = require('../workflows/creative-stage');
const { requireAcceptedAudio } = require('../workflows/creative');
const { Models } = require('../services/aliyun/models');
const { Operations } = require('../services/aliyun/operations');
const { UnitAttempts, checkUnitForOperation, unitForOperation } = require('../services/aliyun/units');
const { Budget } = require('../services/aliyun/budget');
const { Media } = require('../services/aliyun/media');
const { fileHash, hash, readJson, writeJson } = require('../services/aliyun/io');
const { runAudioReviews } = require('../workflows/audio-review');
const { EXECUTION, analyzeLineTone, currentToneReview, runToneReviews, toneReviewBase, toneReviewBinding,
  toneReviewStage } = require('../workflows/tone-review');
const { loadContext } = require('../workflows/production');
const ROOT = path.resolve(__dirname, '..');

const production = { id: 'tone-review-film', description: '帐中读简（离线夹具）', style: '国风插画',
  targetDurationSeconds: 4, maxDurationSeconds: 60, creative: true, creativeFixture: true,
  characters: [{ id: 'jiang_wei', name: '姜维', image: 'hero.png', voiceSample: 'voice.wav' },
    { id: 'narrator', name: '旁白', image: 'hero.png', voiceSample: 'voice.wav' }] };
// Two PERFORMANCE SEGMENTS with their own goals: whatever happens to one of them must not touch the other.
const goals = { ln01: { tone: '低沉克制', pauses: ['念完停半拍'], breath: '吸气压住情绪', silence: ['念完后的静默半拍'] },
  ln02: { tone: '平缓叙述', pauses: ['切镜处停顿'], breath: '平稳', silence: [] } };
const requirementsPayload = () => ({ mustKeep: [
  { id: 'mk_line', kind: 'line', text: '臣等正欲死战', source: 'user', note: '指定台词逐字保留' },
  { id: 'mk_end', kind: 'ending', text: '视线落到营地上方结束', source: 'user' }],
  style: '国风插画', aspect: '16:9', targetSeconds: 4, maxSeconds: 60, prohibitions: ['不得出现字幕与水印'],
  expandable: [{ area: '帐外营地的宿帐分组', serves: '可信空间与生活状态' }], unknowns: ['未提供完整剧本原文'], conflicts: [] });
const directorPayload = () => ({ title: '帐中读简（夹具）', theme: '读简后抬眼看营地', segments: [
  { id: 'seg01', purpose: '交代营帐内的阅读', covers: ['mk_line'], characters: ['jiang_wei'],
    entry: { state: '手持竹简坐于案前', motivation: '确认军令内容' },
    beats: { cause: '读到关键句', action: '低声诵读', reaction: '呼吸一滞', result: '抬头' },
    performance: { tone: goals.ln01.tone, pauses: ['念完停半拍'], breath: goals.ln01.breath, gaze: '由竹简抬起',
      expression: '眉峰收紧', posture: '上身微前倾' },
    space: '帐内案前，右侧火盆，帐帘在左', props: ['竹简'],
    spoken: [{ id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战', covers: ['mk_line'] }],
    ambience: ['帐外风声'], silence: ['念完后的静默半拍'], shotIntent: '近景推向中景',
    endState: '抬头，视线离开竹简', nextHandoff: '下一段望向帐外', creative: [], unknown: [] },
  { id: 'seg02', purpose: '把视线带到营地', covers: ['mk_end'], characters: ['narrator'],
    entry: { state: '姜维保持抬头', motivation: '确认营地动向' },
    beats: { cause: '帐外脚步', action: '镜头切到帐外', reaction: '巡逻队走过', result: '画面停在营地' },
    performance: { tone: goals.ln02.tone, pauses: ['切镜处停顿'], breath: goals.ln02.breath, gaze: '画外',
      expression: '无', posture: '无' },
    space: '营地全景', props: ['火盆'],
    spoken: [{ id: 'ln02', speaker: 'narrator', kind: 'narration', text: '营地夜巡无声', covers: ['mk_end'] }],
    ambience: ['巡逻脚步'], silence: [], shotIntent: '营帐外中远景到营地全景',
    endState: '画面停在营地上方', nextHandoff: '结束', creative: [], unknown: [] }] });
const bibleEntry = (id, name) => ({ id, name, version: 1, refs: ['hero.png'], analyzedRefs: [],
  confirmed: { face: '方脸，浓眉', hair: '束发戴冠', costume: '深色甲袍', accessories: '腰间短剑', weapon: '短剑入鞘',
    palette: '深灰与暗红', materials: '皮革与旧布' }, weaponSide: '短剑挂在左侧腰间', unknown: [],
  source: 'reference', status: 'unverified' });
const scenesPayload = { entries: [{ id: 'tent', name: '主帐内外', version: 1, scale: '主帐宽约四步',
  directions: { north: '画面右后方', entrance: '左侧帐帘', roads: ['帐前主路通向画左'] }, structures: ['主帐木架与厚布'],
  materials: ['粗布', '原木'], wear: ['布面烟熏发暗'], props: ['案几', '竹简', '火盆'],
  light: { position: '帐内火盆', direction: '自右下向左上', warmth: '暖黄', coverage: '照亮案几与人物半侧' },
  weather: '夜，无雨', wind: '偏北风', people: ['帐内一人'], boundary: ['画面右后方为营帐群'],
  fixed: ['主帐木架'], variable: ['火盆火苗高度'], source: 'creative', status: 'creative' }] };
const voicePlanPayload = () => ({ lines: [
  { id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战', performance: goals.ln01,
    notSpoken: ['“死战”二字不要喊出来'],
    durationEstimate: { method: 'character-rate', seconds: 2.6, uncertaintySeconds: 0.6, rate: 5, characters: 6,
      basis: '按每秒 5 字估算' } },
  { id: 'ln02', speaker: 'narrator', kind: 'narration', text: '营地夜巡无声', performance: goals.ln02, notSpoken: [],
    durationEstimate: { method: 'character-rate', seconds: 2.1, uncertaintySeconds: 0.5, rate: 5, characters: 6,
      basis: '按每秒 5 字估算' } }] });
const cast = extra => ({ id: 'jiang_wei', position: '画面左侧案前', facing: '朝向画面右前方', posture: '坐姿，重心落在髋部',
  hands: '双手持竹简，右手在上', props: ['竹简'], gaze: '视线落在竹简上', occlusion: '帐帘在前景右侧遮挡三分之一画面',
  costume: '深色甲袍，腰间短剑入鞘', ...extra });
const castState = extra => [{ id: 'jiang_wei', position: '画面左侧案前', facing: '朝向画面右前方', posture: '坐姿',
  hands: '双手持竹简', props: ['竹简'], gaze: '视线落在竹简上', occlusion: '未见遮挡', costume: '深色甲袍', ...extra }];
// ln01 runs across shot01 AND shot03, so "one review per performance segment" is a real claim here, not a guess.
const shotsPayload = () => ([
  { id: 'shot01', purpose: '读简', covers: ['mk_line'], segments: [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 1.2 }],
    start: 0, end: 1.2, vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 1.2 秒' }, characters: [cast()],
    scene: { id: 'tent', version: 1 }, startState: '双手持简坐于案前', endState: '读到一半停住', camera: '近景',
    transition: 'continuous', drivingLine: 'ln01',
    first: { moment: '双手持简低头阅读的一刻', composition: '近景，竹简占画面下三分之一',
      visibleEnvironment: ['低案与竹简占画面下三分之一'], castState: castState(), extraCast: [] },
    last: { moment: '读到一半停住的一刻', composition: '近景，人物占画面中央', visibleEnvironment: ['案上竹简与火盆一角'],
      castState: castState({ gaze: '视线仍在竹简上' }), extraCast: [] },
    action: { phases: ['起势：吸气', '主动作：念到停住', '收势：闭嘴'], speed: 1, secondary: ['火盆火苗轻晃'],
      settle: '停在停住姿态', continuity: [] } },
  { id: 'shot02', purpose: '帐内空镜', covers: ['mk_line'], segments: [], start: 1.2, end: 1.6,
    vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 0.4 秒' }, characters: [],
    castNote: '本镜是帐内空镜：镜头停在案与火盆上，人物不在本镜任何一帧画内',
    scene: { id: 'tent', version: 1 }, startState: '人物离画，只剩案与火盆', endState: '火焰轻晃的静止画面',
    camera: '中景', transition: 'reframe', drivingLine: null,
    first: { moment: '火盆火苗轻晃的一刻', composition: '中景，案与火盆居中', visibleEnvironment: ['低案与火盆在画面中部'],
      extraCast: [] },
    last: { moment: '火焰稍稳的一刻', composition: '中景，火光映在案面', visibleEnvironment: ['案面与火盆边沿可见'],
      extraCast: [] },
    action: { phases: ['起势：镜头落到案上', '主动作：火焰轻晃', '收势：停在案面'], speed: 1, secondary: [],
      settle: '镜头静止', continuity: ['人物出画是明确的构图变化，视线与声音承接上一镜'] } },
  { id: 'shot03', purpose: '念完并抬眼', covers: ['mk_line'], segments: [{ lineId: 'ln01', sourceStart: 1.2, sourceEnd: 2.4 }],
    start: 1.6, end: 2.8, vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 1.2 秒' }, characters: [cast()],
    scene: { id: 'tent', version: 1 }, startState: '读到一半停住', endState: '抬眼看向帐帘', camera: '近景推中景',
    transition: 'reframe', drivingLine: 'ln01',
    first: { moment: '念到句末停住的一刻', composition: '近景，人物占画面中央', visibleEnvironment: ['案上竹简与火盆一角'],
      castState: castState(), extraCast: [] },
    last: { moment: '抬眼看向帐帘的一刻', composition: '中景，帐帘在画面左', visibleEnvironment: ['帐帘在画面左前景'],
      castState: castState({ gaze: '视线离开竹简，看向帐帘方向' }), extraCast: [] },
    action: { phases: ['起势：念完最后两字', '主动作：停半拍', '收势：抬眼'], speed: 1, secondary: ['火盆火苗轻晃'],
      settle: '停在抬眼姿态', continuity: ['人物回到画内，承接上一镜的案面构图'] } },
  { id: 'shot04', purpose: '营地收尾', covers: ['mk_end'], segments: [{ lineId: 'ln02', sourceStart: 0, sourceEnd: 2 }],
    start: 2.8, end: 4.8, vendor: { modelSeconds: 2, coverage: 'fit', note: '' }, characters: [],
    castNote: '本镜是营地环境镜头：画面停在营地上方，无人物入画', scene: { id: 'tent', version: 1 },
    startState: '抬眼后镜头升到营地', endState: '画面停在营地上方', camera: '远景升高', transition: 'reframe',
    drivingLine: 'ln02',
    first: { moment: '营地全景静止的一刻', composition: '远景，宿帐分组可见', visibleEnvironment: ['宿帐自近到远排开'],
      extraCast: [] },
    last: { moment: '画面升高后停住的一刻', composition: '远景，营地上方与山影', visibleEnvironment: ['最远处只剩山影轮廓'],
      extraCast: [] },
    action: { phases: ['起势：镜头升高', '主动作：营地全景', '收势：停住'], speed: 1, secondary: [], settle: '镜头静止',
      continuity: ['人物出画是明确的构图变化，画面升到营地上方承接上一镜'] } }]);
// ---------------------------------------------------------------- an offline workspace with real media files
function workspace() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'tone-review-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  // The fixture enables the PAID path only in its own isolated config and injects the provider adapter, so no request
  // can leave. The real config/aliyun.json is asserted to stay onlineEnabled:false at the end of this suite.
  const config = readJson(path.join(ROOT, 'config/aliyun.json'));
  config.onlineEnabled = true;
  config.authorizationFile = 'auth.json';
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, region: config.region, productionId: production.id,
    providers: ['aliyun'], approvedBudgetCny: 70, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  writeJson(path.join(root, 'production.json'), production);
  const media = new Media(root, project);
  const hero = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', hero]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  // Two distinguishable synthetic takes: 440Hz for the inner monologue, 660Hz for the narration.
  const takes = { ln01: path.join(root, 'take-ln01.wav'), ln02: path.join(root, 'take-ln02.wav') };
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '2.4', '-ac', '1', takes.ln01]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=24000', '-t', '2', '-ac', '1', takes.ln02]);
  const context = loadContext(root, 'production.json');
  return { root, context, config, production, media, takes, directory: context.directory,
    stateFile: path.join(context.directory, 'state.json'), opsDir: path.join(context.directory, 'operations') };
}
// The authored package exactly as the creative chain leaves it after the takes were generated: two measured takes,
// two performance segments, and NO acceptance yet (the acceptance gate is exercised separately).
function authoredCreative(f) {
  const requirements = requirementBrief(requirementsPayload(), production);
  const characterIds = production.characters.map(item => item.id);
  const director = directorScript(directorPayload(), { requirements, characterIds });
  const characters = characterBible({ entries: [bibleEntry('jiang_wei', '姜维'), bibleEntry('narrator', '旁白')] },
    { production });
  const scenes = sceneBible(scenesPayload, { production, requirements });
  const plan = voicePlan(voicePlanPayload(), { director, characterIds, requirements });
  const durations = { ln01: f.media.audio(f.takes.ln01).duration, ln02: f.media.audio(f.takes.ln02).duration };
  const board = storyboard({ audioBinding: 'b1', shots: shotsPayload() },
    { durations, acceptedBinding: 'b1', lines: audioLines({ voicePlan: plan }), characters, scenes, sceneVersion: 1,
      allowedVendorSeconds: [2], maxSeconds: 60, requirements });
  const timeline = storyboardTimeline(board, { durations, audioFiles: { ...f.takes },
    titles: Object.fromEntries(plan.lines.map(line => [line.id, line.text])) });
  const creative = { version: 1, requirements, directorScript: director, characters, scenes, voicePlan: plan,
    storyboard: board, timeline, audio: Object.fromEntries(plan.lines.map(line => [line.id,
      { operation: 'speech-' + line.id, model: f.config.models.speech, file: f.takes[line.id],
        hash: fileHash(f.takes[line.id]), duration: durations[line.id], measuredBy: 'ffprobe@generation',
        instruction: null, performance: line.performance, estimate: null }])) };
  writeJson(f.stateFile, { version: 1, productionId: production.id, characters: {}, approvals: {}, revisions: {},
    assets: {}, stage: 'audio', creative });
  return { state: readJson(f.stateFile), creative: readJson(f.stateFile).creative, durations, board };
}
// The injected provider adapter. It answers the tone protocol and the legacy audio-review protocol, captures what
// really reached the client (prompt text + attached audio), and can be scripted per line and per mode.
function clientFor(f, script = {}) {
  const calls = [];
  const client = {
    request: async (endpoint, body) => {
      const parts = body.messages?.[0]?.content || [];
      const prompt = parts.find(part => part.type === 'text')?.text || '';
      const audio = parts.find(part => part.type === 'input_audio')?.input_audio?.data || null;
      const tone = prompt.includes('配音表演审核模型');
      const legacy = !tone && prompt.includes('expressiveness');
      const lineId = prompt.match(/本段编号 ([\w-]+)/)?.[1] || prompt.match(/shotId":"([\w-]+)/)?.[1] || null;
      calls.push({ endpoint, model: body.model, kind: tone ? 'tone' : legacy ? 'legacy' : 'other', lineId, prompt, audio,
        stream: body.stream === true, partTypes: parts.map(part => part.type) });
      if (script.failOnRequest === calls.length) throw new Error('SOCKET_HANGUP');
      const mode = (script.modes || {})[lineId] || script.mode || 'pass';
      if (mode === 'raw') return { choices: [{ finish_reason: 'stop', message: { content: '这段音频整体听上去还行' } }] };
      const payload = legacy ? legacyPayload(lineId, mode) : tonePayload(lineId, mode, script);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }],
        usage: { total_tokens: 42 } };
    },
    download: async () => { throw new Error('NO_DOWNLOAD_IN_THIS_SUITE'); },
    upload: async () => { throw new Error('NO_UPLOAD_IN_THIS_SUITE'); },
    task: async () => { throw new Error('NO_TASK_IN_THIS_SUITE'); } };
  return { client, calls };
}
function harness(f, script = {}) {
  const { client, calls } = clientFor(f, script);
  const budget = new Budget(f.root, f.config, f.directory);
  const attempts = new UnitAttempts(f.directory);
  const log = [];
  const ops = new Operations(path.join(f.directory, 'operations'), client, budget, (...args) => log.push(String(args[0])),
    f.config.pollIntervalSeconds, f.config.pollTimeoutSeconds, attempts);
  const models = new Models(f.config, ops, f.media, path.join(f.directory, 'vision-cache'));
  return { client, calls, ops, models, budget, attempts, log };
}
const CRITERIA = ['completeness', 'emotionDirection', 'emotionChange', 'pacing', 'audibility'];
const LINE_TEXT = { ln01: '臣等正欲死战', ln02: '营地夜巡无声' };
const criterion = (status, extra = {}) => ({ status, observed: status === 'satisfied' ? '实际听感与要求一致' : '实际听到的情况',
  basis: '本段实际音频的听感', ...extra });
function criteriaAll(status) { return Object.fromEntries(CRITERIA.map(name => [name, criterion(status)])); }
function tonePayload(lineId, mode, script = {}) {
  const base = { lineId, heard: { transcript: script.transcripts?.[lineId] || LINE_TEXT[lineId] || '未知台词',
    uncertainWords: [] }, problems: [], suggestions: [],
    limits: ['眼神、抬头、服饰动作与画面口型不在音频判断范围内'] };
  if (mode === 'missing') return { ...base, criteria: { completeness: criterion('satisfied') } };
  if (mode === 'unjustified')
    return { ...base, criteria: { ...criteriaAll('satisfied'), emotionChange: criterion('violated') } };
  if (mode === 'fail')
    return { ...base, criteria: { ...criteriaAll('satisfied'),
      emotionDirection: criterion('violated', { span: '句末两字', observed: '音量明显抬高，接近喊出来' }) },
      problems: [{ criterion: 'emotionDirection', span: '句末两字', observed: '音量明显抬高，接近喊出来',
        required: goals[lineId].tone, basis: '与低沉克制的方向相反' }],
      suggestions: ['收住句末的音量，改为压住气息收尾'] };
  if (mode === 'undetermined')
    return { ...base, criteria: { ...criteriaAll('satisfied'), pacing: criterion('unclear', { span: '第二句停顿处' }) },
      heard: { transcript: LINE_TEXT[lineId], uncertainWords: ['战', '简'] } };
  if (mode === 'unsupported')
    return { ...base, criteria: { ...criteriaAll('satisfied'), audibility: criterion('unsupported') } };
  // A conclusion written without anything heard (observed) and without a reason (basis). The protocol asks for both
  // on every criterion, so this answer is refused instead of being recorded — in either direction.
  if (mode === 'baseless')
    return { ...base, criteria: { ...criteriaAll('satisfied'),
      completeness: { status: 'satisfied', observed: '', basis: '' } } };
  // An honest unclear answer: there may be nothing to report as heard, but the reason IS stated. This is not a
  // protocol error: it is recorded as undetermined (and therefore stops the flow) with its reason kept.
  if (mode === 'unclear-with-reason')
    return { ...base, criteria: { ...criteriaAll('satisfied'),
      pacing: { status: 'unclear', observed: '', basis: '本段只有两秒，无法判断停顿是否自然' } } };
  // A fail whose evidence is the very word the same answer calls impossible to make out. When that word is absent
  // from its own transcript ('contradicted') the failure rests on something it did not hear, which the protocol calls
  // a contradiction; when the word IS in its own transcript ('contradiction-cleared') it was heard as well as
  // flagged, so nothing contradicts and the fail is recorded normally.
  if (mode === 'contradicted' || mode === 'contradiction-cleared') {
    return { ...base, heard: { transcript: mode === 'contradicted' ? '臣等正欲死' : LINE_TEXT[lineId],
      uncertainWords: ['战'] },
      criteria: { ...criteriaAll('satisfied'), emotionDirection: criterion('violated', { span: '句末的“战”字' }) },
      problems: [{ criterion: 'emotionDirection', span: '句末的“战”字', observed: '这个字一带而过、含混难辨',
        required: goals[lineId].tone, basis: '以这个字的表现判断语气没有收住' }],
      suggestions: ['句末两个字放慢一点'] };
  }
  return { ...base, criteria: criteriaAll('satisfied') };
}
function legacyPayload(shotId, mode) {
  return { shotId, transcript: '臣等正欲死战', delivery: '低沉，音量偏小',
    expressiveness: mode === 'fail' ? 'flat' : 'moderate', issues: [], uncertainWords: [] };
}
// ---------------------------------------------------------------- the request really carries the review basis
test('the segment audio, its exact words and its performance goals reach the client, and the operation records them', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f);
  const record = await analyzeLineTone(f.context, { creative: state.creative, lineId: 'ln01', models: h.models, media: f.media });
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.kind, 'tone');
  assert.equal(call.endpoint, '/compatible-mode/v1/chat/completions');
  assert.equal(call.model, f.config.audioReview.model, '不静默换模型');
  assert.equal(call.stream, true, '沿用官方要求的流式音频理解请求');
  assert.equal(call.partTypes.join(','), 'input_audio,text');
  // The audio the model receives IS the take on disk, byte for byte. The fixture never sees a plan: this is what
  // the adapter really sent.
  assert.equal(call.audio, 'data:audio/wav;base64,' + fs.readFileSync(f.takes.ln01).toString('base64'));
  assert.equal(record.input.hash, fileHash(f.takes.ln01));
  // The judgement basis: this segment's exact words, its performance goals and its narrative context.
  assert.match(call.prompt, /臣等正欲死战/);
  assert.match(call.prompt, /低沉克制/);
  assert.match(call.prompt, /念完停半拍/);
  assert.match(call.prompt, /吸气压住情绪/);
  assert.match(call.prompt, /念完后的静默半拍/);
  assert.match(call.prompt, /交代营帐内的阅读/);
  assert.match(call.prompt, /不要读出来/);
  // ...and the rules that keep a listening judgement honest.
  assert.match(call.prompt, /不要照抄给出的台词当作听辨结果/);
  assert.match(call.prompt, /同音字、标点差异与识别不确定不等于漏词或错读/);
  assert.match(call.prompt, /不要输出总分/);
  assert.match(call.prompt, /没有可靠定位能力就不要输出精确时间戳/);
  assert.match(call.prompt, /眼神、抬头、服饰动作、画面口型/);
  assert.equal(record.verdict, 'pass');
  assert.equal(record.heard.transcript, '臣等正欲死战');
  assert.deepEqual(Object.keys(record.criteria).sort(), [...CRITERIA].sort());
  // The operation record carries the same input identity the review claims.
  const op = readJson(path.join(f.opsDir, record.operation + '.json'));
  assert.equal(op.status, 'succeeded');
  assert.equal(op.spec.kind, 'creative-tone-review');
  assert.equal(op.spec.protocolVersion, f.config.audioReview.toneProtocolVersion);
  assert.equal(op.spec.promptVersion, f.config.audioReview.tonePromptVersion);
  assert.equal(op.spec.audio, fileHash(f.takes.ln01));
  assert.equal(op.spec.expectedText, hash('臣等正欲死战'));
  assert.equal(op.spec.basis, record.binding);
  // A review is not a generation unit: it runs on the shared check budget of its own logical segment.
  assert.equal(unitForOperation(record.operation), null);
  assert.equal(checkUnitForOperation(record.operation), 'tone-review-qwen38omniflash-ln01');
  // The price of this model was never verified for this purpose: the cost is a conservative reservation, never zero.
  const entry = readJson(path.join(f.directory, 'api-ledger.json')).entries.find(item => item.id === record.operation);
  assert.equal(entry.reservedCents, f.config.audioReview.toneReservationCents);
  assert.equal(entry.actualCents, null);
  assert.equal(entry.costStatus, 'reserved-conservative-estimate');
  assert.equal(entry.estimateIsNotActualCharge, true);
});

test('one take crossing several shots is reviewed once per performance segment, not once per shot', async () => {
  const f = workspace();
  const { state, board } = authoredCreative(f);
  const carrying = board.shots.filter(shot => shot.segments.some(fragment => fragment.lineId === 'ln01'))
    .map(shot => shot.id);
  assert.deepEqual(carrying, ['shot01', 'shot03'], '这条配音确实跨了两个镜头');
  const h = harness(f);
  const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(result.reviewed.length, 2, '两个表演段各一次审核');
  assert.deepEqual(h.calls.map(call => call.lineId).sort(), ['ln01', 'ln02']);
  assert.equal(h.calls.length, 2, '跨镜既不重复审核，也不触发重新配音');
  assert.deepEqual(Object.keys(state.creative.toneReviews).sort(), ['ln01', 'ln02']);
  assert.equal(state.creative.audio.ln01.toneReview.status, 'pass');
  assert.equal(state.creative.toneReviewSummary.requests, 2);
  assert.match(state.creative.toneReviewSummary.limitation, /不是用户验收/);
});
// ---------------------------------------------------------------- the four verdicts, and what is NOT a verdict
test('the verdict is derived from the five criteria, and a failure must carry concrete evidence', async () => {
  for (const [mode, verdict] of [['pass', 'pass'], ['fail', 'fail'], ['undetermined', 'undetermined'],
    ['unsupported', 'unsupported']]) {
    const f = workspace();
    const { state } = authoredCreative(f);
    const h = harness(f, { modes: { ln01: mode } });
    const record = await analyzeLineTone(f.context, { creative: state.creative, lineId: 'ln01', models: h.models, media: f.media });
    assert.equal(record.execution.status, EXECUTION.COMPLETED, mode);
    assert.equal(record.verdict, verdict, mode);
    assert.deepEqual(Object.keys(record.criteria).sort(), [...CRITERIA].sort(), mode);
    if (mode !== 'pass') assert.equal(state.creative.audio.ln01.toneReview.status, verdict);
    if (mode === 'fail') {
      assert.equal(record.problems.length, 1);
      assert.match(record.problems[0].required, /低沉克制/);
      assert.match(record.problems[0].span, /句末/, '问题要落在具体台词片段上');
      assert.ok(record.suggestions.length, '失败必须留下可执行建议');
    }
  }
  // A "violated" without concrete problems, or a partial answer, or prose instead of the protocol: none of these is
  // a judgement, and none of them is recorded as one.
  for (const [mode, code] of [['unjustified', 'TONE_REVIEW_EVIDENCE_MISSING'], ['missing', 'TONE_REVIEW_MISSING_CRITERIA'],
    ['raw', 'TONE_REVIEW_INVALID_JSON']]) {
    const f = workspace();
    const { state } = authoredCreative(f);
    const h = harness(f, { modes: { ln01: mode } });
    const record = await analyzeLineTone(f.context, { creative: state.creative, lineId: 'ln01', models: h.models, media: f.media });
    assert.equal(record.verdict, null, mode);
    assert.equal(record.execution.status, EXECUTION.PROTOCOL_ERROR, mode);
    assert.match(record.execution.error.code, new RegExp(code), mode);
    assert.equal(state.creative.audio.ln01.toneReview.status, null, mode);
    assert.ok(record.limits.length && record.notProven.length, '执行状态要说明它没有结论');
  }
});

// ---------------------------------------------------------------- a conclusion must carry its own evidence
test('a conclusion is only recorded when its own answer shows the hearing it rests on', async () => {
  for (const [mode, code] of [['baseless', 'TONE_REVIEW_BASIS_MISSING'],
    ['contradicted', 'TONE_REVIEW_EVIDENCE_CONTRADICTION']]) {
    const f = workspace();
    const { state } = authoredCreative(f);
    const h = harness(f, { modes: { ln01: mode } });
    const record = await analyzeLineTone(f.context, { creative: state.creative, lineId: 'ln01', models: h.models, media: f.media });
    assert.equal(record.verdict, null, mode);
    assert.equal(record.criteria, null, mode + '：被拒绝的结论项不写进记录');
    assert.equal(record.execution.status, EXECUTION.PROTOCOL_ERROR, mode);
    assert.equal(record.execution.error.code, code, mode);
    assert.equal(record.execution.resend, 'same-input-is-reused', '音频本身不需要重录');
    assert.equal(record.reviewStatus, 'no-conclusion', mode);
    assert.equal(state.creative.audio.ln01.toneReview.status, null, mode + '：无依据的结论不变成通过，也不变成失败');
    assert.equal(state.creative.audio.ln01.toneReview.execution, EXECUTION.PROTOCOL_ERROR, mode);
    assert.ok(record.limits.some(line => /未作数/.test(line)), mode + '：说明哪一项没有作数');
    assert.ok(record.notProven.some(line => /不是模型结论/.test(line) && /重录/.test(line)), mode);
    // What the model said it could not hear is kept, so the operator can see what really happened.
    assert.deepEqual(record.heard.uncertainWords, mode === 'contradicted' ? ['战'] : [], mode);
    // The raw answer stays in the operation record; nothing downstream ever sees it as a judgement.
    assert.equal(readJson(path.join(f.opsDir, record.operation + '.json')).status, 'succeeded', mode);
    assert.equal(state.creative.toneReviews.ln01.verdict, null, mode);
  }
});

test('the evidence rules leave an honest unclear answer and a fail whose word was heard untouched', async () => {
  // An unclear conclusion with nothing heard but a stated reason is a real answer, not a protocol error: it is
  // recorded as undetermined, keeps its reason, and stops the flow exactly like any other non-pass.
  const unclear = workspace();
  const unclearState = authoredCreative(unclear).state;
  const unclearHarness = harness(unclear, { modes: { ln01: 'unclear-with-reason' } });
  const unclearResult = await toneReviewStage(unclear.context, unclearState,
    { models: unclearHarness.models, media: unclear.media, save: () => {} });
  const record = unclearState.creative.toneReviews.ln01;
  assert.equal(record.execution.status, EXECUTION.COMPLETED, '有理由的 unclear 是结论，不是协议错误');
  assert.equal(record.verdict, 'undetermined');
  assert.match(record.criteria.pacing.basis, /无法判断停顿/);
  assert.equal(unclearState.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_UNDETERMINED');
  assert.equal(unclearResult.blocked.lineId, 'ln01');
  // A word the answer both flags as hard to hear AND finds in its own transcript was heard: the failure it draws
  // from that word stands, because there is no contradiction to refuse.
  const heard = workspace();
  const heardState = authoredCreative(heard).state;
  const heardHarness = harness(heard, { modes: { ln01: 'contradiction-cleared' } });
  await toneReviewStage(heard.context, heardState, { models: heardHarness.models, media: heard.media, save: () => {} });
  const failed = heardState.creative.toneReviews.ln01;
  assert.equal(failed.execution.status, EXECUTION.COMPLETED);
  assert.equal(failed.verdict, 'fail', '不因为一个同音词就放过真正的失败');
  assert.equal(failed.criteria.emotionDirection.status, 'violated');
  assert.equal(failed.problems[0].observed, '这个字一带而过、含混难辨');
  assert.equal(heardState.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_FAILED');
});

test('a protocol error stops the run, keeps its evidence, and never becomes a re-record', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f, { modes: { ln01: 'contradicted' } });
  const first = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(first.blocked.lineId, 'ln01');
  assert.equal(first.blocked.execution.status, EXECUTION.PROTOCOL_ERROR);
  assert.equal(first.blocked.verdict, null, '协议错误不得冒充模型结论');
  assert.equal(first.blocked.suggestions.length, 0, '被拒绝的结论不带着建议进入记录');
  assert.equal(state.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_PROTOCOL_ERROR');
  assert.equal(state.creativeStage.pause.verdict, null);
  assert.ok(h.calls.every(call => call.kind === 'tone'), '没有重新配音，也没有下游生成');
  assert.equal(first.reviewed.find(item => item.lineId === 'ln02').verdict, 'pass', '另一段不受影响，也不被要求重录');
  // The same input again: the take and the operation identity are unchanged, so the stored answer is reused instead
  // of being issued as a fresh paid review — a protocol error is never "fixed" by paying twice, and never a reason
  // to regenerate the voice.
  const calls = h.calls.length;
  const ledger = readJson(path.join(f.directory, 'api-ledger.json')).entries.length;
  const operation = state.creative.toneReviews.ln01.operation;
  const inputHash = state.creative.toneReviews.ln01.input.hash;
  const second = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(state.creative.toneReviews.ln01.operation, operation, '同一输入不换操作号');
  assert.equal(state.creative.toneReviews.ln01.input.hash, inputHash, '同一段音频');
  assert.equal(state.creative.toneReviews.ln01.execution.status, EXECUTION.PROTOCOL_ERROR);
  assert.equal(h.calls.length, calls, '同一输入不再发第二次请求');
  assert.equal(readJson(path.join(f.directory, 'api-ledger.json')).entries.length, ledger, '也不再新增预留');
  assert.equal(second.blocked.lineId, 'ln01');
  assert.equal(state.creative.toneReviewSummary.verdicts.ln01, null);
});

test('an execution problem is never a model verdict, and an unresolved submission is never re-sent', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f, { failOnRequest: 1 });
  const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(result.blocked.lineId, 'ln01');
  assert.equal(result.blocked.execution.status, EXECUTION.UNRESOLVED_SUBMISSION);
  assert.equal(result.blocked.verdict, null, '执行状态不得冒充模型结论');
  assert.equal(state.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_UNRESOLVED');
  assert.equal(state.creativeStage.pause.verdict, null);
  const operation = state.creative.toneReviews.ln01.operation;
  assert.equal(readJson(path.join(f.opsDir, operation + '.json')).status, 'uncertain');
  // The failing segment stops the flow; the other segment is still reviewed on its own (one segment's problem does
  // not silently skip the rest).
  const afterFirst = h.calls.length;
  assert.equal(afterFirst, 2);
  // The same run again: the pending submission keeps its own trace and is NOT sent under a new number.
  const second = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(h.calls.length, afterFirst, '未决提交不得换号重发');
  assert.equal(second.requests, 0);
  assert.equal(second.blocked.execution.status, EXECUTION.UNRESOLVED_SUBMISSION);
  assert.equal(state.creative.toneReviews.ln01.operation, operation);
});
// ---------------------------------------------------------------- acceptance: the model never accepts
test('a passing review still waits for the operator, who alone writes the acceptance', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f);
  const entries = Object.entries(f.takes).map(([lineId, file]) => ({ lineId, file }));
  const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(result.requests, 2);
  assert.equal(result.blocked, null);
  assert.equal(state.creativeStage?.pause, undefined, '全部通过不留暂停记录');
  assert.equal(state.creative.acceptance, undefined, '模型通过不等于人工接受');
  assert.throws(() => requireAcceptedAudio(state), /STORYBOARD_REQUIRES_ACCEPTED_AUDIO/);
  // The manual entry reviews the same way and saves its own summary (it can never write an acceptance).
  writeJson(f.stateFile, state); // the automatic stage wrote its records into the state; the entry reads from disk
  const manual = await runToneReviews(f.context, ['ln01'], { client: h.client, log: () => {} });
  assert.equal(manual.requests, 0, '同输入手动入口也复用已有结论');
  assert.equal(manual.verdicts.ln01, 'pass');
  assert.ok(!('acceptance' in readJson(f.stateFile).creative));
  const acceptance = recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media });
  assert.equal(acceptance.status, 'accepted');
  assert.equal(acceptance.toneReview.status, 'human-accepted');
  assert.match(acceptance.toneReview.note, /不代替试听/);
  assert.deepEqual(acceptance.toneReview.lines.map(gate => [gate.lineId, gate.decision]), [['ln01', 'pass'], ['ln02', 'pass']]);
  assert.equal(requireAcceptedAudio(state).basis.byLine.ln01, 'measured', '接受仍带来本地实测时长');
});

test('a failure, an unclear hearing or a missing ability cannot be accepted silently', async () => {
  for (const [mode, verdict, code] of [['fail', 'fail', 'CREATIVE_TONE_REVIEW_FAILED'],
    ['undetermined', 'undetermined', 'CREATIVE_TONE_REVIEW_UNDETERMINED'],
    ['unsupported', 'unsupported', 'CREATIVE_TONE_REVIEW_UNSUPPORTED']]) {
    const f = workspace();
    const { state } = authoredCreative(f);
    const h = harness(f, { modes: { ln01: mode } });
    const entries = Object.entries(f.takes).map(([lineId, file]) => ({ lineId, file }));
    const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
    assert.equal(result.blocked.verdict, verdict, mode);
    assert.equal(state.creativeStage.pause.code, code, mode);
    assert.equal(result.reviewed.find(record => record.lineId === 'ln02').verdict, 'pass', '另一段不受影响');
    // The ordinary acceptance command cannot quietly overrule it — with no reason or with an empty one.
    assert.throws(() => recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media }),
      /CREATIVE_TONE_REVIEW_NOT_PASSED:ln01/, mode);
    assert.throws(() => recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media, toneOverride: '' }),
      /CREATIVE_TONE_REVIEW_NOT_PASSED:ln01/, mode);
    assert.equal(state.creative.acceptance, undefined, mode);
    // An EXPLICIT decision does continue, and it keeps the model's own conclusion beside it.
    const acceptance = recordAcceptance(f.context, state, entries,
      { method: 'operator', media: f.media, toneOverride: '人工已试听，确认这句可用' });
    const gate = acceptance.toneReview.lines.find(item => item.lineId === 'ln01');
    assert.equal(gate.decision, 'accepted-despite-review', mode);
    assert.equal(gate.modelVerdict, verdict, mode);
    assert.equal(gate.override.reason, '人工已试听，确认这句可用');
    assert.equal(gate.override.preservedModelVerdict, verdict);
    writeJson(f.stateFile, state);
    const stored = readJson(f.stateFile).creative.toneReviews.ln01;
    assert.equal(stored.reviewStatus, 'overridden-by-user', mode);
    assert.equal(stored.verdict, verdict, '模型结论原样保留，不因为被接受而改写');
    assert.equal(stored.execution.status, EXECUTION.COMPLETED, mode);
  }
});

// ---------------------------------------------------------------- the operator's decision, and only it, recovers
test('a decision the operator already took for this input keeps standing, without a second reason or a second review', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const entries = Object.entries(f.takes).map(([lineId, file]) => ({ lineId, file }));
  const h = harness(f, { modes: { ln01: 'fail' } });
  const first = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(first.blocked.lineId, 'ln01');
  assert.equal(state.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_FAILED');
  // The operator reviews by ear and takes the explicit decision once, with its reason.
  const acceptance = recordAcceptance(f.context, state, entries,
    { method: 'operator', media: f.media, toneOverride: '人工已试听，这一句可用' });
  const decided = state.creative.toneReviews.ln01.humanDecision;
  assert.equal(state.creative.toneReviews.ln01.reviewStatus, 'overridden-by-user');
  assert.equal(decided.reason, '人工已试听，这一句可用');
  assert.equal(state.creative.toneReviews.ln01.verdict, 'fail', '模型结论原样保留');
  assert.equal(acceptance.toneReview.lines.find(gate => gate.lineId === 'ln01').decision, 'accepted-despite-review');
  // Running the same input again: the decision stands, the pause is lifted, and nothing is asked or paid for twice.
  const calls = h.calls.length;
  const ledger = readJson(path.join(f.directory, 'api-ledger.json')).entries.length;
  const second = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(second.requests, 0, '人工已决定的同输入不再重复审核');
  assert.equal(h.calls.length, calls, '没有第二次请求');
  assert.equal(readJson(path.join(f.directory, 'api-ledger.json')).entries.length, ledger, '没有第二次预留');
  assert.equal(second.blocked, null, '已有决定不再是阻塞项');
  assert.equal(state.creativeStage.pause, undefined, '暂停被撤销，不再有任何阻塞记录');
  assert.equal(second.human.ln01.reason, '人工已试听，这一句可用', '恢复流程里能看到当初的理由');
  assert.equal(second.human.ln01.preservedModelVerdict, 'fail');
  // The summary names the decision on its own; the model's verdict is still the model's, not a silent pass.
  assert.equal(state.creative.toneReviewSummary.verdicts.ln01, 'fail');
  assert.equal(state.creative.toneReviewSummary.humanDecisions.ln01.by, 'operator');
  assert.deepEqual(state.creative.toneReviewSummary.humanDecisionLines, ['ln01']);
  assert.match(state.creative.toneReviewSummary.humanDecisionNote, /未被当成通过/);
  // Re-accepting with a different reason does not rewrite the recorded decision or re-review anything...
  recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media, toneOverride: '换一个理由再确认一次' });
  assert.equal(state.creative.toneReviews.ln01.humanDecision.reason, '人工已试听，这一句可用');
  assert.equal(state.creative.toneReviews.ln01.humanDecision.at, decided.at, '原始理由与时间不被重写');
  assert.equal(h.calls.length, calls);
  // ...and the manual entry reports the standing decision the same way, never as a pass.
  writeJson(f.stateFile, state);
  const manual = await runToneReviews(f.context, ['ln01'], { client: h.client, log: () => {} });
  assert.equal(manual.requests, 0);
  assert.equal(manual.humanDecisions.ln01.reason, '人工已试听，这一句可用');
  assert.equal(manual.verdicts.ln01, 'fail');
  assert.equal(readJson(f.stateFile).creative.toneReviewSummary.humanDecisions.ln01.by, 'operator');
});

test('a tone pause is lifted once its segment passes on a re-review, never lingering as a phantom blocker', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const failing = harness(f, { modes: { ln01: 'fail' } });
  await toneReviewStage(f.context, state, { models: failing.models, media: f.media, save: () => {} });
  assert.equal(state.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_FAILED');
  // The take is re-recorded, so the recorded failure is about audio that no longer exists, and this input passes.
  f.media.command(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '1.8', '-ac', '1', f.takes.ln01]);
  const passing = harness(f);
  const result = await toneReviewStage(f.context, state, { models: passing.models, media: f.media, save: () => {} });
  assert.equal(result.blocked, null);
  assert.equal(result.requests, 1, '只有输入变化的那一句重做审核');
  assert.equal(state.creativeStage.pause, undefined, '旧暂停不再留着当幽灵阻塞');
  assert.equal(state.creativeStage.resumedBy.lineId, 'ln01');
  assert.equal(state.creativeStage.resumedBy.code, 'CREATIVE_TONE_REVIEW_FAILED');
  assert.equal(state.creativeStage.resumedBy.currentVerdict, 'pass');
  assert.match(state.creativeStage.resumedBy.note, /不再成立/);
  assert.equal(state.creative.toneReviewHistory.length, 1, '旧结论作为历史保留，不被删除');
  // A pause that still holds is left exactly where it is: nothing here clears a live blocker.
  const still = workspace();
  const stillState = authoredCreative(still).state;
  const held = harness(still, { modes: { ln01: 'fail' } });
  await toneReviewStage(still.context, stillState, { models: held.models, media: still.media, save: () => {} });
  await toneReviewStage(still.context, stillState, { models: held.models, media: still.media, save: () => {} });
  assert.equal(stillState.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_FAILED', '仍然成立的暂停保持原样');
  assert.equal(stillState.creativeStage.resumedBy, undefined);
});

test('an unusable take is never sent for judgement and can never be accepted by confirming the tone', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const broken = path.join(f.root, 'broken.wav');
  fs.writeFileSync(broken, '这不是音频，只是一个同名文件');
  state.creative.audio.ln01 = { ...state.creative.audio.ln01, file: broken, hash: fileHash(broken) };
  const h = harness(f);
  const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(h.calls.filter(call => call.lineId === 'ln01').length, 0, '本地技术检查未过就不发请求');
  assert.equal(state.creative.toneReviews.ln01.execution.status, EXECUTION.BLOCKED_TECHNICAL);
  assert.equal(state.creative.toneReviews.ln01.verdict, null);
  assert.match(state.creativeStage.pause.code, /CREATIVE_TONE_AUDIO_INVALID|CREATIVE_TONE_REVIEW_UNRESOLVED/);
  assert.equal(result.blocked.lineId, 'ln01');
  const entries = [{ lineId: 'ln01', file: broken }, { lineId: 'ln02', file: f.takes.ln02 }];
  for (const options of [{}, { toneOverride: '人工确认可用' }])
    assert.throws(() => recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media, ...options }),
      /AUDIO_NOT_USABLE|INVALID_MEDIA|CREATIVE_TONE_AUDIO_INVALID/, '技术无效音频不能靠人工语气确认通过');
});
// ---------------------------------------------------------------- reuse, invalidation and recovery
test('the same input is never reviewed twice, and a revision number cannot manufacture a new review', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f);
  const first = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(first.requests, 2);
  assert.equal(h.calls.length, 2);
  const operations = fs.readdirSync(f.opsDir).sort();
  const ledger = readJson(path.join(f.directory, 'api-ledger.json')).entries.length;
  const second = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(second.requests, 0, '同输入恢复零重复审核');
  assert.deepEqual(second.reviewed.map(record => record.reused), [true, true]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(fs.readdirSync(f.opsDir).sort(), operations, '没有新的操作记录');
  assert.equal(readJson(path.join(f.directory, 'api-ledger.json')).entries.length, ledger, '没有新的预留');
  // The operation follows the CONTENT: a bumped revision number, a renamed base or a different model label cannot
  // turn the same input into a fresh review.
  state.revisions[toneReviewBase(f.config.audioReview.model, 'ln01')] = 7;
  const third = await analyzeLineTone(f.context, { creative: state.creative, lineId: 'ln01', models: h.models, media: f.media });
  assert.equal(third.reused, true);
  assert.equal(h.calls.length, 2);
  assert.equal(third.operation, second.reviewed.find(record => record.lineId === 'ln01').operation);
});

test('changed audio or changed performance goals make the old conclusion unusable', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f);
  const entries = Object.entries(f.takes).map(([lineId, file]) => ({ lineId, file }));
  await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  const before = state.creative.toneReviews.ln01.binding;
  recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media });
  assert.equal(requireAcceptedAudio(state).basis.byLine.ln01, 'measured');
  // Re-record the take at the same path: the content digest changes, so the old conclusion no longer applies.
  f.media.command(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '1.8', '-ac', '1', f.takes.ln01]);
  const changed = toneReviewBinding(f.context, state.creative, 'ln01');
  assert.notEqual(changed, before);
  assert.equal(toneReviewBinding(f.context, state.creative, 'ln02'), state.creative.toneReviews.ln02.binding,
    '没变的那句结论不受影响');
  assert.throws(() => requireAcceptedAudio({ creative: { ...state.creative,
    audio: { ...state.creative.audio, ln01: { ...state.creative.audio.ln01, duration: f.media.audio(f.takes.ln01).duration,
      measuredBy: 'ffprobe@acceptance' } } } }), /STORYBOARD_AUDIO_CHANGED|STORYBOARD_REQUIRES_ACCEPTED_AUDIO/);
  // The acceptance gate refuses the stale review, with an override or without one.
  for (const options of [{}, { toneOverride: '人工确认可用' }])
    assert.throws(() => recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media, ...options }),
      /CREATIVE_TONE_REVIEW_STALE:ln01/);
  // ...and re-taking the review is exactly what unblocks it (only the changed segment is re-reviewed).
  const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(result.requests, 1, '只有输入变化的那一句重做审核');
  assert.equal(h.calls.filter(call => call.lineId === 'ln01').length, 2);
  assert.equal(state.creative.toneReviewHistory.length, 1, '旧结论作为历史保留');
  assert.equal(state.creative.toneReviewHistory[0].lineId, 'ln01');
  assert.match(state.creative.toneReviewHistory[0].reason, /输入已变化/);
  assert.equal(state.creative.toneReviewHistory[0].review.binding, before);
  assert.equal(state.creative.toneReviews.ln01.binding, changed);
  assert.equal(recordAcceptance(f.context, state, entries, { method: 'operator', media: f.media })
    .toneReview.lines.find(gate => gate.lineId === 'ln01').decision, 'pass');
  // A changed PERFORMANCE GOAL is the same kind of change: it travels in the request and in the binding.
  state.creative.voicePlan.lines[0] = { ...state.creative.voicePlan.lines[0],
    performance: { ...state.creative.voicePlan.lines[0].performance, tone: '渐渐坚定' } };
  const goalBinding = toneReviewBinding(f.context, state.creative, 'ln01');
  assert.notEqual(goalBinding, changed, '表演目标变化改变绑定');
  const reReview = await analyzeLineTone(f.context, { creative: state.creative, lineId: 'ln01', models: h.models, media: f.media });
  assert.equal(h.calls.at(-1).prompt.includes('渐渐坚定'), true, '新的表演目标进入审核依据');
  assert.equal(reReview.binding, goalBinding);
  assert.equal(state.creative.toneReviewHistory.length, 2);
});

test('a recorded take without a review is still reviewed on resume', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  // Both takes already exist, so generation would be skipped for every line: the review must not be skipped with it.
  delete state.creative.toneReviews;
  delete state.creative.audio.ln01.toneReview;
  const h = harness(f);
  const result = await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  assert.equal(result.requests, 2, '已有配音不会把审核一起跳过');
  assert.ok(h.calls.every(call => call.kind === 'tone'), '没有重新配音：只发审核请求');
  assert.deepEqual(Object.keys(state.creative.toneReviews).sort(), ['ln01', 'ln02']);
  assert.equal(state.creative.audio.ln02.toneReview.execution, EXECUTION.COMPLETED);
});
// ---------------------------------------------------------------- budget, legacy path and isolation
test('the attempt budget is bound to the logical segment and its effective input, not to an operation name', async () => {
  const f = workspace();
  authoredCreative(f);
  const h = harness(f);
  const attempt = (id, basisDigest = 'same-input-digest') => h.models.audioToneReview(id, { lineId: 'ln01',
    audio: f.takes.ln01, audioHash: fileHash(f.takes.ln01), expectedTextHash: hash('臣等正欲死战'),
    basisDigest, prompt: '本段编号 ln01；同一有效输入的审核请求', reservationCents: 20 });
  // One first request plus three controlled retries; a NEW operation name for the same effective input does not add
  // budget, because the logical unit and the input digest are what the ledger counts (the suffix is stripped).
  const names = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd'];
  for (const suffix of names) await attempt('tone-review-x-ln01-' + suffix);
  assert.equal(h.calls.length, 4);
  await assert.rejects(() => attempt('tone-review-x-ln01-eeeeeeeeeeee'), /CHECK_ATTEMPTS_EXHAUSTED/);
  assert.equal(h.calls.length, 4, '超限后不再发送');
  const budget = h.attempts.checkSummary().find(item => item.key.startsWith('tone-review-x-ln01'));
  assert.ok(budget.exhausted, '上限被持久化，不会因为换操作名或重启而重置');
  assert.equal(budget.attempts, 4);
  // A genuinely different input is a genuinely different review, with its own budget.
  await attempt('tone-review-x-ln01-ffffffffffff', 'different-input-digest');
  assert.equal(h.calls.length, 5);
});

test('the legacy shot-based audio review keeps its own protocol, naming and records', async () => {
  const f = workspace();
  writeJson(f.stateFile, { version: 1, productionId: production.id, characters: {}, approvals: {}, revisions: {},
    assets: { shot01: { speechRaw: f.takes.ln01, audio: f.takes.ln01 } },
    timed: { shots: [{ id: 'shot01', type: 'narration', text: '臣等正欲死战', duration: 2.4 }] } });
  const h = harness(f);
  const result = await runAudioReviews(f.context, ['shot01'], { client: h.client, log: () => {} });
  assert.equal(result.requests, 1);
  const call = h.calls[0];
  assert.equal(call.kind, 'legacy');
  assert.match(call.prompt, /expressiveness/);
  assert.ok(!call.prompt.includes('配音表演审核模型'), '旧路径不套用创作审核协议');
  const record = readJson(f.stateFile).audioReviews.shot01;
  assert.equal(record.operation, 'audio-review-qwen38omniflash-shot01-r0', '旧操作号不变');
  assert.equal(record.promptVersion, f.config.audioReview.promptVersion);
  assert.equal(record.input.source, 'speechRaw');
  assert.equal(record.performance.expressiveness, 'moderate');
  assert.equal(record.performance.basis.includes('不是用户验收'), true);
  assert.equal(record.textCheck.expected, '臣等正欲死战');
  assert.equal(record.textCheck.normalizedMatch, true);
  assert.equal(record.reviewStatus, 'awaiting-user-acceptance');
  assert.ok(fs.existsSync(path.join(f.directory, 'audio-review', 'shot01.json')));
  // The two protocols refuse each other's answers instead of half-reading them.
  const answer = payload => ({ request: async () => ({ choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify(payload) } }] }) });
  const models = h.models;
  const toneShaped = new Models(f.config, new Operations(path.join(f.directory, 'operations'), answer(tonePayload('ln01', 'pass')),
    h.budget, () => {}, 15, 600, h.attempts), f.media, path.join(f.directory, 'vision-cache'));
  await assert.rejects(() => toneShaped.audioReview('audio-review-shape-shot01-r0', { shotId: 'shot01',
    shotTextHash: hash('x'), audio: f.takes.ln01, prompt: 'legacy prompt', reservationCents: 20 }),
  /AUDIO_REVIEW_SHAPE_INVALID/);
  const legacyShaped = new Models(f.config, new Operations(path.join(f.directory, 'operations'), answer(legacyPayload('shot01')),
    h.budget, () => {}, 15, 600, h.attempts), f.media, path.join(f.directory, 'vision-cache'));
  await assert.rejects(() => legacyShaped.audioToneReview('tone-review-shape-ln01', { lineId: 'ln01', audio: f.takes.ln01,
    audioHash: fileHash(f.takes.ln01), expectedTextHash: hash('臣等正欲死战'), basisDigest: 'b', prompt: 'tone prompt',
    reservationCents: 20 }), /TONE_REVIEW_SHAPE_INVALID/);
  assert.equal(models.audioToneReview !== undefined && models.audioReview !== undefined, true);
});

test('the offline suite leaves the real switch, the real task directory and the provider alone', () => {
  assert.equal(readJson(path.join(ROOT, 'config/aliyun.json')).onlineEnabled, false, '真实联网开关不得被改动');
  assert.ok(!fs.existsSync(path.join(ROOT, 'jobs', 'aliyun', production.id)), '不创建真实任务目录');
});


test('a standing human decision never overrides a new technical failure', async () => {
  const f = workspace();
  const { state } = authoredCreative(f);
  const h = harness(f, { modes: { ln01: 'fail' } });
  await toneReviewStage(f.context, state, { models: h.models, media: f.media, save: () => {} });
  recordAcceptance(f.context, state, Object.entries(f.takes).map(([lineId, file]) => ({ lineId, file })),
    { method: 'operator', media: f.media, toneOverride: '离线模拟人工确认' });
  const calls = h.calls.length;
  const rejectedMedia = { audio: file => {
    if (file === state.creative.audio.ln01.file) throw new Error('AUDIO_NOT_USABLE');
    return f.media.audio(file);
  } };
  const result = await toneReviewStage(f.context, state,
    { models: h.models, media: rejectedMedia, save: () => {} });
  assert.equal(result.blocked?.lineId, 'ln01');
  assert.equal(result.blocked.execution.status, EXECUTION.BLOCKED_TECHNICAL);
  assert.equal(result.human.ln01, undefined);
  assert.equal(h.calls.length, calls);
});
