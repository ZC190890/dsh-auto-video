// The fine creative chain must be reachable from the NORMAL entry point (index.js -> runProduction), with an
// injected provider adapter only for the external service. No test-only orchestration is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../index');
const { FINAL_PROFILE, Media } = require('../services/aliyun/media');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
// The final composition planner and its stage are exercised both through the entry point and directly, so a
// blocked plan can be shown to stop BEFORE any FFmpeg call instead of failing halfway through an encode.
const { finalCompositionPlan } = require('../workflows/creative');
const { finalStage } = require('../workflows/creative-stage');
const ROOT = path.resolve(__dirname, '..');

const production_ = { id: 'creative-entry-film', description: '姜维读简（离线夹具）', style: '国风插画',
  targetDurationSeconds: 20, maxDurationSeconds: 60, creative: true, creativeFixture: true,
  characters: [{ id: 'jiang_wei', name: '姜维' }, { id: 'narrator', name: '旁白' }] };
const requirementsPayload = () => ({
  mustKeep: [
    { id: 'mk_line', kind: 'line', text: '臣等正欲死战', source: 'user', note: '指定台词逐字保留' },
    { id: 'mk_jiang', kind: 'character', text: '姜维本人在场', source: 'user' },
    { id: 'mk_read', kind: 'action', text: '姜维帐内读简并抬眼看帐外', source: 'user' },
    { id: 'mk_end', kind: 'ending', text: '视线落到营地上方结束', source: 'user' }],
  style: '国风插画，写实光影', aspect: '16:9', targetSeconds: 20, maxSeconds: 60, prohibitions: ['不得出现字幕与水印'],
  expandable: [{ area: '帐外营地的宿帐分组与巡逻', serves: '可信空间与生活状态' }],
  unknowns: ['用户未提供完整剧本原文（本轮使用占位台词夹具）'], conflicts: [] });
const directorPayload = () => ({
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
      endState: '画面停在营地上方', nextHandoff: '结束', creative: [], unknown: [] }] });
const charactersPayload = { entries: [
  { id: 'jiang_wei', name: '姜维', refs: ['fixtures/jiang-wei.png'], confirmed: { face: '方脸，浓眉', hair: '束发戴冠', costume: '深色甲袍', accessories: '腰间短剑', weapon: '短剑入鞘', palette: '深灰与暗红', materials: '皮革与旧布' }, weaponSide: '短剑挂在左侧腰间', unknown: ['靴面细节看不清'], source: 'fixture', status: 'unverified' },
  { id: 'narrator', name: '旁白', refs: ['fixtures/jiang-wei.png'], confirmed: { face: '不出画', hair: '不出画', costume: '不出画', accessories: '不出画', weapon: '不出画', palette: '不出画', materials: '不出画' }, weaponSide: null, unknown: ['旁白不出画'], source: 'fixture', status: 'creative' }] };
const scenesPayload = { entries: [
  { id: 'tent', name: '主帐内外', scale: '主帐宽约四步，案几占内间一半', directions: { north: '画面右后方', entrance: '左侧帐帘', roads: ['帐前主路通向画左', '支路通向宿帐'] },
    structures: ['主帐木架与厚布'], materials: ['粗布', '原木', '粗陶火盆'], wear: ['布面烟熏发暗'], props: ['案几', '竹简', '火盆', '拉绳'],
    light: { position: '帐内火盆与帐帘缝隙', direction: '自右下向左上', warmth: '暖黄与冷蓝对比', coverage: '照亮案几与人物半侧' },
    weather: '夜，无雨', wind: '偏北风，吹动帐帘', people: ['帐内一人', '帐外两名守卫', '四人巡逻队'],
    boundary: ['画面右后方为营帐群'], fixed: ['主帐木架', '案几'], variable: ['火盆火苗高度'] }] };
const voicePlanPayload = () => ({ lines: [
  { id: 'ln01', speaker: 'jiang_wei', kind: 'inner', text: '臣等正欲死战', performance: { tone: '低沉克制', pauses: ['停半拍'], breath: '吸气压住', silence: [] }, notSpoken: ['不要念出这段说明'] },
  { id: 'ln02', speaker: 'narrator', kind: 'narration', text: '蜀营夜巡，甲叶轻响。', performance: { tone: '平缓', pauses: [], breath: '平稳', silence: [] }, notSpoken: [] }] });
const castLine = extra => ({ id: 'jiang_wei', position: '画面左侧案前', facing: '朝向画面右前方', posture: '坐姿，重心落在髋部',
  hands: '双手持竹简，右手在上', props: ['竹简'], gaze: '视线落在竹简上', occlusion: '帐帘在前景右侧遮挡三分之一画面',
  costume: '深色甲袍，腰间短剑入鞘', ...extra });
const boardPayload = () => ({ audioBinding: 'b1', unusedAudio: [], shots: [
  { id: 'shot01', purpose: '读简并抬眼', covers: ['mk_jiang', 'mk_read', 'mk_line'], segments: [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 2.4 }],
    start: 0, end: 2.4, vendor: { modelSeconds: 3, coverage: 'trim', note: '取前 2.4 秒可用段' }, characters: [castLine()], scene: { id: 'tent', version: 1 },
    startState: '双手持简坐于案前', endState: '抬头，视线离开竹简', camera: '从竹简近景推向人物中景', transition: 'continuous', drivingLine: 'ln01',
    first: { moment: '双手持简、低头阅读的一刻', composition: '近景，人物半身与案几占画面下三分之二，机位在案前略高，人物面朝画面右下',
      bans: ['不得出现文字字幕'], crowdCostume: null, creativeAdditions: ['竹简为本片剧情新增物件，参考图中没有'],
      light: '帐内只有案上一盏铜灯为主光（灯焰小、照亮案面与人物右半侧），帐帘缝隙漏入帐外营火的暖色余光形成轮廓光',
      castState: [{ id: 'jiang_wei', position: '画面左侧案前，坐在低案后', facing: '面朝画面右前方并低头', posture: '坐姿，重心落在髋部，上身前倾', hands: '右手按在案上简册的右半边、左手扶住简册左缘，简册摊平在低案上', props: ['竹简'], gaze: '视线落在竹简上', occlusion: '帐帘在前景右侧遮挡约三分之一画面', costume: '深色甲袍，腰间短剑入鞘' }],
      visibleEnvironment: ['低案横在画面下方，简册平摊在案上、占画面下三分之一，双手按在简册两侧，案角与简册边缘可见',
        '帐帘在内间右侧形成前景遮挡，帘角压住画面右上，帘布粗麻纹路与烟熏痕迹可见',
        '案上一盏铜灯，灯焰较小，是帐内唯一亮点，照亮案面与人物右半侧',
        '人物身后是帐内木架与厚布内壁，暗部可辨木架轮廓与布面褶皱'],
      offscreen: ['帐帘外的营火余光从画面右外漏入，只作为人物右肩的暖色边缘光，火堆本身不在画内'],
      extraCast: [] },
    last: { moment: '抬头的一刻，视线离开竹简', composition: '中景，人物占画面中央偏左，案几退到前景下缘并轻微虚化，机位略降',
      bans: [], crowdCostume: null, creativeAdditions: [],
      light: '帐内铜灯仍是主光但灯焰比前一刻更暗，帐外营火的暖色余光更强、照到人物右肩与下颌',
      castState: [{ id: 'jiang_wei', position: '画面中央偏左，坐在低案后但上身已抬起', facing: '面朝画面左前方，头已抬起看向帐帘方向', posture: '坐姿，肩背挺起，重心略后', hands: '双手仍按在案上简册的两侧，简册没有离开案面', props: ['竹简'], gaze: '视线离开竹简，看向帐帘方向', occlusion: '帐帘已退到画面右缘，只遮住画面边缘，不再遮挡人物面部', costume: '深色甲袍，腰间短剑入鞘' }],
      visibleEnvironment: ['低案与案上的简册退到画面下缘，只见案角与简册一角，双手仍按在简册上，焦点转到人物面部',
        '帐帘仍在内间右侧但已退到画面边缘，人物身后露出帐内木架与前一刻被遮住的布墙',
        '铜灯仍在案上，光位不变，人物抬头后灯光落在下颌与颧骨下方'],
      offscreen: ['帐外营火余光比上一帧更强，形成人物右肩与下颌的轮廓光'],
      extraCast: [] },
    action: { phases: ['起势：吸气', '主动作：念完并停半拍', '收势：抬头'], speed: 1, secondary: ['火盆火苗轻晃'], settle: '停在抬头姿态', continuity: ['视线方向交给下一镜'] } },
  { id: 'shot02', purpose: '望向营地', covers: ['mk_end'], segments: [{ lineId: 'ln02', sourceStart: 0, sourceEnd: 3.6 }],
    start: 2.4, end: 6, vendor: { modelSeconds: 5, coverage: 'trim', note: '取前 3.6 秒可用段' }, characters: [],
    castNote: '本镜是无人物入画的环境镜头：摄影机从帐内切到帐外再升高到营地全景；姜维仍在帐内（故事空间中存在），但不在本镜任何一帧画内，因此不属于本镜可见人物，也不需要人物参考', scene: { id: 'tent', version: 1 },
    startState: '帐内抬头、视线离开竹简（姜维仍在帐内）', endState: '画面升高后停在营地上方，姜维不在画内', camera: '越过帐帘切到帐外，再升高到营地全景', transition: 'reframe', drivingLine: null,
    first: { moment: '帐帘被掀开、镜头刚越过帘口的一刻', composition: '中远景，姜维肩背在画面右下帘口，营地自画面中部向纵深展开，机位略低',
      bans: ['不得出现文字字幕'],
      crowdCostume: '群演共用衣着：深蓝灰短袍、束腰带、皮护腕、麻鞋、布制头盔（无缨）',
      light: '夜间室外光：天光很暗，主光是营门内侧两盏营火与营帐缝里漏出的灯光的暖色混合，人物在火光侧有轮廓；画面没有室内案面照明',
      castState: [{ id: 'jiang_wei', position: '画面右下角帘口，只看见肩背与一侧衣袖，站在门帘内侧', facing: '背对镜头、面朝帐外右前方', posture: '站姿，肩背放松，身体被帘口框住', hands: '右手掀着帘布，左手垂在身侧', props: [], gaze: '看不见正脸，视线朝营地方向', occlusion: '被帘布与门框挡住大部分身体，只露肩背与手臂', costume: '深色甲袍的肩背与衣袖，腰间短剑被帘布遮住' }],
      creativeAdditions: ['画面右侧一排晾晒的布甲为本片新增，参考图中没有'],
      visibleEnvironment: ['营前主路自画面左下向右上延伸，路面被踩实并有车辙，路边散着草料与两只木桶',
        '主路左侧两组宿帐、右侧三组宿帐，帐顶高低不齐，木桩与拉绳可见，帐布有雨痕与补丁',
        '营门木栅在画面中部偏左，栅后可见整备架与堆放的矛杆',
        '地面为踩实的黄土，靠画面右下有一块湿泥与水迹',
        '天空为夜间低云，远处第二排宿帐之后是低矮木栅与山影，画面最远处只剩轮廓'],
      offscreen: ['画面左外的帐内灯火照到帘口，形成帘口的暖光边；灯本身不在画内'],
      extraCast: [
        { id: 'guard_a', label: '守卫甲', group: '营门守卫', position: '画面中景偏左，营门木栅内侧', facing: '面朝画外右前方', posture: '站姿，重心在右腿，左肩略松',
          hands: '右手持矛，矛杆贴肩竖直，左手扶在腰带上', props: ['长矛'], gaze: '视线平视画外', action: '静止值守：右手持矛贴肩、视线平视画外、重心在右腿',
          visible: '全身可见，腰部以下被木栅略挡', costume: null },
        { id: 'guard_b', label: '守卫乙', group: '营门守卫', position: '画面中景偏右，营门另一侧，与守卫甲斜向相对', facing: '面朝画内左前方', posture: '站姿，重心略后，肩背挺直',
          hands: '左手握矛中段，右手自然垂在腰侧', props: ['长矛'], gaze: '视线扫过路过的巡逻队', action: '静止值守：头部朝向营门内侧',
          visible: '全身可见', costume: null },
        { id: 'patrol_a', label: '巡逻队员甲', group: '四人巡逻队', position: '主路左侧第一列首位', facing: '面朝画面右前方', posture: '行进中，上身前压，齐步抬腿',
          hands: '右手持矛扛在右肩', props: ['长矛'], gaze: '目视前方', action: '迈出左步的瞬间', visible: '全身可见，小腿被路边草料略挡', costume: null },
        { id: 'patrol_b', label: '巡逻队员乙', group: '四人巡逻队', position: '巡逻队员甲身后半步，左列第二人', facing: '面朝画面右前方', posture: '行进中，步幅与甲一致',
          hands: '右手持矛贴身', props: ['长矛'], gaze: '目视前方', action: '右脚落地', visible: '全身可见', costume: null },
        { id: 'patrol_c', label: '巡逻队员丙', group: '四人巡逻队', position: '主路右侧第一列首位，与甲并排', facing: '面朝画面右前方', posture: '行进中，肩略高于甲',
          hands: '双手横持长矛', props: ['长矛'], gaze: '目视前方', action: '迈出右步的瞬间', visible: '全身可见', costume: null },
        { id: 'patrol_d', label: '巡逻队员丁', group: '四人巡逻队', position: '巡逻队员丙身后半步（右列第二人，位于主路右侧）', facing: '面朝画面右前方', posture: '行进中，与丙间距略大',
          hands: '右手持矛，矛尖略低', props: ['长矛'], gaze: '瞥向左侧宿帐', action: '右脚刚落地、左脚在后，处在行进中的这一瞬间', visible: '全身可见', costume: null },
        { id: 'leggings_a', label: '整理绑腿者', group: '营地杂役', position: '画面右前，宿帐前木桩旁', facing: '侧身朝画面左，背对镜头三分之二', posture: '蹲姿，重心压在左脚，右膝点地',
          hands: '双手正在整理左腿绑腿，布条半松', props: [], gaze: '低头看绑腿', action: '静止不动，处在刚蹲下的姿势',
          visible: '全身可见', costume: '群演服饰外，肩上搭一条深色布巾' },
        { id: 'bucket_a', label: '提桶者', group: '营地杂役', position: '画面左下，主路边', facing: '面朝画面右上，正要走向主路', posture: '站姿，上身略向右侧倾',
          hands: '右手提木桶，桶身略倾斜，左手空着摆向身后', props: ['木桶'], gaze: '看向主路上的巡逻队', action: '起步的瞬间，脚跟刚离地',
          visible: '全身可见，桶被左腿略挡', costume: '群演服饰外，腰间系一块浅色干布' }
      ] },
    last: { moment: '镜头停在营地全景、人员各在其位的一刻', composition: '远景，营地上方留出夜空，主路自左下到右上贯穿画面，姜维只剩肩背在画面右下角帘口',
      bans: ['不得出现文字字幕'],
      crowdCostume: '群演共用衣着：深蓝灰短袍、束腰带、皮护腕、麻鞋、布制头盔（无缨）',
      light: '夜间室外光：天光很暗，营火与帐内漏光在画面中部形成暖色区，远处只剩冷调轮廓',
      castState: [{ id: 'jiang_wei', position: '画面右下角帘口，只剩肩背与一侧衣袖在画面边缘', facing: '背对镜头、面朝帐外', posture: '站姿，身体更靠帘内', hands: '右手扶着帘布边', props: [], gaze: '看不见正脸', occlusion: '几乎全部被帘布遮住，只留肩背轮廓', costume: '深色甲袍的肩背与衣袖' }],
      creativeAdditions: [],
      visibleEnvironment: ['宿帐五组自近到远排开，最后两组只余轮廓与被风吹起的帐绳',
        '主路延伸到画面右上并消失在帐影之间，车辙在湿泥处反光',
        '营门木栅退到画面中部，巡逻队已走过营门，栅后的整备架只余轮廓',
        '远处山影与低云压住画面上缘，最远一层的帐影与山形几乎合并'],
      offscreen: ['画左外的帐内灯火已弱，只留帘口一点暖光；火盆本身仍在画外'],
      extraCast: [
        { id: 'guard_a', label: '守卫甲', group: '营门守卫', position: '画面中景偏左，仍站营门木栅内侧', facing: '面朝画外右前方', posture: '站姿未变，重心略向右侧移',
          hands: '右手持矛贴肩，左手已放回身侧', props: ['长矛'], gaze: '视线随巡逻队方向移向画面右上', action: '值守不动，只有头部方向与前一刻不同',
          visible: '半身轮廓，细节随景别减弱', costume: null },
        { id: 'guard_b', label: '守卫乙', group: '营门守卫', position: '画面中景偏右，营门另一侧', facing: '面朝画内左前方', posture: '站姿未变',
          hands: '左手握矛中段', props: ['长矛'], gaze: '视线落回营门内侧', action: '值守不动，头部回正', visible: '半身轮廓', costume: null },
        { id: 'patrol_a', label: '巡逻队员甲', group: '四人巡逻队', position: '已走到主路中段偏右，位于营门之后', facing: '面朝画面右上', posture: '行进中，步幅与前一刻一致',
          hands: '右手持矛扛肩', props: ['长矛'], gaze: '目视前方', action: '已向前走过营门一段', visible: '队形与装备轮廓可辨，面部细节不可辨', costume: null },
        { id: 'patrol_b', label: '巡逻队员乙', group: '四人巡逻队', position: '巡逻队员甲身后半步', facing: '面朝画面右上', posture: '行进中',
          hands: '右手持矛贴身', props: ['长矛'], gaze: '目视前方', action: '右脚刚落地，位置在甲身后半步', visible: '轮廓可辨', costume: null },
        { id: 'patrol_c', label: '巡逻队员丙', group: '四人巡逻队', position: '主路右侧，与甲并行', facing: '面朝画面右上', posture: '行进中',
          hands: '双手横持长矛', props: ['长矛'], gaze: '目视前方', action: '右脚落地，位置与甲并列', visible: '轮廓可辨', costume: null },
        { id: 'patrol_d', label: '巡逻队员丁', group: '四人巡逻队', position: '巡逻队员丙身后半步（右列第二人）', facing: '面朝画面右上', posture: '行进中，间距仍略大',
          hands: '右手持矛', props: ['长矛'], gaze: '目视前方', action: '静止在丙身后半步', visible: '轮廓可辨', costume: null },
        { id: 'leggings_a', label: '整理绑腿者', group: '营地杂役', position: '画面右前木桩旁，位置未变', facing: '侧身朝画面左', posture: '蹲姿未变，重心略后移',
          hands: '双手绑好了左腿绑腿，正在收布条', props: [], gaze: '抬头前的低头姿态', action: '双手停在绑腿上、身体未起身的静止姿态',
          visible: '全身轮廓', costume: '群演服饰外，肩上深色布巾仍在' },
        { id: 'bucket_a', label: '提桶者', group: '营地杂役', position: '已沿主路走到画面中部偏左，比前一刻前移一段', facing: '面朝画面右上', posture: '行走中，上身前倾',
          hands: '右手提桶，桶内水面静止', props: ['木桶'], gaze: '看路面', action: '右脚落地、左腿在后的静止姿势', visible: '全身轮廓，桶被身体略挡',
          costume: '群演服饰外，腰间浅色干布仍在' }
      ] },
    action: { phases: ['起势：帐帘被风掀起', '主动作：镜头越过帐帘拉远', '收势：停在营地上方'], speed: 1, secondary: ['巡逻队走过'], settle: '镜头静止', continuity: ['结束'] } }] });

// Three registered characters in ONE frame. The first frame fits the adapter's 1-3 references (one identity
// material per person); the last frame also has to carry this shot's own first frame as a structural anchor and
// therefore does not. This is the exact ordering case the frame stage must refuse BEFORE it submits anything.
const trioCast = () => [castLine(),
  castLine({ id: 'zhong_hui', position: '画面右侧案后，面朝画面左前方', facing: '面朝画面左前方，略低头',
    posture: '跪坐，重心在左膝', hands: '双手交叠按在案上，未持物', props: [], gaze: '视线落在案上的军令上',
    occlusion: '被前景案沿挡住下半身', costume: '深色外袍，腰间无兵器' }),
  castLine({ id: 'deng_ai', position: '画面后方帐帘内侧', facing: '面朝画面内侧', posture: '站姿，重心略前',
    hands: '右手扶着帐帘边，左手垂在身侧', props: [], gaze: '视线看向案前', occlusion: '被帐帘遮住约三分之一身子',
    costume: '浅色布甲，未持械' })];
const trioBoard = () => {
  const payload = boardPayload(), shot = payload.shots[0], cast = trioCast();
  shot.characters = cast;
  for (const kind of ['first', 'last']) shot[kind].castState = cast.map(entry => ({ ...entry }));
  return payload;
};
const trioCharactersPayload = { entries: [charactersPayload.entries[0],
  { id: 'zhong_hui', name: '钟会', refs: ['fixtures/zhong-hui.png'],
    confirmed: { face: '长脸，细目', hair: '束发戴小冠', costume: '深色外袍', accessories: '腰间玉带', weapon: '未持械', palette: '深青与灰', materials: '丝与皮革' },
    weaponSide: null, unknown: ['手部细节看不清'], source: 'fixture', status: 'unverified' },
  { id: 'deng_ai', name: '邓艾', refs: ['fixtures/deng-ai.png'],
    confirmed: { face: '方圆脸，浓须', hair: '束发无冠', costume: '浅色布甲', accessories: '皮护腕', weapon: '未持械', palette: '灰白与土黄', materials: '粗布与皮' },
    weaponSide: null, unknown: ['靴面看不清'], source: 'fixture', status: 'unverified' },
  charactersPayload.entries[1]] };
const trioManifest = ({ image, voiceSample }) => [
  { id: 'jiang_wei', name: '姜维', image, voiceSample, traits: '测试夹具' },
  { id: 'zhong_hui', name: '钟会', image, voiceSample, traits: '测试夹具' },
  { id: 'deng_ai', name: '邓艾', image, voiceSample, traits: '测试夹具' },
  { id: 'narrator', name: '旁白', image, voiceSample, traits: '测试夹具' }];
// The same two-character frame, but this time the manifest itself DECLARES what each material has been confirmed
// to show: 姜维's 立绘 covers the costume and the short sword this frame must keep, while the 正脸参考 only covers
// the face and the hair. Necessity therefore follows the declaration, and the 立绘 is not a spare because it is
// listed second. The first frame fits the adapter's 1-3 references exactly; the last frame also has to carry this
// shot's own first frame and does not — the exact case the preflight must refuse before any submission.
const declaredCast = () => [castLine({ props: ['短剑入鞘'] }),
  castLine({ id: 'zhong_hui', position: '画面右侧案后，面朝画面左前方', facing: '面朝画面左前方，略低头',
    posture: '跪坐，重心在左膝', hands: '双手交叠按在案上，未持物', props: [], gaze: '视线落在案上的军令上',
    occlusion: '被前景案沿挡住下半身', costume: '深色外袍，腰间无兵器' })];
const declaredBoard = () => {
  const payload = boardPayload(), shot = payload.shots[0], cast = declaredCast();
  shot.characters = cast;
  for (const kind of ['first', 'last']) shot[kind].castState = cast.map(entry => ({ ...entry }));
  return payload;
};
const declaredCharactersPayload = { entries: [charactersPayload.entries[0], trioCharactersPayload.entries[1],
  charactersPayload.entries[1]] };
const declaredManifest = ({ image, voiceSample }) => [
  { id: 'jiang_wei', name: '姜维', image, frontImage: image, voiceSample, traits: '测试夹具',
    referenceCoverage: { frontImage: { covers: ['face', 'hair'], note: '正脸参考只证明面容与发型' },
      image: { covers: ['identity', 'costume', 'weapon'] } } },
  { id: 'zhong_hui', name: '钟会', image, voiceSample, traits: '测试夹具',
    referenceCoverage: { image: { covers: ['identity', 'costume'] } } },
  { id: 'narrator', name: '旁白', image, voiceSample, traits: '测试夹具' }];
// The same storyboard with ONE frame's wording changed: what a controlled re-plan of the creative product
// produces. The frames already generated from the old wording must not be able to pass as this new input.
const rewordedBoard = () => {
  const payload = boardPayload();
  payload.shots[0].first.composition += '；画面右缘留出帐帘缝隙漏入的一条暖光边';
  return payload;
};


function acceptedBinding(root) {
  const state = readJson(path.join(root, 'jobs', 'aliyun', production_.id, 'state.json'));
  return hash(state.creative.voicePlan.lines.map(line => ({ id: line.id, text: line.text,
    file: state.creative.audio?.[line.id]?.file ? fileHash(state.creative.audio[line.id].file) : null })));
}

function fixture({ characters: bible = charactersPayload, board = null, cast = null, voiceProducts = null,
  silentClips = false, ending = false, toneFailure = false } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'creative-entry-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  // The fixture enables the paid path ONLY in its own isolated config (the real config/aliyun.json stays
  // onlineEnabled:false, asserted in the test) and injects the provider adapter, so no request can leave.
  const config = readJson(path.join(ROOT, 'config/aliyun.json'));
  config.onlineEnabled = true;
  config.authorizationFile = 'auth.json';
  config.planner = { ...config.planner, reservationCents: 20 };
  config.pollTimeoutSeconds = 0;
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, region: config.region, productionId: production_.id, providers: ['aliyun'],
    approvedBudgetCny: 70, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000,volume=4', '-t', '3', '-ac', '1', sample]);
  // Two synthetic voice products: a full acting passage, not one file per sentence. A caller may hand in its own
  // products instead (voiceProducts), which is how a single continuous performance with a position marker inside
  // it is built for the cross-cut case.
  // Two visually different stand-ins, so first and last frame can be told apart in the requests.
  const framePngs = [path.join(root, 'frame-a.png'), path.join(root, 'frame-b.png')];
  media.command(['-f', 'lavfi', '-i', 'color=c=orange:s=512x512', '-frames:v', '1', framePngs[0]]);
  media.command(['-f', 'lavfi', '-i', 'color=c=teal:s=512x512', '-frames:v', '1', framePngs[1]]);
  const takes = voiceProducts || [path.join(root, 'take-ln01.wav'), path.join(root, 'take-ln02.wav')];
  if (!voiceProducts) {
    media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000,volume=4', '-t', '2.4', '-ac', '1', takes[0]]);
    media.command(['-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=24000,volume=4', '-t', '3.6', '-ac', '1', takes[1]]);
  }
  // Two supplier stand-in clips. The driver answers with exactly the seconds it was asked for and hands back an
  // audio track, so the plan's own numbers (asked 3s / 5s, film uses 2.4s / 3.6s) can be checked against a real
  // file instead of a placeholder string. `silentClips` builds the same pictures without any audio track, which is
  // the case a lip-sync take may really come back as.
  const clips = {};
  for (const seconds of [3, 5]) {
    const file = path.join(root, 'supplier-' + seconds + 's' + (silentClips ? '-silent' : '') + '.mp4');
    const args = ['-f', 'lavfi', '-i', 'color=c=' + (seconds === 3 ? 'green' : 'red') + ':s=1920x1080:r=30'];
    if (!silentClips) args.push('-f', 'lavfi', '-i', 'sine=frequency=' + (seconds === 3 ? 330 : 550) + ':sample_rate=48000');
    args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    if (!silentClips) args.push('-c:a', 'aac');
    args.push(file);
    media.command(args);
    clips[seconds] = file;
  }
  const manifest = { ...production_, intakeFile: 'input/director-brief.json',
    // A declared ending card: its picture is one of the fixture's own files, so a test can replace the file at the
    // same path and see whether the composition's input identity follows the CONTENT of the picture.
    ...(ending ? { ending: { image: framePngs[1], cardSeconds: 1, blackSeconds: 0.5 } } : {}),
    characters: cast ? cast({ image, voiceSample: sample })
      : [{ id: 'jiang_wei', name: '姜维', image, voiceSample: sample, traits: '测试夹具' },
        { id: 'narrator', name: '旁白', image, voiceSample: sample, traits: '测试夹具' }] };
  writeJson(path.join(root, 'input/production.json'), manifest);
  let failingChecks = false;
  const planner = [], speech = [], images = [], videos = [], checks = [], others = [], toneReviews = [];
  const modelsCfg = config.models;
  // The vision check uses body.messages[].content[] with {type:'image_url',image_url:{url:'data:...'}} while image
  // generation uses body.input.messages[].content[] with {image:'data:...'}; both shapes are parsed here.
  const mediaContent = body => [...(body?.input?.messages || []), ...(body?.messages || [])]
    .flatMap(message => Array.isArray(message?.content) ? message.content : [])
    .filter(part => part && typeof part === 'object');
  const imageParts = parts => parts.map(part => part.image || part.image_url?.url).filter(Boolean);
  const textParts = parts => parts.map(part => part.text).filter(Boolean).join('\n');
  const client = {
    request: async (endpoint, body = {}) => {
      if (body.model === 'qwen-voice-enrollment') return { output: { voice: 'test-voice' } };
      // Image generation and the vision frame check. The references are captured as the actual data URIs the
      // adapter sent, so the material really reaching the client is checked on the client boundary.
      if (body.model === modelsCfg.image) {
        const parts = mediaContent(body);
        images.push({ model: body.model, prompt: textParts(parts), references: imageParts(parts) });
        return { output: { choices: [{ message: { content: [{ image: 'https://mock.aliyuncs.com/frame-' + images.length + '.png' }] } }] } };
      }
      if (body.model === modelsCfg.vision || String(body.messages || '').includes('同一部片子的首尾帧')) {
        const parts = mediaContent(body);
        const text = textParts(parts) || String(body.messages || '');
        const references = imageParts(parts);
        // A text-only vision check must never be answered; the planner adapter owns text-only requests.
        if (!references.length) throw new Error('CHECK_WITHOUT_IMAGES_REJECTED_BY_FIXTURE');
        checks.push({ prompt: text, references });
        const verdict = failingChecks ? { pass: false, issues: ['手部与持物不符，需重做'] } : { pass: true, issues: [] };
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(verdict) } }] };
      }
      if (body.model && String(body.model).startsWith('qwen3-tts')) { speech.push(body);
        return { output: { audio: { url: 'https://test.aliyuncs.com/speech-' + speech.length + '.wav' } } }; }
      // The automatic tone review of ONE performance segment (the creative-tone-review protocol). The fixture
      // answers with all five criteria satisfied, so the verdict derived from them is a pass and the chain
      // continues to the ordinary acceptance gate exactly as before. What really reached the client is captured,
      // including the attached audio and the exact performance goals of the segment.
      if (endpoint.includes('chat/completions') && body.model === 'qwen3.8-omni-flash') {
        const parts = mediaContent(body), request = textParts(parts);
        if (request.includes('你是本片的配音表演审核模型')) {
          const lineId = request.match(/本段编号 ([\w-]+)/)?.[1] || 'ln01';
          toneReviews.push({ lineId, prompt: request, audio: parts.map(part => part.input_audio?.data).filter(Boolean),
            text: body.messages?.length || 0 });
          return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            lineId, heard: { transcript: request.match(/逐字台词（必须完整念出，不得念表演说明）":"([^"]*)"/)?.[1] || '念出的台词',
              uncertainWords: [] },
            criteria: Object.fromEntries(['completeness', 'emotionDirection', 'emotionChange', 'pacing', 'audibility']
              .map(name => [name, { status: toneFailure && lineId === 'ln01' && name === 'emotionDirection' ? 'violated' : 'satisfied', observed: '实际听感与表演安排对照', basis: '本段实际音频' }])),
            problems: toneFailure && lineId === 'ln01' ? [{ criterion: 'emotionDirection', span: '整段', observed: '声音过度激昂', required: '低沉克制', basis: '强烈重音与目标不符' }] : [], suggestions: [], limits: ['眼神、抬头、服饰动作与画面口型不在音频判断范围内'] }) } }] };
        }
      }
      if (endpoint.includes('chat/completions') && body.model === 'qwen3.8-omni-flash') {
        planner.push(JSON.stringify(body));
        // Which planning stage this is, is decided by the REQUEST CONTENT, not by a fixed call index: a run may
        // plan the storyboard more than once (for example after the accepted audio is replaced), and the answer
        // must still be the storyboard for that stage.
        const request = planner[planner.length - 1];
        const value = request.includes('你是本片的需求整理模型') ? requirementsPayload()
          : request.includes('你是本片的导演与分镜编剧') ? directorPayload()
            : request.includes('你是本片的美术设定模型') ? bible
              : request.includes('你是本片的美术与场景设定模型') ? scenesPayload
                : request.includes('你是本片的配音导演') ? voicePlanPayload()
                  : request.includes('你是本片的分镜师') ? { ...(board ? board() : boardPayload()), audioBinding: acceptedBinding(root) }
                    : { advice: '按检查问题重做该帧', scope: 'frames', requiresPaidRetry: true, userAction: '用户决定是否重做' };
        if (!value) throw new Error('UNEXPECTED_PLANNING_CALL');
        return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] };
      }
      // One plan-driven video request per shot. Both shapes the adapter can send are captured: the i2v dialogue
      // request (first frame, last frame, driving audio) and the five-second keyframe request (first + last frame
      // URL). The fixture never sees a plan: what it captures is what the client really received.
      if (body.model === modelsCfg.dialogueVideo || body.model === modelsCfg.actionVideo) {
        const parts = Array.isArray(body.input?.media) ? body.input.media : [];
        const urlOf = type => parts.find(part => part.type === type)?.url || null;
        videos.push({ endpoint, model: body.model, duration: body.parameters?.duration,
          prompt: body.input?.prompt || '', media: parts.map(part => part.type),
          first: urlOf('first_frame') || body.input?.first_frame_url || null,
          last: urlOf('last_frame') || body.input?.last_frame_url || null, audio: urlOf('driving_audio'),
          promptExtend: body.parameters?.prompt_extend, watermark: body.parameters?.watermark });
        return { output: { task_id: 'task-video-' + body.parameters?.duration } };
      }
      others.push({ endpoint, model: body.model || null });
      throw new Error('UNEXPECTED_REQUEST:' + endpoint);
    },
    download: async (url, destination) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const frame = String(url).match(/frame-(\d+)\.png$/);
      const clip = String(url).match(/supplier-(\d+)s\.mp4$/);
      const source = clip ? clips[Number(clip[1])] : frame ? framePngs[(Number(frame[1]) - 1) % 2]
        : url.endsWith('.png') ? image : url.endsWith('speech-2.wav') ? takes[1] : takes[0];
      fs.copyFileSync(source, destination); return destination; },
    upload: async () => 'oss://test/audio.wav',
    task: async taskId => {
      const seconds = Number(String(taskId).match(/task-video-(\d+)$/)?.[1] || 0);
      return { output: { task_status: 'SUCCEEDED', task_id: taskId,
        video_url: 'https://test.aliyuncs.com/supplier-' + seconds + 's.mp4' } };
    } };
  return { root, directory: path.join(root, 'jobs', 'aliyun', production_.id), manifest: 'input/production.json',
    planner, speech, images, videos, checks, others, toneReviews, client, takes, clips, media, ending: manifest.ending || null,
    setFailingChecks: value => { failingChecks = value; } };
}
const stateOf = f => readJson(path.join(f.directory, 'state.json'));

// ---- the final composition: entry-level helpers ---------------------------------------------------------
// The last boundary of this chain is local, so it is verified on the produced FILE, not on JSON alone: the
// helpers below drive the existing fixture through the normal entry and then measure the film with the
// project's own FFmpeg (same method as tests/creative-timeline-media.test.js, so the numbers are comparable).
const FINAL_DURATION_TOLERANCE = 0.15; // assemble() itself rejects a film whose duration drifts more than this
const FINAL_TONE_TOLERANCE = 60;       // AAC keeps the dominant tone well inside this band
const FINAL_SILENCE_LIMIT = 0.05;      // RMS below this counts as a real gap
// The "residue" test measures the neighbouring tone as a BAND, so the band has to be narrow enough that the
// film's own voice does not leak into it. Calibrated with the project's own FFmpeg (scratch probe, 24000 Hz
// PCM, both tone pairs of the fixture): around a voice-only signal the neighbouring clip's band reads
// 0.026-0.028 of the voice's band at w=5 (0.15 at w=30), while a clip track leaking at 30% of the voice level
// reads 0.079 and at full level 0.25. The limit below therefore fails a real leak without failing a clean mix.
const FINAL_RESIDUE_WIDTH = 5;
const FINAL_RESIDUE_LIMIT = 0.06;
const finalOutput = f => path.join(f.root, 'output', production_.id, 'final.mp4');
const filmSubtitleFile = output => path.join(path.dirname(output), 'subtitles.srt');
async function withOffline(fn) {
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try { await fn(); }
  finally { global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker; }
}
// The accepted audio is the prerequisite of the storyboard, so every film walk passes the same gate.
async function acceptFixtureAudio(f) {
  await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
  const audio = stateOf(f);
  await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
    'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
  return audio;
}
// Dominant tone + loudness of one window of the finished film, measured on decoded PCM.
function windowSignal(media, file, at, seconds) {
  const rate = 24000;
  const pcm = media.command(['-ss', String(at), '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
  const samples = Math.floor(pcm.length / 2);
  let peak = 0, squares = 0;
  for (let i = 0; i < samples; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768; peak = Math.max(peak, v); squares += v * v; }
  const rms = samples ? Math.sqrt(squares / samples) : 0, threshold = peak * 0.35;
  let crossings = 0, state = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    if (v > threshold) { if (state === -1) crossings++; state = 1; }
    else if (v < -threshold) { if (state === 1) crossings++; state = -1; }
  }
  return { frequency: samples ? Math.round((crossings * rate) / (2 * samples)) : 0, rms };
}
// Energy inside a narrow band around one frequency, measured with FFmpeg's own band-pass filter. This is what
// makes a "residue" assertion meaningful: the clip's own tone is measured as a BAND, so a quiet leftover
// cannot hide behind a different dominant frequency.
function bandRms(media, file, at, seconds, frequency, width = 30) {
  const rate = 24000;
  const pcm = media.command(['-ss', String(at), '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', String(rate),
    '-af', 'bandpass=f=' + frequency + ':width_type=h:w=' + width, '-f', 's16le', 'pipe:1']);
  const samples = Math.floor(pcm.length / 2);
  let squares = 0;
  for (let i = 0; i < samples; i++) { const v = pcm.readInt16LE(i * 2) / 32768; squares += v * v; }
  return samples ? Math.sqrt(squares / samples) : 0;
}
function cues(srt) {
  return srt.trim().split(/\n\n+/).map(block => {
    const [index, range, ...text] = block.split('\n');
    const [from, to] = range.split(' --> ').map(stamp => {
      const [h, m, rest] = stamp.split(':'); const [s, ms] = rest.split(',');
      return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    });
    return { index: Number(index), from, to, text: text.join('\n') };
  });
}

test('the creative chain runs through the normal entry: creative, audio, acceptance gate, storyboard', { timeout: 120000 }, async () => {
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  try {
    await main(['run', f.manifest, '--until', 'creative'], { root: f.root, client: f.client });
    const first = stateOf(f);
    assert.equal(first.stage, 'creative');
    assert.equal(f.planner.length, 5, '五个规划阶段各一次请求');
    assert.equal(f.speech.length, 0, '--until creative 不生成配音');
    assert.equal(f.others.length, 0, '--until creative 不发起图片或视频请求');
    assert.ok(first.creative.requirements && first.creative.directorScript && first.creative.characters);
    assert.ok(first.creative.scenes && first.creative.voicePlan, '设定集与配音计划已落盘');
    assert.equal(first.creative.audio, undefined, '未到配音阶段');
    // A restart resumes from the persisted package instead of planning again.
    await main(['run', f.manifest, '--until', 'creative'], { root: f.root, client: f.client });
    assert.equal(f.planner.length, 5, '重启恢复不重复规划');
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    assert.equal(audio.stage, 'audio');
    assert.equal(f.speech.length, 2, '配音按表演段组织，不强制一句一个文件');
    const spoken = JSON.stringify(f.speech);
    assert.ok(spoken.includes('臣等正欲死战'), '朗读文本来自配音计划');
    assert.ok(!spoken.includes('不要念出这段说明'), '表演说明不进入朗读');
    assert.ok(Math.abs(audio.creative.audio.ln01.duration - 2.4) < 0.05, 'ln01 实测时长');
    assert.ok(Math.abs(audio.creative.audio.ln02.duration - 3.6) < 0.05, 'ln02 实测时长');
    assert.ok(String(audio.creative.audio.ln01.measuredBy).includes('ffprobe'), '时长来自本地实测');
    // Gate: not accepted yet, so the run stops here with zero storyboard requests.
    await main(['run', f.manifest], { root: f.root, client: f.client });
    const gated = stateOf(f);
    assert.equal(f.planner.length, 5, '未接受音频时分镜请求数为零');
    assert.equal(gated.creativeStage.pause.code, 'CREATIVE_AUDIO_NOT_ACCEPTED');
    assert.equal(gated.creative.storyboard, undefined);
    // Acceptance through the same entry: plan digest, audio content, measured duration and method are bound.
    await main(['accept-creative-audio', f.manifest, 'ln01=' + gated.creative.audio.ln01.file,
      'ln02=' + gated.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    const accepted = stateOf(f);
    assert.equal(accepted.creative.acceptance.status, 'accepted');
    assert.equal(accepted.creative.acceptance.method, 'fixture');
    assert.ok(accepted.creative.acceptance.binding, '接受绑定音频内容');
    assert.ok(accepted.creative.acceptance.plan.digest, '接受绑定配音计划摘要');
    assert.ok(Math.abs(accepted.creative.acceptance.measured.ln01 - 2.4) < 0.05, '接受记录实测时长');
    await main(['run', f.manifest, '--until', 'storyboard'], { root: f.root, client: f.client });
    const board = stateOf(f);
    assert.equal(board.stage, 'storyboard');
    assert.equal(f.planner.length, 6, '分镜只规划一次');
    assert.equal(board.creative.storyboard.shots.length, 2);
    assert.equal(board.creative.timeline.audioBed.length, 2, '成片音频床来自已接受的音频');
    assert.equal(f.others.length, 0, '--until storyboard 不发起任何图片或视频请求');
    await main(['run', f.manifest, '--until', 'storyboard'], { root: f.root, client: f.client });
    assert.equal(f.planner.length, 6, '恢复不重复提交分镜');
    assert.equal(stateOf(f).creative.storyboard.audioBinding, board.creative.storyboard.audioBinding);
    // Changing the accepted audio must invalidate the old acceptance AND the old storyboard.
    f.media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000,volume=4', '-t', '1.9', '-ac', '1', board.creative.audio.ln01.file]);
    await main(['run', f.manifest, '--until', 'storyboard'], { root: f.root, client: f.client });
    const after = stateOf(f);
    assert.equal(f.planner.length, 6, '绑定失效时不得再次规划分镜');
    assert.equal(after.creative.storyboard, undefined, '旧分镜必须失效');
    assert.equal(after.creative.invalidated.code, 'CREATIVE_AUDIO_CHANGED');
    assert.equal(after.creativeStage.pause.code, 'CREATIVE_AUDIO_NOT_ACCEPTED');
  } finally { global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker; }
});
test('a fixture acceptance is refused on a task that is not an offline fixture', async () => {
  const f = fixture();
  await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
  const state = stateOf(f);
  const manifest = readJson(path.join(f.root, 'input/production.json'));
  delete manifest.creativeFixture;
  writeJson(path.join(f.root, 'input/production.json'), manifest);
  await assert.rejects(main(['accept-creative-audio', f.manifest, 'ln01=' + state.creative.audio.ln01.file,
    'ln02=' + state.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root }), /FIXTURE_ACCEPTANCE_NOT_ALLOWED/);
});

test('the creative frame stage runs through the normal entry: first/last frames, checks, zero video', { timeout: 180000 }, async () => {
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    const done = stateOf(f);
    assert.equal(done.stage, 'frames');
    assert.equal(f.images.length, 4, '两镜各生成首帧与尾帧');
    assert.equal(f.checks.length, 2, '每镜一次既有帧检查');
    assert.equal(f.others.length, 0, '--until frames 期间零视频请求');
    assert.ok(fs.existsSync(done.assets.shot01.first) && fs.existsSync(done.assets.shot01.last));
    assert.ok(fs.existsSync(done.assets.shot02.first) && fs.existsSync(done.assets.shot02.last));
    // The three running times stay separate and are recorded per shot.
    assert.equal(done.creative.frames.shot01.supplierSeconds, 3);
    assert.ok(Math.abs(done.creative.frames.shot01.filmSeconds - 2.4) < 0.01);
    assert.equal(done.creative.frames.shot01.coverage, 'trim');
    assert.equal(done.creative.frames.shot01.drivingAudio.lineId, 'ln01');
    assert.ok(done.creative.actions.shot01.includes('动作分阶段'), '动作提示词单独保存，不塞进静态首帧');
    // What was ACTUALLY sent: frame-specific content, no off-screen crowd, reference mapping in the text.
    const sent = f.images[0].prompt;
    assert.ok(sent.includes('该帧的唯一静止时刻'), '实际请求含单一静止时刻');
    assert.ok(!sent.includes('本帧可见的人群分布'), '近景不含画外人群');
    assert.ok(sent.includes('图1=立绘参考（jiang_wei）'), '文本说明与参考图顺序一致，且按清单字段如实标注（本夹具只有 image 立绘，不冒充正脸参考）');
    assert.equal(f.images[0].references.length, 1, '参考素材真实进入图片请求');
    assert.ok(f.images[0].references[0].startsWith('data:image/'), '参考素材以实际图像数据送达');
    // The fixture declares nothing about its material, so the request must NOT present it as covering anything:
    // the coverage is recorded and stated as unconfirmed, and no requirement is claimed to be met by a reference.
    const plan01 = done.assets.shot01.referencePlan;
    assert.deepEqual(plan01.unconfirmed.map(entry => entry.source), ['image'], '未声明覆盖范围的素材记录为覆盖未知');
    assert.deepEqual(done.creative.frames.shot01.references.map(entry => [entry.role, entry.coverage]),
      plan01.first.kept.map(entry => [entry.role, entry.coverage]), '记录与预检的用途与覆盖一致');
    assert.ok(sent.includes('（用途：' + done.creative.frames.shot01.references[0].purpose + '）'),
      '实际请求逐条写明该素材的用途');
    assert.match(sent, /覆盖范围未经确认的参考只作保守保留，不得据此声称身份、服饰或武器已由参考图保证/);
    assert.deepEqual(plan01.uncovered.filter(entry => entry.frame === 'first').map(entry => entry.need),
      ['identity', 'costume', 'weapon'], '未声明覆盖时不声称任何必需项已被参考满足');
    assert.deepEqual(done.creative.frames.shot01.droppedReferences, [], '没有被省略的素材');
    // The frame check is a vision request whose material transport is not asserted here (the mock boundary
    // captured ' + 'the prompt only); the input binding below is what protects reuse and invalidation.
    assert.equal(f.checks[0].references.length, 3, '帧检查实际收到 1 张参考 + 首帧 + 尾帧');
    assert.equal(new Set(f.checks[0].references).size, 3, '三张图互不相同（首尾帧都在）');
    assert.ok(f.checks[0].references.every(entry => String(entry).startsWith('data:image/')), '检查图以图像数据发送');
    assert.ok(f.checks[0].prompt.includes('目标首帧') && f.checks[0].prompt.includes('目标尾帧'), '检查提示词与图片顺序对应');
    assert.ok(typeof done.assets.shot01.frameReview.binding.digest === 'string', '检查输入绑定已记录');
    assert.ok(typeof done.assets.shot01.frameReview.binding.digest === 'string', '帧检查输入绑定已记录');
    assert.equal(done.assets.shot01.frameReview.pass, true);
    assert.equal(done.creative.frames.shot01.review, 'accept');
    // Resume: the same input must not be submitted again.
    const before = { images: f.images.length, checks: f.checks.length };
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    assert.equal(f.images.length, before.images, '同输入恢复不重复提交图片');
    assert.equal(f.checks.length, before.checks, '同输入恢复不重复提交帧检查');
    // The video boundary is separate from the frames' one: --until video generates the takes, and the stage
    // after them stops explicitly instead of entering the legacy path.
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    const withVideo = stateOf(f);
    assert.equal(withVideo.stage, 'video');
    assert.equal(f.videos.length, 2, '两镜各一次视频请求');
    assert.equal(f.others.length, 0, '没有预期之外的请求');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});

test('the video stage asks for exactly what each shot planned, driving audio included', { timeout: 180000 }, async () => {
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    const done = stateOf(f);

    // 1) One take per shot, in shot order, each with the branch's own adapter and requested seconds.
    assert.equal(done.stage, 'video');
    assert.equal(f.videos.length, 2, '两镜各一次视频请求');
    assert.equal(f.planner.length, 6, '分镜规划一次；视频阶段不重复规划');
    assert.equal(f.videos[0].model, 'wan2.7-i2v', '口型镜走口型驱动适配器');
    assert.equal(f.videos[0].duration, 3, '口型镜按分镜声明的整数秒请求');
    assert.equal(f.videos[1].model, 'wan2.2-kf2v-flash', '无口型镜走首尾帧适配器');
    assert.equal(f.videos[1].duration, 5, '首尾帧适配器固定 5 秒');
    assert.ok(f.videos.every(video => video.promptExtend === false && video.watermark === false), '关闭提示词扩写与水印');

    // 2) The plan is what was actually sent: same text, same anchors, no invented wording.
    const take01 = done.creative.videos.shot01, take02 = done.creative.videos.shot02;
    assert.equal(f.videos[0].prompt, take01.plan.prompt.text, '请求提示词与计划逐字一致');
    assert.equal(f.videos[0].prompt, take01.request.prompt, '记录里的提示词就是实际发送的提示词');
    assert.ok(f.videos[0].prompt.includes('口型：本镜人物只按输入音频说话'), '口型镜在请求里写明口型依据');
    assert.ok(f.videos[0].prompt.includes('动作分阶段：'), '动作提示词完整进入视频请求');
    assert.deepEqual(f.videos[0].media, ['first_frame', 'last_frame', 'driving_audio'], '口型镜同时送出两帧与驱动音频');
    assert.deepEqual(f.videos[1].media, [], '首尾帧镜使用 first/last 帧字段而不是 media 数组');
    assert.ok(f.videos[1].first && f.videos[1].last, '首尾帧镜真的带上两张锚点');
    assert.ok(f.videos[1].prompt.includes('口型：本镜没有口型驱动'), '无口型镜要求人物闭口');
    assert.equal(take01.plan.digest, take01.digest, '记录与计划同源');
    assert.equal(take01.digest, done.assets.shot01.videoPlan.digest, '状态里的计划与记录一致');
    assert.equal(take02.plan.branch, 'keyframes');

    // 3) The driving audio comes from the accepted line, sits where the film plays it, and is measured.
    const driving = take01.drivingAudio;
    assert.equal(driving.lineId, 'ln01');
    assert.ok(fs.existsSync(driving.file), '驱动音频文件存在');
    assert.ok(Math.abs(driving.seconds - 2.4) < 0.05, '驱动音频取本镜实际播放的 2.4 秒');
    assert.ok(Math.abs(driving.seconds - take01.plan.drivingAudio.padToSeconds) < 0.05, '实测时长与计划声明一致');
    assert.equal(take01.plan.drivingAudio.pieces.length, 1);
    assert.equal(take01.plan.drivingAudio.pieces[0].inShotStart, 0, '按镜头内真实偏移放置');
    assert.equal(driving.sourceHash, fileHash(done.creative.audio.ln01.file), '驱动音频来自已接受的配音');
    // The film uses 2.4 of the 3 requested seconds: the discarded tail is recorded, not implied away.
    assert.deepEqual([take01.usage.start, take01.usage.end], [0, 2.4]);
    assert.ok(Math.abs(take01.usage.tailDiscardedSeconds - 0.6) < 0.05);
    assert.ok(Math.abs(take01.info.duration - 3) < 0.2, '取回的是供应商生成的 3 秒');
    assert.equal(take01.info.audio, true, '口型镜素材带音轨');

    // 4) The existing video check runs over the window the film uses, and claims nothing more.
    assert.equal(f.checks.length, 4, '两镜各一次帧检查与一次视频检查');
    const check = f.checks[2];
    assert.ok(check.prompt.includes('本镜成片只用前 2.4 秒'), '检查声明与实际取用窗口一致');
    assert.ok(check.prompt.includes('末尾 0.6 秒不进入成片、也不检查'), '未检查的尾部被明说');
    assert.ok(check.prompt.includes('抽帧不能证明口型是否与声音对上'), '不声称口型已被验证');
    assert.equal(check.references.length, 5, '目标首帧 + 三次抽帧 + 目标尾帧');
    assert.equal(take01.check.verdict, 'pass');
    assert.deepEqual(take01.check.sampledTimes, done.assets.shot01.videoReview.evidence.sampling);
    assert.equal(take02.check.pass, true);
    assert.equal(done.creativeStage?.pause, undefined, '--until video 不留下暂停记录');

    // 5) Resume: the same input reuses the take and its verdict instead of paying twice.
    const before = { videos: f.videos.length, checks: f.checks.length };
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    assert.equal(f.videos.length, before.videos, '同输入恢复不重复提交视频');
    assert.equal(f.checks.length, before.checks, '同输入恢复不重复提交视频检查');

    // 6) The last boundary is closed by local assembly: the same run now writes the film, and this step
    // contacts no provider. What the file contains is verified below on the produced media itself.
    await main(['run', f.manifest], { root: f.root, client: f.client });
    const finished = stateOf(f);
    assert.equal(finished.stage, 'final');
    assert.equal(finished.creativeStage?.pause, undefined, '可合成的输入不再停在合成边界');
    assert.equal(finished.creative.finalBlockers, undefined, '可合成的输入不留阻断清单');
    assert.equal(finished.output, finalOutput(f));
    assert.ok(fs.existsSync(finished.output), '成片真的写到了磁盘');
    assert.equal(finished.acceptance, 'awaiting_user_playback', '成片仍需用户播放验收，不自动接受');
    assert.equal(f.videos.length, before.videos, '合成不发起新的生成请求');
    assert.equal(f.checks.length, before.checks, '合成不发起新的检查请求');
    assert.equal(f.others.length, 0, '没有预期之外的请求');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});

test('a rejected frame check spends a round or pauses instead of passing through the entry', { timeout: 180000 }, async () => {
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    f.setFailingChecks(true);
    // A rejected frame does not pass silently: the existing controlled path stops the run for the user.
    await assert.rejects(main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client }),
      /REVIEW_REQUIRED:frames-shot01/);
    const rejected = stateOf(f);
    // The run stops for the user before any per-shot frame record is completed: the frame asset and its
    // review are what exist, and a failed review never becomes an accepted one.
    assert.equal(rejected.assets.shot01.frameReview.pass, false, '检查结论被记录为不通过');
    assert.equal(rejected.creative.frames.shot01, undefined, '未通过检查的镜头不写完成记录');
    assert.ok(rejected.assets.shot01.frameReview.issues.length > 0, '不通过的检查带具体问题');
    // Bookkeeping follows the existing policy: both frame units are registered with exactly the one generation
    // that was actually submitted, and neither is marked exhausted or out of rounds — the stop is a pause for the
    // user to decide, not an automatic exhaustion and never a silent pass. The check itself owns no generation
    // round (checks have their own budget), so a rejected check cannot consume the frames' rework allowance.
    const rounds = readJson(path.join(f.directory, 'unit-attempts.json')).units;
    assert.equal(rounds['first-shot01']?.generations, 1, '首帧单元只登记一次生成');
    assert.equal(rounds['last-shot01']?.generations, 1, '尾帧单元只登记一次生成');
    assert.equal(rounds['first-shot01']?.exhausted, null, '拒绝不自动判定为单元用尽');
    assert.equal(rounds['last-shot01']?.limitReached, null, '返工额度未被静默关闭');
    assert.equal(rounds['frame-check-shot01'], undefined, '帧检查不占用生成轮次');
    assert.equal(f.images.length, 2, '拒绝路径只提交了该镜的首尾帧');
    assert.equal(f.checks.length, 1, '拒绝路径只提交一次帧检查');
    assert.equal(f.others.length, 0, '拒绝路径也不发起视频请求');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});


test('a fixture acceptance cannot be used for a real media client', { timeout: 120000 }, async () => {
  const f = fixture();
  const originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'storyboard'], { root: f.root, client: f.client });
    const imagesBefore = f.images.length;
    // No injected client: this is the real media client. The run must be refused before anything is submitted.
    // Two independent protections are acceptable here: the stage refuses a fixture acceptance for a real client,
    // and without credentials the real client cannot even be constructed (DASHSCOPE_API_KEY_MISSING).
    await assert.rejects(main(['run', f.manifest, '--until', 'frames'], { root: f.root }),
      /CREATIVE_FIXTURE_ACCEPTANCE_IN_REAL_RUN|DASHSCOPE_API_KEY_MISSING/);
    assert.equal(f.images.length, imagesBefore, '未向真实客户端提交任何图片请求');
  } finally {
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});

test('the four real image requests are exported verbatim, with the crowd-only shot through the entry', { timeout: 180000 }, async () => {
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });

    // 1) The planning request is identified by its CONTENT, not by a fixed array index.
    const storyboardCall = f.planner.find(entry => entry.includes('你是本片的分镜师'));
    assert.ok(storyboardCall, '应能在实际规划请求中按内容找到分镜请求');
    for (const requirement of ['visibleEnvironment', 'castState', 'extraCast', 'crowdCostume',
      'creativeAdditions', 'offscreen', 'light', '首帧与尾帧的人物状态必须分别输出',
      '共用服饰不等于共用武器', '独立的动作提示词']) {
      assert.ok(storyboardCall.includes(requirement), '实际分镜规划请求必须要求：' + requirement);
    }

    // 2) Four image requests and two checks, in shot order, and no video request at all.
    assert.equal(f.images.length, 4, '两镜各首尾帧各一次实际请求');
    assert.equal(f.checks.length, 2, '每镜一次既有帧检查');
    assert.equal(f.others.length, 0, '--until frames 期间零视频请求');
    const closeUpFirst = f.images[0].prompt, closeUpLast = f.images[1].prompt;
    const crowdFirst = f.images[2].prompt, crowdLast = f.images[3].prompt;

    // 3) The shot with no registered character still runs: the crowd IS in frame and is described one by one
    // with stable ids, while the protagonist is explicitly outside this frame.
    for (const personId of ['guard_a', 'guard_b', 'patrol_a', 'patrol_b', 'patrol_c', 'patrol_d', 'leggings_a', 'bucket_a']) {
      assert.ok(crowdFirst.includes('身份 ' + personId), '群演首帧应含稳定身份 ' + personId);
      assert.ok(crowdLast.includes('身份 ' + personId), '群演尾帧应含同一稳定身份 ' + personId);
    }
    assert.ok(crowdFirst.includes('本镜人物范围说明：') && crowdFirst.includes('不在本镜任何一帧画内'),
      '无主角色入画的镜头必须写明主角色不在画内');
    assert.ok(crowdFirst.includes('共用群演服饰（已在上面对应人物身上展开）'), '共用服饰实际展开');
    assert.ok(!crowdFirst.includes('立绘参考（jiang_wei）') && !crowdFirst.includes('正脸参考（jiang_wei）'), '主角色不入画时不得附带其人物参考');
    // 4) The only reference is the previous shot's frame, and its purpose is stated as limited on purpose.
    assert.equal(f.images[2].references.length, 1, '群演镜只用一张有明确用途的参考');
    assert.ok(crowdFirst.includes('画风与材质参考（前镜首帧；只作画风、材质与局部光照参考，不含本镜场景布局'),
      '参考用途必须写明有限，不得宣称完整场景连续性');
    // 5) The two close-up frames carry their own static states, and the props agree with the environment text.
    assert.ok(closeUpFirst.includes('简册平摊在案上') && closeUpFirst.includes('按在案上简册'),
      '竹简的位置在环境与人物描述里必须一致');
    assert.ok(closeUpFirst.includes('低头') && closeUpLast.includes('已抬起'), '首尾帧各自的状态必须分别进入请求');
    assert.notEqual(closeUpFirst, closeUpLast);
    assert.ok(!closeUpFirst.includes('守卫') && !closeUpLast.includes('守卫'), '近景不得混入画外群演');

    const labels = [
      { shot: 'shot01 姜维近景', kind: '首帧' }, { shot: 'shot01 姜维近景', kind: '尾帧' },
      { shot: 'shot02 八名群演军营广角', kind: '首帧' }, { shot: 'shot02 八名群演军营广角', kind: '尾帧' } ];
    const document = ['# 首尾帧实际请求全文（由运行模块导出）', '',
      '> 本文件由 tests/creative-entry.test.js 在隔离夹具上运行正常入口 run --until frames 时写入图片客户端**实际收到**的提示词；未手工润色、未节选、未使用省略号。',
      '> 夹具为合成素材与模拟设定：参考图是合成的色块图，人物与场景资料是测试夹具，不代表用户立绘分析，也没有进行任何真实生成。',
      '> 两镜：A 姜维近景（姜维一人入画）；B 八名群演军营广角（**无主角色入画、八名群演入画**：两名守卫、四名巡逻队员、整理绑腿者、提桶者；姜维仍在帐内但不在本镜任何一帧画内）。',
      '> B 镜的参考素材只有前镜首帧的一张图，用途仅为画风、材质与局部光照参考，不含营地布局，也不得照抄其中的人物与构图。',
      '> 参考素材的必要性由清单 referenceCoverage 声明与本帧必须保持的内容共同决定；本夹具**没有声明任何覆盖范围**，因此正文如实写明“覆盖未知”，只作保守保留，不声称身份、服饰或武器已由参考图保证。', ''];
    f.images.forEach((entry, index) => {
      document.push('## ' + labels[index].shot + ' · ' + labels[index].kind, '',
        '- 实际发送的参考素材数量：' + entry.references.length,
        '- 参考用途：' + (entry.references.length
          ? (index >= 2 ? '画风与材质参考（前镜首帧，用途有限）——逐条用途见正文「参考图对应」'
            : '人物身份参考（按清单实际素材字段：正脸或立绘）——覆盖范围以清单声明为准；未声明时正文写明“未经确认”，不声称必需项已由参考保证')
          : '无'),
        '- 实际请求全文：', '', '```text', entry.prompt, '```', '');
    });
    const target = path.resolve(ROOT, 'docs', 'CREATIVE_FRAME_REQUEST_SAMPLE.md');
    fs.writeFileSync(target, document.join('\n') + '\n', 'utf8');
    const stored = fs.readFileSync(target, 'utf8');
    // 6) One text block per request, in order: strictly equal, not merely contained.
    const blocks = stored.split('```text\n').slice(1).map(part => part.split('\n```')[0]);
    assert.deepEqual(blocks, f.images.map(entry => entry.prompt), '四个正文区块必须与四次实际请求逐字一一对应');
    assert.ok(stored.includes('无主角色入画、八名群演入画'), '文档开头必须说明无主角入画但有八名群演');

    // 7) Resume: the same input is neither re-submitted nor re-checked.
    const before = { images: f.images.length, checks: f.checks.length, planner: f.planner.length };
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    assert.equal(f.images.length, before.images, '同输入恢复不重复提交图片');
    assert.equal(f.checks.length, before.checks, '同输入恢复不重复提交帧检查');
    assert.equal(f.planner.length, before.planner, '同输入恢复不重复规划');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});



// The fixture gate is verified in isolation: a stub provider client is used (so client construction cannot fail
// on missing credentials and no network is reachable), the acceptance is a fixture acceptance, and the run is NOT
// declared an allowed offline-fixture execution. The gate itself must be what stops the run.
test('a fixture acceptance is refused when the run is not an allowed offline fixture execution', { timeout: 180000 }, async () => {
  const { runProduction, loadContext } = require('../workflows/production');
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  try {
    // Prepare the state through the entry with a permitted fixture acceptance.
    process.env.CREATIVE_OFFLINE_FIXTURE = '1';
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'storyboard'], { root: f.root, client: f.client });
    delete process.env.CREATIVE_OFFLINE_FIXTURE;
    const imagesBefore = f.images.length, checksBefore = f.checks.length;
    const context = loadContext(f.root, path.join(f.root, f.manifest));
    // A stub client is injected so nothing can reach the network and no credentials are needed, but the run is not
    // marked as an allowed offline-fixture execution: the gate must fire before any submission.
    await assert.rejects(runProduction(context, { until: 'frames', client: f.client, testDouble: false, log: () => {} }),
      /CREATIVE_FIXTURE_ACCEPTANCE_IN_REAL_RUN/);
    assert.equal(f.images.length, imagesBefore, '守门触发时不得提交任何图片请求');
    assert.equal(f.checks.length, checksBefore, '守门触发时不得提交任何检查请求');
    assert.equal(f.others.length, 0, '守门触发时不得有任何其他提交');
  } finally {
    // Restore the marker instead of deleting it: an outer process may legitimately have set it, and deleting it
    // would leak that change into every later test in the same process.
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
    global.fetch = originalFetch;
  }
});

// A changed reference material must invalidate the old frames and the old check, with no silent re-generation:
// the run stops with PRODUCTION_INPUT_CHANGED, keeps the previous frames, their recorded review and its binding
// exactly as they were, sends nothing new, and the user continues only after an explicit controlled revision.
test('a changed reference image invalidates the old frames and their check', { timeout: 180000 }, async () => {
  const { Media } = require('../services/aliyun/media');
  const f = fixture();
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    const firstRound = stateOf(f);
    const bindingBefore = firstRound.assets.shot01.frameReview.binding.digest;
    const imagesBefore = f.images.length, checksBefore = f.checks.length;
    // The user replaces the character reference material with a different image.
    const media = new Media(f.root, readJson(path.join(f.root, 'config/project.json')));
    const original = path.join(f.root, 'hero-original.png');
    fs.copyFileSync(path.join(f.root, 'hero.png'), original);
    media.command(['-f', 'lavfi', '-i', 'color=c=green:s=512x512', '-frames:v', '1', '-y', path.join(f.root, 'hero.png')]);
    await assert.rejects(main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client }), /PRODUCTION_INPUT_CHANGED/);
    const secondRound = stateOf(f);
    void secondRound;
    assert.equal(f.images.length, imagesBefore, '输入变化后旧帧不得放行，也不得自动重生成');
    assert.equal(f.checks.length, checksBefore, '输入变化后旧检查不得放行');
    assert.equal(stateOf(f).assets.shot01.frameReview.binding.digest, bindingBefore, '旧绑定保持原样，需受控修订后才可继续');
    assert.equal(secondRound.creative.frames.shot01.references[0].necessity, 'required', '必要参考必须被记录');
    assert.equal(f.others.length, 0, '失效重做期间仍然零视频请求');
    // The recovery that IS available on this path: the user puts the original material back (or starts a
    // controlled revision). The old frames and their check then apply to the same input again and are reused
    // instead of being regenerated or re-checked. Coverage level: this proves the ORIGINAL input was restored, it
    // is NOT a verified controlled-revision path for a NEW input (that needs the revision flow, not this test).
    // 覆盖层级：只证明原输入恢复，不等于新输入的受控修订路径已验证。
    fs.copyFileSync(original, path.join(f.root, 'hero.png'));
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    assert.equal(f.images.length, imagesBefore, '恢复原素材后旧帧被复用，不重复生成');
    assert.equal(f.checks.length, checksBefore, '恢复原素材后旧检查被复用，不重复提交');
    assert.equal(stateOf(f).assets.shot01.frameReview.binding.digest, bindingBefore, '恢复后绑定仍与已记录的检查一致');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});

// The reference plan itself is pure and is verified directly: necessity follows the frame's must-keep content and
// the coverage the manifest has CONFIRMED — never the order of the material fields — and capacity is decided for
// BOTH frames before anything is submitted. An undeclared material keeps its unknown coverage instead of being
// treated as spare, and every omission is recorded with its own reason.
test('reference necessity follows confirmed coverage, not the order of the material fields', () => {
  const { planShotReferences, REFERENCE_COVERAGE_MAP, REFERENCE_LIMIT } = require('../workflows/production');
  const { REFERENCE_COVERAGE_VOCABULARY, validateProduction } = require('../services/aliyun/schema');
  assert.equal(REFERENCE_LIMIT, 3, '容量依据为图片适配器自身的 1-3 张校验');
  assert.deepEqual(Object.keys(REFERENCE_COVERAGE_MAP).sort(), [...REFERENCE_COVERAGE_VOCABULARY].sort(),
    '清单允许的覆盖词表与参考规划的映射必须一致，否则声明会被静默降级为未知');
  const frame = () => ({ moment: 'm', composition: 'c', castState: [], crowdCostume: null });
  const shot = casts => ({ id: 'shot01', characters: casts, first: frame(), last: frame() });
  const jiang = { id: 'jiang_wei', costume: '深色甲袍，腰间短剑入鞘', props: ['短剑入鞘'] };
  const zhong = { id: 'zhong_hui', costume: '深色外袍，腰间无兵器', props: [] };
  // Scenario 1: the manifest CONFIRMS that the 立绘 (listed second) carries the costume and the weapon this frame
  // must keep. It is required and attached: a second position never makes a needed material droppable.
  const declared = { characters: [{ id: 'jiang_wei', name: '姜维', image: 'jw.png', frontImage: 'jw-front.png',
    referenceCoverage: { frontImage: { covers: ['face', 'hair'] }, image: { covers: ['identity', 'costume', 'weapon'] } } }] };
  const single = planShotReferences(shot([jiang]), { production: declared });
  assert.equal(single.error, undefined);
  const portrait = single.first.find(entry => entry.source === 'image');
  assert.equal(portrait.necessity, 'required', '立绘被确认覆盖必需的服饰与武器，不得因排在第二位而被省略');
  assert.deepEqual(portrait.coveredNeeds, ['identity', 'costume', 'weapon']);
  assert.match(portrait.purpose, /清单 referenceCoverage 声明的已确认覆盖/);
  assert.deepEqual(single.record.needs.first, [{ id: 'jiang_wei', needs: ['identity', 'costume', 'weapon'],
    evidence: { costume: '深色甲袍，腰间短剑入鞘', props: ['短剑入鞘'] } }], '必需项来自本帧文字，不来自素材字段名');
  assert.equal(single.record.first.omitted.length, 0, '没有素材被省略');
  assert.equal(single.record.unconfirmed.length, 0, '已声明覆盖的素材不算“覆盖未知”');
  assert.deepEqual(single.record.uncovered, [], '每个必需项都有已确认覆盖它的已附素材');
  // Scenario 2: two people in one frame. The first frame fits exactly (正脸 + 立绘 + 立绘); the last frame needs one
  // slot more for this shot's own first frame. The anchor is NOT accepted as proof that the two 立绘 were
  // unnecessary, so the shot stops in the preflight, before any submission, with the first frame's fit recorded.
  const pair = { characters: [declared.characters[0],
    { id: 'zhong_hui', name: '钟会', image: 'zh.png', referenceCoverage: { image: { covers: ['identity', 'costume'] } } }] };
  const overflow = planShotReferences(shot([jiang, zhong]), { production: pair });
  assert.equal(overflow.error.code, 'CREATIVE_REFERENCE_CAPACITY_EXCEEDED');
  assert.match(overflow.error.detail, /尾帧必要参考 4 张/);
  assert.deepEqual(overflow.record.first.kept.map(entry => entry.source), ['frontImage', 'image', 'image']);
  assert.equal(overflow.record.first.kept.length, 3, '首帧本可容纳三张必要参考，且包含覆盖武器的立绘');
  assert.equal(overflow.record.last, null, '尾帧方案未被接受，不留下“已决定”的假象');
  assert.deepEqual(overflow.record.lastNeeded.map(entry => entry.source), ['ownFirstFrame', 'frontImage', 'image', 'image']);
  assert.deepEqual(overflow.record.lastNeeded[0].coveredNeeds, [], '结构锚点不证明任何身份、服饰或武器');
  assert.match(overflow.error.detail, /锚点只作结构参考，不作为身份、服饰或武器的覆盖证据/);
  assert.match(overflow.error.detail, /不自动改变人物数量、剧情或用户指定装备/);
  assert.equal(overflow.record.limitBasis.includes('供应商上限未核实'), true, '不把适配器限制说成供应商上限');

  // Scenario 3: a material the manifest declares OPTIONAL is left out when the required ones already fill the
  // capacity, and the recorded reason is the declaration itself — not a guess about what the picture contains.
  // With room left it is attached instead, so nothing is ever silently discarded.
  const withOptional = { characters: [
    { id: 'jiang_wei', name: '姜维', image: 'jw.png', frontImage: 'jw-front.png',
      referenceCoverage: { frontImage: { covers: ['face'] },
        image: { covers: ['identity', 'costume'], optional: true, note: '与正脸参考重复，仅在有余量时附上' } } },
    { id: 'zhong_hui', name: '钟会', image: 'zh.png', frontImage: 'zh-front.png',
      referenceCoverage: { frontImage: { covers: ['identity'] }, image: { covers: ['costume'] } } }] };
  const optionalOverflow = planShotReferences(shot([jiang, zhong]), { production: withOptional });
  assert.equal(optionalOverflow.error.code, 'CREATIVE_REFERENCE_CAPACITY_EXCEEDED');
  const omitted = optionalOverflow.record.first.omitted;
  assert.deepEqual(omitted.map(entry => entry.source), ['image'], '明确可选且已确认冗余的素材可以省略');
  assert.match(omitted[0].reason, /清单已声明该素材为可选/);
  assert.match(omitted[0].purpose, /与正脸参考重复/, '省略原因带上清单自己写的理由');
  assert.match(omitted[0].note, /不因此声称已参考/);
  const roomPlan = planShotReferences(shot([jiang]), { production: { characters: [withOptional.characters[0]] } });
  assert.deepEqual(roomPlan.first.map(entry => entry.necessity), ['required', 'optional'], '有余量时可选参考照常附上');
  assert.equal(roomPlan.record.first.omitted.length, 0);
  // Scenario 4: the SAME two material fields with two different declarations, and the same declaration written in
  // another field order. Which source stays necessary follows the declaration and the frame's needs only: writing
  // the manifest fields in another order changes nothing at all.
  const pManifest = { characters: [{ id: 'jiang_wei', name: '姜维', image: 'jw.png', frontImage: 'jw-front.png',
    referenceCoverage: { frontImage: { covers: ['identity', 'costume'] }, image: { covers: ['palette'] } } }] };
  const qManifest = { characters: [{ id: 'jiang_wei', name: '姜维', frontImage: 'jw-front.png', image: 'jw.png',
    referenceCoverage: { image: { covers: ['palette'] }, frontImage: { covers: ['identity', 'costume'] } } }] };
  const rManifest = { characters: [{ id: 'jiang_wei', name: '姜维', image: 'jw.png', frontImage: 'jw-front.png',
    referenceCoverage: { frontImage: { covers: ['palette'] }, image: { covers: ['identity', 'costume'] } } }] };
  const necessityBySource = plan => Object.fromEntries(plan.first.map(entry => [entry.source, entry.necessity]));
  const keptSources = plan => plan.first.map(entry => entry.source);
  assert.deepEqual(necessityBySource(planShotReferences(shot([jiang]), { production: pManifest })),
    { frontImage: 'required', image: 'optional' }, '声明覆盖服饰的那张才是必要的');
  assert.deepEqual(necessityBySource(planShotReferences(shot([jiang]), { production: qManifest })),
    { frontImage: 'required', image: 'optional' }, '清单字段书写顺序改变不改变任何素材的必要性');
  assert.deepEqual(keptSources(planShotReferences(shot([jiang]), { production: qManifest })),
    keptSources(planShotReferences(shot([jiang]), { production: pManifest })), '请求里的素材顺序同样不由书写顺序决定');
  assert.deepEqual(necessityBySource(planShotReferences(shot([jiang]), { production: rManifest })),
    { frontImage: 'optional', image: 'required' }, '交换两份声明，必要的那张随之改变');
  const styleOnly = planShotReferences(shot([jiang]), { production: rManifest }).first
    .find(entry => entry.source === 'frontImage');
  assert.match(styleOnly.purpose, /无交集/, '声明只覆盖画风的素材与本帧必需项无交集，因此不是必要参考');
  assert.deepEqual(styleOnly.coveredNeeds, []);
  // Scenario 5: a manifest that declares NOTHING. The materials keep their unknown coverage: they are retained,
  // never presented as covering what this frame must keep, and never silently called spare either.
  const legacy = { characters: [{ id: 'jiang_wei', name: '姜维', image: 'jw.png', frontImage: 'jw-front.png' }] };
  const legacyPlan = planShotReferences(shot([jiang]), { production: legacy });
  assert.deepEqual(legacyPlan.first.map(entry => [entry.source, entry.necessity, entry.coverage]),
    [['frontImage', 'required', 'unconfirmed'], ['image', 'required', 'unconfirmed']]);
  assert.ok(legacyPlan.first.every(entry => entry.coveredNeeds.length === 0), '未声明覆盖的素材不声称任何已覆盖项');
  assert.deepEqual(legacyPlan.record.unconfirmed.map(entry => entry.source), ['frontImage', 'image']);
  assert.match(legacyPlan.record.unconfirmed[0].note, /既不说它可丢弃，也不说它已证明了任何必需项/);
  assert.deepEqual(legacyPlan.record.uncovered.filter(entry => entry.frame === 'first').map(entry => entry.need),
    ['identity', 'costume', 'weapon'], '覆盖未知时不得声称任何必需项已被参考满足');
  assert.match(legacyPlan.first[1].purpose, /未经确认，不得据此声称身份、服饰或武器已被参考/);
  assert.equal(legacyPlan.record.first.omitted.length, 0, '覆盖未知不得静默认定第二张可丢弃');
  // …and when the two people's undeclared materials no longer fit, the honest answer is to stop rather than to
  // guess which one could be dropped.
  const legacyPair = { characters: [legacy.characters[0],
    { id: 'zhong_hui', name: '钟会', image: 'zh.png', frontImage: 'zh-front.png' }] };
  const legacyOverflow = planShotReferences(shot([jiang, zhong]), { production: legacyPair });
  assert.equal(legacyOverflow.error.code, 'CREATIVE_REFERENCE_CAPACITY_EXCEEDED');
  assert.match(legacyOverflow.error.detail, /覆盖未经确认（保守保留）/);
  assert.match(legacyOverflow.error.detail, /本镜首帧本身就装不下/);
  // A required material that cannot be read stops the shot with its own code; an optional one is left out and
  // recorded instead of failing after the first frame was already sent.
  const unreadable = planShotReferences(shot([jiang]), { production: declared,
    probe: () => { throw new Error('IMAGE_NOT_USABLE:jw-front.png'); } });
  assert.equal(unreadable.error.code, 'CREATIVE_REFERENCE_UNREADABLE');
  assert.match(unreadable.error.detail, /jw-front\.png/);
  const optionalBroken = planShotReferences(shot([jiang]), { production: pManifest,
    probe: file => { if (file === 'jw.png') throw new Error('IMAGE_NOT_USABLE:jw.png'); } });
  assert.equal(optionalBroken.error, undefined, '可选素材不可读不阻断本镜');
  assert.deepEqual(optionalBroken.first.map(entry => entry.file), ['jw-front.png'], '必要素材不受可选素材不可读影响');
  assert.equal(optionalBroken.record.unreadable.length, 1);
  assert.match(optionalBroken.record.unreadable[0].reason, /可选参考不可读取/);
  // An environment-only shot keeps the previous frame as an OPTIONAL look reference with a limited purpose, and
  // can only be planned when such a frame exists.
  const carrier = { id: null, source: 'previousShotFirstFrame', necessity: 'optional', file: null,
    role: '画风与材质参考（前镜首帧）', purpose: '画风、材质与局部光照（可选）' };
  const environment = planShotReferences({ id: 'shot02', characters: [] }, { production: declared, previousFrame: carrier });
  assert.deepEqual([...environment.first, ...environment.last].map(entry => entry.necessity), ['optional', 'required', 'optional']);
  assert.deepEqual(environment.record.needs.first, [], '没有已登记角色入画时没有可断言的必需项');
  assert.equal(planShotReferences({ id: 'shot02', characters: [] }, { production: declared }).error.code,
    'CREATIVE_REFERENCE_FOR_ENVIRONMENT_FRAME_REQUIRED');
  // The declaration itself is validated: a typo can never look like a declaration and silently change necessity.
  const manifestWith = extra => ({ id: 'p1', description: '一句话描述', style: '风格', targetDurationSeconds: 5,
    maxDurationSeconds: 60, characters: [{ id: 'jiang_wei', name: '姜维', image: 'jw.png', voiceSample: 'v.wav',
      frontImage: 'jw-front.png', ...extra }] });
  assert.equal(validateProduction(manifestWith({ referenceCoverage: { frontImage: { covers: ['face', 'hair'] } } }))
    .characters[0].referenceCoverage.frontImage.covers.length, 2, '合法声明原样通过');
  assert.throws(() => validateProduction(manifestWith({ referenceCoverage: { frontImage: { covers: ['costumes'] } } })),
    /INVALID_REFERENCE_COVERAGE/, '拼错的覆盖词不得被当成声明');
  assert.throws(() => validateProduction(manifestWith({ referenceCoverage: { backImage: { covers: ['face'] } } })),
    /UNKNOWN_MATERIAL/, '只能声明清单里真实存在的素材字段');
  assert.throws(() => validateProduction(manifestWith({ frontImage: null, referenceCoverage: { frontImage: { covers: ['face'] } } })),
    /DECLARED_WITHOUT_MATERIAL/, '没有该素材就不得声明它的覆盖范围');
  assert.throws(() => validateProduction(manifestWith({ referenceCoverage: { frontImage: { covers: ['face'], optional: 'yes' } } })),
    /INVALID_REFERENCE_COVERAGE/);
  assert.throws(() => validateProduction(manifestWith({ referenceCoverage: { frontImage: { covers: ['face'], note: ' ' } } })),
    /INVALID_REFERENCE_COVERAGE/);
});


// Entry-level capacity protection: three registered characters in one shot fill the first frame exactly, so the
// old order (submit the first frame, then check the last frame) would have paid for a frame it could not use.
// Now the last frame's overflow is found in the preflight and the whole run stops with zero image, zero check and
// zero video requests — including on a resumed attempt.
test('a last frame that cannot hold every required reference stops before any submission', { timeout: 180000 }, async () => {
  const f = fixture({ characters: trioCharactersPayload, board: trioBoard, cast: trioManifest });
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    const state = stateOf(f);
    assert.equal(state.stage, 'storyboard', '帧阶段未完成，停在参考预检');
    assert.equal(state.assets.shot01.referencePause.code, 'CREATIVE_REFERENCE_CAPACITY_EXCEEDED');
    assert.match(state.assets.shot01.referencePause.detail, /尾帧必要参考 4 张/);
    assert.match(state.assets.shot01.referencePause.detail, /在本镜任何媒体提交之前停止/);
    assert.equal(state.assets.shot01.referencePlan.decidedBeforeAnySubmission, true, '预检记录写明在任何提交之前');
    assert.equal(state.assets.shot01.referencePlan.first.kept.length, 3, '首帧本可容纳三张必要参考');
    assert.equal(state.assets.shot01.referencePlan.last, null, '尾帧方案未被接受，不留下“已决定”的假象');
    assert.deepEqual(state.assets.shot01.referencePlan.lastNeeded.map(entry => entry.source),
      ['ownFirstFrame', 'image', 'image', 'image'], '尾帧需要三张身份素材加本镜首帧锚点');
    assert.equal(f.images.length, 0, '容量预检失败时零图片请求');
    assert.equal(f.checks.length, 0, '容量预检失败时零检查请求');
    assert.equal(f.others.length, 0, '零视频或其它请求');
    assert.equal(state.assets.shot01.first, undefined, '没有生成首帧');
    assert.equal(state.creative.frames.shot01, undefined, '未写任何帧完成记录');
    // The other shot was planned in the same pass and is recorded too: the user sees the whole picture at once.
    assert.ok(state.assets.shot02.referencePlan, '同一轮预检也留下第二镜的方案');
    assert.equal(state.assets.shot02.referencePause, undefined);
    // A resumed run cannot slip past it either.
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    assert.equal(f.images.length, 0, '恢复重跑同样零图片请求');
    assert.equal(f.checks.length, 0, '恢复重跑同样零检查请求');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});
// Entry-level necessity protection: the manifest CONFIRMS that 姜维's 立绘 carries the costume and the short sword
// this frame must keep, and two registered characters are in frame. The first frame fits the adapter's limit
// exactly (正脸 + 立绘 + 立绘) while the last frame needs one slot more for its own first frame, so the run stops
// in the preflight with zero image, zero check and zero video requests — and the confirmed-necessary 立绘 is never
// dropped in favour of the material listed before it.
test('a 立绘 that is confirmed to carry the required weapon is never dropped for capacity', { timeout: 180000 }, async () => {
  const f = fixture({ characters: declaredCharactersPayload, board: declaredBoard, cast: declaredManifest });
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    const state = stateOf(f);
    assert.equal(state.stage, 'storyboard', '帧阶段未完成，停在参考预检');
    assert.equal(state.assets.shot01.referencePause.code, 'CREATIVE_REFERENCE_CAPACITY_EXCEEDED');
    assert.match(state.assets.shot01.referencePause.detail, /尾帧必要参考 4 张/);
    assert.match(state.assets.shot01.referencePause.detail, /在本镜任何媒体提交之前停止/);
    const plan = state.assets.shot01.referencePlan;
    assert.equal(plan.decidedBeforeAnySubmission, true, '预检记录写明在任何提交之前');
    assert.deepEqual(plan.first.kept.map(entry => [entry.id, entry.source, entry.necessity]),
      [['jiang_wei', 'frontImage', 'required'], ['jiang_wei', 'image', 'required'], ['zhong_hui', 'image', 'required']],
      '立绘被确认覆盖必需的服饰与武器，必须留在首帧参考里，不因排在正脸之后被省略');
    assert.deepEqual(plan.first.kept[1].coveredNeeds, ['identity', 'costume', 'weapon']);
    assert.match(plan.first.kept[1].purpose, /本帧必须保持的 身份与容貌、服饰、武器与持物/);
    assert.deepEqual(plan.first.omitted, [], '没有素材被省略');
    assert.equal(plan.last, null, '尾帧方案未被接受');
    assert.deepEqual(plan.lastNeeded.map(entry => entry.source), ['ownFirstFrame', 'frontImage', 'image', 'image']);
    assert.deepEqual(plan.unconfirmed, [], '两张素材都由清单声明覆盖，不再有“覆盖未知”');
    assert.deepEqual(plan.needs.first.map(entry => [entry.id, entry.needs]),
      [['jiang_wei', ['identity', 'costume', 'weapon']], ['zhong_hui', ['identity', 'costume']]],
      '必需项逐人记录，来自本帧文字');
    assert.equal(f.images.length, 0, '容量预检失败时零图片请求');
    assert.equal(f.checks.length, 0, '容量预检失败时零检查请求');
    assert.equal(f.others.length, 0, '零视频或其它请求');
    assert.equal(state.assets.shot01.first, undefined, '没有生成首帧');
    assert.equal(state.creative.frames.shot01, undefined, '未写任何帧完成记录');
    // A resumed run cannot slip past it either.
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    assert.equal(f.images.length, 0, '恢复重跑同样零图片请求');
    assert.equal(f.checks.length, 0, '恢复重跑同样零检查请求');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});



// The declared coverage is also what the ACTUAL request carries and what the record keeps: the plan, the material
// attached, the request text and the state record tell the same story about every reference (same order, same
// role, same purpose, same necessity), so a reference can never be described one way in the record and another
// way in the request that was really sent.
test('declared coverage travels with the request and matches the record', { timeout: 180000 }, async () => {
  const f = fixture({ characters: declaredCharactersPayload, cast: declaredManifest });
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    const done = stateOf(f);
    assert.equal(f.images.length, 4, '两镜各生成首帧与尾帧');
    const plan = done.assets.shot01.referencePlan;
    assert.deepEqual(plan.first.kept.map(entry => [entry.source, entry.necessity, entry.coverage]),
      [['frontImage', 'required', 'confirmed'], ['image', 'required', 'confirmed']], '立绘与正脸都按声明保留');
    assert.deepEqual(plan.first.kept.map(entry => entry.coveredNeeds), [['identity'], ['identity', 'costume', 'weapon']]);
    assert.equal(f.images[0].references.length, 2, '清单声明的两张素材都真实进入图片请求');
    // Request text, plan and record agree figure by figure, for both frames of both shots.
    const pairs = [{ index: 0, shot: 'shot01', key: 'references', planKey: 'first' },
      { index: 1, shot: 'shot01', key: 'lastReferences', planKey: 'last' },
      { index: 2, shot: 'shot02', key: 'references', planKey: 'first' },
      { index: 3, shot: 'shot02', key: 'lastReferences', planKey: 'last' }];
    for (const { index, shot, key, planKey } of pairs) {
      const record = done.creative.frames[shot][key];
      assert.equal(record.length, f.images[index].references.length, shot + ' 记录与请求的参考数量一致');
      assert.deepEqual(record.map(entry => [entry.role, entry.necessity, entry.coverage]),
        done.assets[shot].referencePlan[planKey].kept.map(entry => [entry.role, entry.necessity, entry.coverage]),
        shot + ' 记录与预检的参考一一对应');
      for (const entry of record)
        assert.ok(f.images[index].prompt.includes('（用途：' + entry.purpose + '）'),
          shot + ' 请求逐条写明用途：' + entry.role);
    }
    assert.ok(!f.images[0].prompt.includes('覆盖范围未经确认'), '两张都声明了覆盖，请求里不出现“覆盖未知”的备注');
    assert.deepEqual(done.creative.frames.shot01.droppedReferences, [], '没有被省略的素材');
    assert.deepEqual(plan.unconfirmed, [], '没有覆盖未知的素材');
    assert.deepEqual(done.creative.frames.shot01.lastReferences.map(entry => entry.coverage),
      ['anchor', 'confirmed', 'confirmed'], '尾帧锚点标明是结构参考，两张声明素材仍在');
    // The environment-only shot keeps its single style reference from the previous shot, with its limited purpose.
    assert.equal(f.images[2].references.length, 1);
    assert.equal(done.creative.frames.shot02.references[0].coverage, 'style');
    assert.match(f.images[2].prompt, /（用途：画风、材质与局部光照（可选；不证明本镜布局，也不证明群演身份））/);
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});

// ---------------------------------------------------------------- the final composition (the film itself)
// The chain now CLOSES at the normal entry: `--until final` assembles one film locally from the accepted audio
// bed, the storyboard timeline, the subtitles and the shots that already passed their own check. Everything
// below is measured on the produced file with the project's own FFmpeg; a provider request at any point fails
// the test through the fixture's injected client (and real fetch is forbidden).
test('--until final assembles the film locally, and the same input is reused instead of re-encoded', { timeout: 240000 }, async () => {
  const f = fixture();
  await withOffline(async () => {
    const audio = await acceptFixtureAudio(f);
    assert.equal(audio.stage, 'audio');
    // The video boundary is not the end of the chain, and it writes no film.
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    const stopped = stateOf(f);
    assert.equal(stopped.stage, 'video');
    assert.equal(stopped.output, undefined, '--until video 不写成片');
    assert.equal(fs.existsSync(finalOutput(f)), false, '--until video 时磁盘上没有成片');
    // Continuing the SAME task to the end is local assembly: a real file appears, nothing is requested.
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const done = stateOf(f);
    const output = finalOutput(f);
    assert.equal(done.stage, 'final');
    assert.equal(done.output, output);
    assert.equal(done.creativeStage?.pause, undefined, '可合成的输入不停在合成边界');
    assert.equal(done.creative.finalBlockers, undefined, '可合成的输入不留阻断清单');
    assert.ok(fs.existsSync(output), '成片真的写到了磁盘');
    // 1) The file itself: decodable, 1920x1080, 30fps, with sound, of exactly the timeline length.
    const info = f.media.video(output, done.timed.totalDuration, true);
    assert.equal(info.width, 1920);
    assert.equal(info.height, 1080);
    assert.equal(info.audio, true, '成片带音轨');
    assert.ok(Math.abs(info.duration - done.timed.totalDuration) <= FINAL_DURATION_TOLERANCE,
      '成片时长等于时间线总长：' + info.duration + ' vs ' + done.timed.totalDuration);
    assert.ok(Math.abs(info.duration - 6) <= FINAL_DURATION_TOLERANCE, '两镜 2.4 + 3.6 秒');
    assert.equal(f.media.probe(output).streams.find(stream => stream.codec_type === 'video').avg_frame_rate, '30/1');
    // 2) The composition record describes that same file, shot by shot and line by line.
    const record = done.creative.composition;
    assert.match(record.inputDigest, /^[0-9a-f]{64}$/, '成片有可复算的输入身份');
    assert.equal(record.hash, fileHash(output), '记录里的哈希就是磁盘上的文件');
    assert.equal(record.pendingUserPlayback, true, '成片等待用户播放验收');
    assert.equal(done.acceptance, 'awaiting_user_playback');
    assert.deepEqual(record.shots.map(shot => shot.id), ['shot01', 'shot02']);
    assert.deepEqual(record.shots.map(shot => [shot.start, shot.end]), [[0, 2.4], [2.4, 6]]);
    assert.equal(record.shots[1].videoHash, fileHash(done.assets.shot02.video), '记录绑定实际取回的素材');
    assert.equal(record.shots[1].planDigest, done.assets.shot02.videoPlan.digest, '记录绑定该镜的计划');
    assert.deepEqual(record.audioBed.map(entry => [entry.lineId, entry.startSeconds, entry.durationSeconds]),
      [['ln01', 0, 2.4], ['ln02', 2.4, 3.6]], '音频床就是被接受的那两份配音');
    // 3) Subtitles follow the audio timeline: one continuous cue per line, at its real position.
    const lines = cues(fs.readFileSync(filmSubtitleFile(output), 'utf8'));
    assert.deepEqual(lines.map(cue => [cue.from, cue.to]), [[0, 2.4], [2.4, 6]]);
    assert.deepEqual(lines.map(cue => cue.text), ['臣等正欲死战', '蜀营夜巡，甲叶轻响。']);
    // 4) Assembly is local: it invents no new work.
    assert.equal(f.videos.length, 2, '合成不发起新的视频请求');
    assert.equal(f.checks.length, 4, '合成不发起新的检查请求');
    assert.equal(f.planner.length, 6, '合成不重新规划分镜');
    assert.equal(f.speech.length, 2, '合成不重新配音');
    assert.equal(f.others.length, 0, '没有预期之外的请求');
    // 5) The same input is REUSED instead of encoded again: the bytes on disk do not move.
    const before = { videos: f.videos.length, checks: f.checks.length, planner: f.planner.length };
    const hashBefore = fileHash(output);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const again = stateOf(f);
    assert.equal(fileHash(output), hashBefore, '同输入不重新编码成片');
    assert.equal(again.creative.composition.reuses, 1, '复用被记录而不是重新合成');
    assert.equal(again.creative.composition.inputDigest, record.inputDigest, '复用判据是输入身份');
    assert.equal(again.output, output);
    assert.equal(again.stage, 'final');
    assert.equal(f.videos.length, before.videos);
    assert.equal(f.checks.length, before.checks);
    assert.equal(f.planner.length, before.planner);
    // 6) A CHANGED input may not pass as the same film: it is assembled again, and the film that was already
    // there is preserved under its own input digest instead of being overwritten.
    const changed = stateOf(f);
    changed.creative.timeline.subtitles[0].text = '臣等正欲死战（改）';
    writeJson(path.join(f.directory, 'state.json'), changed);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const rewritten = stateOf(f);
    const preserved = path.join(path.dirname(output), 'final-' + String(record.inputDigest).slice(0, 8) + '.mp4');
    assert.notEqual(rewritten.creative.composition.inputDigest, record.inputDigest, '改过的输入不是同一部片子');
    assert.notEqual(fileHash(output), hashBefore, '不同输入必须重新合成，不能复用旧成片');
    assert.ok(fs.existsSync(preserved), '旧成片按自己的输入摘要保留，不被覆盖');
    assert.equal(fileHash(preserved), hashBefore, '保留的旧成片内容不变');
    assert.equal(rewritten.creative.composition.previous.inputDigest, record.inputDigest);
    assert.equal(rewritten.creative.compositions.length, 1, '被替换的成片进入历史，不静默丢失');
    assert.equal(f.planner.length, before.planner, '改字幕不重新规划');
    assert.equal(f.videos.length, before.videos, '改字幕不重新生成视频');
    assert.equal(f.checks.length, before.checks, '改字幕不重新检查');
  });
});

// The audio of the film is verified on the decoded signal, not on the command line: the accepted takes are
// 440 Hz and 660 Hz while the two supplier clips carry 330 Hz and 550 Hz of their own, so a mixed-in clip
// track or a missing line would show up as a different dominant tone or as a silent seam at the cut.
// What this fixture proves is the BED: two accepted takes meeting at the cut are each heard once, where the
// timeline places them, with nothing of the clips' own tracks mixed in. It does NOT prove that ONE performance can
// run across a cut — here the cut IS the seam between two takes — so it is not used as evidence for that; the
// cross-cut case below carries that claim instead.
test('the assembled film plays ONE continuous dialogue bed across the cut, with no supplier track mixed in (two takes meeting at the cut)', { timeout: 240000 }, async () => {
  const f = fixture();
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const done = stateOf(f);
    const film = finalOutput(f);
    assert.ok(fs.existsSync(film), '成片已写出');
    assert.ok(Math.abs(Number(f.media.probe(film).format.duration) - 6) <= FINAL_DURATION_TOLERANCE,
      '成片没有多出供应商素材的 5 秒尾部');
    // 1) Each line is heard where the timeline plays it.
    const first = windowSignal(f.media, film, 1.0, 0.3), second = windowSignal(f.media, film, 4.0, 0.3);
    assert.ok(Math.abs(first.frequency - 440) <= FINAL_TONE_TOLERANCE, '第一句是被接受的 440Hz 配音，实测 ' + first.frequency);
    assert.ok(Math.abs(second.frequency - 660) <= FINAL_TONE_TOLERANCE, '第二句是 2.4 秒处的 660Hz 配音，实测 ' + second.frequency);
    // 2) The bed is continuous across the cut at 2.4s: no window of the dialogue is silent.
    for (const at of [0.2, 0.6, 1.0, 1.4, 1.8, 2.2, 2.6, 3.0, 3.4, 3.8, 4.2, 4.6, 5.0, 5.4, 5.7]) {
      const window = windowSignal(f.media, film, at, 0.2);
      assert.ok(window.rms > FINAL_SILENCE_LIMIT, '对话在 ' + at + ' 秒处不应中断：rms=' + window.rms.toFixed(4));
    }
    // 3) The clips' OWN tracks are not in the film: the picture is kept and the dialogue is muxed once.
    const residue01 = bandRms(f.media, film, 0.3, 0.3, 330, FINAL_RESIDUE_WIDTH);
    const voice01 = bandRms(f.media, film, 0.3, 0.3, 440, FINAL_RESIDUE_WIDTH);
    const residue02 = bandRms(f.media, film, 3.0, 0.3, 550, FINAL_RESIDUE_WIDTH);
    const voice02 = bandRms(f.media, film, 3.0, 0.3, 660, FINAL_RESIDUE_WIDTH);
    assert.ok(residue01 < FINAL_RESIDUE_LIMIT * voice01,
      '第一镜素材自己的 330Hz 音轨没有进入成片：' + residue01.toFixed(5) + ' vs ' + (FINAL_RESIDUE_LIMIT * voice01).toFixed(5) + '（本句 440Hz 为 ' + voice01.toFixed(5) + '）');
    assert.ok(residue02 < FINAL_RESIDUE_LIMIT * voice02,
      '第二镜素材自己的 550Hz 音轨没有进入成片：' + residue02.toFixed(5) + ' vs ' + (FINAL_RESIDUE_LIMIT * voice02).toFixed(5) + '（本句 660Hz 为 ' + voice02.toFixed(5) + '）');
    // 4) A line used for its whole accepted length is not cut short: the last moment is still that line.
    assert.ok(Math.abs(windowSignal(f.media, film, 5.6, 0.3).frequency - 660) <= FINAL_TONE_TOLERANCE,
      '第二句的最后一个可听窗口仍是本句（没有被截断，也没有被静音顶替）');
    // 5) The takes really are the longer files the plan used only in part, and the film says so.
    assert.ok(Math.abs(done.creative.videos.shot01.info.duration - 3) < 0.2, '第一镜取回 3 秒素材');
    assert.ok(Math.abs(done.creative.videos.shot02.info.duration - 5) < 0.2, '第二镜取回 5 秒素材');
    assert.deepEqual(done.creative.composition.audioBed.map(entry => entry.durationSeconds), [2.4, 3.6],
      '成片只用被接受配音的完整长度，没有把 5 秒素材塞进音频床');
  });
});

// The same storyboard with its FIRST shot declared silent: the line it would have carried is listed as unused
// (declared, not silently dropped), so the bed starts later in the film and the head of the film must be a REAL
// silent gap. This is the case the timeline invariant refuses to "solve" by padding or by moving the line.
const silentBoard = () => {
  const payload = boardPayload(), shot = payload.shots[0];
  shot.segments = [];
  shot.drivingLine = null;
  shot.vendor = { modelSeconds: 5, coverage: 'trim', note: '本镜没有对白：供应商时长只用于取画面，成片前 2.4 秒是真实静音' };
  return { ...payload, unusedAudio: [{ id: 'ln01', reason: '本片第一镜保持无声：这一句留给后续版本，本镜不播' }] };
};
test('a silent first shot keeps a real gap: the bed starts late and nothing is padded into it', { timeout: 240000 }, async () => {
  const f = fixture({ board: silentBoard });
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const done = stateOf(f);
    // 1) The unused line is declared, and the timeline really has no span for it in the first shot.
    assert.deepEqual(done.creative.storyboard.unusedAudio.map(entry => entry.id), ['ln01']);
    assert.deepEqual(done.creative.timeline.shots[0].audioSpans, [], '第一镜没有对白');
    assert.equal(done.creative.timeline.audioBed.length, 1, '音频床只载真正被念出的那一句');
    assert.equal(done.creative.timeline.audioBed[0].lineId, 'ln02');
    assert.equal(done.creative.timeline.audioBed[0].startSeconds, 2.4, '音频床按时间线放在第二镜开始处');
    const film = finalOutput(f);
    assert.ok(fs.existsSync(film), '成片已写出');
    assert.equal(done.stage, 'final');
    assert.equal(done.creativeStage?.pause, undefined);
    // 2) The head is silent for real (measured RMS, not "the JSON says so"), and the line is heard after it.
    const gap = windowSignal(f.media, film, 1.0, 0.5);
    assert.ok(gap.rms < FINAL_SILENCE_LIMIT, '前 2.4 秒是真实静音：rms=' + gap.rms.toFixed(4));
    const heard = windowSignal(f.media, film, 4.5, 0.3);
    assert.ok(heard.rms > FINAL_SILENCE_LIMIT, '第二镜的对白被念出');
    assert.ok(Math.abs(heard.frequency - 660) <= FINAL_TONE_TOLERANCE, '实测 ' + heard.frequency);
    // 3) The silence stays silence: no other track is moved in to fill it (both clips carry 550 Hz).
    assert.ok(bandRms(f.media, film, 1.0, 0.5, 550) < FINAL_SILENCE_LIMIT, '第二镜素材自己的音轨没有被搬来填空');
    // 4) A shot with no line is generated by its own branch: no driving audio is sent for it.
    assert.equal(f.videos[0].model, 'wan2.2-kf2v-flash');
    assert.equal(f.videos[0].duration, 5);
    assert.equal(f.videos[0].audio, null, '无口型镜不送驱动音频');
    // 5) Subtitles cover only what is really spoken, at its real position.
    const lines = cues(fs.readFileSync(filmSubtitleFile(film), 'utf8'));
    assert.deepEqual(lines.map(cue => [cue.from, cue.to]), [[2.4, 6]]);
    assert.deepEqual(lines.map(cue => cue.text), ['蜀营夜巡，甲叶轻响。']);
  });
});

// What the final stage may NOT do is just as important as what it does: when the accepted audio, the timeline
// or a shot's verdict cannot be assembled exactly as declared, the run stops with a recorded reason, calls no
// FFmpeg and writes no file — it never trims, pads, retimes or falls back to the legacy assembly path.
test('a composition that cannot be assembled exactly is blocked before any FFmpeg call', { timeout: 240000 }, async () => {
  const f = fixture();
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    const good = stateOf(f);
    const context = { root: f.root, production: readJson(path.join(f.root, 'input/production.json')),
      config: readJson(path.join(f.root, 'config/aliyun.json')) };
    // The untouched input IS assemblable, and the plan's own numbers match the real files on disk.
    const clean = finalCompositionPlan(context, good, { media: f.media });
    assert.deepEqual(clean.blockers, []);
    assert.deepEqual(clean.audioBed.map(entry => [entry.lineId, entry.startSeconds, entry.sourceEnd, entry.durationSeconds]),
      [['ln01', 0, 2.4, 2.4], ['ln02', 2.4, 3.6, 3.6]]);
    assert.deepEqual(clean.shots.map(shot => [shot.id, shot.start, shot.end, shot.usageSeconds, shot.requestSeconds]),
      [['shot01', 0, 2.4, 2.4, 3], ['shot02', 2.4, 6, 3.6, 5]]);
    // A stage-level probe: every media call is recorded, so "blocked" can be shown to mean "no encode at all".
    const calls = [];
    const record = (name, method) => (...args) => { calls.push(name); return method.apply(f.media, args); };
    const recorder = { audio: record('audio', f.media.audio), assemble: record('assemble', f.media.assemble),
      video: record('video', f.media.video), probe: record('probe', f.media.probe), command: record('command', f.media.command) };
    // (a) A storyboard that used only part of an accepted line: the missing tail is a blocker, not a trim.
    const truncated = structuredClone(good);
    truncated.creative.timeline.audioBed[0].durationSeconds = 3;
    const blocked = finalStage(context, structuredClone(truncated), { media: recorder, log: () => {}, save: () => {} });
    assert.ok(blocked.creative.finalBlockers.some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_TRUNCATED')),
      '未用满已接受配音时必须阻断：' + blocked.creative.finalBlockers.join('；'));
    assert.equal(blocked.creativeStage.pause.code, 'CREATIVE_FINAL_BLOCKED');
    assert.equal(blocked.output, undefined, '阻断时不写 output');
    assert.equal(blocked.stage, 'video', '阻断时阶段不前进');
    assert.deepEqual(calls, ['audio', 'audio'], '阻断时只做只读探测：不合成、不编码、不写文件');
    assert.equal(fs.existsSync(finalOutput(f)), false, '阻断时不产生任何成片');
    // (b) A verdict that no longer belongs to the current take/revision is stale, not reusable.
    const stale = structuredClone(good);
    stale.revisions ||= {};
    stale.revisions['video-shot02'] = (stale.revisions['video-shot02'] || 0) + 1;
    assert.deepEqual(finalCompositionPlan(context, stale, { media: f.media }).blockers,
      ['CREATIVE_FINAL_VIDEO_CHECK_STALE:shot02'], '视频检查必须仍然属于当前素材、计划与修订号');
    // (c) A verdict that is not a pass can never become part of the film.
    const denied = structuredClone(good);
    denied.assets.shot01.videoReview.pass = false;
    const deniedPlan = finalCompositionPlan(context, denied, { media: f.media });
    assert.equal(deniedPlan.blockers.length, 1);
    assert.ok(deniedPlan.blockers[0].startsWith('CREATIVE_FINAL_VIDEO_CHECK_UNACCEPTED:shot01'),
      '未通过的检查不得进入成片：' + deniedPlan.blockers.join('；'));
    // (d) A missing take, a missing file and a bed entry that does not match its real file are all blockers.
    const missing = structuredClone(good);
    delete missing.assets.shot02.video;
    assert.deepEqual(finalCompositionPlan(context, missing, {}).blockers, ['CREATIVE_FINAL_VIDEO_MISSING:shot02']);
    const gone = structuredClone(good);
    gone.assets.shot01.video = path.join(f.root, 'not-there.mp4');
    assert.deepEqual(finalCompositionPlan(context, gone, {}).blockers, ['CREATIVE_FINAL_VIDEO_MISSING:shot01']);
    const swapped = structuredClone(good);
    swapped.creative.timeline.audioBed[1].file = swapped.creative.timeline.audioBed[0].file;
    assert.ok(finalCompositionPlan(context, swapped, { media: f.media }).blockers
      .some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_FILE_MISMATCH')),
      '音频床要混的文件必须就是被接受的那份录音（按内容摘要绑定），否则在任何编码之前阻断');
    // (e) A retimed line, a bed entry placed outside the film, a negative placement, two lines that would sound
    // at the same moment and a subtitle overlapping another are all refused before any encode.
    const retimed = structuredClone(good);
    retimed.creative.timeline.audioBed[0].segments[0].filmEnd += 0.5;
    assert.ok(finalCompositionPlan(context, retimed, { media: f.media }).blockers
      .some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_RETIME_UNSUPPORTED')), '不得静默变速');
    const outOfRange = structuredClone(good);
    outOfRange.creative.timeline.audioBed[1].startSeconds = 5.5;
    assert.ok(finalCompositionPlan(context, outOfRange, { media: f.media }).blockers
      .some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_OUT_OF_RANGE')), '音频床不得超出成片时长');
    const negative = structuredClone(good);
    negative.creative.timeline.audioBed[0].startSeconds = -1;
    assert.ok(finalCompositionPlan(context, negative, { media: f.media }).blockers
      .some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_PLACEMENT_UNSUPPORTED')), '负起点不是可合成的放置');
    const overlapping = structuredClone(good);
    overlapping.creative.timeline.audioBed[1].startSeconds = 1;
    assert.ok(finalCompositionPlan(context, overlapping, { media: f.media }).blockers
      .some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_OVERLAP')), '两句不得在同一时刻同时发声');
    const badCue = structuredClone(good);
    badCue.creative.timeline.subtitles.push({ lineId: 'ln03', text: '重复字幕', start: 3, end: 5 });
    assert.ok(finalCompositionPlan(context, badCue, { media: f.media }).blockers
      .some(entry => entry.startsWith('CREATIVE_FINAL_SUBTITLES_INVALID')), '字幕重叠在任何编码之前就被拒绝');
    // (f) A timeline that does not describe the storyboard's own shots is a hard error, never a repaired guess.
    const mismatched = structuredClone(good);
    mismatched.creative.timeline.shots = mismatched.creative.timeline.shots.slice(0, 1);
    assert.throws(() => finalCompositionPlan(context, mismatched, {}), /CREATIVE_STORYBOARD_TIMELINE_MISMATCH:shot02/);
    assert.throws(() => finalStage(context, structuredClone(mismatched), { media: f.media, log: () => {}, save: () => {} }),
      /CREATIVE_STORYBOARD_TIMELINE_MISMATCH:shot02/, '不一致的时间线在合成边界也不得被猜测修复');
    // (g) None of the refusals above wrote a film, and the untouched task still assembles one afterwards.
    assert.equal(fs.existsSync(finalOutput(f)), false, '阻断案例不产生成片');
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const after = stateOf(f);
    assert.ok(fs.existsSync(finalOutput(f)), '被拒绝的输入没有被改写，随后仍能合成');
    assert.equal(after.stage, 'final');
    assert.equal(after.creativeStage?.pause, undefined);
  });
});


// ---- ONE accepted performance across a real cut -----------------------------------------------------------
// A single accepted take with an audible position marker INSIDE it: `switchAt` seconds of one tone, then another.
// The marker is what makes "the same performance continues across the cut" measurable on the finished film — a
// restart of the take, a dropped span, a duplicated copy or a re-placed line would move or repeat the marker.
function markedPerformance(media, file, { first = 880, second = 1200, switchAt = 2, seconds = 6 } = {}) {
  const head = file.replace(/\.wav$/, '-head.wav'), tail = file.replace(/\.wav$/, '-tail.wav');
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=' + first + ':sample_rate=24000,volume=4', '-t', String(switchAt), '-ac', '1', head]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=' + second + ':sample_rate=24000,volume=4', '-t', String(seconds - switchAt), '-ac', '1', tail]);
  media.command(['-i', head, '-i', tail, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]',
    '-ac', '1', '-ar', '24000', file]);
  return file;
}
// The storyboard of the cross-cut case: BOTH shots play the SAME accepted take, from contiguous source windows, so
// the cut at 2.4s falls INSIDE the performance instead of at a seam between two takes. The other accepted line is
// declared unused (a declared choice, not a silent drop). Both shots were generated longer than the film uses them,
// so a discarded tail is part of the case as well. The second shot's length follows the MEASURED take, so the film
// holds exactly as long as the performance that is heard over it.
function crossCutBoard(measured) {
  const payload = boardPayload();
  payload.shots[0].segments = [{ lineId: 'ln01', sourceStart: 0, sourceEnd: 2.4 }];
  payload.shots[1].segments = [{ lineId: 'ln01', sourceStart: 2.4, sourceEnd: measured.ln01 }];
  payload.shots[1].end = measured.ln01;
  return { ...payload, unusedAudio: [{ id: 'ln02', reason: '交叉剪辑夹具：本片只有一段连续表演跨两镜，旁白不参与本轮合成' }] };
}
test('one accepted performance runs across a cut: the same take continues, with its marker in place', { timeout: 300000 }, async () => {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const takeDir = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'crosscut-'));
  const takes = [path.join(takeDir, 'take-ln01.wav'), path.join(takeDir, 'take-ln02.wav')];
  let f = null;
  f = fixture({ voiceProducts: takes, board: () => crossCutBoard(stateOf(f).creative.acceptance.measured) });
  // ONE continuous 6.0s performance: 880 Hz until 2.0s, then 1200 Hz. The cut at 2.4s is inside the second part.
  markedPerformance(f.media, takes[0], { first: 880, second: 1200, switchAt: 2, seconds: 6 });
  f.media.command(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=24000,volume=4', '-t', '2', '-ac', '1', takes[1]]);
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    const acceptedTake = stateOf(f).creative.audio.ln01;
    assert.ok(Math.abs(acceptedTake.duration - 6) < 0.05, '被接受的是一整段 6 秒表演：' + acceptedTake.duration);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const done = stateOf(f), film = finalOutput(f);
    assert.equal(done.stage, 'final');
    assert.equal(done.creativeStage?.pause, undefined);
    assert.ok(fs.existsSync(film), '成片已写出');
    // 1) The timeline says the cut falls INSIDE one take: ONE bed entry, two contiguous segments.
    assert.equal(done.creative.timeline.audioBed.length, 1, '音频床只有一条：同一段表演');
    const bed = done.creative.timeline.audioBed[0];
    assert.equal(bed.lineId, 'ln01');
    assert.equal(bed.file, acceptedTake.file, '音频床用的就是被接受的那份文件');
    assert.deepEqual(bed.segments.map(span => [span.sourceStart, span.sourceEnd]), [[0, 2.4], [2.4, 6]]);
    assert.deepEqual(bed.segments.map(span => [span.filmStart, span.filmEnd]), [[0, 2.4], [2.4, 6]]);
    assert.deepEqual(done.creative.timeline.shots.map(shot => shot.audioSpans.map(span => span.lineId)), [['ln01'], ['ln01']],
      '两镜的音频区间都属于同一段表演');
    // 2) The composition's own record carries the take by CONTENT, with both segments of the one entry.
    const record = done.creative.composition;
    assert.equal(record.audioBed.length, 1);
    assert.equal(record.audioBed[0].contentHash, acceptedTake.hash, '合成输入摘要里的是实际音频床文件的内容摘要');
    assert.equal(record.audioBed[0].source, 'accepted-file');
    assert.equal(record.audioBed[0].segments.length, 2);
    assert.deepEqual(record.shots.map(shot => [shot.id, shot.start, shot.end]), [['shot01', 0, 2.4], ['shot02', 2.4, 6]]);
    // 3) The film is measured, not read off the JSON: the take's marker timeline is heard where it belongs.
    const info = f.media.video(film, done.timed.totalDuration, true);
    assert.ok(Math.abs(info.duration - acceptedTake.duration) <= FINAL_DURATION_TOLERANCE,
      '成片时长等于这段表演：' + info.duration + ' vs ' + acceptedTake.duration);
    const windowAt = (at, seconds = 0.3) => windowSignal(f.media, film, at, seconds);
    assert.ok(Math.abs(windowAt(1.4).frequency - 880) <= FINAL_TONE_TOLERANCE,
      '切镜之前是这段表演的前半段：实测 ' + windowAt(1.4).frequency);
    assert.ok(Math.abs(windowAt(2.5).frequency - 1200) <= FINAL_TONE_TOLERANCE,
      '切镜之后是这段表演的后半段（不是重播开头）：实测 ' + windowAt(2.5).frequency);
    assert.ok(Math.abs(windowAt(5.6).frequency - 1200) <= FINAL_TONE_TOLERANCE,
      '结尾仍在同一段表演的尾部：实测 ' + windowAt(5.6).frequency);
    assert.ok(Math.abs(windowAt(1.7, 0.25).frequency - 880) <= FINAL_TONE_TOLERANCE, '标记切换前仍是前半段');
    assert.ok(Math.abs(windowAt(2.1, 0.25).frequency - 1200) <= FINAL_TONE_TOLERANCE,
      '标记切换发生在第一镜内部、切镜之前：中间没有漏段，也没有整体前后移动');
    assert.equal(done.creative.timeline.shots[0].end, 2.4, '切换点 2.0 秒确实落在第一镜里');
    // 4) No hole and no double at the cut: the dialogue is audible on both sides of it.
    for (const at of [1.0, 1.8, 2.2, 2.35, 2.45, 2.8, 4.0, 5.6]) {
      const heard = windowAt(at, 0.2);
      assert.ok(heard.rms > FINAL_SILENCE_LIMIT, at + ' 秒处不应有断口：rms=' + heard.rms.toFixed(4));
    }
    // 5) Nothing of the clips' own tracks is mixed in, at the cut or before it (330 Hz first shot, 550 Hz second).
    const cutVoice = bandRms(f.media, film, 2.6, 0.3, 1200, FINAL_RESIDUE_WIDTH);
    const cutOther = bandRms(f.media, film, 2.6, 0.3, 550, FINAL_RESIDUE_WIDTH);
    assert.ok(cutOther < FINAL_RESIDUE_LIMIT * cutVoice,
      '切镜处没有第二镜素材自己的 550Hz 音轨：' + cutOther.toFixed(5) + ' vs ' + (FINAL_RESIDUE_LIMIT * cutVoice).toFixed(5));
    const headVoice = bandRms(f.media, film, 0.4, 0.3, 880, FINAL_RESIDUE_WIDTH);
    const headOther = bandRms(f.media, film, 0.4, 0.3, 330, FINAL_RESIDUE_WIDTH);
    assert.ok(headOther < FINAL_RESIDUE_LIMIT * headVoice, '第一镜素材自己的 330Hz 音轨没有进入成片');
    // 6) ONE subtitle for the whole performance: it does not restart at the cut.
    const lines = cues(fs.readFileSync(filmSubtitleFile(film), 'utf8'));
    assert.equal(lines.length, 1, '跨镜的一句仍只有一条字幕');
    assert.ok(Math.abs(lines[0].from) <= 0.01);
    assert.ok(Math.abs(lines[0].to - acceptedTake.duration) <= 0.02, '字幕覆盖整段表演，没有在切镜处归零');
    assert.equal(lines[0].text, '臣等正欲死战');
    // 7) Nothing was re-recorded, re-generated or re-planned for the cut; the lip-sync shot uses the same take.
    assert.equal(f.speech.length, 2, '切镜不触发第二次配音');
    assert.equal(f.videos.length, 2);
    assert.equal(f.checks.length, 4);
    assert.equal(f.planner.length, 6, '不重新规划分镜');
    assert.equal(f.others.length, 0);
    const take01 = done.creative.videos.shot01;
    assert.equal(take01.drivingAudio.lineId, 'ln01');
    assert.equal(take01.drivingAudio.sourceHash, acceptedTake.hash, '口型驱动用的仍是同一份被接受录音');
    assert.ok(Math.abs(take01.drivingAudio.seconds - 2.4) < 0.05, '驱动音频只取本镜真实播放的 2.4 秒');
    assert.equal(take01.plan.lipSync.crossesShots, true, '计划本身就记录了这段表演跨两镜');
    assert.deepEqual(take01.plan.lipSync.bedShotIds, ['shot01', 'shot02']);
    // 8) Both shots were generated LONGER than the film uses them: the tail is discarded, never invented.
    assert.ok(Math.abs(take01.usage.tailDiscardedSeconds - 0.6) < 0.05);
    assert.ok(Math.abs(done.creative.videos.shot02.usage.tailDiscardedSeconds - 1.4) < 0.05);
    assert.ok(Math.abs(take01.info.duration - 3) < 0.2, '第一镜生成 3 秒，成片只用 2.4 秒');
    assert.ok(Math.abs(done.creative.videos.shot02.info.duration - 5) < 0.2, '第二镜生成 5 秒，成片只用约 3.6 秒');
  });
});

// The bed is bound to the accepted take by CONTENT, not by path or by a declared length: a same-length recording of
// ANOTHER performance, put into the bed while the acceptance records stay untouched, must stop the run before any
// FFmpeg call, must never be mixed into a film, and must not let the older film pass as the result of this input.
test('the audio bed must be the accepted take by content: a same-length substitute is refused before any encode', { timeout: 300000 }, async () => {
  const f = fixture();
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const good = stateOf(f), film = finalOutput(f), goodHash = fileHash(film);
    const context = { root: f.root, production: readJson(path.join(f.root, 'input/production.json')),
      config: readJson(path.join(f.root, 'config/aliyun.json')) };
    // The unchanged input: every bed entry names its accepted recording and carries that recording's content hash.
    const clean = finalCompositionPlan(context, structuredClone(good), { media: f.media });
    assert.deepEqual(clean.blockers, []);
    assert.deepEqual(clean.audioBed.map(entry => [entry.lineId, entry.source]),
      [['ln01', 'accepted-file'], ['ln02', 'accepted-file']]);
    assert.deepEqual(clean.audioBed.map(entry => entry.contentHash),
      [fileHash(good.creative.audio.ln01.file), fileHash(good.creative.audio.ln02.file)],
      '音频床摘要就是实际会被解码混音的文件内容');
    assert.deepEqual(clean.audioBed.map(entry => entry.acceptedHash),
      [good.creative.audio.ln01.hash, good.creative.audio.ln02.hash], '每一句都对应到自己的已接受来源');
    assert.equal(clean.composition.burn, true, '有字幕的成片把烧字幕写进合成参数');
    assert.deepEqual(clean.composition.profile, FINAL_PROFILE, '合成参数里的规格就是编码器使用的档位');
    // The impostor: another performance of exactly the same length. The acceptance records are NOT touched.
    const impostor = path.join(f.root, 'impostor-ln01.wav');
    f.media.command(['-f', 'lavfi', '-i', 'sine=frequency=200:sample_rate=24000,volume=4', '-t', '2.4', '-ac', '1', impostor]);
    assert.ok(Math.abs(f.media.audio(impostor).duration - good.creative.audio.ln01.duration) < 0.03, '替身与已接受配音等长');
    const edited = structuredClone(good);
    edited.creative.timeline.audioBed[0].file = impostor;
    // (a) The plan itself refuses it, and reaches the refusal without assembling or encoding anything.
    const calls = [];
    const spy = name => (...args) => { calls.push(name); return f.media[name](...args); };
    const media = { audio: spy('audio'), image: spy('image'), probe: spy('probe'), video: spy('video'), command: spy('command'),
      assemble: () => { calls.push('assemble'); throw new Error('ASSEMBLE_MUST_NOT_RUN'); } };
    const planned = finalCompositionPlan(context, structuredClone(edited), { media });
    assert.ok(planned.blockers.some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_FILE_MISMATCH:ln01')),
      '音频床的替身必须在合成前被拒：' + planned.blockers.join('；'));
    assert.ok(!calls.includes('assemble') && !calls.includes('command'), '被拒时没有合成、没有编码');
    const stopped = finalStage(context, structuredClone(edited), { media, log: () => {}, save: () => {} });
    assert.equal(stopped.creativeStage.pause.code, 'CREATIVE_FINAL_BLOCKED');
    assert.ok(!calls.includes('assemble') && !calls.includes('command'), '合成边界的拒绝同样不编码、不写文件');
    // (b) Through the normal entry the same state stops the run: the older film is not reused as this input's result
    //     and no wrong dialogue is written.
    writeJson(path.join(f.directory, 'state.json'), edited);
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const after = stateOf(f);
    assert.equal(after.creativeStage.pause.code, 'CREATIVE_FINAL_BLOCKED');
    assert.ok(after.creative.finalBlockers.some(entry => entry.startsWith('CREATIVE_FINAL_AUDIO_FILE_MISMATCH:ln01')));
    assert.notEqual(after.stage, 'final', '阻断时阶段不前进');
    assert.equal(fileHash(film), goodHash, '没有拿替身音频去重新合成');
    assert.ok(fs.existsSync(film), '旧成片文件没有被删除');
    assert.equal(after.creative.composition.inputDigest, good.creative.composition.inputDigest,
      '旧成片没有被当成这次输入的结果');
    assert.equal(after.creative.composition.reuses, 0, '不同输入不会被算作一次复用');
    assert.equal(after.creative.composition.output, film, '旧成片的合成记录仍在，路径可查');
    assert.equal(after.output, undefined, '指向旧成片的 output 指针已清除并写明原因');
    assert.equal(after.acceptance, undefined, '旧成片的播放验收状态同样不再指向本次输入');
    assert.equal(f.videos.length, 2, '为这场拒绝没有重新生成视频');
    assert.equal(f.checks.length, 4, '也没有重新检查');
    assert.equal(f.speech.length, 2, '没有重新配音');
    assert.equal(f.planner.length, 6);
  });
});

// The composition boundary must not accept a plan or a verdict that belongs to an older input. The saved plan is
// re-derived from the CURRENT storyboard, timeline, anchor frames and applicable audio with the video stage's own
// planner, and the verdict is bound to the take that is on disk now. The normal entry protects the same changes
// EARLIER (the video stage refuses to answer a changed plan with an old record) — that is a different layer, and it
// is asserted as such instead of being credited to the composition step.
test('the composition refuses an old video plan or an old verdict once the input has changed', { timeout: 240000 }, async () => {
  const f = fixture();
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    const good = stateOf(f);
    const context = { root: f.root, production: readJson(path.join(f.root, 'input/production.json')),
      config: readJson(path.join(f.root, 'config/aliyun.json')) };
    // The unchanged input: the saved plan IS the plan the current input produces, so the film may be built.
    const clean = finalCompositionPlan(context, structuredClone(good), { media: f.media });
    assert.deepEqual(clean.blockers, []);
    assert.deepEqual(clean.shots.map(shot => [shot.id, shot.planDigest]),
      [['shot01', good.assets.shot01.videoPlan.digest], ['shot02', good.assets.shot02.videoPlan.digest]],
      '记录的计划就是当前分镜/时间线/帧素材/适用音频算出的计划');
    // (a) The first shot's action is reworded, the old plan and the old verdict stay in the state.
    const reworded = structuredClone(good);
    reworded.creative.storyboard.shots[0].action.phases[1] += '（改成另一种收势）';
    const staleAction = finalCompositionPlan(context, reworded, { media: f.media });
    assert.equal(staleAction.blockers.length, 1);
    assert.ok(staleAction.blockers[0].startsWith('CREATIVE_FINAL_VIDEO_PLAN_STALE:shot01'),
      '当前动作与旧计划不一致时不得合成：' + staleAction.blockers.join('；'));
    // (b) The timeline no longer holds the slot the saved plan was made for: that plan cannot even be re-derived,
    //     so the film is refused instead of being cut to a window the take's plan never covered. (A pure move of the
    //     cut — a hand-edited start — does not change what a shot's REQUEST carries; what must not happen there is
    //     the older film passing as this input's result, which the composition's input identity covers.)
    const moved = structuredClone(good);
    moved.creative.timeline.shots[1].duration = 3.4;
    const staleTimeline = finalCompositionPlan(context, moved, { media: f.media });
    assert.equal(staleTimeline.blockers.length, 1);
    assert.ok(staleTimeline.blockers[0].startsWith('CREATIVE_FINAL_VIDEO_PLAN_STALE:shot02'),
      '时间线变化必须让旧计划失效：' + staleTimeline.blockers.join('；'));
    // (c) An anchor frame is replaced by different bytes: the plan no longer belongs to these frames.
    const swappedFrame = path.join(f.root, 'frame-replaced.png');
    f.media.command(['-f', 'lavfi', '-i', 'color=c=purple:s=512x512', '-frames:v', '1', swappedFrame]);
    const reframed = structuredClone(good);
    reframed.assets.shot01.first = swappedFrame;
    const staleFrames = finalCompositionPlan(context, reframed, { media: f.media });
    assert.equal(staleFrames.blockers.length, 1);
    assert.ok(staleFrames.blockers[0].startsWith('CREATIVE_FINAL_VIDEO_PLAN_STALE:shot01'),
      '帧素材内容变化必须让旧计划与旧审核失效：' + staleFrames.blockers.join('；'));
    // (d) The take on disk is replaced by another clip: the plan still matches, but the verdict does not.
    const otherTake = path.join(f.root, 'other-take.mp4');
    fs.copyFileSync(f.clips[5], otherTake);
    const replacedTake = structuredClone(good);
    replacedTake.assets.shot01.video = otherTake;
    const staleVerdict = finalCompositionPlan(context, replacedTake, { media: f.media });
    assert.equal(staleVerdict.blockers.length, 1);
    assert.ok(staleVerdict.blockers[0].startsWith('CREATIVE_FINAL_VIDEO_CHECK_STALE:shot01'),
      '素材内容变化后旧审核必须失效：' + staleVerdict.blockers.join('；'));
    // (e) Through the normal entry the reworded action is stopped EARLIER, at the video boundary, where the recorded
    //     request is compared with the plan of the current storyboard. The composition step is not reached at all.
    writeJson(path.join(f.directory, 'state.json'), structuredClone(reworded));
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const stopped = stateOf(f);
    assert.notEqual(stopped.stage, 'final', '入口没有走到成片阶段');
    assert.equal(stopped.creativeStage?.pause, undefined, '这一层由视频阶段自己的预检挡住，不写合成暂停记录');
    assert.equal(stopped.assets.shot01.videoPause.code, 'CREATIVE_VIDEO_PLAN_FAILED',
      '预检失败按既有约定记在视频暂停记录里');
    assert.match(stopped.assets.shot01.videoPause.detail, /CREATIVE_VIDEO_PLAN_CHANGED/,
      '入口在视频边界就挡住与已记录请求不一致的计划');
    assert.equal(stopped.assets.shot01.video, good.assets.shot01.video, '没有换素材，也没有换号重发');
    assert.equal(fs.existsSync(finalOutput(f)), false, '没有成片被写出来');
    assert.equal(f.videos.length, 2, '入口没有为这次拒绝提交新视频');
    assert.equal(f.checks.length, 4);
    // (f) The same state, handed to the composition boundary, is refused THERE TOO, by the composition's own rule.
    const calls = [];
    const spy = name => (...args) => { calls.push(name); return f.media[name](...args); };
    const media = { audio: spy('audio'), image: spy('image'), probe: spy('probe'), video: spy('video'), command: spy('command'),
      assemble: () => { calls.push('assemble'); throw new Error('ASSEMBLE_MUST_NOT_RUN'); } };
    const blocked = finalStage(context, structuredClone(reworded), { media, log: () => {}, save: () => {} });
    assert.ok(blocked.creative.finalBlockers.some(entry => entry.startsWith('CREATIVE_FINAL_VIDEO_PLAN_STALE:shot01')),
      '合成边界自己也要挡住旧计划：' + blocked.creative.finalBlockers.join('；'));
    assert.equal(blocked.creativeStage.pause.code, 'CREATIVE_FINAL_BLOCKED');
    assert.ok(!calls.includes('assemble') && !calls.includes('command'), '合成边界同样不编码、不写文件');
  });
});

// The cache basis is not "the paths did not change". The ending card is a real picture whose content decides the
// last seconds of the film, and the effective composition parameters (the profile the encoder is built from, the
// preview flag, whether the cues are burned) are part of a film's identity as well. Both are recorded, so a changed
// ending picture at the same path cannot leave the older film looking like the result of the new input.
test('the film cache basis covers the ending picture and the composition parameters', { timeout: 300000 }, async () => {
  const f = fixture({ ending: true });
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    assert.ok(fs.existsSync(f.ending.image), '片尾图片存在');
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const first = stateOf(f), film = finalOutput(f), firstHash = fileHash(film);
    const record = first.creative.composition;
    assert.equal(first.stage, 'final');
    assert.equal(record.composition.preview, false, '成片不是分镜预览');
    assert.equal(record.composition.burn, true, '有字幕的成片记下烧字幕这一参数');
    assert.deepEqual(record.composition.profile, FINAL_PROFILE, '缓存依据里的合成参数就是编码器使用的档位');
    assert.equal(record.ending.cardSeconds, 1);
    assert.ok(Math.abs(record.ending.start - 6) <= 0.01, '片尾卡从内容结束处开始');
    assert.ok(Math.abs(record.totalDuration - 7.5) <= 0.05, '成片时长 = 6 秒内容 + 1 秒片尾卡 + 0.5 秒黑场');
    const context = { root: f.root, production: readJson(path.join(f.root, 'input/production.json')),
      config: readJson(path.join(f.root, 'config/aliyun.json')) };
    assert.equal(finalCompositionPlan(context, structuredClone(first), { media: f.media }).inputDigest, record.inputDigest,
      '同一输入必须算出同一个身份');
    // Unchanged input: nothing is encoded again.
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    assert.equal(fileHash(film), firstHash, '未变化的输入不重新编码');
    assert.equal(stateOf(f).creative.composition.reuses, 1);
    // The SAME path now holds a different picture: the ending card of the film would be another picture.
    f.media.command(['-f', 'lavfi', '-i', 'color=c=yellow:s=640x640', '-frames:v', '1', f.ending.image]);
    const swapped = finalCompositionPlan(context, stateOf(f), { media: f.media });
    assert.deepEqual(swapped.blockers, [], '换掉片尾图片本身仍是可合成的输入');
    assert.notEqual(swapped.inputDigest, record.inputDigest, '片尾图片内容改变必须改变成片的输入身份');
    // The normal entry refuses this change even earlier, at the production fingerprint (which already hashes the
    // ending picture), so the older film can never be served as the result of this input. That is a different layer
    // than the composition's own digest, and it is asserted as such here.
    await assert.rejects(main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client }),
      /PRODUCTION_INPUT_CHANGED/);
    const after = stateOf(f);
    assert.equal(fileHash(film), firstHash, '被拒时旧成片既没有被复用也没有被重新编码');
    assert.equal(after.creative.composition.inputDigest, record.inputDigest);
    assert.equal(f.videos.length, 2, '这里没有生成任何新视频');
    assert.equal(f.checks.length, 4);
    assert.equal(f.speech.length, 2, '也不重新配音');
  });
});

// A lip-sync take that comes back WITHOUT its own audio track. No supplier evidence in this project says the 口型驱动
// branch must return one (docs/TODO.md keeps that behaviour unverified), so the take is not declared invalid: the
// picture is validated technically, the missing track is recorded as an observation WITH its basis, the film's
// dialogue still comes from the accepted audio bed, and whether the mouth matches the voice stays with the user.
test('a lip-sync take without an audio track is recorded as an observation, not declared invalid', { timeout: 240000 }, async () => {
  const f = fixture({ silentClips: true });
  await withOffline(async () => {
    await acceptFixtureAudio(f);
    await main(['run', f.manifest, '--until', 'video'], { root: f.root, client: f.client });
    const video = stateOf(f), take = video.creative.videos.shot01;
    assert.equal(take.plan.branch, 'driving-audio', '这一镜仍然是口型驱动镜头');
    assert.ok(take.request.drivingAudio, '驱动音频照常送出');
    assert.equal(video.assets.shot01.videoInfo.audio, false, '取回的素材确实没有音轨');
    assert.equal(video.assets.shot01.lipSyncObserved.supplierTrack, 'absent');
    assert.equal(video.assets.shot01.lipSyncObserved.policy, 'observation-only');
    assert.ok(video.assets.shot01.lipSyncObserved.basis.includes('未核实'), '依据要写明这是未核实的保守判断');
    assert.ok(video.assets.shot01.lipSyncObserved.effect.includes('成片对白仍来自已接受音频床'),
      '说明成片对白不受这条音轨影响');
    assert.equal(take.lipSyncObserved.supplierTrack, 'absent', '完成记录里也写明了观察结果');
    assert.equal(video.assets.shot01.videoReview.evidence.supplierTrack, 'absent', '检查证据里同样记录');
    assert.ok(fs.existsSync(take.file), '素材没有被删除，也没有被换掉');
    assert.equal(take.check.verdict, 'pass', '画面技术检查照常进行，缺音轨没有被当成无效');
    assert.ok(f.checks[2].prompt.includes('取回素材没有自带音轨'), '检查记录如实说明缺音轨');
    assert.ok(f.checks[2].prompt.includes('不据此判定口型素材无效'), '检查记录写明这不是无效判定');
    assert.ok(f.checks[2].prompt.includes('抽帧不能证明口型是否与声音对上'), '不声称口型已经被验证');
    // The film is still assembled, and its dialogue is measured on the decoded signal instead of being claimed.
    await main(['run', f.manifest, '--until', 'final'], { root: f.root, client: f.client });
    const done = stateOf(f), film = finalOutput(f);
    assert.equal(done.stage, 'final');
    assert.equal(done.creativeStage?.pause, undefined);
    assert.ok(fs.existsSync(film), '成片已写出');
    assert.equal(f.media.probe(film).streams.filter(stream => stream.codec_type === 'audio').length, 1,
      '成片只有一条音轨：被接受的配音床');
    const heard = windowSignal(f.media, film, 1.0, 0.3);
    assert.ok(Math.abs(heard.frequency - 440) <= FINAL_TONE_TOLERANCE, '听到的仍是被接受的那句配音：实测 ' + heard.frequency);
    const info = f.media.video(film, done.timed.totalDuration, true);
    assert.ok(Math.abs(info.duration - 6) <= FINAL_DURATION_TOLERANCE, '成片时长仍是两镜的 6 秒');
    assert.equal(f.videos.length, 2, '缺音轨没有触发重新生成');
    assert.equal(f.checks.length, 4);
    assert.equal(f.speech.length, 2, '没有重新配音');
    assert.equal(done.acceptance, 'awaiting_user_playback', '口型与声音是否对上仍由用户播放验收');
  });
});

// Entry-level material protection: a required identity material that cannot be read stops the run with zero
// requests. The manifest images are already validated on this path before the first stage (fingerprints), so the
// refusal happens at the very start and never after a submission; the frame stage's own per-material probe is the
// second layer of the same rule.
test('a required reference that cannot be read stops the run before any submission', { timeout: 120000 }, async () => {
  const f = fixture();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  try {
    const manifest = readJson(path.join(f.root, 'input/production.json'));
    manifest.characters[0].image = path.join(f.root, 'missing-hero.png');
    writeJson(path.join(f.root, 'input/production.json'), manifest);
    await assert.rejects(main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client }),
      /ENOENT|IMAGE_NOT_USABLE/);
    assert.equal(f.planner.length, 0, '必要素材不可读时不进入任何规划请求');
    assert.equal(f.images.length, 0, '必要素材不可读时零图片请求');
    assert.equal(f.checks.length, 0, '必要素材不可读时零检查请求');
    assert.equal(f.others.length, 0, '必要素材不可读时零视频或其它请求');
    assert.equal(fs.existsSync(path.join(f.directory, 'state.json')), false, '没有留下半成品状态文件');
  } finally {
    global.fetch = originalFetch;
  }
});

// Entry-level protection for a CHANGED prompt: a controlled re-plan of the creative product produces different
// frame wording under the same operation numbers. The frames and the check made from the old wording must not
// pass as the new input, and nothing may be re-generated on the user's behalf — the run stops explicitly.
test('a changed frame prompt cannot reuse the old frames or their check', { timeout: 180000 }, async () => {
  let boardCalls = 0;
  const f = fixture({ board: () => (boardCalls++ === 0 ? boardPayload() : rewordedBoard()) });
  const originalFetch = global.fetch, originalMarker = process.env.CREATIVE_OFFLINE_FIXTURE;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  process.env.CREATIVE_OFFLINE_FIXTURE = '1';
  try {
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    const audio = stateOf(f);
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client });
    const firstRound = stateOf(f);
    const bindingBefore = firstRound.assets.shot01.frameReview.binding.digest;
    const before = { images: f.images.length, checks: f.checks.length, planner: f.planner.length, speech: f.speech.length };
    // The controlled path that changes the wording: the user re-records one line with the SAME measured duration,
    // listens again and accepts it. That invalidates the old storyboard, so it is planned again (a new request)
    // and the new wording produces a different frame prompt under the same operation numbers.
    f.media.command(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=24000,volume=4', '-t', '2.4', '-ac', '1',
      '-y', audio.creative.audio.ln01.file]);
    // The replaced take must be re-reviewed BEFORE it can be accepted: an acceptance bound to different audio (and a
    // tone conclusion bound to the old one) can never be carried over by a new acceptance, not even in a fixture.
    await assert.rejects(main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root }),
    /CREATIVE_TONE_REVIEW_STALE:ln01/);
    await main(['run', f.manifest, '--until', 'audio'], { root: f.root, client: f.client });
    await main(['accept-creative-audio', f.manifest, 'ln01=' + audio.creative.audio.ln01.file,
      'ln02=' + audio.creative.audio.ln02.file, '--method', 'fixture', '--offline-fixture'], { root: f.root });
    await assert.rejects(main(['run', f.manifest, '--until', 'frames'], { root: f.root, client: f.client }),
      /CREATIVE_FRAME_INPUT_CHANGED/);
    assert.equal(boardCalls, 2, '新旧配音各自规划一次分镜');
    assert.equal(f.planner.length, before.planner + 1, '受控重新规划只增加一次规划请求');
    assert.equal(f.speech.length, before.speech, '重新接受不重发配音请求');
    assert.equal(f.images.length, before.images, '提示词变化后旧帧不得放行，也不得自动重生成');
    assert.equal(f.checks.length, before.checks, '提示词变化后旧检查不得放行');
    assert.equal(stateOf(f).assets.shot01.frameReview.binding.digest, bindingBefore, '旧绑定保持原样，需受控修订后才可继续');
    assert.equal(f.others.length, 0, '提示词变化期间仍然零视频请求');
  } finally {
    global.fetch = originalFetch;
    if (originalMarker === undefined) delete process.env.CREATIVE_OFFLINE_FIXTURE;
    else process.env.CREATIVE_OFFLINE_FIXTURE = originalMarker;
  }
});



// Step75: exercise command dispatch, persisted state and the real Operations layer together.
const recoveryCounts = f => [f.planner.length, f.speech.length, f.toneReviews.length,
  f.images.length, f.checks.length, f.videos.length];
test('acceptance override resumes through CLI to storyboard without repeat submissions', { timeout: 180000 }, async () => {
  await withOffline(async () => {
    const f = fixture({ toneFailure: true });
    const run = until => main(['run', f.manifest, '--until', until], { root: f.root, client: f.client });
    await run('audio');
    const initial = stateOf(f);
    assert.equal(initial.creativeStage.pause.code, 'CREATIVE_TONE_REVIEW_FAILED');
    const args = ['accept-creative-audio', f.manifest,
      ...Object.entries(initial.creative.audio).map(([id, a]) => id + '=' + a.file)];
    await assert.rejects(main(args, { root: f.root }), /CREATIVE_TONE_REVIEW_NOT_PASSED/);
    await main([...args, '--tone-override', '离线模拟人工已试听并确认可用'], { root: f.root });
    const decision = stateOf(f).creative.toneReviews.ln01.humanDecision;
    const before = recoveryCounts(f);
    await run('storyboard');
    const complete = stateOf(f);
    assert.ok(complete.creative.storyboard);
    assert.equal(complete.creative.toneReviews.ln01.verdict, 'fail');
    assert.deepEqual(complete.creative.toneReviews.ln01.humanDecision, decision);
    assert.equal(f.planner.length, before[0] + 1);
    assert.equal(f.toneReviews.length, before[2]);
    assert.equal(f.speech.length, before[1]);
    const counts = recoveryCounts(f);
    const ledger = fs.readFileSync(path.join(f.directory, 'api-ledger.json'), 'utf8');
    await run('storyboard');
    assert.deepEqual(recoveryCounts(f), counts);
    assert.equal(fs.readFileSync(path.join(f.directory, 'api-ledger.json'), 'utf8'), ledger);
  });
});

test('controlled scene replan resumes through CLI into new frames and reuses them', { timeout: 240000 }, async () => {
  await withOffline(async () => {
    let revised = false;
    const marker = '新增的暗红色帐布补丁';
    const f = fixture({ board: () => {
      const board = boardPayload();
      if (revised) for (const shot of board.shots) for (const kind of ['first', 'last'])
        shot[kind].visibleEnvironment.push(marker);
      return board;
    } });
    const run = until => main(['run', f.manifest, '--until', until], { root: f.root, client: f.client });
    await acceptFixtureAudio(f);
    await run('frames');
    const original = stateOf(f);
    const audio = structuredClone(original.creative.audio);
    const acceptance = structuredClone(original.creative.acceptance);
    const oldOperations = Object.fromEntries(fs.readdirSync(path.join(f.directory, 'operations'))
      .filter(name => name.endsWith('.json')).map(name => [name, fileHash(path.join(f.directory, 'operations', name))]));
    const scene = structuredClone(original.creative.scenes.entries[0]);
    scene.structures.push(marker);
    writeJson(path.join(f.root, 'revision.json'), { kind: 'scene', target: scene.id, scene });
    await main(['revise-creative', f.manifest, 'revision.json', '离线确认场景补丁变化'], { root: f.root });
    const beforePause = recoveryCounts(f);
    await run('frames');
    assert.equal(stateOf(f).creativeStage.pause.code, 'CREATIVE_STORYBOARD_SETTING_CHANGED');
    assert.deepEqual(recoveryCounts(f), beforePause);
    writeJson(path.join(f.root, 'revision.json'), { kind: 'storyboard', decision: 'replan' });
    await main(['revise-creative', f.manifest, 'revision.json', '离线确认整体重规划'], { root: f.root });
    revised = true;
    const before = recoveryCounts(f);
    await run('frames');
    const after = stateOf(f);
    assert.equal(f.planner.length, before[0] + 1);
    assert.ok(f.planner.at(-1).includes(marker));
    assert.equal(f.images.length, before[3] + 4);
    assert.equal(f.checks.length, before[4] + 2);
    assert.ok(f.images.slice(-4).every(image => image.prompt.includes(marker)));
    assert.deepEqual(after.creative.audio, audio);
    assert.deepEqual(after.creative.acceptance, acceptance);
    assert.equal(after.creative.storyboardReplan, undefined);
    assert.equal(after.creative.storyboardReplanHistory.length, 1);
    for (const [name, digest] of Object.entries(oldOperations))
      assert.equal(fileHash(path.join(f.directory, 'operations', name)), digest, name);
    const counts = recoveryCounts(f), revisions = after.revisions;
    const ledger = fs.readFileSync(path.join(f.directory, 'api-ledger.json'), 'utf8');
    await run('frames');
    assert.deepEqual(recoveryCounts(f), counts);
    assert.deepEqual(stateOf(f).revisions, revisions);
    assert.equal(fs.readFileSync(path.join(f.directory, 'api-ledger.json'), 'utf8'), ledger);
    assert.equal(f.videos.length, 0);
  });
});
