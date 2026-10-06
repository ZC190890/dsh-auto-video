const fs = require('node:fs');
const path = require('node:path');
const { hash, readJson } = require('./io');
const { parseModelJson } = require('./schema');

// Structured quality results. A cheap HTTP success, a decodable file or a few passing samples are not
// quality acceptance: every check returns a validated structure with evidence, severity, the exact time
// or frame it refers to, and an explicit scope for the smallest repair. "Cannot tell" is its own verdict,
// so it can neither pass silently nor burn a generation round.
const VERDICTS = ['pass', 'rework', 'undetermined'];
// Bumped whenever the review rules or the review result shape change: a stored verdict from an older
// rules version is stale by definition and must not be reused for new material.
const QUALITY_RULES_VERSION = 2;
const SEVERITIES = ['major', 'minor'];
const CATEGORIES = ['action', 'pose', 'prop', 'identity', 'continuity', 'interaction', 'camera', 'framing', 'artifact', 'text', 'other'];
const FIX_SCOPES = ['prompt', 'first', 'last', 'video', 'adjacent'];
const ISSUE_KEYS = ['category', 'severity', 'at', 'frameIndex', 'observed', 'expected', 'detail', 'fix'];
const MAX_TEXT = 600;

// Sampling is a declared time plan, not "a few frames": the times, the reading order and the coverage
// limit are recorded with the request and printed in the prompt. Count is capped at 3 so that
// target-first + samples + target-last stays within the adapter's 5-image limit.
function samplingPlan(duration, { count = 3 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('SAMPLING_REQUIRES_DURATION');
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('INVALID_SAMPLE_COUNT');
  const end = Number(Math.max(0.03, duration - 0.05).toFixed(3));
  const times = [];
  for (let index = 0; index < count; index++) {
    const ratio = count === 1 ? 1 : index / (count - 1);
    times.push(Number(Math.min(end, Math.max(0.03, 0.1 + (end - 0.1) * ratio)).toFixed(3)));
  }
  return { count, times, width: 512, height: 512,
    coverage: '抽帧只覆盖上述时刻；不能证明连续动作、肢体形变过程、口型或声音',
    note: '每张抽帧压缩到512像素用于检查，拼图会进一步降低可辨识度，因此不使用拼图，改用以时间标注排列的单帧' };
}
function textOf(value) { return typeof value === 'string' ? value.trim() : ''; }
function stringField(value, key) {
  const text = textOf(value);
  if (!text || text.length > MAX_TEXT) throw new Error('REVIEW_TEXT_INVALID:' + key);
  return text;
}
// The image order is stated so the model (and a human reading the record later) knows exactly what each
// picture is and when it was taken.
function orderLine(images) {
  return images.map((image, index) => '图' + (index + 1) + '=' + image.label).join('；');
}
function reviewSchemaPrompt() {
  return '只输出JSON：{"verdict":"pass或rework或undetermined","issues":[{"category":"' + CATEGORIES.join('或') +
    '","severity":"major或minor","at":视频秒数,"frameIndex":图序,"observed":"实际看到的内容","expected":"约束要求的状态",' +
    '"detail":"两者的差异","fix":"最小修改建议"}],"targetInvalid":true或false,"uncovered":["无法判断的部分"],' +
    '"fixScope":["prompt","first","last","video","adjacent"]}。';
}
function reviewRulesPrompt({ docFirst = false } = {}) {
  return '判定规则：只有可见证据支持的问题才能记为 major；审美偏好、轻微表情差异记 minor；看不清、证据不足或需要听音才能判断的写进 uncovered 并把 verdict 设为 undetermined，不要猜。' +
    'verdict=pass 时不得同时存在 major 问题或 uncovered 项。若首尾目标本身与约束矛盾或在该时长内不可实现，把 targetInvalid 设为 true 并在 fixScope 写 prompt（先修目标，不要求重做视频）。' +
    '相邻镜头之间只有同一场景、且后镜声明为承接时才比较；场景或时间切换不算错误。抽帧只能证明这些时刻，不能证明完整动作或口型。' +
    (docFirst ? '用户定稿文档是道具与动作的最高依据；参考图只约束身份、服饰与画风。' : '脚本是道具与动作的最高依据；参考图只约束身份、服饰与画风。');
}
function framesCheckPrompt({ shot, images, contract = '', docFirst = false }) {
  return '检查分镜首尾画面。' + orderLine(images) + '。检查严重可见的身份/服饰/道具错乱、破损多肢、动作起止与约束不符、文字水印。' +
    '不要因合理的镜头角度变化、轻微表情差异或历史剧情争议而要求返工。' + contract +
    '目标：' + JSON.stringify(shot) + '。' + reviewRulesPrompt({ docFirst }) + reviewSchemaPrompt();
}
function videoCheckPrompt({ shot, images, duration, contract = '', docFirst = false }) {
  return '检查视频质量。' + orderLine(images) + '。视频总长' + duration + '秒。' +
    '逐项对照：主动作是否发生并到达应有结束状态；是否有明显瞬移、滑步、肢体突变、道具或武器形变；持物是否无过程换手、消失或改变；接触、格挡、推拉等互动是否有可见依据；运镜是否与主体运动冲突。' +
    '合理停顿、静止对白、遮挡与透视变化不算错误。' + contract + '目标：' + JSON.stringify(shot) + '。' +
    reviewRulesPrompt({ docFirst }) + reviewSchemaPrompt();
}
function adjacentCheckPrompt({ pair, images, duration, docFirst = false }) {
  return '检查相邻两镜的衔接。' + orderLine(images) + '。前镜为' + pair.from + '（时长' + pair.fromDuration +
    '秒），后镜为' + pair.to + '（时长' + duration + '秒），后镜声明的承接：' + pair.handoff + '。' +
    '比较前镜实际结束状态与后镜实际开始状态：人物位置、朝向、持物、视线、动作阶段与运动方向是否被无依据地重置或跳变。' +
    '只有同一场景的相邻镜头才比较；场景或时间切换、合理切镜与景别变化不算错误。' + (docFirst ? '用户定稿文档决定剧情与道具。' : '脚本决定剧情与道具。') +
    '目标：' + JSON.stringify({ previous: pair.fromEndState, current: pair.toStartState }) + '。' +
    reviewRulesPrompt({ docFirst }) + reviewSchemaPrompt();
}

function normalizeIssue(issue, { duration, imageCount, sampledTimes = null, actualFrameIndexes = null }) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('REVIEW_ISSUE_SHAPE_INVALID');
  const unknown = Object.keys(issue).filter(key => !ISSUE_KEYS.includes(key));
  if (unknown.length) throw new Error('REVIEW_ISSUE_UNKNOWN_FIELD:' + unknown.join(','));
  if (!CATEGORIES.includes(issue.category)) throw new Error('REVIEW_CATEGORY_INVALID:' + issue.category);
  if (!SEVERITIES.includes(issue.severity)) throw new Error('REVIEW_SEVERITY_INVALID:' + issue.severity);
  const normalized = { category: issue.category, severity: issue.severity,
    observed: stringField(issue.observed, 'observed'), expected: textOf(issue.expected) || null,
    detail: textOf(issue.detail) || null, fix: textOf(issue.fix) || null, at: null, frameIndex: null };
  // A time or frame that does not exist in this clip is refused instead of being trusted.
  if (issue.at !== undefined && issue.at !== null) {
    if (duration === null) throw new Error('REVIEW_TIME_REQUIRES_DURATION');
    if (!Number.isFinite(issue.at) || issue.at < 0 || issue.at > duration + 0.05) throw new Error('REVIEW_TIME_OUT_OF_RANGE:' + issue.at);
    normalized.at = Number(issue.at);
  }
  if (issue.frameIndex !== undefined && issue.frameIndex !== null) {
    if (imageCount === null) throw new Error('REVIEW_FRAME_INDEX_REQUIRES_IMAGES');
    if (!Number.isInteger(issue.frameIndex) || issue.frameIndex < 1 || issue.frameIndex > imageCount)
      throw new Error('REVIEW_FRAME_INDEX_INVALID:' + issue.frameIndex);
    normalized.frameIndex = issue.frameIndex;
  }
  if (normalized.severity === 'major' && !normalized.fix) throw new Error('REVIEW_MAJOR_REQUIRES_FIX');
  // Time-based checks must point at the evidence that was actually supplied: a time that was never sampled
  // is not evidence, and a frame number must be one of the real sampled frames (not the target or a
  // reference image). When a time and a frame are both given they must agree.
  if (Array.isArray(sampledTimes) && sampledTimes.length) {
    if (normalized.at === null && normalized.frameIndex === null && normalized.severity === 'major')
      throw new Error('REVIEW_MAJOR_REQUIRES_LOCATION');
    if (normalized.at !== null && !sampledTimes.some(time => Math.abs(time - normalized.at) <= 0.2))
      throw new Error('REVIEW_TIME_NOT_SAMPLED:' + normalized.at);
    if (normalized.frameIndex !== null) {
      const frameTimes = Array.isArray(actualFrameIndexes) && actualFrameIndexes.length ? actualFrameIndexes : null;
      if (frameTimes && !frameTimes.includes(normalized.frameIndex))
        throw new Error('REVIEW_LOCATOR_NOT_VIDEO_FRAME:' + normalized.frameIndex);
      if (normalized.at !== null) {
        const index = frameTimes ? frameTimes.indexOf(normalized.frameIndex) : null;
        if (index !== null && Math.abs(sampledTimes[index] - normalized.at) > 0.2)
          throw new Error('REVIEW_LOCATOR_MISMATCH:' + normalized.frameIndex + ':' + normalized.at);
      }
    }
  }
  return normalized;
}
// The old shape (pass + plain strings) stays readable, but nothing is invented: severity defaults to
// major so an unverified failure still blocks, and no time or frame is claimed because none was given.
function legacyReview(value) {
  const issues = Array.isArray(value.issues) ? value.issues.filter(item => textOf(item)) : [];
  // The old shape has no severity, so any finding still blocks: an unverified "pass" with findings must
  // never be allowed through.
  const verdict = value.pass === true && !issues.length ? 'pass' : 'rework';
  return { verdict, pass: verdict === 'pass', legacy: true,
    corrected: value.pass === true && issues.length ? ['PASS_WITH_ISSUES'] : [], targetInvalid: false,
    issues: issues.map(item => ({ category: 'other', severity: 'major', observed: textOf(item), expected: null,
      detail: null, fix: null, at: null, frameIndex: null })),
    uncovered: value.degraded ? ['质检响应不完整（' + value.degraded + '），需人工查看实际画面'] : [],
    fixScope: verdict === 'pass' ? [] : ['video'], degraded: value.degraded || null };
}
function normalizeReview(value, { duration = null, imageCount = null, sampledTimes = null, actualFrameIndexes = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REVIEW_SHAPE_INVALID');
  if (value.verdict === undefined) {
    if (typeof value.pass === 'boolean') return legacyReview(value);
    throw new Error('REVIEW_SHAPE_INVALID');
  }
  if (!VERDICTS.includes(value.verdict)) throw new Error('REVIEW_VERDICT_INVALID:' + value.verdict);
  if (!Array.isArray(value.issues)) throw new Error('REVIEW_ISSUES_REQUIRED');
  const issues = value.issues.map(issue => normalizeIssue(issue, { duration, imageCount, sampledTimes, actualFrameIndexes }));
  const uncovered = (value.uncovered === undefined ? [] : value.uncovered);
  if (!Array.isArray(uncovered) || uncovered.some(item => !textOf(item))) throw new Error('REVIEW_UNCOVERED_INVALID');
  const fixScope = (value.fixScope === undefined ? [] : value.fixScope);
  if (!Array.isArray(fixScope) || fixScope.some(item => !FIX_SCOPES.includes(item))) throw new Error('REVIEW_FIX_SCOPE_INVALID');
  if (value.targetInvalid !== undefined && typeof value.targetInvalid !== 'boolean') throw new Error('REVIEW_TARGET_FLAG_INVALID');
  const targetInvalid = value.targetInvalid === true;
  const corrected = [];
  let verdict = value.verdict;
  // A pass that contradicts its own evidence is never allowed through.
  if (verdict === 'pass' && issues.some(issue => issue.severity === 'major')) { verdict = 'rework'; corrected.push('PASS_WITH_MAJOR_ISSUES'); }
  if (verdict === 'pass' && uncovered.length) { verdict = 'undetermined'; corrected.push('PASS_WITH_UNCOVERED'); }
  // Only small, cosmetic findings: recorded as observations, never as a paid redo.
  if (verdict === 'rework' && !issues.some(issue => issue.severity === 'major') && uncovered.length === 0) {
    verdict = 'pass'; corrected.push('MINOR_ONLY_NO_PAID_REDO');
  }
  if (verdict === 'undetermined' && !uncovered.length) throw new Error('REVIEW_UNDETERMINED_REQUIRES_UNCOVERED');
  if (verdict === 'rework' && !fixScope.length) throw new Error('REVIEW_FIX_SCOPE_REQUIRED');
  if (targetInvalid && !fixScope.includes('prompt')) throw new Error('REVIEW_TARGET_INVALID_REQUIRES_PROMPT_FIX');
  return { verdict, pass: verdict === 'pass', legacy: false, corrected, targetInvalid,
    issues, uncovered: uncovered.map(item => textOf(item)), fixScope, degraded: value.degraded || null };
}
// What a failed check actually means for the next step. Only a real, evidence-backed problem in the
// generated material spends a generation round; an unclear result and a wrong target do not.
function reworkDecision(report, { hasLastFrame = true } = {}) {
  if (report.targetInvalid)
    return { action: 'pause', code: 'TARGET_INVALID', consumesRound: false, fixScope: ['prompt'], unit: null,
      reason: '首尾目标本身不可实现或与约束矛盾：先修目标与约束，不重做视频' };
  if (report.verdict === 'undetermined')
    return { action: 'pause', code: 'UNDETERMINED', consumesRound: false, fixScope: report.fixScope, unit: null,
      reason: '证据不足或无法判断：交人工查看，不自动重做、也不当作通过' };
  const major = report.issues.filter(issue => issue.severity === 'major');
  if (report.verdict === 'pass' || !major.length)
    return { action: 'accept', code: 'PASS', consumesRound: false, fixScope: [], unit: null,
      observations: report.issues, reason: report.issues.length ? '仅有轻微差异或审美偏好，已记录不自动重做' : null };
  const scopes = new Set(report.fixScope.length ? report.fixScope : ['video']);
  const frames = scopes.has('first') || scopes.has('last') || (scopes.has('adjacent') && !hasLastFrame);
  // A problem that only lives in the wording of the target cannot be fixed by generating the same video
  // again: it is reported as a target/prompt fix that must be decided before any paid round.
  if (scopes.has('prompt') && !scopes.has('video') && !frames)
    return { action: 'pause', code: 'PROMPT_FIX_REQUIRED', consumesRound: false, fixScope: [...scopes], unit: null,
      reason: '问题在提示词或约束本身：先改约束/提示词，不直接重做视频' };
  if (frames && !scopes.has('video'))
    return { action: 'repair', code: scopes.has('adjacent') ? 'ADJACENT' : 'FRAMES', consumesRound: true,
      fixScope: [...scopes], unit: 'frames', issues: major, reason: '问题在首尾画面：只重做受影响的首尾帧' };
  return { action: 'repair', code: 'VIDEO', consumesRound: true, fixScope: [...scopes], unit: 'video', issues: major,
    reason: '视频本身有问题：按最小范围重做该镜头视频' };
}
// A repair instruction may only come from located, explicit model fixes. An unclear result, a wrong target
// or an empty suggestion is never turned into a generation request.
function repairInstruction(report) {
  if (!report || typeof report !== 'object') throw new Error('REPAIR_INSTRUCTION_REQUIRED');
  if (report.targetInvalid === true) throw new Error('REPAIR_INSTRUCTION_NOT_FOR_TARGET');
  if (report.verdict === 'undetermined') throw new Error('REPAIR_INSTRUCTION_NOT_FOR_UNDETERMINED');
  const fixes = (Array.isArray(report.issues) ? report.issues : [])
    .filter(issue => issue && typeof issue === 'object' && issue.severity === 'major' && textOf(issue.fix))
    .map(issue => textOf(issue.fix));
  const unique = [...new Set(fixes)];
  if (!unique.length) throw new Error('REPAIR_INSTRUCTION_REQUIRED');
  return unique.join('。');
}
// The binding a verdict is tied to. A different first frame, last frame, video, contract or rules version
// makes the stored verdict stale instead of silently reusable. `extra` carries the inputs of the special
// checks (for example both shots and both videos of an adjacent pair).
function reviewBinding({ shotId, revision = null, first = null, last = null, video = null, contract = null,
  promptVersion = null, promptHash = null, sampling = null, rules = QUALITY_RULES_VERSION, extra = null }) {
  const value = { shotId, revision, first, last, video, contract, promptVersion, promptHash, rules,
    sampling: sampling ? { count: sampling.count, times: sampling.times } : null, extra: extra || null };
  return { ...value, digest: hash(value) };
}
function reviewIsReusable(stored, binding) {
  return !!stored?.binding?.digest && !!binding?.digest && stored.binding.digest === binding.digest;
}
// A check that already succeeded is reused only when the current input is proven identical: an exact review
// binding when the request carried one, otherwise the material it was sent with, hash by hash. A verdict
// that cannot be proven to belong to the current input is never reused, and a reused verdict keeps its
// original provenance (operation, rule version, coverage) instead of being presented as a fresh review.
function readStoredReview(directory, id, { duration = null, imageCount = null, images = null, binding = null,
  rules = QUALITY_RULES_VERSION, sampledTimes = null, actualFrameIndexes = null } = {}) {
  const file = path.join(directory, 'operations', id + '.json');
  if (!fs.existsSync(file)) return null;
  let record;
  try { record = readJson(file); } catch { return null; }
  if (record?.status !== 'succeeded') return null;
  const spec = record.spec || {};
  const content = record.result?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const recordedBinding = typeof spec.review === 'string' ? spec.review : spec.review?.digest || null;
  let proof;
  if (binding) {
    if (!recordedBinding || recordedBinding !== binding.digest) return null;
    proof = 'binding';
  } else if (Array.isArray(images) && images.length) {
    const sent = Array.isArray(spec.images) ? spec.images : null;
    if (!sent || sent.length !== images.length || sent.some((value, index) => value !== images[index])) return null;
    proof = 'material';
  } else return null;
  let value;
  try { value = parseModelJson(content); } catch { return null; }
  // The same evidence rules as the first response: recovering from the cache must never relax the location
  // requirements, otherwise a response that was invalid when it arrived could enter the rework path later.
  let report;
  try { report = normalizeReview(value, { duration, imageCount, sampledTimes, actualFrameIndexes }); }
  catch { return null; }
  const protocol = value && typeof value === 'object' && value.verdict !== undefined ? 'structured' : 'legacy';
  const recordedRules = Number.isInteger(spec.review?.rules) ? spec.review.rules : (Number.isInteger(spec.rules) ? spec.rules : null);
  const rulesOlder = recordedRules !== null && recordedRules !== rules;
  const coverage = Array.isArray(spec.images) ? spec.images.length : null;
  return { report, spec, fingerprint: record.fingerprint || null, provenance: { operation: id, proof, protocol,
    binding: recordedBinding, rulesVersion: recordedRules, rulesOlder, coverage, images: coverage,
    note: [
      protocol === 'legacy' ? '旧协议记录：按原有覆盖边界（' + coverage + ' 张输入图）复用，未按新协议的定位要求重新判定' : null,
      rulesOlder ? '规则版本较旧（规则 ' + recordedRules + '→' + rules + '），材料输入一致' : null,
      proof === 'material' ? '旧操作没有绑定摘要：按输入哈希逐一核对后复用' : '绑定摘要一致，可直接复用'
    ].filter(Boolean).join('；') } };
}
// The raw record of one operation, used to decide whether an existing check may be resumed at all.
function operationRecord(directory, id) {
  const file = path.join(directory, 'operations', id + '.json');
  if (!fs.existsSync(file)) return null;
  try { const record = readJson(file); return { state: record, spec: record?.spec || null, fingerprint: record?.fingerprint || null }; }
  catch { return { state: null, spec: null, fingerprint: null, corrupt: true }; }
}
// Is the input this code is about to send different from the input the recorded request was made with?
// A record whose input cannot be compared is treated as different: never rebound, never renumbered silently.
function checkInputChanged(record, { prompt = null, images = null } = {}) {
  if (!record?.spec) return true;
  if (typeof prompt === 'string' && record.spec.prompt !== prompt) return true;
  if (Array.isArray(images)) {
    const sent = Array.isArray(record.spec.images) ? record.spec.images : null;
    if (!sent || sent.length !== images.length || sent.some((value, index) => value !== images[index])) return true;
  }
  return false;
}
// What a recorded check actually covered, so a pause can state the original boundary instead of hiding it.
function checkCoverage(record) {
  const spec = record?.spec || {};
  return { protocol: spec.review ? 'structured' : 'legacy', images: Array.isArray(spec.images) ? spec.images.length : null,
    rules: Number.isInteger(spec.review?.rules) ? spec.review.rules : (Number.isInteger(spec.rules) ? spec.rules : null),
    status: record?.state?.status || null };
}
// The prompt an existing operation was sent with. Reusing it keeps the input fingerprint unchanged, so a
// resumed task can never be re-sent with upgraded wording.
function recordedPrompt(directory, id, fallback) {
  const file = path.join(directory, 'operations', id + '.json');
  if (!fs.existsSync(file)) return fallback;
  try { const prompt = readJson(file)?.spec?.prompt; return typeof prompt === 'string' && prompt.trim() ? prompt : fallback; }
  catch { return fallback; }
}
// The shot object an existing video/plan operation was sent with (it is part of that request's
// fingerprint), so resuming never changes what that request was made from.
function recordedInput(directory, id, key, fallback) {
  const file = path.join(directory, 'operations', id + '.json');
  if (!fs.existsSync(file)) return fallback;
  try { const value = readJson(file)?.spec?.[key]; return value === undefined || value === null ? fallback : value; }
  catch { return fallback; }
}
// Coverage is compared with the images an older record was actually sent: a reused verdict is labelled
// with what it did NOT look at instead of being presented as a new, fuller check.
function coverageGap(spec, expectedLabels) {
  const sent = Array.isArray(spec?.images) ? spec.images.length : 0;
  if (!sent || sent >= expectedLabels.length) return null;
  return '复用了旧质检结果：当时只提供' + sent + '张图，本次方案为' + expectedLabels.length + '张，未覆盖的部分已记录';
}

module.exports = { CATEGORIES, FIX_SCOPES, ISSUE_KEYS, QUALITY_RULES_VERSION, SEVERITIES, VERDICTS, adjacentCheckPrompt,
  checkCoverage, checkInputChanged, coverageGap, framesCheckPrompt, legacyReview, normalizeReview, operationRecord,
  readStoredReview, recordedInput, recordedPrompt, repairInstruction, reviewBinding, reviewIsReusable,
  reviewRulesPrompt, reviewSchemaPrompt, reworkDecision, samplingPlan, videoCheckPrompt };

