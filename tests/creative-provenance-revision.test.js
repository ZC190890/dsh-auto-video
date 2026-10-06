// Provenance (where a statement came from and what was really confirmed), the duration basis (hard limit /
// estimate / measurement) and the ONE controlled way to revise a creative setting are exercised offline here.
// No provider is contacted and no real task, ledger, history or acceptance record is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appearanceLabel, castLine, characterBible, directorScript, durationLedger, frameRequest, invalidations,
  requirementBrief, sceneBible, staleSettingShots, storyboard, storyboardTimeline, sourceLabel,
  voicePlan } = require('../services/aliyun/creative');
const { audioLines, creativeAuthority, creativePlaceholderTimed, measuredDurations, recordCreativeAuthority,
  requireAcceptedAudio, requirementsPrompt, sceneBiblePrompt } = require('../workflows/creative');
const { settingStalePause } = require('../workflows/creative-stage');
const { reviseCreative, revisionOperations } = require('../workflows/creative-revise');
const { loadContext } = require('../workflows/production');
const { unitForOperation } = require('../services/aliyun/units');
const { Budget } = require('../services/aliyun/budget');
const { fileHash, hash, readJson, writeJson } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

const production = { id: 'provenance-film', description: '姜维读简（离线夹具）', style: '国风插画',
  targetDurationSeconds: 4, maxDurationSeconds: 60, creative: true, creativeFixture: true,
  characters: [{ id: 'jiang_wei', name: '姜维', image: 'hero.png',
    referenceCoverage: { image: { covers: ['identity', 'costume'] } } }, { id: 'narrator', name: '旁白' }] };
const realTask = { ...production, creativeFixture: false };
const requirementsPayload = () => ({ mustKeep: [{ id: 'mk_line', kind: 'line', text: '臣等正欲死战',
  source: 'user', note: '指定台词逐字保留' }], style: '国风插画', aspect: '16:9', targetSeconds: 4, maxSeconds: 60,
  prohibitions: ['不得出现字幕与水印'], expandable: [{ area: '帐外营地的宿帐分组', serves: '可信空间与生活状态' }],
  unknowns: ['未提供完整剧本原文'], conflicts: [] });
const directorPayload = () => ({ title: '帐中读简（夹具）', theme: '读简后抬眼看营地',
  segments: [{ id: 'seg01', purpose: '交代营帐内的阅读', covers: ['mk_line'], characters: ['jiang_wei'],
    entry: { state: '手持竹简坐于案前', motivation: '确认军令内容' },
    beats: { cause: '读到关键句', action: '低声诵读', reaction: '呼吸一滞', result: '抬头' },
    performance: { tone: '低沉克制', pauses: ['念完停半拍'], breath: '吸气压住情绪', gaze: '由竹简抬起',
      expression: '眉峰收紧', posture: '上身微前倾' },
    space: '帐内案前，右侧火盆，帐帘在左', props: ['竹简'],
    spoken: [{ id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战', covers: ['mk_line'] }],
    ambience: ['帐外风声'], silence: ['念完后的静默半拍'], shotIntent: '近景推向中景',
    endState: '抬头，视线离开竹简', nextHandoff: '下一段望向帐外', creative: ['火盆微光映在竹简上'], unknown: [] }] });
const charactersPayload = { entries: [
  { id: 'jiang_wei', name: '姜维', version: 1, refs: ['hero.png'], confirmed: { face: '方脸，浓眉', hair: '束发戴冠',
    costume: '深色甲袍', accessories: '腰间短剑', weapon: '短剑入鞘', palette: '深灰与暗红', materials: '皮革与旧布' },
    weaponSide: '短剑挂在左侧腰间', unknown: ['靴面细节看不清'], source: 'reference', status: 'unverified' },
  { id: 'narrator', name: '旁白', version: 1, refs: ['hero.png'], confirmed: { face: '不出画', hair: '不出画',
    costume: '不出画', accessories: '不出画', weapon: '不出画', palette: '不出画', materials: '不出画' },
    weaponSide: null, unknown: ['旁白不出画'], source: 'creative', status: 'creative' }] };
const scenesPayload = { entries: [
  { id: 'tent', name: '主帐内外', version: 1, scale: '主帐宽约四步', directions: { north: '画面右后方',
    entrance: '左侧帐帘', roads: ['帐前主路通向画左'] }, structures: ['主帐木架与厚布'], materials: ['粗布', '原木'],
    wear: ['布面烟熏发暗'], props: ['案几', '竹简', '火盆'], light: { position: '帐内火盆', direction: '自右下向左上',
      warmth: '暖黄', coverage: '照亮案几与人物半侧' }, weather: '夜，无雨', wind: '偏北风', people: ['帐内一人'],
    boundary: ['画面右后方为营帐群'], fixed: ['主帐木架'], variable: ['火盆火苗高度'], source: 'creative', status: 'creative' },
  { id: 'camp', name: '营地', version: 1, scale: '营地纵深约四十步', directions: { north: '画面深处',
    entrance: '营门木栅', roads: ['主路自画左下向右上'] }, structures: ['宿帐与木栅'], materials: ['粗布', '原木'],
    wear: ['帐布有雨痕'], props: ['木桶'], light: { position: '营门内侧两盏营火', direction: '自左下向右上',
      warmth: '暖橙', coverage: '照亮主路中段' }, weather: '夜间低云', wind: '无风',
    people: ['两名守卫', '四人巡逻队'], boundary: ['最远处为山影'], fixed: ['木栅'], variable: ['火苗高度'],
    source: 'creative', status: 'creative' }] };
const lines = () => [{ id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战' }];
const durations = { ln01: 2.4 };
const voicePlanPayload = () => ({ lines: lines().map(line => ({ ...line,
  performance: { tone: '低沉克制', pauses: ['念完停半拍'], breath: '吸气压住情绪', silence: ['念完后的静默半拍'] },
  notSpoken: ['“死战”二字不要喊出来'],
  durationEstimate: { method: 'character-rate', seconds: 2.6, uncertaintySeconds: 0.6, rate: 5,
    characters: [...line.text].length, basis: '按每秒 5 字估算' } })) });
const cast = (extra = {}) => ({ id: 'jiang_wei', position: '画面左侧案前', facing: '朝向画面右前方',
  posture: '坐姿，重心落在髋部', hands: '双手持竹简，右手在上', props: ['竹简'], gaze: '视线落在竹简上',
  occlusion: '帐帘在前景右侧遮挡三分之一画面', costume: '深色甲袍，腰间短剑入鞘', ...extra });
const castState = (extra = {}) => [{ id: 'jiang_wei', position: '画面左侧案前', facing: '朝向画面右前方',
  posture: '坐姿', hands: '双手持竹简', props: ['竹简'], gaze: '视线落在竹简上', occlusion: '未见遮挡',
  costume: '深色甲袍', ...extra }];
const extraGuard = () => ({ id: 'guard_a', label: '守卫甲', group: '营门守卫', position: '画面中景偏左',
  facing: '面朝画外右前方', posture: '站姿，重心在右腿', hands: '右手持矛贴肩', props: ['长矛'],
  gaze: '视线平视画外', action: '静止值守', visible: '全身可见，腰部以下被木栅略挡', costume: null });
// Four shots in TWO runs: scene tent appears at index 0 and again at index 2, so a scene change must compute
// every run (each with its own boundary neighbours) instead of assuming one contiguous block.
const shotsPayload = () => ([
  { id: 'shot01', purpose: '读简', covers: ['mk_line'], segments: [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 1 }],
    start: 0, end: 1, vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 1 秒' }, characters: [cast()],
    scene: { id: 'tent', version: 1 }, startState: '双手持简坐于案前', endState: '读到一半停住', camera: '近景',
    transition: 'continuous', drivingLine: 'ln01',
    first: { moment: '双手持简低头阅读的一刻', composition: '近景，竹简占画面下三分之一', bans: ['不得出现文字字幕'],
      visibleEnvironment: ['低案与竹简占画面下三分之一'], castState: castState(), extraCast: [] },
    last: { moment: '读到一半停住的一刻', composition: '近景，人物占画面中央', visibleEnvironment: ['案上竹简与火盆一角'],
      castState: castState({ gaze: '视线仍在竹简上', hands: '右手按住竹简' }), extraCast: [] },
    action: { phases: ['起势：吸气', '主动作：念到停住', '收势：闭嘴'], speed: 1, secondary: ['火盆火苗轻晃'],
      settle: '停在停住姿态', continuity: ['停住后抬眼'] } },
  { id: 'shot02', purpose: '营地环境', covers: ['mk_line'], segments: [], start: 1, end: 2.4,
    vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 1.4 秒' }, characters: [],
    castNote: '本镜是无人物入画的环境镜头：摄影机切到帐外营地，姜维仍在帐内但不在本镜任何一帧画内',
    scene: { id: 'camp', version: 1 }, startState: '读到一半停住（姜维在帐内）', endState: '主路空镜', camera: '中远景',
    transition: 'scene', drivingLine: null,
    first: { moment: '巡逻队刚入画的一刻', composition: '中远景，主路自画左下向右上',
      crowdCostume: '群演共用衣着：深蓝灰短袍、束腰带、皮护腕',
      visibleEnvironment: ['主路自画左下向右上延伸', '两组宿帐在路左，营门木栅在画面中部'],
      extraCast: [extraGuard()] },
    last: { moment: '守卫静止值守的一刻', composition: '中远景，营门木栅与主路',
      crowdCostume: '群演共用衣着：深蓝灰短袍、束腰带、皮护腕',
      visibleEnvironment: ['主路空着，木栅与宿帐可见'], extraCast: [extraGuard()] },
    action: { phases: ['起势：镜头越过帐帘', '主动作：主路空镜', '收势：停在营地'], speed: 1, secondary: ['营火轻晃'],
      settle: '镜头静止', continuity: [] } },
  { id: 'shot03', purpose: '念完并抬眼', covers: ['mk_line'], segments: [{ lineId: 'ln01', sourceStart: 1, sourceEnd: 2.4 }],
    start: 2.4, end: 3.8, vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 1.4 秒' }, characters: [cast()],
    scene: { id: 'tent', version: 1 }, startState: '读到一半停住', endState: '抬眼看向帐帘', camera: '近景推中景',
    transition: 'scene', drivingLine: 'ln01',
    first: { moment: '念到句末停住的一刻', composition: '近景，人物占画面中央', visibleEnvironment: ['案上竹简与火盆一角'],
      castState: castState(), extraCast: [] },
    last: { moment: '抬眼看向帐帘的一刻', composition: '中景，帐帘在画面左', visibleEnvironment: ['帐帘在画面左前景'],
      castState: castState({ gaze: '视线离开竹简，看向帐帘方向', position: '画面中央偏左' }), extraCast: [] },
    action: { phases: ['起势：念完最后两字', '主动作：停半拍', '收势：抬眼'], speed: 1, secondary: ['火盆火苗轻晃'],
      settle: '停在抬眼姿态', continuity: [] } },
  { id: 'shot04', purpose: '营地收尾', covers: ['mk_line'], segments: [], start: 3.8, end: 5.2,
    vendor: { modelSeconds: 2, coverage: 'trim', note: '只取前 1.4 秒' }, characters: [],
    castNote: '本镜仍是环境镜头：画面停在营地上方，无人物入画', scene: { id: 'camp', version: 1 },
    startState: '抬眼后镜头切到营地', endState: '画面停在营地上方', camera: '远景升高', transition: 'scene', drivingLine: null,
    first: { moment: '营地全景静止的一刻', composition: '远景，宿帐分三组', visibleEnvironment: ['宿帐分三组自近到远排开'],
      extraCast: [] },
    last: { moment: '画面升高后停住的一刻', composition: '远景，营地上方与山影', visibleEnvironment: ['最远处只剩山影轮廓'],
      extraCast: [] },
    action: { phases: ['起势：镜头升高', '主动作：营地全景', '收势：停住'], speed: 1, secondary: [], settle: '镜头静止',
      continuity: [] } }]);
function packageParts() {
  const requirements = requirementBrief(requirementsPayload(), production);
  const characterIds = production.characters.map(item => item.id);
  const directorScriptValue = directorScript(directorPayload(), { requirements, characterIds });
  const characters = characterBible(charactersPayload, { production });
  const scenes = sceneBible(scenesPayload, { production, requirements });
  const voice = voicePlan(voicePlanPayload(), { director: directorScriptValue, characterIds, requirements });
  const board = storyboard({ audioBinding: 'b1', shots: shotsPayload() },
    { durations, acceptedBinding: 'b1', lines: lines(), characters, scenes, sceneVersion: 1,
      allowedVendorSeconds: [2], maxSeconds: 60, requirements });
  const timeline = storyboardTimeline(board, { durations, audioFiles: { ln01: 'ln01.wav' }, titles: { ln01: '臣等正欲死战' } });
  return { requirements, directorScript: directorScriptValue, characters, scenes, voicePlan: voice, board, timeline };
}

// ---------------------------------------------------------------- an offline workspace with a real job layout
// A controlled revision is exercised on the real workspace SHAPE (config, job directory and state.json) with no
// provider reachable: nothing here submits, quotes or spends, and no existing task directory is touched.
function workspace(manifest = production) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'prov-rev-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: false };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'config/project.json'), readJson(path.join(ROOT, 'config/project.json')));
  writeJson(path.join(root, 'production.json'), { ...manifest, characters: manifest.characters.map(character => ({
    image: 'hero.png', voiceSample: 'voice.wav', ...character })) });
  const context = loadContext(root, 'production.json');
  return { root, context, config, directory: context.directory, stateFile: path.join(context.directory, 'state.json'),
    opsDir: path.join(context.directory, 'operations'), ledgerFile: path.join(context.directory, 'api-ledger.json') };
}
// The authored package as it stands after the authoring stage: ONE authority record, a MEASURED take for ln01 and
// an acceptance bound to that take. The binding is built exactly the way recordAcceptance binds it, so the
// acceptance gate really evaluates this fixture instead of being bypassed by a hand-written flag.
function authoredPackage(f) {
  const parts = packageParts();
  const audioFile = path.join(f.root, 'take-ln01.wav');
  fs.writeFileSync(audioFile, Buffer.from('fixture-take'));
  const creative = { version: 1, requirements: parts.requirements, directorScript: parts.directorScript,
    characters: parts.characters, scenes: parts.scenes, voicePlan: parts.voicePlan, storyboard: parts.board,
    timeline: parts.timeline, audio: { ln01: { file: audioFile, duration: durations.ln01,
      measuredBy: 'ffprobe@acceptance', estimate: parts.voicePlan.lines[0].durationEstimate } } };
  creative.acceptance = { status: 'accepted', method: 'operator', at: new Date().toISOString(),
    durationBasis: { basis: 'measured', measuredBy: 'ffprobe@acceptance' }, measuredBy: 'ffprobe',
    measured: { ln01: durations.ln01 },
    binding: hash(audioLines(creative).map(line => ({ id: line.id, text: line.text,
      file: creative.audio[line.id]?.file ? fileHash(creative.audio[line.id].file) : null }))) };
  recordCreativeAuthority(creative, { by: 'authoring' });
  return creative;
}
const SHOT_IDS = ['shot01', 'shot02', 'shot03', 'shot04'];
// Every shot already has frames, a video and the checks taken against them, and the film was composed.
function authoredState(f) {
  const creative = authoredPackage(f);
  creative.frames = Object.fromEntries(SHOT_IDS.map(id => [id, { firstPrompt: id + ' 旧首帧提示词', lastPrompt: id + ' 旧尾帧提示词' }]));
  creative.videos = Object.fromEntries(SHOT_IDS.map(id => [id, { file: id + '.mp4' }]));
  creative.actions = Object.fromEntries(SHOT_IDS.map(id => [id, { prompt: id + ' 旧动作提示词' }]));
  creative.composition = { output: 'output/final.mp4', inputDigest: 'old-digest' };
  const products = id => ({ first: id + '-first.png', last: id + '-last.png', frameReview: { ok: true },
    video: id + '.mp4', videoInfo: { seconds: 1.4 }, videoReview: { ok: true }, referencePlan: { used: 1 },
    adjacentReview: { ok: true }, drivingAudio: id + '-drive.wav' });
  return { version: 1, productionId: production.id, characters: {}, approvals: {}, revisions: {},
    assets: Object.fromEntries(SHOT_IDS.map(id => [id, products(id)])),
    adjacencyReviews: { shot02: { ok: true }, shot04: { ok: true } }, stage: 'final',
    output: 'output/final.mp4', preview: 'output/preview.mp4', acceptance: 'awaiting_user_playback',
    timed: { shots: SHOT_IDS.map(id => ({ id, duration: 5 })) }, creative };
}
function writeAuthored(f) { const state = authoredState(f); writeJson(f.stateFile, state); return state; }
function snapshot(f) {
  return { state: fs.existsSync(f.stateFile) ? fileHash(f.stateFile) : null,
    ledger: fs.existsSync(f.ledgerFile) ? fileHash(f.ledgerFile) : null,
    ops: fs.existsSync(f.opsDir)
      ? fs.readdirSync(f.opsDir).sort().map(name => name + ':' + fileHash(path.join(f.opsDir, name))).join(',') : '' };
}
function writeOp(f, id, status) {
  writeJson(path.join(f.opsDir, id + '.json'), { id, status, spec: { id }, at: new Date().toISOString() });
}

// ---------------------------------------------------------------- provenance reaches the request
test('the source and what was really confirmed survive planning and reach the assembled request', () => {
  const requirements = requirementBrief(requirementsPayload(), production);
  const characterIds = production.characters.map(item => item.id);
  const director = directorScript(directorPayload(), { requirements, characterIds });
  // The planning INPUT asks for the source itself and for the two axes to be kept apart...
  assert.match(requirementsPrompt(production, null), /来源规则：user=用户明确指定/);
  assert.match(requirementsPrompt(production, null), /不得自行宣称已核实/);
  assert.match(sceneBiblePrompt(production, requirements, director), /来源与确认状态是两件事/);
  assert.match(sceneBiblePrompt(production, requirements, director), /只有真看过参考图才写 status=analyzed/);
  // ...the accepted response keeps them apart, and what the user SAID is not promoted to "every detail confirmed".
  const parts = packageParts();
  const line = parts.requirements.mustKeep[0];
  assert.equal(line.source, 'user');
  assert.equal(line.status, 'unverified');
  assert.match(sourceLabel(line), /^用户指定（用户提供的素材不等于其中每个细节都已确认）/);
  const person = parts.characters.entries.find(entry => entry.id === 'jiang_wei');
  assert.deepEqual({ refs: person.refs, analyzedRefs: person.analyzedRefs, source: person.source, status: person.status },
    { refs: ['hero.png'], analyzedRefs: [], source: 'reference', status: 'unverified' });
  assert.equal(sourceLabel(person), '参考素材（素材：hero.png）（关联素材；其中的内容未逐项确认，只作保守保留）');
  // A setting the picture only needed is recorded as a creative addition, never as a user statement.
  assert.match(sourceLabel(parts.scenes.entries.find(entry => entry.id === 'tent')), /^创作补充（为叙事与画面提出/);
  // Every setting a shot was built from is recorded on the shot with id, version AND source.
  const shot = parts.board.shots[0];
  assert.deepEqual(shot.settings.scene, { id: 'tent', version: 1, source: 'creative', status: 'creative' });
  assert.deepEqual(shot.settings.characters, [{ id: 'jiang_wei', version: 1, source: 'reference', status: 'unverified' }]);
  // The request the picture model receives repeats the same distinction, so an unanalysed reference is never
  // presented to it as a confirmed appearance.
  const first = frameRequest(shot, { characters: parts.characters, scenes: parts.scenes, kind: 'first' });
  assert.match(first, /本帧设定依据（ID\/版本\/来源）：tent（场景设定 v1，创作补充（为叙事与画面提出，不是用户指定，也不是历史事实））/);
  assert.match(first, /；jiang_wei（人物设定 v1，参考素材（素材：hero.png）（关联素材；其中的内容未逐项确认，只作保守保留））/);
  assert.match(first, /① 姜维（jiang_wei）：参考素材外观（未逐项确认）（方脸，浓眉、束发戴冠、深色甲袍、腰间短剑、短剑入鞘、深灰与暗红、皮革与旧布）/);
  assert.match(first, /；设定来源：参考素材（素材：hero.png）（关联素材；其中的内容未逐项确认，只作保守保留）（设定集 v1）/);
  assert.ok(!first.includes('已确认外观'), '没有分析过参考图时不得把外观写成“已确认外观”');
});

test('an appearance label never claims more evidence than it has, and a fixture cannot pass for user material', () => {
  assert.equal(appearanceLabel({ source: 'reference', status: 'analyzed', analyzedRefs: ['hero.png'] }), '已确认外观');
  assert.equal(appearanceLabel({ source: 'reference', status: 'unverified' }), '参考素材外观（未逐项确认）');
  assert.equal(appearanceLabel({ source: 'user', status: 'provided' }), '用户提供的外观');
  assert.equal(appearanceLabel({ source: 'verified', status: 'provided' }), '已核对外观');
  assert.equal(appearanceLabel({ source: 'fixture', status: 'unverified' }), '离线夹具外观（不代表用户素材）');
  assert.equal(appearanceLabel({ source: 'creative', status: 'creative' }), '创作设定的外观（不是用户指定）');
  // An unknown or missing source never earns a stronger label than the creative fallback.
  assert.equal(appearanceLabel({ source: 'unknown-source', status: 'unverified' }), '创作设定的外观（不是用户指定）');
  assert.equal(appearanceLabel({}), '创作设定的外观（不是用户指定）');
  // A person with no bible entry is given no appearance at all, and the line says so twice instead of inventing one.
  const stranger = { id: 'extra_person', position: '帐门内侧', facing: '朝外', posture: '站立', hands: '空手', props: [],
    gaze: '看向远处', occlusion: '半身可见', costume: '旧布短衣' };
  const strangerLine = castLine(stranger, { entries: [] });
  assert.match(strangerLine, /extra_person（extra_person）：没有设定集条目，外观只按本帧文字描述/);
  assert.match(strangerLine, /；设定来源：没有设定集条目，外观只按本帧文字描述$/);
  // "analyzed" needs the material the analysis actually covered: having a file is not having looked at it.
  assert.throws(() => characterBible({ entries: charactersPayload.entries.map(entry => entry.id === 'jiang_wei'
    ? { ...entry, status: 'analyzed' } : entry) }, { production }), /BIBLE_CHARACTER_ANALYZED_UNPROVEN:jiang_wei/);
  assert.doesNotThrow(() => characterBible({ entries: charactersPayload.entries.map(entry => entry.id === 'jiang_wei'
    ? { ...entry, status: 'analyzed', analyzedRefs: ['hero.png'] } : entry) }, { production }));
  // A fixture entry may only exist on a task that declares itself an offline fixture.
  const asFixture = entry => ({ ...entry, source: 'fixture' });
  assert.throws(() => characterBible({ entries: charactersPayload.entries.map(entry => entry.id === 'jiang_wei'
    ? asFixture(entry) : entry) }, { production: realTask }), /BIBLE_CHARACTER_FIXTURE_IN_REAL_TASK:jiang_wei/);
  assert.doesNotThrow(() => characterBible({ entries: charactersPayload.entries.map(entry => entry.id === 'jiang_wei'
    ? asFixture(entry) : entry) }, { production }));
});

// ---------------------------------------------------------------- duration basis: hard limit / estimate / measurement
test('an estimate is never a measurement, and only a measurement may stop the flow', () => {
  const parts = packageParts();
  const estimated = durationLedger({ voicePlan: parts.voicePlan }, { maxSeconds: 60 });
  assert.equal(estimated.basis, 'estimated');
  assert.equal(estimated.lines[0].basis, 'estimated');
  assert.equal(estimated.lines[0].measuredBy, null);
  assert.deepEqual(estimated.measured.ids, [], '估计时长绝不进入实测集合');
  assert.deepEqual(estimated.estimated.ids, ['ln01']);
  assert.deepEqual(estimated.conflicts, [], '没有超出硬性上限的估计不制造冲突');
  // A hard limit below the ESTIMATE records an open, non-gating conflict: the words stay untouched.
  const tight = durationLedger({ voicePlan: parts.voicePlan }, { maxSeconds: 1, targetSeconds: 4 });
  assert.equal(tight.conflicts.length, 1);
  const conflict = tight.conflicts[0];
  assert.equal(conflict.kind, 'estimate-over-hard-limit');
  assert.equal(conflict.basis, 'estimate');
  assert.equal(conflict.gating, false, '估计不足以判定必然冲突，不得停下流程');
  assert.equal(conflict.status, 'open');
  assert.match(conflict.note, /不删词、不改词、不加速/);
  assert.equal(tight.lines[0].seconds, 2.6, '记录的是估计值本身');
  assert.equal(parts.voicePlan.lines[0].text, '臣等正欲死战', '时长账本不改变台词原文');
  // A MEASUREMENT beyond the hard limit is the ONE case that stops the flow and waits for a decision.
  const measured = durationLedger({ voicePlan: parts.voicePlan,
    audio: { ln01: { duration: durations.ln01, measuredBy: 'ffprobe@acceptance' } } }, { maxSeconds: 1 });
  assert.equal(measured.basis, 'measured');
  assert.deepEqual(measured.measured.ids, ['ln01']);
  assert.equal(measured.measured.seconds, 2.4);
  assert.equal(measured.lines[0].estimateSeconds, 2.6, '估计留作历史，不参与判定');
  assert.equal(measured.conflicts[0].kind, 'measured-over-hard-limit');
  assert.equal(measured.conflicts[0].gating, true);
  assert.equal(measured.conflicts[0].status, 'open');
  assert.ok(measured.conflicts[0].options.length >= 2, '人工决定前给出可执行选项');
});

test('a shot cannot be scheduled on estimates, and a placeholder duration says what it is', () => {
  const f = workspace();
  const state = writeAuthored(f);
  // The authored take really opens the gate: it was accepted and its length was MEASURED.
  const accepted = requireAcceptedAudio(state);
  assert.deepEqual(accepted.measured, { ln01: durations.ln01 });
  assert.equal(accepted.basis.byLine.ln01, 'measured');
  // An estimate is never promoted into it: without a take the flow stops before the storyboard.
  const noAudio = structuredClone(state.creative);
  delete noAudio.audio.ln01;
  noAudio.acceptance = { ...noAudio.acceptance,
    binding: hash(audioLines(noAudio).map(line => ({ id: line.id, text: line.text, file: null }))) };
  assert.equal(measuredDurations(noAudio).basis.byLine.ln01, 'estimated');
  assert.deepEqual(measuredDurations(noAudio).missing, ['ln01']);
  const estimateOnly = () => requireAcceptedAudio({ creative: noAudio });
  assert.throws(estimateOnly, /STORYBOARD_REQUIRES_MEASURED_AUDIO:ln01/);
  assert.throws(estimateOnly, /估计不能替代实测/, '估计必须说明它不能代替实测');
  // No acceptance at all, a changed take, and a length nobody measured locally all stop it too.
  const unaccepted = structuredClone(noAudio);
  delete unaccepted.acceptance;
  assert.throws(() => requireAcceptedAudio({ creative: unaccepted }), /STORYBOARD_REQUIRES_ACCEPTED_AUDIO/);
  const changed = structuredClone(state.creative);
  changed.audio.ln01.file = path.join(f.root, 'other-take.wav');
  fs.writeFileSync(changed.audio.ln01.file, 'other');
  assert.throws(() => requireAcceptedAudio({ creative: changed }), /STORYBOARD_AUDIO_CHANGED/);
  const guessed = structuredClone(state.creative);
  guessed.acceptance = { ...guessed.acceptance, measuredBy: 'model-guess' };
  assert.throws(() => requireAcceptedAudio({ creative: guessed }),
    /STORYBOARD_REQUIRES_MEASURED_AUDIO:验收记录的时长来源不是本地实测（model-guess）/);
  // The legacy placeholder keeps its own label: an unmeasured slot is an estimate and carries no speech time.
  const placeholder = creativePlaceholderTimed({ script: { shots: [{ id: 'shot01' }, { id: 'shot02' }] } }, { shot01: 2.4 });
  assert.equal(placeholder.shots[0].durationBasis, 'measured');
  assert.equal(placeholder.shots[0].speechDuration, 2.4);
  // The used time keeps a small margin over the speech and is rounded up to a frame-friendly step.
  assert.equal(placeholder.shots[0].duration, 2.7);
  assert.equal(placeholder.shots[1].durationBasis, 'placeholder-estimate');
  assert.equal(placeholder.shots[1].speechDuration, null, '没有实测就没有可用的朗读时长');
  assert.equal(placeholder.shots[1].duration, 5);
});

// A reservation that really exists: the authoritative record and its ledger entry must agree, otherwise the
// preflight refuses the revision instead of treating a missing record as "never ran".
function writeLedger(f, ids) {
  writeJson(f.ledgerFile, { version: 1, entries: ids.map(id => ({ id, fingerprint: 'fixture-' + id,
    reservedCents: 18, actualCents: null, status: 'reserved', costStatus: 'reserved-conservative-estimate',
    estimateIsNotActualCharge: true, createdAt: new Date().toISOString() })) });
}

// ---------------------------------------------------------------- the ONE controlled revision route
test('a revision of a scene is re-validated, covers BOTH runs of that scene, and is recorded with its reason', async () => {
  const f = workspace();
  const state = writeAuthored(f);
  const context = loadContext(f.root, 'production.json');
  assert.ok(!fs.existsSync(path.join(ROOT, 'jobs', 'aliyun', production.id)), '离线套件不得触碰真实任务目录');
  const stored = state.creative.scenes.entries.find(entry => entry.id === 'tent');
  const request = { kind: 'scene', target: 'tent', field: 'lighting', note: '用户要求主帐改为黄昏逆光',
    scene: { ...stored, version: 2, light: { position: '帐外西侧落日', direction: '自左向右下', warmth: '暖橙偏红',
      coverage: '照亮人物半侧轮廓' } } };
  // The scope is computed from the CURRENT board, and scene tent appears twice, so both runs are covered.
  const scope = invalidations({ kind: 'scene', sceneId: 'tent', field: 'lighting' }, state.creative,
    state.creative.storyboard);
  assert.deepEqual(scope.shots, ['shot01', 'shot03'], '引用该场景的每一段都在范围内');
  assert.deepEqual(scope.detail.basis.runs, [{ start: 0, end: 0 }, { start: 2, end: 2 }], '两段之间不连续');
  assert.deepEqual(scope.detail.neighbourOnly, ['shot02', 'shot04'], '两种边界邻居都记录在案');
  assert.deepEqual(scope.adjacentPairs.map(pair => pair.to), ['shot02', 'shot03', 'shot04']);
  assert.equal(scope.acceptance, false, '场景变更不动台词，也不动已验收的配音');
  assert.equal(scope.voicePlan, false);
  assert.equal(scope.composition, true, '旧成片指针必须失效：旧片另存为历史');
  // Every affected operation has a real record AND a ledger entry, so the preflight really runs.
  const bases = revisionOperations(scope);
  assert.deepEqual(bases.slice(0, 5),
    ['first-shot01', 'last-shot01', 'frame-check-shot01', 'video-shot01', 'video-check-shot01']);
  assert.ok(!bases.includes('first-shot02') && !bases.includes('video-shot02'), '邻居的画面与视频不被重做');
  assert.ok(bases.includes('frame-check-shot02') && bases.includes('adjacent-check-shot02'));
  for (const base of bases) writeOp(f, base + '-r0', 'succeeded');
  writeLedger(f, bases.map(base => base + '-r0'));

  const result = await reviseCreative(context, request, '用户要求主帐改为黄昏逆光');
  assert.equal(result.authorized, true);
  assert.equal(result.networkRequests, 0, '离线修订不提交任何请求');
  assert.deepEqual(result.affectedShots, ['shot01', 'shot03']);
  assert.deepEqual(result.neighbourOnly, ['shot02', 'shot04']);
  assert.equal(result.acceptanceInvalidated, false);
  assert.deepEqual(result.revisions, Object.fromEntries(bases.map(base => [base, 1])));

  const after = readJson(f.stateFile);
  // The stored setting is the VALIDATED one under a new version, and the authority record is the revision's.
  assert.equal(after.creative.scenes.entries.find(entry => entry.id === 'tent').version, 2, '设定本身带上了新版本号');
  assert.equal(after.creative.scenes.entries.find(entry => entry.id === 'tent').light.position, '帐外西侧落日');
  assert.equal(after.creative.authority.by, 'controlled-revision');
  assert.equal(after.creative.authority.reason, '用户要求主帐改为黄昏逆光');
  assert.equal(creativeAuthority(after.creative).confirmed, true);
  assert.equal(after.editRevision, 1);
  assert.deepEqual(after.creative.revisions.map(entry => [entry.kind, entry.target, entry.revision]),
    [['scene', 'tent', 1]]);
  // Exactly what the change reaches: the affected shots give up their products, a neighbour keeps its own.
  assert.deepEqual(after.assets.shot01, {});
  assert.deepEqual(after.assets.shot02, { first: 'shot02-first.png', last: 'shot02-last.png', video: 'shot02.mp4',
    videoInfo: { seconds: 1.4 }, drivingAudio: 'shot02-drive.wav' });
  assert.equal(after.creative.frames.shot01, undefined);
  assert.equal(after.creative.frames.shot02.firstPrompt, 'shot02 旧首帧提示词');
  assert.equal(after.creative.videos.shot03, undefined);
  assert.deepEqual(Object.keys(after.adjacencyReviews), []);
  assert.deepEqual(Object.keys(after.revisions).sort(), [...bases].sort(), '只有受影响的单元推进一步');
  // The superseded package and film stay as history instead of being overwritten.
  assert.equal(after.creative.compositions.length, 1);
  assert.equal(after.creative.compositions[0].output, 'output/final.mp4');
  assert.equal(after.creative.composition, undefined);
  assert.equal(after.timed, undefined);
  assert.equal(after.acceptance, undefined);
  assert.equal(after.history.at(-1).kind, 'creative-revision');
  assert.equal(after.history.at(-1).creative.scenes.entries.find(entry => entry.id === 'tent').light.position,
    '帐内火盆', '历史里保留的是被取代的旧设定');
  // Nothing about the words or the accepted take was touched: it still measures what it measured.
  assert.equal(after.creative.audio.ln01.duration, durations.ln01);
  assert.equal(after.creative.acceptance.status, 'accepted');
  assert.equal(after.creative.acceptance.binding, hash(audioLines(after.creative).map(line => ({ id: line.id,
    text: line.text, file: line.id === 'ln01' ? fileHash(after.creative.audio.ln01.file) : null }))));
  assert.equal(after.creative.durationLedger.basis, 'measured');
  assert.equal(requireAcceptedAudio(after).basis.byLine.ln01, 'measured', '修订不改变实测结论');
});

test('the controlled revision refuses a hand-edited package, an unknown target, a bad kind and a missing reason', async () => {
  const f = workspace();
  const state = writeAuthored(f);
  const context = loadContext(f.root, 'production.json');
  const stored = state.creative.scenes.entries.find(entry => entry.id === 'tent');
  const request = { kind: 'scene', target: 'tent', field: 'lighting',
    scene: { ...stored, version: 2, light: { ...stored.light, position: '帐外西侧落日' } } };
  const before = snapshot(f);
  // A reason is required: an unexplained change is never applied, and a request must be shaped correctly.
  await assert.rejects(() => reviseCreative(context, request, '   '), /REVISION_REASON_REQUIRED/);
  await assert.rejects(() => reviseCreative(context, { kind: 'lighting', target: 'tent' }, '改光照'),
    /CREATIVE_REVISION_KIND:lighting/);
  await assert.rejects(() => reviseCreative(context, { ...request, target: 'hall' }, '改光照'),
    /CREATIVE_REVISION_SCENE_UNKNOWN:hall/);
  await assert.rejects(() => reviseCreative(context, { kind: 'scene', target: 'tent' }, '改光照'),
    /CREATIVE_REVISION_SCENE_REQUIRED/);
  assert.deepEqual(snapshot(f), before, '被拒绝的请求不写任何东西');
  // A package edited by hand is NOT an authorisation: the recorded digest no longer matches, so the change is
  // refused instead of being certified by this command.
  stored.wear.push('帐布被雨水打湿');
  writeJson(f.stateFile, state);
  await assert.rejects(() => reviseCreative(context, request, '用户要求改光照'), /CREATIVE_REVISION_UNKNOWN_BASIS/);
  assert.equal(creativeAuthority(readJson(f.stateFile).creative).reason, 'changed-outside-a-controlled-entry');
  assert.equal(fs.existsSync(path.join(f.opsDir, 'first-shot01-r0.json')), false, '连操作记录都不生成');
});

// A second performance segment is not part of the shared fixture, so the carry-through case builds one: the point
// is that a change to ONE line leaves the other line's take, its review and its measured duration exactly as they
// were. It never runs the chain: it exercises the controlled revision and the states the chain would read.
function twoLinePackage(f) {
  const parts = packageParts();
  // The must-keep item of this fixture is an EVENT (not the exact words), so the words of ln01 may legitimately be
  // rewritten by the controlled revision — which is exactly the case under test.
  const requirements = requirementBrief({ ...requirementsPayload(),
    mustKeep: [{ id: 'mk_line', kind: 'event', text: '帐内读简并抬头', source: 'user' }] }, production);
  const characterIds = production.characters.map(item => item.id);
  const second = { ...structuredClone(parts.directorScript.segments[0]), id: 'seg02', purpose: '把视线带到营地',
    characters: ['narrator'], performance: { ...parts.directorScript.segments[0].performance, tone: '平缓叙述' },
    spoken: [{ id: 'ln02', speaker: 'narrator', kind: 'narration', text: '营地夜巡无声', covers: ['mk_line'] }] };
  const director = directorScript({ ...parts.directorScript, segments: [...parts.directorScript.segments, second] },
    { requirements, characterIds });
  const plan = voicePlan({ lines: [...parts.voicePlan.lines, { id: 'ln02', speaker: 'narrator', kind: 'narration',
    text: '营地夜巡无声', performance: { tone: '平缓叙述', pauses: ['切镜处停顿'], breath: '平稳', silence: [] },
    notSpoken: [], durationEstimate: { method: 'character-rate', seconds: 2, uncertaintySeconds: 0.4, rate: 5,
      characters: 6, basis: '按每秒 5 字估算' } }] },
  { director, characterIds, requirements });
  const allLines = [...lines(), { id: 'ln02', speaker: 'narrator', kind: 'narration', text: '营地夜巡无声' }];
  const measured = { ...durations, ln02: 2 };
  const board = storyboard({ audioBinding: 'b1',
    unusedAudio: [{ id: 'ln02', reason: '本用例只验证台词修订的承接，不排进分镜' }], shots: shotsPayload() },
  { durations: measured, acceptedBinding: 'b1', lines: allLines, characters: parts.characters, scenes: parts.scenes,
    sceneVersion: 1, allowedVendorSeconds: [2], maxSeconds: 60, requirements });
  const takes = { ln01: path.join(f.root, 'take-ln01.wav'), ln02: path.join(f.root, 'take-ln02.wav') };
  fs.writeFileSync(takes.ln01, Buffer.from('fixture-take-ln01'));
  fs.writeFileSync(takes.ln02, Buffer.from('fixture-take-ln02'));
  const creative = { version: 1, requirements, directorScript: director, characters: parts.characters,
    scenes: parts.scenes, voicePlan: plan, storyboard: board,
    timeline: storyboardTimeline(board, { durations: measured, audioFiles: takes, titles: { ln01: '臣等正欲死战' } }),
    audio: Object.fromEntries(plan.lines.map(line => [line.id, { file: takes[line.id], duration: measured[line.id],
      measuredBy: 'ffprobe@acceptance' }])),
    toneReviews: { ln01: { lineId: 'ln01', binding: 'review-of-the-old-words', verdict: 'pass',
      execution: { status: 'completed' } },
    ln02: { lineId: 'ln02', binding: 'review-of-ln02', verdict: 'pass', execution: { status: 'completed' } } } };
  creative.acceptance = { status: 'accepted', method: 'operator', at: new Date().toISOString(),
    durationBasis: { basis: 'measured', measuredBy: 'ffprobe@acceptance' }, measuredBy: 'ffprobe',
    measured: { ...measured },
    binding: hash(audioLines(creative).map(line => ({ id: line.id, text: line.text,
      file: creative.audio[line.id]?.file ? fileHash(creative.audio[line.id].file) : null }))) };
  recordCreativeAuthority(creative, { by: 'authoring' });
  const state = authoredState(f);
  state.creative = creative;
  return { state, takes, measured, board };
}

test('a changed line loses its own take and its own review, while the untouched line keeps both', async () => {
  const f = workspace();
  const { state, takes, measured } = twoLinePackage(f);
  writeJson(f.stateFile, state);
  const context = loadContext(f.root, 'production.json');
  const stored = state.creative.voicePlan.lines.find(line => line.id === 'ln01');
  const request = { kind: 'dialogue', target: 'ln01', note: '用户确认改写这一句',
    lines: [{ id: 'ln01', text: '愿陛下忍数日之辱', performance: stored.performance }] };
  // The take really has to be recorded again, so the SPEECH unit of that line belongs to the revision scope: the new
  // request must not land on the old operation number (it would be reused as the old take or refused as changed).
  const scope = invalidations({ kind: 'dialogue', lineIds: ['ln01'] }, state.creative, state.creative.storyboard);
  const bases = revisionOperations(scope);
  assert.ok(bases.includes('speech-ln01'), '改台词的范围内包含该句的配音单元');
  assert.ok(!bases.includes('speech-ln02'), '没改的那句不重配');
  for (const base of bases) writeOp(f, base + '-r0', 'succeeded');
  writeLedger(f, bases.map(base => base + '-r0'));
  // A reservation without its authoritative speech record is not treated as "never ran".
  fs.unlinkSync(path.join(f.opsDir, 'speech-ln01-r0.json'));
  await assert.rejects(() => reviseCreative(context, request, '用户确认改写这一句'),
    /CREATIVE_REVISION_RESERVED_OPERATION_MISSING:speech-ln01-r0/);
  writeOp(f, 'speech-ln01-r0', 'succeeded');
  const before = fileHash(takes.ln01);

  const result = await reviseCreative(context, request, '用户确认改写这一句');
  assert.deepEqual(result.audioInvalidated, ['ln01']);
  assert.deepEqual(result.speechReRecorded, ['ln01']);

  const after = readJson(f.stateFile), creative = after.creative;
  // The changed line's take is gone from the package (a new one has to be recorded) while the old take stays on disk
  // as history: the normal entry can no longer use the audio of words that are no longer said.
  assert.equal(creative.audio.ln01, undefined, '改台词的入口不能继续使用旧台词音频');
  assert.equal(fs.existsSync(takes.ln01), true, '旧音频文件不被删除');
  assert.equal(fileHash(takes.ln01), before);
  assert.equal(after.history.at(-1).creative.audio.ln01.file, takes.ln01, '历史里保留旧台词的音频指针');
  assert.equal(after.history.at(-1).creative.voicePlan.lines.find(line => line.id === 'ln01').text, '臣等正欲死战');
  // The untouched line keeps its take, its measured duration and its review.
  assert.equal(creative.audio.ln02.file, takes.ln02);
  assert.equal(creative.audio.ln02.duration, measured.ln02);
  assert.equal(creative.toneReviews.ln02.binding, 'review-of-ln02');
  // The review of the replaced take is retired as history: it is never carried onto audio it never heard.
  assert.equal(creative.toneReviews.ln01, undefined);
  assert.deepEqual(creative.toneReviewHistory.map(entry => entry.lineId), ['ln01']);
  assert.match(creative.toneReviewHistory[0].reason, /台词已受控修订/);
  assert.equal(creative.toneReviewHistory[0].review.binding, 'review-of-the-old-words');
  // Changed words make the acceptance and the products built on it stale, and only THAT line's unit advances.
  assert.equal(creative.acceptance, undefined);
  assert.equal(creative.storyboard, undefined);
  assert.equal(creative.timeline, undefined);
  assert.equal(after.revisions['speech-ln01'], 1);
  assert.equal(after.revisions['speech-ln02'], undefined);
  assert.equal(creative.voicePlan.lines.find(line => line.id === 'ln01').text, '愿陛下忍数日之辱');
  assert.equal(creative.directorScript.segments.flatMap(segment => segment.spoken)
    .find(line => line.id === 'ln01').text, '愿陛下忍数日之辱', '台词与配音计划必须逐字一致');
  // Recovery: the ordinary gate is back on, the changed line has no take to accept, and another line's take can never
  // stand in for it.
  assert.throws(() => requireAcceptedAudio(after), /STORYBOARD_REQUIRES_ACCEPTED_AUDIO/);
  const { recordAcceptance } = require('../workflows/creative-stage');
  assert.throws(() => recordAcceptance(context, after, [{ lineId: 'ln01', file: takes.ln02 }],
    { method: 'operator', media: { audio: () => ({ duration: 2 }) } }), /ACCEPTANCE_REQUIRES_GENERATED_AUDIO:ln01/);
  assert.equal(creative.audio.ln02.file, takes.ln02, '没有把另一句的音频当成本句的配音');
});

test('a revised setting is never spliced onto the old frame text: the board enters a controlled update state', async () => {
  const f = workspace();
  const state = writeAuthored(f);
  const context = loadContext(f.root, 'production.json');
  const bible = state.creative, board = bible.storyboard;
  const shot01 = board.shots.find(shot => shot.id === 'shot01');
  const shot02 = board.shots.find(shot => shot.id === 'shot02');
  // A change to a setting the frame text was written against is caught even when it did NOT go through the revision
  // command: the shot records the CONTENT it was written for, so the request cannot quietly mix the two.
  const editedScenes = structuredClone(bible.scenes);
  editedScenes.entries.find(entry => entry.id === 'tent').wear.push('帐布被雨水打湿');
  assert.throws(() => frameRequest(shot01, { characters: bible.characters, scenes: editedScenes, kind: 'first' }),
    /FRAME_SETTING_SUPERSEDED:shot01:scene:tent/);
  const editedCharacters = structuredClone(bible.characters);
  editedCharacters.entries.find(entry => entry.id === 'jiang_wei').confirmed.costume = '改为白色战袍';
  assert.throws(() => frameRequest(shot01, { characters: editedCharacters, scenes: bible.scenes, kind: 'first' }),
    /FRAME_SETTING_SUPERSEDED:shot01:cast:jiang_wei/);
  assert.ok(frameRequest(shot02, { characters: editedCharacters, scenes: editedScenes, kind: 'first' })
    .includes('营门内侧两盏营火'), '不引用该设定的镜头照常组装');
  assert.equal(settingStalePause(board), null, '没有被取代的文字时没有受控更新状态');

  // The controlled revision marks exactly the shots whose text came from that setting.
  const stored = bible.scenes.entries.find(entry => entry.id === 'tent');
  const request = { kind: 'scene', target: 'tent', field: 'lighting', note: '用户要求主帐改为黄昏逆光',
    scene: { ...stored, version: 2, light: { position: '帐外西侧落日', direction: '自左向右下', warmth: '暖橙偏红',
      coverage: '照亮人物半侧轮廓' } } };
  const scope = invalidations({ kind: 'scene', sceneId: 'tent', field: 'lighting' }, bible, board);
  const bases = revisionOperations(scope);
  for (const base of bases) writeOp(f, base + '-r0', 'succeeded');
  writeLedger(f, bases.map(base => base + '-r0'));
  const result = await reviseCreative(context, request, '用户要求主帐改为黄昏逆光');
  assert.deepEqual(result.settingsSupersededShots, ['shot01', 'shot03']);
  assert.equal(result.storyboardReplanRequired, true);

  const after = readJson(f.stateFile), revised = after.creative;
  assert.deepEqual(staleSettingShots(revised.storyboard).map(item => item.id), ['shot01', 'shot03']);
  const marked = revised.storyboard.shots.find(shot => shot.id === 'shot01').settingsStale;
  assert.equal(marked.kind, 'scene');
  assert.equal(marked.target, 'tent');
  assert.equal(marked.field, 'lighting');
  assert.equal(marked.reason, '用户要求主帐改为黄昏逆光');
  assert.equal(marked.requires, 'controlled-storyboard-replan');
  assert.match(marked.note, /不得与新设定拼接生成/);
  assert.equal(marked.writtenFor.scene.version, 1, '记录这份文字是按哪个版本写的');
  assert.equal(marked.writtenFor.sceneDigest, shot01.settings.sceneDigest);
  assert.equal(revised.storyboard.shots.find(shot => shot.id === 'shot02').settingsStale, undefined);
  // The frame request refuses the marked shot outright — whatever the settings now say.
  assert.throws(() => frameRequest(revised.storyboard.shots.find(shot => shot.id === 'shot01'),
    { characters: revised.characters, scenes: revised.scenes, kind: 'first' }), /FRAME_SETTING_SUPERSEDED:shot01:tent/);
  // ...and the run stops at a recorded, explicit controlled-update state instead of generating anything.
  const pause = settingStalePause(revised.storyboard);
  assert.equal(pause.code, 'CREATIVE_STORYBOARD_SETTING_CHANGED');
  assert.deepEqual(pause.shots.map(item => item.id), ['shot01', 'shot03']);
  assert.match(pause.detail, /不得与新设定拼接生成/);
  assert.match(pause.detail, /"kind":"storyboard","decision":"replan"/);
});

test('the controlled storyboard re-plan re-authors the board from the current settings', async () => {
  const f = workspace();
  const state = writeAuthored(f);
  const context = loadContext(f.root, 'production.json');
  const bible = state.creative;
  const stored = bible.scenes.entries.find(entry => entry.id === 'tent');
  const request = { kind: 'scene', target: 'tent', field: 'lighting', note: '用户要求主帐改为黄昏逆光',
    scene: { ...stored, version: 2, light: { ...stored.light, position: '帐外西侧落日' } } };
  const sceneScope = invalidations({ kind: 'scene', sceneId: 'tent', field: 'lighting' }, bible, bible.storyboard);
  for (const base of revisionOperations(sceneScope)) writeOp(f, base + '-r0', 'succeeded');
  writeLedger(f, revisionOperations(sceneScope).map(base => base + '-r0'));
  await reviseCreative(context, request, '用户要求主帐改为黄昏逆光');
  const after = readJson(f.stateFile);

  const replanScope = invalidations({ kind: 'storyboard', reason: '按新设定重写逐帧文字' }, after.creative,
    after.creative.storyboard);
  assert.equal(replanScope.storyboard, true);
  assert.equal(replanScope.acceptance, false, '已接受的配音与实测时长不因此失效');
  assert.deepEqual([...replanScope.shots].sort(), [...SHOT_IDS].sort(), '整块分镜重写，所有镜头都在范围内');
  const replanBases = revisionOperations(replanScope);
  for (const base of replanBases) writeOp(f, base + '-r' + (after.revisions[base] || 0), 'succeeded');
  writeLedger(f, replanBases.map(base => base + '-r' + (after.revisions[base] || 0)));
  const replanned = await reviseCreative(context,
    { kind: 'storyboard', decision: 'replan', note: '按新设定重写逐帧文字' }, '用户确认重新规划分镜');
  assert.equal(replanned.storyboardReplanRequired, true);
  assert.equal(replanned.acceptanceInvalidated, false);
  assert.equal(replanned.networkRequests, 0);

  const done = readJson(f.stateFile);
  assert.equal(done.creative.storyboard, undefined, '旧分镜不参与下一次生成');
  assert.equal(done.creative.timeline, undefined);
  assert.equal(done.creative.storyboardReplan.previousShots, 4);
  assert.deepEqual(done.creative.storyboardReplan.superseded.map(item => item.id), ['shot01', 'shot03']);
  assert.match(done.creative.storyboardReplan.next, /重新规划/);
  assert.equal(done.history.at(-1).creative.storyboard.shots.length, 4, '被取代的分镜留在历史里');
  assert.equal(done.creative.acceptance.status, 'accepted', '配音已接受且实测时长不变');
  assert.equal(done.creative.audio.ln01.duration, durations.ln01);
  assert.equal(settingStalePause(done.creative.storyboard), null);
  // It is NOT a general-purpose re-plan entry: an explicit decision is required, and a board with nothing superseded
  // is refused instead of being used to paper over a change nobody authorised.
  const other = workspace();
  writeAuthored(other);
  const otherContext = loadContext(other.root, 'production.json');
  await assert.rejects(() => reviseCreative(otherContext, { kind: 'storyboard' }, '想重新规划分镜'),
    /CREATIVE_REVISION_DECISION_REQUIRED/);
  await assert.rejects(() => reviseCreative(otherContext, { kind: 'storyboard', decision: 'replan' }, '想重新规划分镜'),
    /CREATIVE_REVISION_STORYBOARD_NOT_STALE/);
});

test('a revision happens once: a corrupt, unresolved or unreserved operation stops it before anything is written', async () => {
  const f = workspace();
  const state = writeAuthored(f);
  const context = loadContext(f.root, 'production.json');
  const stored = state.creative.scenes.entries.find(entry => entry.id === 'tent');
  const request = { kind: 'scene', target: 'tent', field: 'lighting', note: '用户要求改光照',
    scene: { ...stored, version: 2, light: { ...stored.light, position: '帐外西侧落日' } } };
  const scope = invalidations({ kind: 'scene', sceneId: 'tent', field: 'lighting' }, state.creative,
    state.creative.storyboard);
  const bases = revisionOperations(scope);
  for (const base of bases) writeOp(f, base + '-r0', 'succeeded');
  writeLedger(f, bases.map(base => base + '-r0'));
  const accepted = snapshot(f);
  // A damaged record is never read as "absent", and an unresolved operation is never overwritten.
  fs.writeFileSync(path.join(f.opsDir, 'frame-check-shot04-r0.json'), '{ not json');
  await assert.rejects(() => reviseCreative(context, request, '用户要求改光照'),
    /CREATIVE_REVISION_RECORD_CORRUPT:frame-check-shot04-r0/);
  writeOp(f, 'frame-check-shot04-r0', 'succeeded');
  writeOp(f, 'video-shot01-r0', 'submitted');
  await assert.rejects(() => reviseCreative(context, request, '用户要求改光照'),
    /CREATIVE_REVISION_BLOCKED_UNRESOLVED_OPERATION:video-shot01-r0:submitted/);
  // A reservation without its authoritative record must not be guessed away.
  writeOp(f, 'video-shot01-r0', 'succeeded');
  fs.unlinkSync(path.join(f.opsDir, 'last-shot01-r0.json'));
  await assert.rejects(() => reviseCreative(context, request, '用户要求改光照'),
    /CREATIVE_REVISION_RESERVED_OPERATION_MISSING:last-shot01-r0/);
  writeOp(f, 'last-shot01-r0', 'succeeded');
  // Only generation operations consume rounds, and a unit that used them all is never reset by a revision.
  assert.equal(unitForOperation('first-shot01-r0'), 'first-shot01');
  assert.equal(unitForOperation('video-check-shot02-r0'), null, '检查不消耗生成轮次');
  writeJson(path.join(f.directory, 'unit-attempts.json'), { version: 1, units: { 'first-shot01': { generations: 4,
    reworks: 3, consumed: {}, exhausted: { at: new Date().toISOString(), reason: '已用完首次生成与 3 次返工' } } } });
  await assert.rejects(() => reviseCreative(context, request, '用户要求改光照'),
    /CREATIVE_REVISION_ATTEMPTS_EXHAUSTED:first-shot01-r0/);
  fs.unlinkSync(path.join(f.directory, 'unit-attempts.json'));
  assert.equal(fileHash(f.stateFile), accepted.state, '被拒绝的修订一次也没有写入状态');

  const first = await reviseCreative(context, request, '用户要求改光照');
  assert.equal(first.revision, 1);
  const applied = snapshot(f);
  // The same request is the same revision: no version is advanced twice and no round is consumed twice.
  await assert.rejects(() => reviseCreative(context, request, '用户要求改光照'),
    /CREATIVE_REVISION_ALREADY_APPLIED:1/);
  assert.deepEqual(snapshot(f), applied, '重复的同一请求不改变任何东西');
  assert.equal(readJson(f.stateFile).editRevision, 1);
  // A new request that results in the SAME stored value is a no-op, not a new version.
  const now = readJson(f.stateFile).creative.scenes.entries.find(entry => entry.id === 'tent');
  await assert.rejects(() => reviseCreative(context, { kind: 'scene', target: 'tent', field: 'setting',
    note: '同样的内容换个说法', scene: now }, '再确认一次光照'), /CREATIVE_REVISION_UNCHANGED/);
  assert.deepEqual(snapshot(f), applied);
});

test('an offline workspace cannot authorise or reserve a paid call', async () => {
  const f = workspace();
  writeAuthored(f);
  const budget = new Budget(f.root, f.config, f.directory);
  // The fixture config has onlineEnabled:false, so even a well-formed reservation is refused before any ledger
  // entry exists: nothing in this suite can quote, submit or spend.
  await assert.rejects(() => budget.reserve('first-shot01-r0', 100, 'fingerprint'), /ONLINE_DISABLED/);
  assert.equal(fs.existsSync(f.ledgerFile), false, '被拒绝的预留不留下账本记录');
});

