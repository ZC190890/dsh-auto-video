const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { actionRequest, characterBible, creativeDigests, directorScript, frameRequest, invalidations,
  requirementBrief, sceneBible, scriptFromStoryboard, storyboard, storyboardTimeline, voicePlan } =
  require('../services/aliyun/creative');
const { authorCreative, creativeTimed, planStoryboard, requireAcceptedAudio, scriptForPipeline } = require('../workflows/creative');
const { hash, fileHash } = require('../services/aliyun/io');

const production = { id: 'demo-film', description: '姜维在营帐中读简，随后视线转向帐外营地（离线测试夹具）', style: '国风插画',
  targetDurationSeconds: 20, maxDurationSeconds: 60, narrator: 'narrator', requiredQuotes: ['臣等正欲死战'],
  characters: [{ id: 'jiang_wei', name: '姜维' }, { id: 'narrator', name: '旁白', speaks: true }] };
const requirements = () => requirementBrief({
  mustKeep: [
    { id: 'mk_line', kind: 'line', text: '臣等正欲死战', source: 'user', note: '指定台词逐字保留' },
    { id: 'mk_jiang', kind: 'character', text: '姜维本人在场', source: 'user' },
    { id: 'mk_read', kind: 'action', text: '姜维帐内读简并抬眼看帐外', source: 'user' },
    { id: 'mk_end', kind: 'ending', text: '视线落到营地上方结束', source: 'user' }],
  style: '国风插画，写实光影', aspect: '16:9', targetSeconds: 20, maxSeconds: 60,
  prohibitions: ['不得出现字幕与水印'],
  expandable: [{ area: '帐外营地的宿帐分组与巡逻', serves: '可信空间与生活状态' }],
  unknowns: ['用户未提供完整剧本原文（本轮使用占位台词夹具）'],
  conflicts: [{ issue: '指定台词 6 字与 5 秒动作镜长不完全匹配', options: ['延长该镜到台词实测时长', '把台词拆到多镜'], status: 'open', resolution: null }] }, production);
const director = () => directorScript({
  title: '帐中读简（夹具）', theme: '因果：读简→抬眼→望向营地',
  segments: [
    { id: 'seg01', purpose: '交代营帐内的阅读', covers: ['mk_jiang', 'mk_read', 'mk_line'], characters: ['jiang_wei'],
      entry: { state: '双手持竹简坐于案前', motivation: '确认军令内容' },
      beats: { cause: '读到关键句', action: '低声诵读并停住', reaction: '呼吸一滞', result: '抬头' },
      performance: { tone: '低沉克制', pauses: ['读到“死战”后停半拍'], breath: '吸气压住情绪', gaze: '由竹简抬起', expression: '眉峰收紧', posture: '上身微微前倾' },
      space: '帐内案前，右侧有火盆，帐帘在左', props: ['竹简', '火盆'],
      spoken: [{ id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战', covers: ['mk_line'] }],
      ambience: ['帐外风声'], silence: ['念完后的静默半拍'], shotIntent: '从竹简近景推向人物中景',
      endState: '姜维抬头，视线离开竹简', nextHandoff: '下一段望向帐外', creative: ['火盆微光映在竹简上'], unknown: [] },
    { id: 'seg02', purpose: '把视线带到营地', covers: ['mk_end'], characters: ['narrator'],
      entry: { state: '姜维保持抬头', motivation: '确认营地动向' },
      beats: { cause: '帐外传来脚步', action: '画面切到营帐外', reaction: '巡逻队走过', result: '视线落到营地上方' },
      performance: { tone: '平缓叙述', pauses: ['切镜处停顿'], breath: '平稳', gaze: '画外', expression: '无', posture: '无' },
      space: '营地全景，主路通向画外', props: ['火盆', '拉绳'],
      spoken: [{ id: 'ln02', speaker: 'narrator', kind: 'narration', text: '蜀营夜巡，甲叶轻响。', covers: ['mk_end'] }],
      ambience: ['巡逻脚步'], silence: [], shotIntent: '营帐外中远景到营地全景',
      endState: '画面停在营地上方', nextHandoff: '结束', creative: [], unknown: [] }] }, { requirements: requirements(), characterIds: production.characters.map(c => c.id) });
const characters = { entries: [
  { id: 'jiang_wei', name: '姜维', refs: ['fixtures/jiang-wei.png'], confirmed: { face: '方脸，浓眉', hair: '束发戴冠', costume: '深色甲袍', accessories: '腰间短剑', weapon: '短剑入鞘', palette: '深灰与暗红', materials: '皮革与旧布' }, weaponSide: '短剑挂在左侧腰间', unknown: ['靴面细节看不清'], source: 'reference', status: 'unverified' },
  { id: 'narrator', name: '旁白', refs: ['fixtures/jiang-wei.png'], confirmed: { face: '不出画', hair: '不出画', costume: '不出画', accessories: '不出画', weapon: '不出画', palette: '不出画', materials: '不出画' }, weaponSide: null, unknown: ['旁白不出画'], source: 'creative', status: 'creative' }] };
const scenes = { entries: [
  { id: 'tent', name: '主帐内外', scale: '主帐宽约四步，案几占内间一半', directions: { north: '画面右后方', entrance: '左侧帐帘', roads: ['帐前主路通向画左', '支路通向宿帐】'] },
    structures: ['主帐木架与厚布'], materials: ['粗布', '原木', '粗陶火盆'], wear: ['布面烟熏发暗'], props: ['案几', '竹简', '火盆', '拉绳'],
    light: { position: '帐内火盆与帐帘缝隙', direction: '自右下向左上', warmth: '暖黄与冷蓝对比', coverage: '照亮案几与人物半侧' },
    weather: '夜，无雨', wind: '偏北风，吹动帐帘', people: ['帐内一人', '帐外两名守卫', '四人巡逻队'],
    boundary: ['画面右后方为营帐群'], fixed: ['主帐木架', '案几'], variable: ['火盆火苗高度'] }] };const lines = () => [{ id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战' },
  { id: 'ln02', speaker: 'narrator', kind: 'narration', text: '蜀营夜巡，甲叶轻响。' }];
const durations = { ln01: 2.4, ln02: 3.6 };
const cast = (id, extra = {}) => ({ id, position: '画面左侧案前', facing: '朝向画面右前方', posture: '坐姿，重心落在髋部',
  hands: '双手持竹简，右手在上', props: ['竹简'], gaze: '视线落在竹简上', occlusion: '帐帘在前景右侧遮挡三分之一画面',
  costume: '深色甲袍，腰间短剑入鞘', ...extra });
const board = (extra = {}) => ({ audioBinding: 'b1', shots: [
  { id: 'shot01', purpose: '读简并抬眼', covers: ['mk_jiang', 'mk_read', 'mk_line'], segments: [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 2.4 }],
    start: 0, end: 2.4, vendor: { modelSeconds: 3, coverage: 'trim', note: '取前 2.4 秒可用段' }, characters: [cast('jiang_wei')], scene: { id: 'tent', version: 1 },
    startState: '双手持简坐于案前', endState: '抬头，视线离开竹简', camera: '从竹简近景推向人物中景', transition: 'continuous', drivingLine: 'ln01',
    first: { moment: '双手持简、低头阅读的一刻', composition: '近景，竹简占画面下三分之一，火盆光在右侧', bans: ['不得出现文字字幕'],
      visibleEnvironment: ['低案与竹简占画面下三分之一', '帐帘在内间右侧形成前景遮挡'], offscreen: ['帐外营火余光形成右肩轮廓光'], extraCast: [] },
    last: { moment: '抬头的一刻，视线离开竹简', composition: '中景，人物占画面中央，帐帘在左', bans: [],
      visibleEnvironment: ['低案退到画面下缘，只见案角', '帐帘退到画面边缘，露出帐内木架'], offscreen: [], extraCast: [] },
    action: { phases: ['起势：吸气', '主动作：念完并停半拍', '收势：抬头'], speed: 1, secondary: ['火盆火苗轻晃'], settle: '停在抬头姿态', continuity: ['视线方向交给下一镜'] } },
  { id: 'shot02', purpose: '望向营地', covers: ['mk_end'], segments: [{ lineId: 'ln02', sourceStart: 0, sourceEnd: 3.6 }],
    start: 2.4, end: 6, vendor: { modelSeconds: 5, coverage: 'trim', note: '取前 3.6 秒可用段' }, characters: [cast('jiang_wei', { position: '画面中央偏左' })], scene: { id: 'tent', version: 1 },
    startState: '抬头，视线离开竹简', endState: '画面停在营地上方', camera: '拉远到营地全景', transition: 'continuous', drivingLine: null,
    first: { moment: '抬头望向帐外的一刻', composition: '中景，帐帘在左，营地入口透光', bans: [],
      visibleEnvironment: ['帐帘在画面左前景，帘口透出营地光', '画面右侧帐内木架与火盆余光'], offscreen: ['营地上方有巡逻脚步'], extraCast: [] },
    last: { moment: '营地全景静止的一刻', composition: '远景，主路自画左下延伸，宿帐分三组', bans: ['不得出现文字字幕'],
      visibleEnvironment: ['主路自画面左下向右上延伸', '宿帐分三组自近到远排开，远处只剩轮廓'], offscreen: [], extraCast: [] },
    action: { phases: ['起势：帐帘被风掀起', '主动作：镜头越过帐帘拉远', '收势：停在营地上方'], speed: 1, secondary: ['巡逻队走过'], settle: '镜头静止', continuity: ['结束'] } }], ...extra });
const options = extra => ({ durations, acceptedBinding: 'b1', lines: lines(), characters, scenes, sceneVersion: 1,
  allowedVendorSeconds: [3, 5], maxSeconds: 60, requirements: requirements(), ...extra });

test('the requirement package refuses duplicate ids, dropped must-keep lines and silent conflicts', () => {
  const brief = requirements();
  assert.equal(brief.mustKeep[0].text, '臣等正欲死战');
  assert.equal(brief.conflicts[0].status, 'open', '冲突保留为待处理，不静默解决');
  assert.throws(() => requirementBrief({ ...brief, mustKeep: [brief.mustKeep[0], brief.mustKeep[0]] }, production), /REQUIREMENTS_MUST_DUPLICATE/);
  assert.throws(() => requirementBrief({ ...brief, targetSeconds: 90 }, production), /REQUIREMENTS_TARGET_OVER_MAX/);
  assert.throws(() => requirementBrief({ ...brief, conflicts: [{ issue: 'x', options: ['a'], status: 'resolved', resolution: null }] }, production),
    /REQUIREMENTS_CONFLICT_UNEXPLAINED/);
});

test('the director script must cover every must-keep item and carry a real performance process', () => {
  const script = director();
  assert.equal(script.segments.length, 2);
  assert.match(script.segments[0].performance.gaze, /竹简/);
  assert.equal(script.segments[0].spoken[0].text, '臣等正欲死战', '指定台词逐字保留');
  assert.throws(() => directorScript({ ...script, segments: [{ ...script.segments[0], covers: ['mk_jiang'] }, script.segments[1]] },
    { requirements: requirements(), characterIds: ['jiang_wei', 'narrator'] }), /DIRECTOR_MUST_KEEP_UNCOVERED/);
  assert.throws(() => directorScript({ ...script, segments: [{ ...script.segments[0], spoken: [] }, script.segments[1]] },
    { requirements: requirements(), characterIds: ['jiang_wei', 'narrator'] }), /DIRECTOR_MUST_KEEP_LINE_MISSING/);
  assert.throws(() => directorScript({ ...script, segments: [{ ...script.segments[0], performance: { ...script.segments[0].performance, gaze: '' } }, script.segments[1]] },
    { requirements: requirements(), characterIds: ['jiang_wei', 'narrator'] }), /DIRECTOR_PERFORMANCE:seg01_GAZE/);
  assert.throws(() => directorScript({ ...script, segments: [{ ...script.segments[0], spoken: [{ ...script.segments[0].spoken[0], speaker: 'ghost' }] }, script.segments[1]] },
    { requirements: requirements(), characterIds: ['jiang_wei', 'narrator'] }), /DIRECTOR_SPOKEN_SPEAKER:ln01/);
});
test('the voice plan keeps the spoken text verbatim and holds the performance notes apart', () => {
  const plan = voicePlan({ lines: [
    { id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战', performance: { tone: '低沉克制', pauses: ['停半拍'], breath: '吸气压住', silence: [] }, notSpoken: ['不要念出这段说明'] },
    { id: 'ln02', speaker: 'narrator', kind: 'narration', text: '蜀营夜巡，甲叶轻响。', performance: { tone: '平缓', pauses: [], breath: '平稳', silence: [] }, notSpoken: [] }] },
    { director: director(), characterIds: ['jiang_wei', 'narrator'], requirements: requirements() });
  assert.equal(plan.lines[0].text, '臣等正欲死战');
  assert.deepEqual(plan.lines[0].notSpoken, ['不要念出这段说明'], '不朗读的表演说明与朗读文本分开保存');
  assert.ok(!plan.lines[0].text.includes('说明'), '表演说明不进入朗读文本');
  assert.throws(() => voicePlan({ lines: [{ ...plan.lines[0], text: '臣等正欲死戰' }, plan.lines[1]] },
    { director: director(), characterIds: ['jiang_wei', 'narrator'], requirements: requirements() }), /VOICE_PLAN_TEXT_CHANGED:ln01/);
  assert.throws(() => voicePlan({ lines: [plan.lines[0]] }, { director: director(), characterIds: ['jiang_wei', 'narrator'], requirements }),
    /VOICE_PLAN_MISSING_LINES:ln02/);
});

test('the bibles carry confirmed appearance, unknown parts and the scene specifics', () => {
  const bible = characterBible({ entries: characters.entries }, { production });
  assert.match(bible.entries[0].confirmed.weapon, /短剑/);
  assert.deepEqual(bible.entries[0].unknown, ['靴面细节看不清'], '看不清的部分如实保留');
  assert.throws(() => characterBible({ entries: [characters.entries[0]] }, { production }), /BIBLE_CHARACTER_MISSING:narrator/);
  const scene = sceneBible(scenes);
  assert.deepEqual(scene.entries[0].directions.roads.length, 2);
  assert.throws(() => sceneBible({ entries: [{ ...scenes.entries[0], directions: undefined }] }), /BIBLE_SCENE_DIRECTIONS:tent/);
  assert.throws(() => sceneBible({ entries: [{ ...scenes.entries[0], light: undefined }] }), /BIBLE_SCENE_LIGHT:tent/);
});

test('the storyboard refuses truncated, overlapping, unmapped or undeclared audio and timing', () => {
  const ok = storyboard(board(), options());
  assert.equal(ok.totalSeconds, 6);
  assert.equal(ok.shots[0].first.moment, '双手持简、低头阅读的一刻');
  assert.throws(() => storyboard(board(), options({ lines: [] })), /STORYBOARD_AUDIO_REQUIRED/);
  assert.throws(() => storyboard(board(), options({ acceptedBinding: 'other' })), /STORYBOARD_AUDIO_BINDING_MISMATCH/);
  const truncated = board(); truncated.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0.5, sourceEnd: 2.4 }];
  assert.throws(() => storyboard(truncated, options()), /STORYBOARD_PACE_UNDECLARED:shot01/);
  const headCut = board();
  headCut.shots[0].end = 1.9; headCut.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0.5, sourceEnd: 2.4 }];
  headCut.shots[1].start = 1.9; headCut.shots[1].end = 5.5;
  assert.throws(() => storyboard(headCut, options()), /STORYBOARD_AUDIO_HEAD_TRUNCATED:ln01/);
  const gap = board(); gap.shots[1].segments = [{ lineId: 'ln02', sourceStart: 0, sourceEnd: 3 }]; gap.shots[1].end = 5.4;
  assert.throws(() => storyboard(gap, options()), /STORYBOARD_AUDIO_TAIL_TRUNCATED:ln02/);
  const overlap = board(); overlap.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 1.5 }, { lineId: 'ln01', sourceStart: 1, sourceEnd: 2.4 }];
  assert.throws(() => storyboard(overlap, options()), /STORYBOARD_SEGMENT_OVERLAP:shot01:ln01/);
  const outOfRange = board(); outOfRange.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 9 }];
  assert.throws(() => storyboard(outOfRange, options()), /STORYBOARD_SOURCE_END/);
  // Cutting semantics are structured: wording may differ between framings, structured state may not.
  const wording = board(); wording.shots[1].startState = '另一处措辞不同但身份、持物与空间一致的状态';
  assert.equal(storyboard(wording, options()).shots.length, 2);
  const castChanged = board(); castChanged.shots[1].characters = [cast('narrator')];
  assert.throws(() => storyboard(castChanged, options()), /STORYBOARD_HANDOFF_MISMATCH:shot02:CAST_CHANGED/);
  const propsChanged = board(); propsChanged.shots[1].characters[0].props = ['旗帜'];
  assert.throws(() => storyboard(propsChanged, options()), /STORYBOARD_HANDOFF_MISMATCH:shot02:PROPS_CHANGED:jiang_wei/);
  const unexplained = board(); unexplained.shots[1].action.continuity = [];
  assert.throws(() => storyboard(unexplained, options()), /STORYBOARD_HANDOFF_MISMATCH:shot02:CONTINUITY_UNEXPLAINED/);
  const reframed = board(); reframed.shots[1].transition = 'reframe';
  reframed.shots[1].characters = [cast('jiang_wei', { position: '画面右侧，只看见半身' })];
  assert.equal(storyboard(reframed, options()).shots[1].transition, 'reframe', '机位变化允许构图与描述不同');
  const jumped = board(); jumped.shots[1].transition = 'time';
  assert.throws(() => storyboard(jumped, options()), /STORYBOARD_TIME_JUMP_REASON:shot02/);
  jumped.shots[1].timeJump = '跳过夜里巡营的一段时间';
  assert.equal(storyboard(jumped, options()).shots[1].timeJump, '跳过夜里巡营的一段时间');
  const sceneCut = board(); sceneCut.shots[1].transition = 'scene';
  assert.throws(() => storyboard(sceneCut, options()), /STORYBOARD_HANDOFF_MISMATCH:shot02:SCENE_UNCHANGED/);
  const unknownCut = board(); unknownCut.shots[0].transition = 'dissolve';
  assert.throws(() => storyboard(unknownCut, options()), /STORYBOARD_TRANSITION:shot01/);
  const pace = board(); pace.shots[0].end = 2.4; pace.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 2.4 }]; pace.shots[0].end = 3.4; pace.shots[1].start = 3.4; pace.shots[1].end = 7;
  assert.throws(() => storyboard(pace, options()), /STORYBOARD_PACE_UNDECLARED:shot01/);
  const vendorTrim = board(); vendorTrim.shots[0].vendor = { modelSeconds: 5, coverage: 'fit' };
  assert.throws(() => storyboard(vendorTrim, options()), /STORYBOARD_VENDOR_COVERAGE:shot01:TRIM/);
  const vendorOk = board(); vendorOk.shots[0].vendor = { modelSeconds: 5, coverage: 'trim', note: '取前 2.4 秒可用段' };
  assert.equal(storyboard(vendorOk, options()).shots[0].vendor.coverage, 'trim');
  const unsupported = board(); unsupported.shots[0].vendor = { modelSeconds: 7, coverage: 'fit' };
  assert.throws(() => storyboard(unsupported, options()), /STORYBOARD_VENDOR_UNSUPPORTED:shot01:7/);
  const missingCastField = board(); missingCastField.shots[0].characters = [{ ...cast('jiang_wei'), hands: undefined }];
  assert.throws(() => storyboard(missingCastField, options()), /STORYBOARD_CAST_HANDS:shot01:jiang_wei/);
  const unknownCast = board(); unknownCast.shots[0].characters = [cast('guard01')];
  assert.throws(() => storyboard(unknownCast, options()), /STORYBOARD_CAST_UNKNOWN:shot01:guard01/);
  const sceneVersion = board(); sceneVersion.shots[1].scene = { id: 'tent', version: 2 };
  assert.throws(() => storyboard(sceneVersion, options()), /STORYBOARD_SCENE_VERSION:shot02/);
  const uncovered = board(); uncovered.shots[1].covers = ['mk_line'];
  assert.throws(() => storyboard(uncovered, options()), /STORYBOARD_MUST_KEEP_UNCOVERED:mk_end/);
  const timelineGap = board(); timelineGap.shots[1].start = 2.6; timelineGap.shots[1].end = 6.2;
  assert.throws(() => storyboard(timelineGap, options()), /STORYBOARD_TIMELINE_GAP:shot02/);
});

test('one frame is one moment: pasting the action or chaining moments is refused', () => {
  const chained = board(); chained.shots[0].first.moment = '先吸气然后抬头的一刻';
  assert.throws(() => storyboard(chained, options()), /STORYBOARD_FRAME_MULTIPLE_MOMENTS:shot01:first/);
  const pasted = board();
  pasted.shots[0].first.composition = '起势：吸气；主动作：念完并停半拍；收势：抬头';
  assert.throws(() => storyboard(pasted, options()), /STORYBOARD_FRAME_CONTAINS_ACTION_SEQUENCE:shot01:first/);
  const both = storyboard(board(), options());
  assert.notEqual(both.shots[0].first.moment, both.shots[0].last.moment);
});
test('the timeline keeps one line across cuts, allows silence, and never restarts subtitles', () => {
  const first = board().shots[0], second = board().shots[1];
  const split = { audioBinding: 'b1', shots: [
    { ...first, id: 'a', segments: [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 1.2 }], start: 0, end: 1.2 },
    { ...first, id: 'b', startState: first.endState, segments: [{ lineId: 'ln01', sourceStart: 1.2, sourceEnd: 2.4 }], start: 1.2, end: 2.4 },
    { ...second, id: 'c', segments: [{ lineId: 'ln02', sourceStart: 0, sourceEnd: 3.6 }], start: 2.4, end: 6 }] };
  const validated = storyboard(split, options());
  const timeline = storyboardTimeline(validated, { durations, audioFiles: { ln01: 'ln01.wav', ln02: 'ln02.wav' },
    titles: { ln01: '臣等正欲死战', ln02: '蜀营夜巡，甲叶轻响。' } });
  assert.equal(timeline.audioBed.length, 2, '一条音频只混一次，不因跨镜重复');
  assert.equal(timeline.audioBed[0].lineId, 'ln01');
  assert.equal(timeline.audioBed[0].startSeconds, 0);
  assert.equal(timeline.audioBed[0].segments.length, 2, '跨镜片段都在同一条音频床条目里');
  assert.equal(timeline.subtitles.length, 2);
  assert.equal(timeline.subtitles[0].start, 0);
  assert.equal(timeline.subtitles[0].end, 2.4, '字幕跟音频时间线，不在切镜处归零');
  assert.equal(timeline.shots[1].duration, 1.2);
  assert.equal(timeline.shots[1].audioSpans[0].sourceStart, 1.2, '明确区分源音频范围与成片时间范围');
  const silent = board();
  silent.shots[0].segments = [];
  silent.shots[0].drivingLine = null;
  const silentBoard = storyboard(silent, options({ lines: [lines()[1]] }));
  assert.equal(silentBoard.totalSeconds, 6, '无声镜不需要变速声明');
  const multi = board();
  multi.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 2.4 }, { lineId: 'ln02', sourceStart: 0, sourceEnd: 3.6 }];
  multi.shots[0].end = 6;
  multi.shots[0].covers = ['mk_jiang', 'mk_read', 'mk_line', 'mk_end'];
  multi.shots[0].covers = ['mk_jiang', 'mk_read', 'mk_line', 'mk_end'];
  multi.shots[0].vendor = { modelSeconds: 5, coverage: 'extra', note: '不足 6 秒，需补足覆盖' };
  multi.shots[1].vendor = { modelSeconds: 3, coverage: 'trim', note: '只取 1.5 秒' };
  multi.shots[1].start = 6; multi.shots[1].end = 7.5;
  multi.shots[1].segments = [];
  const multiBoard = storyboard(multi, options());
  const multiTimeline = storyboardTimeline(multiBoard, { durations, audioFiles: {}, titles: {} });
  assert.equal(multiTimeline.shots[0].audioSpans.length, 2, '一镜可以包含多段音频');
  assert.equal(multiTimeline.shots[1].audioSpans.length, 0, '同一镜也可以是无声音区间');
});

test('the assembled requests carry the bibles, every visible person and the bans', () => {
  const ok = storyboard(board(), options());
  const first = frameRequest(ok.shots[0], { characters, scenes, kind: 'first', style: production.style });
  const crowd = ok.shots[1];
  assert.match(first, /场景「主帐内外」版本 v1/);
  assert.match(first, /本帧可见的环境：/);
  assert.match(first, /光照与天气：光源 帐内火盆与帐帘缝隙，方向 自右下向左上/);
  assert.match(first, /① 姜维（jiang_wei）：参考素材外观（未逐项确认）（方脸，浓眉、束发戴冠、深色甲袍、腰间短剑、短剑入鞘、深灰与暗红、皮革与旧布）/);
  assert.match(first, /参考图继承规则：必须继承——身份与已记录外观/);
  assert.match(first, /随本镜变化——姿态、表情、机位/);
  assert.match(first, /可以不采用——参考图中的背景与非必要物件/);
  assert.match(first, /未知或冲突——jiang_wei：靴面细节看不清/);
  assert.match(first, /不得写成已知事实/);
  assert.match(first, /本帧未附带参考图：外观只能依据上面的文字描述，不得声称已参考立绘。/);
  assert.match(first, /不新增立绘生成，也不把夹具外观当作真实任务默认值/);
  assert.match(first, /禁止：不得出现文字字幕/);
  assert.ok(!/见参考图|同上|保持一致即可|一律不入画/.test(first), '不能只写见参考图之类，也不得靠写死排除语句');
  const last = frameRequest(ok.shots[1], { characters, scenes, kind: 'last', style: production.style });
  assert.notEqual(last, first);
  const action = actionRequest(ok.shots[0]);
  void crowd;

});
test('the derived script keeps the storyboard durations and the driving slice', () => {
  const ok = storyboard(board(), options());
  const script = scriptFromStoryboard(ok, { title: '夹具', characters, scenes, style: production.style });
  assert.equal(script.storyboardTimed, true);
  assert.equal(script.shots[0].duration, 2.4, '时长来自实测音频而不是固定 5 秒');
  assert.equal(script.shots[1].duration, 3.6);
  assert.deepEqual(script.shots[0].drivingAudio, { lineId: 'ln01', sourceStart: 0, sourceEnd: 2.4 });
  assert.equal(script.shots[1].drivingAudio, null, '旁白不作口型驱动');
  assert.match(script.shots[0].scene, /场景「主帐内外」/);
  assert.equal(script.shots[0].cut, 'continuous');
});

test('a change invalidates only the affected downstream artefacts and shots', () => {
  const ok = storyboard(board(), options());
  const dialogue = invalidations({ kind: 'dialogue', lineIds: ['ln01'] }, {}, ok);
  assert.deepEqual(dialogue.shots, ['shot01']);
  assert.equal(dialogue.voicePlan, true); assert.equal(dialogue.timeline, true); assert.equal(dialogue.acceptance, true);
  const audio = invalidations({ kind: 'audio' }, {}, ok);
  assert.deepEqual(audio.shots, ['shot01', 'shot02']);
  assert.equal(audio.acceptance, true);
  const scene = invalidations({ kind: 'scene', sceneId: 'tent' }, {}, ok);
  assert.deepEqual(scene.shots, ['shot01', 'shot02']);
  const equipment = invalidations({ kind: 'equipment', characterId: 'jiang_wei' }, {}, ok);
  assert.deepEqual(equipment.shots, ['shot01', 'shot02']);
  assert.throws(() => invalidations({ kind: 'weather' }, {}, ok), /INVALIDATION_KIND/);
});
// ---------------------------------------------------------------- workflow level (mock planner)
function fakeModels(payloads) {
  const calls = [];
  return { calls, plan: async (id, spec) => { calls.push({ id, prompt: spec.prompt });
    const build = payloads.find(entry => id.startsWith(entry.id));
    if (!build) throw new Error('UNEXPECTED_OPERATION:' + id);
    return { json: build.value({ id, prompt: spec.prompt }) }; } };
}
function fixtureState() {
  return { version: 1, productionId: production.id, characters: { jiang_wei: { traits: '方脸，束甲' }, narrator: { traits: '旁白不出画' } },
    assets: {}, revisions: {}, approvals: {}, stage: 'characters' };
}
const payloads = (override = {}) => [
  { id: 'plan-requirements', value: () => JSON.parse(JSON.stringify({ mustKeep: requirements().mustKeep, style: requirements().style,
    aspect: '16:9', targetSeconds: 20, maxSeconds: 60, prohibitions: requirements().prohibitions, expandable: requirements().expandable,
    unknowns: requirements().unknowns, conflicts: requirements().conflicts })) },
  { id: 'plan-director-script', value: () => JSON.parse(JSON.stringify({ title: director().title, theme: director().theme, segments: director().segments })) },
  { id: 'plan-character-bible', value: () => JSON.parse(JSON.stringify({ entries: characters.entries })) },
  { id: 'plan-scene-bible', value: () => JSON.parse(JSON.stringify({ entries: scenes.entries })) },
  { id: 'plan-voice-plan', value: () => ({ lines: lines().map(line => ({ ...line, performance: { tone: '低沉', pauses: [], breath: '平稳', silence: [] }, notSpoken: [] })) }) },
  { id: 'plan-storyboard-', value: () => { const built = board(); built.audioBinding = override.binding || 'b1'; return built; } }];

test('authoring runs each stage once, validates locally and resumes without extra requests', async () => {
  const state = fixtureState();
  const models = fakeModels(payloads());
  const creative = await authorCreative({ production, config: { planner: { reservationCents: 20 } } }, { models, state, log: () => {} });
  assert.equal(models.calls.length, 5, '五个阶段各一次请求');
  assert.equal(creative.requirements.mustKeep.length, 4);
  assert.equal(creative.voicePlan.lines[0].text, '臣等正欲死战');
  assert.ok(creative.digests.directorScript && creative.digests.voicePlan, '每件产物都有摘要');
  const before = models.calls.length;
  await authorCreative({ production, config: { planner: { reservationCents: 20 } } }, { models, state, log: () => {} });
  assert.equal(models.calls.length, before, '已有产物时不重复请求');
});

test('the storyboard stage refuses to run before the audio is accepted, with zero requests', async () => {
  const state = fixtureState();
  const models = fakeModels(payloads());
  await authorCreative({ production, config: { planner: { reservationCents: 20 } } }, { models, state, log: () => {} });
  const callsBefore = models.calls.length;
  const audioDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-audio-'));
  const wavs = { ln01: path.join(audioDir, 'ln01.wav'), ln02: path.join(audioDir, 'ln02.wav') };
  fs.writeFileSync(wavs.ln01, 'fixture'); fs.writeFileSync(wavs.ln02, 'fixture');
  state.creative.audio = { ln01: { file: wavs.ln01, duration: 2.4 }, ln02: { file: wavs.ln02, duration: 3.6 } };
  await assert.rejects(planStoryboard({ production, config: { planner: { reservationCents: 20 } } }, { models, state, log: () => {} }),
    /STORYBOARD_REQUIRES_ACCEPTED_AUDIO/);
  assert.equal(models.calls.length, callsBefore, '未接受音频时零请求');
  const binding = hash([{ id: 'ln01', text: '臣等正欲死战', file: fileHash(wavs.ln01) }, { id: 'ln02', text: '蜀营夜巡，甲叶轻响。', file: fileHash(wavs.ln02) }]);
  state.creative.acceptance = { status: 'accepted', binding: 'stale', at: new Date().toISOString() };
  assert.throws(() => requireAcceptedAudio(state), /STORYBOARD_AUDIO_CHANGED/);
  state.creative.acceptance = { status: 'accepted', binding, at: new Date().toISOString() };
  const { measured } = requireAcceptedAudio(state);
  assert.deepEqual(measured, { ln01: 2.4, ln02: 3.6 }, '时长取自接受音频的实测值');
});

test('after acceptance the storyboard is planned once, validated locally and turned into the pipeline timeline', async () => {
  const state = fixtureState();
  const context = { production, config: { planner: { reservationCents: 20 } } };
  const audioDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-audio2-'));
  const wavs = { ln01: path.join(audioDir, 'ln01.wav'), ln02: path.join(audioDir, 'ln02.wav') };
  fs.writeFileSync(wavs.ln01, 'fixture'); fs.writeFileSync(wavs.ln02, 'fixture');
  const binding = hash([{ id: 'ln01', text: '臣等正欲死战', file: fileHash(wavs.ln01) }, { id: 'ln02', text: '蜀营夜巡，甲叶轻响。', file: fileHash(wavs.ln02) }]);
  const models = fakeModels(payloads({ binding }));
  await authorCreative(context, { models, state, log: () => {} });
  fs.writeFileSync(wavs.ln01, 'fixture'); fs.writeFileSync(wavs.ln02, 'fixture');
  state.creative.audio = { ln01: { file: wavs.ln01, duration: 2.4 }, ln02: { file: wavs.ln02, duration: 3.6 } };
  state.creative.acceptance = { status: 'accepted',
    binding: hash([{ id: 'ln01', text: '臣等正欲死战', file: fileHash(wavs.ln01) }, { id: 'ln02', text: '蜀营夜巡，甲叶轻响。', file: fileHash(wavs.ln02) }]),
    at: new Date().toISOString() };
  const before = models.calls.length;
  const { board: planned, timeline } = await planStoryboard(context, { models, state, log: () => {} });
  assert.equal(models.calls.length, before + 1, '分镜只请求一次');
  assert.match(models.calls[models.calls.length - 1].prompt, /实测时长/);
  assert.match(models.calls[models.calls.length - 1].prompt, /2\.4/, '请求里带实测时长');
  assert.equal(planned.totalSeconds, 6);
  assert.equal(timeline.audioBed.length, 2);
  const script = scriptForPipeline(context, state);
  state.script = scriptForPipeline(context, state);
  const timed = creativeTimed(context, state);
  assert.equal(script.storyboardTimed, true);
  assert.equal(timed.shots[0].duration, 2.4);
  assert.equal(timed.totalDuration, 6);
  assert.equal(timed.audioBed.length, 2);
});

test('the storyboard plan keeps one operation identity per input, and a controlled re-plan is consumed by it', async () => {
  const state = fixtureState();
  const context = { production, config: { planner: { reservationCents: 20 } } };
  const audioDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'creative-audio-replan-'));
  const wavs = { ln01: path.join(audioDir, 'ln01.wav'), ln02: path.join(audioDir, 'ln02.wav') };
  fs.writeFileSync(wavs.ln01, 'fixture'); fs.writeFileSync(wavs.ln02, 'fixture');
  const binding = hash([{ id: 'ln01', text: '臣等正欲死战', file: fileHash(wavs.ln01) },
    { id: 'ln02', text: '蜀营夜巡，甲叶轻响。', file: fileHash(wavs.ln02) }]);
  const models = fakeModels(payloads({ binding }));
  await authorCreative(context, { models, state, log: () => {} });
  state.creative.audio = { ln01: { file: wavs.ln01, duration: 2.4 }, ln02: { file: wavs.ln02, duration: 3.6 } };
  state.creative.acceptance = { status: 'accepted', binding, at: new Date().toISOString() };
  // A controlled re-plan of the whole board is outstanding (a setting the frame text was written against changed).
  state.creative.storyboardReplan = { at: new Date().toISOString(), reason: '场景设定修订后重写逐帧文字',
    previousShots: 2, superseded: [{ id: 'shot01' }], next: '按当前设定重新规划分镜' };
  const callsBefore = models.calls.length;
  const { board } = await planStoryboard(context, { models, state, log: () => {} });
  const operation = models.calls.at(-1).id;
  assert.equal(models.calls.length, callsBefore + 1);
  assert.match(operation, /^plan-storyboard-[0-9a-f]{12}$/, '操作号是整包输入的摘要，不是计数器');
  // The successful planning CONSUMES the outstanding re-plan: it is a record of what happened, not a flag that
  // makes every later run believe a re-plan is still pending (which would plan and pay again and again).
  assert.equal(state.creative.storyboardReplan, undefined);
  assert.equal(state.creative.storyboardReplanHistory.length, 1);
  assert.equal(state.creative.storyboardReplanHistory[0].previousShots, 2);
  assert.deepEqual(state.creative.storyboardReplanHistory[0].superseded.map(item => item.id), ['shot01']);
  assert.equal(state.creative.storyboardReplanHistory[0].operation, operation);
  assert.equal(state.creative.storyboardReplanHistory[0].completedShots, board.shots.length);
  assert.match(state.creative.storyboardReplanHistory[0].note, /不再处于待执行状态/);
  // The same input lands on the same number — the operation record is what makes a re-run free in a real run — and
  // the consumed re-plan is not appended to history a second time.
  await planStoryboard(context, { models, state, log: () => {} });
  assert.equal(models.calls.at(-1).id, operation, '同一输入不换操作号');
  assert.equal(state.creative.storyboardReplanHistory.length, 1, '历史不被重复追加');
  // A genuinely different plan input (here a reworded director script) gets its OWN number, so the retries of the
  // superseded plan cannot starve the new one of its check budget.
  state.creative.directorScript = { ...state.creative.directorScript, theme: '营中夜巡，压抑与克制' };
  await planStoryboard(context, { models, state, log: () => {} });
  assert.notEqual(models.calls.at(-1).id, operation);
  assert.match(models.calls.at(-1).id, /^plan-storyboard-[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------- offline sample document
test('the offline sample document is generated from the real modules', () => {
  const board0 = storyboard(board(), options());
  const timeline0 = storyboardTimeline(board0, { durations, audioFiles: { ln01: 'fixtures/ln01.wav', ln02: 'fixtures/ln02.wav' },
    titles: { ln01: '臣等正欲死战', ln02: '蜀营夜巡，甲叶轻响。' } });
  const script0 = scriptFromStoryboard(board0, { title: '帐中读简（占位夹具）', characters, scenes, style: production.style });
  const lines_ = [
    '# 精细创作流程离线样例（姜维读简→望向营地）',
    '',
    '> 说明：本样例由 services/aliyun/creative.js 与 workflows/creative.js 在本机离线生成，使用**测试夹具**（占位台词与占位参考图路径），',
    '> 工作区没有用户认可的完整剧本原文，因此台词为占位、参考图路径为占位，**不代表已查看用户立绘**，也不冒充历史事实。',
    '',
    '## 1 需求约束包',
    '- 必须保留：' + requirements().mustKeep.map(entry => entry.id + '（' + entry.kind + '，' + entry.source + '）：' + entry.text).join('；'),
    '- 风格/画幅/时长：' + requirements().style + '，' + requirements().aspect + '，目标 ' + requirements().targetSeconds + ' 秒，上限 ' + requirements().maxSeconds + ' 秒',
    '- 禁止项：' + requirements().prohibitions.join('、'),
    '- 可扩展：' + requirements().expandable.map(entry => entry.area + '（服务于：' + entry.serves + '）').join('；'),
    '- 未知信息：' + requirements().unknowns.join('；'),
    '- 冲突（未静默解决）：' + requirements().conflicts.map(entry => entry.issue + ' → 选项：' + entry.options.join(' / ')).join('；'),
    '',
    '## 2 导演脚本',
    '片名：' + director().title + '；主题：' + director().theme,
    ...director().segments.flatMap(segment => ['',
      '### 段落 ' + segment.id + '：' + segment.purpose,
      '- 覆盖必须保留项：' + segment.covers.join('、'),
      '- 进入状态与动机：' + segment.entry.state + '；' + segment.entry.motivation,
      '- 起因→行动→反应→结果：' + segment.beats.cause + ' → ' + segment.beats.action + ' → ' + segment.beats.reaction + ' → ' + segment.beats.result,
      '- 表演过程：语气 ' + segment.performance.tone + '；停顿 ' + segment.performance.pauses.join('、') + '；呼吸 ' + segment.performance.breath +
        '；视线 ' + segment.performance.gaze + '；表情 ' + segment.performance.expression + '；姿态 ' + segment.performance.posture,
      '- 空间与道具：' + segment.space + '；' + segment.props.join('、'),
      '- 朗读：' + segment.spoken.map(line => line.id + '（' + line.speaker + '/' + line.kind + '）' + line.text).join('；'),
      '- 环境声：' + (segment.ambience.join('、') || '无') + '；无声留白：' + (segment.silence.join('、') || '无'),
      '- 镜头意图：' + segment.shotIntent,
      '- 结束状态与承接：' + segment.endState + ' → ' + segment.nextHandoff,
      '- 创作补充：' + (segment.creative.join('、') || '无') + '；未知项：' + (segment.unknown.join('、') || '无')]),
    '',
    '## 3 人物与场景设定集',
    ...characters.entries.map(entry => '- 人物 ' + entry.id + '（' + entry.status + '，来源 ' + entry.source + '）：容貌 ' + entry.confirmed.face +
      '；发型 ' + entry.confirmed.hair + '；服装 ' + entry.confirmed.costume + '；配饰 ' + entry.confirmed.accessories + '；武器 ' + entry.confirmed.weapon +
      '；颜色 ' + entry.confirmed.palette + '；材质 ' + entry.confirmed.materials + '；持械 ' + (entry.weaponSide || '无') + '；未确认 ' + entry.unknown.join('、')),
    ...scenes.entries.map(entry => '- 场景 ' + entry.id + '：尺度 ' + entry.scale + '；方位 ' + entry.directions.north + '；入口 ' + entry.directions.entrance +
      '；道路 ' + entry.directions.roads.join('、') + '；结构 ' + entry.structures.join('、') + '；材料 ' + entry.materials.join('、') + '；使用状态 ' + entry.wear.join('、') +
      '；陈设 ' + entry.props.join('、') + '；光源 ' + entry.light.position + '/' + entry.light.direction + '/' + entry.light.warmth + '/' + entry.light.coverage +
      '；天气 ' + entry.weather + '；风 ' + (entry.wind || '无') + '；人员分布 ' + entry.people.join('、') + '；边界 ' + entry.boundary.join('、') +
      '；固定 ' + entry.fixed.join('、') + '；可变 ' + entry.variable.join('、')),
    '',
    '## 4 配音计划（朗读文本与表演说明分开）',
    ...lines().map(line => '- ' + line.id + '（' + line.speaker + '/' + line.kind + '）逐字文本：' + line.text),
    '- 不朗读的表演说明单独保存（voicePlan.performance/notSpoken），不进入朗读文本',
    '',
    '## 5 模拟接受音频与实测时长（夹具）',
    '- 接受状态：accepted（夹具绑定 ' + board().audioBinding + '）；实测时长：' + Object.entries(durations).map(([id, value]) => id + '=' + value + '秒').join('，'),
    '- 说明：这是标注清楚的模拟接受音频，不是真实配音，也不用于任何真实运行',
    '',
    '## 6 最终分镜与音画映射',
    ...board0.shots.flatMap(shot => ['',
      '### ' + shot.id + '：' + shot.purpose + '（成片 ' + shot.start + '-' + shot.end + ' 秒，供应商时长 ' + shot.vendor.modelSeconds +
        ' 秒 / ' + shot.vendor.coverage + '）',
      '- 源音频映射：' + shot.segments.map(fragment => fragment.lineId + ' 源 ' + fragment.sourceStart + '-' + fragment.sourceEnd + ' 秒').join('；'),
      '- 人物与场景版本：' + shot.characters.map(cast => cast.id).join('、') + ' @ ' + shot.scene.id + ' v' + shot.scene.version,
      '- 起止状态：' + shot.startState + ' → ' + shot.endState + '（切镜 ' + shot.transition + '；机位 ' + shot.camera + '）']),
    '',
    '## 7 各镜首尾帧与动作提示词（实际发送文本）',
    ...board0.shots.flatMap(shot => ['', '### ' + shot.id + ' 首帧请求', '```', frameRequest(shot, { characters, scenes, kind: 'first', style: production.style }), '```',
      '### ' + shot.id + ' 尾帧请求', '```', frameRequest(shot, { characters, scenes, kind: 'last', style: production.style }), '```',
      '### ' + shot.id + ' 动作请求', '```', actionRequest(shot), '```']),
    '',
    '## 8 时间线与字幕',
    ...timeline0.audioBed.map(entry => '- 音频床 ' + entry.lineId + '：成片起点 ' + entry.startSeconds + ' 秒，时长 ' + entry.durationSeconds + ' 秒，片段 ' + entry.segments.length + ' 段'),
    ...timeline0.subtitles.map(entry => '- 字幕 ' + entry.lineId + '：' + entry.start + '-' + entry.end + ' 秒「' + entry.text + '」（跟音频时间线，不在切镜处归零）'),
    '- 成片内容时长 ' + timeline0.contentSeconds + ' 秒；总时长（含片尾）' + timeline0.totalDuration + ' 秒',
    '',
    '## 9 派生给既有生成/检查/返工链路的镜头对象（节选）',
    '```json', JSON.stringify(script0.shots[0], null, 2), '```'];
  const document = lines_.join('\n');
  const target = path.resolve(__dirname, '..', 'docs', 'CREATIVE_SAMPLE.md');
  fs.writeFileSync(target, document + '\n', 'utf8');
  assert.ok(document.includes('## 2 导演脚本'));
  assert.ok(document.includes('## 7 各镜首尾帧与动作提示词（实际发送文本）'));
  assert.ok(document.includes('场景「主帐内外」'), '样例里的请求带具体设定');
  assert.ok(fs.statSync(target).size > 4000, '样例文档已生成');
});
test('the frame request assembles only what this frame can see, and binds reference images', () => {
  const board_ = storyboard(board(), options());
  const shot = board_.shots[0];
  const request = frameRequest(shot, { characters, scenes, kind: 'first', style: production.style,
    references: [{ role: '姜维立绘（id jiang_wei）' }] });
  // A close-up must not turn the off-screen crowd into visible subjects. The scene record still holds them
  // (internal), and the request says so explicitly instead of pasting the whole camp.
  assert.ok(request.includes('场景「主帐内外」版本 v1'), '场景按版本引用');
  assert.ok(!/守卫|巡逻/.test(request), '未声明的画外人员不得出现在请求里，也不靠写死排除语句');
  assert.ok(request.includes('本帧可见的环境：'), '请求必须先给出本帧可见的环境');
  assert.ok(request.includes('图1=姜维立绘（id jiang_wei）'), '参考图按角色对应写在请求里');
  assert.ok(request.includes('该帧的唯一静止时刻：双手持简、低头阅读的一刻'), '首帧仍是单一静止时刻');
  const lastRequest = frameRequest(shot, { characters, scenes, kind: 'last', style: production.style });
  assert.ok(lastRequest.includes('该帧的唯一静止时刻：抬头的一刻，视线离开竹简'));
  assert.ok(lastRequest.includes('本帧未附带参考图'), '没有参考图时必须说明，不得声称已参考立绘');
  assert.ok(!/同上|保持一致即可|人物同上/.test(request), '不得用“同上”代替具体描述');
  // A wide multi-person frame lists people one by one, and the environment is selected for this frame only.
  // A wide frame with two extra people: numbering, shared costume expansion and the selected environment.
  const crowd = { ...shot, first: { ...shot.first, crowdCostume: '群演共用衣着：深蓝灰短袍、束腰带、皮护腕、麻鞋',
    visibleEnvironment: ['中景：营帐木架与营前主路', '地面踩实的土与草料'], extraCast: [
      { id: 'guard_a', label: '守卫甲', group: '营门守卫', position: '画面中景偏左', facing: '面朝画外右前', posture: '站姿，重心在右腿',
        hands: '右手持矛贴肩', props: ['长矛'], gaze: '平视画外', action: '值守不动', visible: '全身可见', costume: null },
      { id: 'bucket_a', label: '提桶者', group: '营地杂役', position: '画面左下主路边', facing: '面朝画面右上', posture: '站姿，上身前倾',
        hands: '右手提木桶', props: ['木桶'], gaze: '看向主路', action: '起步瞬间', visible: '全身可见', costume: '临时的浅褐外袍（本帧特例）' }] } };
  const crowdRequest = frameRequest(crowd, { characters, scenes, kind: 'first', style: production.style,
    references: [{ role: '正脸参考（jiang_wei）' }] });
  assert.match(crowdRequest, /② 守卫甲（营门守卫，身份 guard_a）：位置：画面中景偏左/);
  assert.match(crowdRequest, /③ 提桶者（营地杂役，身份 bucket_a）：位置：画面左下主路边/);
  assert.match(crowdRequest, /② 守卫甲（营门守卫，身份 guard_a）：.*；服饰装备：群演共用衣着：深蓝灰短袍、束腰带、皮护腕、麻鞋/);
  assert.match(crowdRequest, /③ 提桶者（营地杂役，身份 bucket_a）：.*；服饰装备：群演共用衣着：深蓝灰短袍、束腰带、皮护腕、麻鞋；个体补充：临时的浅褐外袍（本帧特例）/);
  assert.match(crowdRequest, /共用群演服饰（已在上面对应人物身上展开）：群演共用/);
  assert.match(crowdRequest, /本帧可见的环境：中景：营帐木架与营前主路；地面踩实的土与草料/);
  assert.ok(!/一律不入画|本帧可见的人群分布/.test(crowdRequest), '不得使用写死的排除语句或旧的整段人群拼装');
});
