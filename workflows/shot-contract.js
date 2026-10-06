const { hash } = require('../services/aliyun/io');

// The action contract of one shot. The planner model authors the words; this module only checks the
// structure and the declared hand-off between neighbouring shots, and turns the same contract into the
// wording used by image generation, video generation and both quality checks. Nothing here invents
// motion: a plan without a contract is accepted as legacy input, but then no continuity is claimed.
const CONTRACT_VERSION = 2;
const REQUIRED_FIELDS = ['startState', 'endState', 'primaryAction', 'beats', 'cut', 'handoff'];
const CUTS = ['continuous', 'scene', 'time'];
const MAX_TEXT = 400;
const MAX_BEATS = 3;

// Rules shared by authoring (script / visual plan) and by review, so generation and review cannot drift
// into two different standards.
const CONTRACT_RULES = [
  '首帧和尾帧各自只描述一个单一、明确的静止瞬间；连续运动写进动作描述。',
  '短镜头（不超过5秒）只安排一个主动作，禁止同镜同时要求转身、拔剑、冲刺、交战、倒地。',
  '动作要写清起势、重心转移、接触与收势，不用“动作自然”这类形容词代替具体设计。',
  '首尾姿态跨度必须在给定时长内可实现，不把整场动作塞进一个镜头。',
  '同场相邻镜头必须写清承接：持物、视线、人物位置与运动方向如何延续，不每镜重复全场动作。',
  '场景或时间切换按原文处理，不强行保持空间连续，但要写明这是切场或时间跳跃。',
  '冲突处理：用户定稿决定剧情、道具与动作；参考素材只约束身份、服饰与画风；两者冲突要写明，不自行编造。',
  '不新增原文没有的台词、人物、事件或关键动作。'
];
function contractRulesPrompt() {
  return '镜头动作约束（生成与审核共用同一份）：' + CONTRACT_RULES.map((rule, index) => (index + 1) + '）' + rule).join('');
}
// The single wording for “who decides what”. docFirst=true is the external-script path, where the user
// document wins for props and actions; otherwise the script wins. Both generation and review use it.
function authorityPrompt({ docFirst } = {}) {
  return docFirst
    ? '依据优先级：用户定稿文档决定剧情、道具与动作；参考图只约束身份、脸型、服饰与画风。文档写佩剑时不得因为参考图是长矛而改成长矛或判为错误；两者冲突时按文档执行并写明冲突，不自行编造。'
    : '依据优先级：本片脚本决定剧情、道具与动作；参考图只约束身份、脸型、服饰与画风。两者冲突时按脚本执行并写明冲突，不自行编造。';
}
const CONTRACT_SHAPE = '{"startState":"起始静止瞬间：姿态、朝向、视线、重心与支撑点、左右手持物及道具状态",' +
  '"endState":"结束静止瞬间（同上维度）","primaryAction":"本镜唯一主动作及目的",' +
  '"beats":["关键动作阶段，起势/接触/收势，1至3项，首项与startState一致，末项与endState一致"],' +
  '"cut":"continuous（承接上一镜）或scene（切场）或time（时间跳跃）",' +
  '"handoff":"与上一镜如何承接（持物、视线、方向、位置），或写明这是切场/时间跳跃"}';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function hasContract(shot) { return REQUIRED_FIELDS.some(field => shot?.[field] !== undefined && shot?.[field] !== null); }
// A partially migrated shot is refused instead of being half-checked: either the shot carries the whole
// contract or it is treated as legacy input.
function contractOf(shot) {
  if (!hasContract(shot)) return null;
  const missing = REQUIRED_FIELDS.filter(field => field === 'beats' ? !Array.isArray(shot.beats) : !text(shot[field]));
  if (missing.length) throw new Error('SHOT_CONTRACT_INCOMPLETE:' + (shot?.id || '?') + ':' + missing.join(','));
  return { version: CONTRACT_VERSION, startState: text(shot.startState), endState: text(shot.endState),
    primaryAction: text(shot.primaryAction), beats: shot.beats.map(text), cut: text(shot.cut), handoff: text(shot.handoff) };
}
// The digest that binds image, video and review requests to the very contract they were made from.
function contractDigest(shot, promptVersion) {
  const contract = contractOf(shot);
  return contract ? hash({ contract, promptVersion: promptVersion ?? null }) : null;
}

// Structural checks only: length limits, enum values, the beats/duration match and the declared hand-off.
function validateContract(shot, { duration = null, sceneId = null, previous = null, previousSceneId = null } = {}) {
  const contract = contractOf(shot);
  if (!contract) return { mode: 'legacy', issues: ['CONTRACT_MISSING'] };
  const issues = [];
  for (const field of ['startState', 'endState', 'primaryAction', 'handoff'])
    if (contract[field].length > MAX_TEXT) issues.push('CONTRACT_TEXT_TOO_LONG:' + field);
  if (contract.beats.length < 1 || contract.beats.length > MAX_BEATS) issues.push('CONTRACT_BEATS_COUNT');
  if (contract.beats.some(beat => !beat || beat.length > MAX_TEXT)) issues.push('CONTRACT_BEATS_TEXT');
  if (!CUTS.includes(contract.cut)) issues.push('CONTRACT_CUT_INVALID');
  // One primary action for a short shot: "转身、拔剑、冲刺" in five seconds is exactly what is refused.
  if (Number.isFinite(duration) && duration < 5 && contract.beats.length > 2) issues.push('CONTRACT_TOO_MANY_BEATS_FOR_DURATION');
  const sameScene = previous && sceneId !== null && previousSceneId !== null ? sceneId === previousSceneId : null;
  if (previous) {
    const previousContract = contractOf(previous);
    // Same scene must be declared as a continuation with an explicit carry-over; a scene or time change
    // must be declared as such and must not claim continuity.
    if (sameScene === true && contract.cut !== 'continuous') issues.push('CONTRACT_SAME_SCENE_MUST_CONTINUE');
    if (sameScene === false && contract.cut === 'continuous') issues.push('CONTRACT_CUT_CLAIMS_CONTINUITY_ACROSS_SCENE');
    if (previousContract && sameScene === true && contract.cut === 'continuous' && !text(previousContract.endState))
      issues.push('CONTRACT_PREVIOUS_END_STATE_REQUIRED');
  }
  // The hand-off is model-authored text: the local program never rewrites it, only refuses silence, and a
  // scene or time change must say so instead of silently dropping the thread.
  if (!contract.handoff) issues.push('CONTRACT_HANDOFF_REQUIRED');
  if (issues.length) throw new Error('SHOT_CONTRACT_INVALID:' + (shot?.id || '?') + ':' + issues.join(','));
  return { mode: 'contract', version: CONTRACT_VERSION, contract };
}
// Which neighbouring pairs can be checked against each other, and which gaps are known and allowed.
// Scene changes and time jumps are never treated as broken continuity.
function planContinuity(shots, sceneOf = () => null) {
  const pairs = [], gaps = [];
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index], previous = shots[index - 1] || null;
    const sceneId = sceneOf(shot), previousSceneId = previous ? sceneOf(previous) : null;
    let contract = null;
    try { contract = contractOf(shot); }
    catch (error) { gaps.push({ shotId: shot.id, reason: 'CONTRACT_INVALID', detail: error.message }); continue; }
    if (!contract) { gaps.push({ shotId: shot.id, reason: 'CONTRACT_MISSING' }); continue; }
    if (!previous) { gaps.push({ shotId: shot.id, reason: 'FIRST_SHOT' }); continue; }
    const sameScene = sceneId !== null && previousSceneId !== null && sceneId === previousSceneId;
    if (!sameScene) { gaps.push({ shotId: shot.id, reason: contract.cut === 'time' ? 'ALLOWED_TIME_CUT' : 'ALLOWED_SCENE_CUT' }); continue; }
    if (contract.cut !== 'continuous') { gaps.push({ shotId: shot.id, reason: 'SAME_SCENE_NOT_DECLARED_CONTINUOUS' }); continue; }
    let fromEndState = null;
    try { fromEndState = text(contractOf(previous)?.endState); } catch { fromEndState = null; }
    pairs.push({ from: previous.id, to: shot.id, sceneId, checkable: true, handoff: contract.handoff,
      fromEndState, toStartState: contract.startState });
  }
  return { mode: shots.some(shot => hasContract(shot)) ? 'contract' : 'legacy', pairs, gaps };
}
// The fragment appended to generation and review prompts. Legacy shots get an empty fragment, so their
// requests keep the exact wording (and therefore the exact fingerprint) they were sent with.
function contractPrompt(shot, { docFirst = false } = {}) {
  const contract = contractOf(shot);
  if (!contract) return '';
  return authorityPrompt({ docFirst }) + contractRulesPrompt() +
    '本镜动作约束：起始状态：' + contract.startState + '；唯一主动作：' + contract.primaryAction +
    '；关键阶段：' + contract.beats.join('→') + '；结束状态：' + contract.endState +
    '；与上一镜关系：' + contract.cut + '，承接说明：' + contract.handoff + '。';
}

// The script path has no separate scene key: each shot declares for itself whether it continues the
// previous one. The local program only checks that the declaration is complete and uses it to decide
// which neighbouring pairs can be compared; a legacy script is accepted and never forced into continuity.
function declaredPairs(shots) {
  const pairs = [], gaps = [];
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index], previous = shots[index - 1] || null;
    let contract = null;
    try { contract = contractOf(shot); }
    catch (error) { gaps.push({ shotId: shot.id, reason: 'CONTRACT_INVALID', detail: error.message }); continue; }
    if (!contract) { gaps.push({ shotId: shot.id, reason: 'CONTRACT_MISSING' }); continue; }
    if (!previous) { gaps.push({ shotId: shot.id, reason: 'FIRST_SHOT' }); continue; }
    if (contract.cut !== 'continuous') { gaps.push({ shotId: shot.id, reason: contract.cut === 'time' ? 'ALLOWED_TIME_CUT' : 'ALLOWED_SCENE_CUT' }); continue; }
    let fromEndState = null;
    try { fromEndState = text(contractOf(previous)?.endState); } catch { fromEndState = null; }
    pairs.push({ from: previous.id, to: shot.id, handoff: contract.handoff, fromEndState, toStartState: contract.startState });
  }
  return { mode: shots.some(shot => hasContract(shot)) ? 'contract' : 'legacy', pairs, gaps };
}
// Structural validation for a script: contract completeness, duration/beats match and a declared hand-off.
function validateScriptPlan(shots) {
  const problems = [];
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index], previous = shots[index - 1] || null;
    try {
      validateContract(shot, { duration: Number.isFinite(shot.duration) ? shot.duration : null, previous,
        sceneId: null, previousSceneId: null });
    } catch (error) { problems.push(error.message); }
  }
  if (problems.length) throw new Error('SCRIPT_CONTRACT_INVALID:' + problems.join('|'));
  return declaredPairs(shots);
}

module.exports = { CONTRACT_RULES, CONTRACT_SHAPE, CONTRACT_VERSION, CUTS, REQUIRED_FIELDS, authorityPrompt,
  contractDigest, contractOf, contractPrompt, contractRulesPrompt, declaredPairs, hasContract, planContinuity,
  validateContract, validateScriptPlan };



