const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adjacentCheckPrompt, framesCheckPrompt, normalizeReview, readStoredReview, repairInstruction,
  reviewBinding, reviewIsReusable, reworkDecision, samplingPlan, videoCheckPrompt } =
  require('../services/aliyun/quality');
const { hash, writeJson } = require('../services/aliyun/io');

const structured = (extra = {}) => ({ verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['video'],
  issues: [{ category: 'action', severity: 'major', at: 2.5, frameIndex: 3, observed: '第三张抽帧里剑仍在鞘内',
    expected: '结束状态要求剑已出鞘并指向左前方', detail: '结束状态没有到达', fix: '把出鞘动作延长到片尾并保持剑已出鞘' }], ...extra });

test('a structured verdict keeps evidence, severity, time and frame, and impossible values are refused', () => {
  const report = normalizeReview(structured(), { duration: 5, imageCount: 5 });
  assert.equal(report.verdict, 'rework');
  assert.equal(report.pass, false);
  assert.equal(report.issues[0].at, 2.5);
  assert.equal(report.issues[0].frameIndex, 3);
  assert.equal(report.issues[0].expected, '结束状态要求剑已出鞘并指向左前方');
  // A frame or a time that does not exist in this clip is refused instead of being trusted.
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], at: 9 }] }), { duration: 5, imageCount: 5 }),
    /REVIEW_TIME_OUT_OF_RANGE:9/);
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], frameIndex: 6 }] }), { duration: 5, imageCount: 5 }),
    /REVIEW_FRAME_INDEX_INVALID:6/);
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], at: 1 }] }), { imageCount: 5 }),
    /REVIEW_TIME_REQUIRES_DURATION/);
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], frameIndex: 1 }] }), { duration: 5 }),
    /REVIEW_FRAME_INDEX_REQUIRES_IMAGES/);
  // Malformed structures are refused rather than half-read.
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], mood: '兴奋' }] }), { duration: 5, imageCount: 5 }),
    /REVIEW_ISSUE_UNKNOWN_FIELD:mood/);
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], category: 'film-feel' }] }), { duration: 5, imageCount: 5 }),
    /REVIEW_CATEGORY_INVALID/);
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], severity: 'huge' }] }), { duration: 5, imageCount: 5 }),
    /REVIEW_SEVERITY_INVALID/);
  assert.throws(() => normalizeReview(structured({ issues: [{ ...structured().issues[0], fix: '' }] }), { duration: 5, imageCount: 5 }),
    /REVIEW_MAJOR_REQUIRES_FIX/);
  assert.throws(() => normalizeReview(structured({ verdict: 'maybe' }), { duration: 5, imageCount: 5 }), /REVIEW_VERDICT_INVALID/);
  assert.throws(() => normalizeReview(structured({ fixScope: ['cut-everything'] }), { duration: 5, imageCount: 5 }), /REVIEW_FIX_SCOPE_INVALID/);
  assert.throws(() => normalizeReview(structured({ verdict: 'undetermined', issues: [] }), { duration: 5, imageCount: 5 }),
    /REVIEW_UNDETERMINED_REQUIRES_UNCOVERED/);
  assert.throws(() => normalizeReview('不是对象', { duration: 5, imageCount: 5 }), /REVIEW_SHAPE_INVALID/);
  assert.throws(() => normalizeReview(structured({ issues: ['破损'] }), { duration: 5, imageCount: 5 }), /REVIEW_ISSUE_SHAPE_INVALID/);
});

test('a pass that contradicts its own findings is never allowed through', () => {
  const contradictory = normalizeReview(structured({ verdict: 'pass' }), { duration: 5, imageCount: 5 });
  assert.equal(contradictory.verdict, 'rework');
  assert.equal(contradictory.pass, false);
  assert.deepEqual(contradictory.corrected, ['PASS_WITH_MAJOR_ISSUES']);
  // A pass that admits it could not see the evidence is undetermined, not a pass.
  const blind = normalizeReview(structured({ verdict: 'pass', issues: [], uncovered: ['口型无法从抽帧判断'] }),
    { duration: 5, imageCount: 5 });
  assert.equal(blind.verdict, 'undetermined');
  assert.deepEqual(blind.corrected, ['PASS_WITH_UNCOVERED']);
  // Cosmetic findings alone are recorded as observations and never trigger a paid redo.
  const cosmetic = normalizeReview(structured({ issues: [{ category: 'framing', severity: 'minor', observed: '构图略偏' }] }),
    { duration: 5, imageCount: 5 });
  assert.equal(cosmetic.verdict, 'pass');
  assert.deepEqual(cosmetic.corrected, ['MINOR_ONLY_NO_PAID_REDO']);
  assert.equal(reworkDecision(cosmetic).action, 'accept');
  assert.equal(reworkDecision(cosmetic).consumesRound, false);
  // The old shape stays readable, and an unverified pass with findings still blocks.
  const legacyBad = normalizeReview({ pass: true, issues: ['画面破损'] });
  assert.equal(legacyBad.verdict, 'rework');
  assert.equal(legacyBad.pass, false);
  assert.equal(legacyBad.legacy, true);
  assert.equal(normalizeReview({ pass: true, issues: [] }).verdict, 'pass');
});

test('undetermined, a wrong target and a prompt-only problem never spend a generation round', () => {
  const undetermined = normalizeReview(structured({ verdict: 'undetermined', issues: [],
    uncovered: ['0.1秒的抽帧看不清是否换手'], fixScope: [] }), { duration: 5, imageCount: 5 });
  const undecided = reworkDecision(undetermined);
  assert.equal(undecided.action, 'pause');
  assert.equal(undecided.code, 'UNDETERMINED');
  assert.equal(undecided.consumesRound, false);
  const wrongTarget = reworkDecision(normalizeReview(structured({ targetInvalid: true, fixScope: ['prompt'] }),
    { duration: 5, imageCount: 5 }));
  assert.equal(wrongTarget.action, 'pause');
  assert.equal(wrongTarget.code, 'TARGET_INVALID');
  assert.equal(wrongTarget.consumesRound, false);
  assert.match(wrongTarget.reason, /先修目标/);
  const promptOnly = reworkDecision(normalizeReview(structured({ fixScope: ['prompt'] }), { duration: 5, imageCount: 5 }));
  assert.equal(promptOnly.action, 'pause');
  assert.equal(promptOnly.code, 'PROMPT_FIX_REQUIRED');
  assert.equal(promptOnly.consumesRound, false);
  // A frame-level problem repairs the frames, and only a video-level problem spends the video round.
  const frames = reworkDecision(normalizeReview(structured({ fixScope: ['first', 'last'] }), { duration: 5, imageCount: 5 }));
  assert.equal(frames.action, 'repair');
  assert.equal(frames.unit, 'frames');
  assert.equal(frames.consumesRound, true);
  const video = reworkDecision(normalizeReview(structured(), { duration: 5, imageCount: 5 }));
  assert.equal(video.unit, 'video');
  assert.equal(video.consumesRound, true);
});

test('the sampling plan is explicit, bounded by the image limit and printed with its reading order', () => {
  const plan = samplingPlan(5);
  assert.equal(plan.count, 3);
  assert.equal(plan.times.length, 3);
  assert.ok(plan.times.every(at => at > 0 && at <= 5));
  assert.deepEqual([...plan.times].sort((a, b) => a - b), plan.times);
  assert.ok(plan.times[2] <= 5 - 0.04);
  // target-first + samples + target-last must stay inside the adapter limit of five images.
  assert.ok(1 + plan.count + 1 <= 5);
  assert.match(plan.coverage, /不能证明连续动作/);

test('a major problem must be locatable in the sampled evidence, not merely plausible', () => {
  const base = { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['video'] };
  const issue = extra => ({ category: 'action', severity: 'major', observed: '第三张抽帧里剑仍在鞘内',
    fix: '把出鞘动作延长到片尾', ...extra });
  const plan = samplingPlan(5);
  const options = { duration: 5, imageCount: 5, sampledTimes: plan.times, actualFrameIndexes: [2, 3, 4] };
  // 有时间或图序才算可定位：两者都缺时不能驱动返工。
  assert.throws(() => normalizeReview({ ...base, issues: [issue({})] }, options), /REVIEW_MAJOR_REQUIRES_LOCATION/);
  // 未被抽到的时间不是证据。
  assert.throws(() => normalizeReview({ ...base, issues: [issue({ at: 3.2 })] }, options), /REVIEW_TIME_NOT_SAMPLED:3.2/);
  // 指向目标图或参考图的编号不是实际视频抽帧。
  assert.throws(() => normalizeReview({ ...base, issues: [issue({ frameIndex: 1 })] }, options), /REVIEW_LOCATOR_NOT_VIDEO_FRAME:1/);
  assert.throws(() => normalizeReview({ ...base, issues: [issue({ frameIndex: 5 })] }, options), /REVIEW_LOCATOR_NOT_VIDEO_FRAME:5/);
  // 时间与图序必须互相吻合：都落在已抽到的时点上，但指向不同的抽帧时必须拒绝。
  assert.throws(() => normalizeReview({ ...base, issues: [issue({ frameIndex: 3, at: 0.1 })] }, options), /REVIEW_LOCATOR_MISMATCH:3:0.1/);
  assert.throws(() => normalizeReview({ ...base, issues: [issue({ frameIndex: 2, at: 4.95 })] }, options), /REVIEW_LOCATOR_MISMATCH:2:4.95/);
  const located = normalizeReview({ ...base, issues: [issue({ frameIndex: 3, at: plan.times[1] })] }, options);
  assert.equal(located.verdict, 'rework');
  assert.equal(located.issues[0].frameIndex, 3);
  assert.equal(located.issues[0].at, plan.times[1]);
  // 轻微差异不需要定位，也不会触发付费返工。
  const cosmetic = normalizeReview({ verdict: 'pass', targetInvalid: false, uncovered: [], fixScope: [],
    issues: [{ category: 'framing', severity: 'minor', observed: '构图略偏' }] }, options);
  assert.equal(cosmetic.verdict, 'pass');
  // 首尾帧检查没有实际视频抽帧：调用方不声明实际抽帧时，图序只是图内编号，不按"实际抽帧"校验。
  assert.equal(normalizeReview({ ...base, issues: [issue({ frameIndex: 1 })] },
    { duration: 2, imageCount: 2, sampledTimes: [], actualFrameIndexes: [] }).verdict, 'rework');
  assert.equal(normalizeReview({ ...base, issues: [issue({})] },
    { duration: 2, imageCount: 2 }).verdict, 'rework');
});

test('a repair instruction only comes from located, explicit model fixes', () => {
  const located = { category: 'action', severity: 'major', observed: '剑仍在鞘内', fix: '把出鞘动作延长到片尾', at: 2.5, frameIndex: 3 };
  assert.equal(repairInstruction({ issues: [located, { ...located }] }), '把出鞘动作延长到片尾');
  assert.match(repairInstruction({ issues: [located, { ...located, fix: '保持剑已出鞘' }] }), /把出鞘动作延长到片尾。保持剑已出鞘/);
  // 没有可执行的修复建议时不允许被转换成一个新的生成请求。
  assert.throws(() => repairInstruction({ issues: [] }), /REPAIR_INSTRUCTION_REQUIRED/);
  assert.throws(() => repairInstruction({ issues: [{ ...located, severity: 'minor' }] }), /REPAIR_INSTRUCTION_REQUIRED/);
  assert.throws(() => repairInstruction({ issues: [{ ...located, fix: '' }] }), /REPAIR_INSTRUCTION_REQUIRED/);
  assert.throws(() => repairInstruction({ issues: [{ ...located, fix: null }] }), /REPAIR_INSTRUCTION_REQUIRED/);
  assert.throws(() => repairInstruction(null), /REPAIR_INSTRUCTION_REQUIRED/);
  assert.throws(() => repairInstruction({ issues: ['破损'] }), /REPAIR_INSTRUCTION_REQUIRED/);
  // 目标本身不合理或无法判断时，不能当作画面返工指令。
  assert.throws(() => repairInstruction({ targetInvalid: true, issues: [located] }), /REPAIR_INSTRUCTION_NOT_FOR_TARGET/);
  assert.throws(() => repairInstruction({ verdict: 'undetermined', issues: [located] }), /REPAIR_INSTRUCTION_NOT_FOR_UNDETERMINED/);
});

  assert.match(plan.note, /不使用拼图/);
  assert.throws(() => samplingPlan(5, { count: 5 }), /INVALID_SAMPLE_COUNT/);
  assert.throws(() => samplingPlan(0), /SAMPLING_REQUIRES_DURATION/);
  const labels = [{ label: '目标首帧' }, ...plan.times.map(at => ({ label: '视频' + at + '秒抽帧' })), { label: '目标尾帧' }];

test('a stored verdict is only reused when the current input is proven identical', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-review-'));
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  const binding = extra => reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v1',
    contract: 'c1', promptVersion: 1, sampling: samplingPlan(5), ...extra });
  writeJson(path.join(directory, 'operations', 'video-check-a-r0.json'), { id: 'video-check-a-r0', status: 'succeeded',
    fingerprint: 'x', spec: { prompt: '旧提示词', images: ['h1', 'h2'], review: binding({}).digest, rules: 1 },
    result: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ pass: true, issues: [] }) } }] } });
  // 同一绑定：可复用，并保留原始来源与当时的规则版本。
  const same = readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 2, binding: binding({}), rules: 1 });
  assert.equal(same.report.verdict, 'pass');
  assert.equal(same.provenance.operation, 'video-check-a-r0');
  assert.equal(same.provenance.rulesVersion, 1);
  assert.equal(same.provenance.rulesOlder, false);
  // 材料、契约或视频任一不同：不得复用，旧通过结论不能被重新绑定后放行。
  assert.equal(readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 2, binding: binding({ video: 'v2' }) }), null);
  assert.equal(readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 2, binding: binding({ contract: 'c2' }) }), null);
  // 规则版本较旧：材料一致仍可复用，但必须标注规则较旧与覆盖边界。
  const older = readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 3, binding: binding({}), rules: 9 });
  assert.equal(older.provenance.rulesOlder, true);
  assert.equal(older.provenance.rulesVersion, 1);
  assert.match(older.provenance.note, /规则/);
  // 完全没有绑定记录的旧操作：只有输入哈希逐一相同才允许复用，并标注它按输入核对。
  writeJson(path.join(directory, 'operations', 'frame-check-b-r0.json'), { id: 'frame-check-b-r0', status: 'succeeded',
    fingerprint: 'y', spec: { prompt: '更旧的提示词', images: ['h1', 'h2'] },
    result: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ pass: true, issues: [] }) } }] } });
  assert.equal(readStoredReview(directory, 'frame-check-b-r0', { duration: 2, imageCount: 2, images: ['h9', 'h2'] }), null);
  assert.equal(readStoredReview(directory, 'frame-check-b-r0', { duration: 2, imageCount: 2 }), null);
  const material = readStoredReview(directory, 'frame-check-b-r0', { duration: 2, imageCount: 2, images: ['h1', 'h2'] });
  assert.equal(material.report.verdict, 'pass');
  assert.equal(material.provenance.binding, null);
  assert.match(material.provenance.note, /输入/);
  fs.rmSync(directory, { recursive: true });
});

test('a cached response is validated exactly as strictly as the first response', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cached-strict-'));
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  const plan = samplingPlan(5);
  const binding = reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v1', contract: 'c1',
    promptVersion: 1, sampling: plan });
  const options = { duration: 5, imageCount: 5, sampledTimes: plan.times, actualFrameIndexes: [2, 3, 4] };
  const evidence = { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['video'],
    issues: [{ category: 'action', severity: 'major', at: 3.2, frameIndex: 3, observed: '剑仍在鞘内', fix: '延长出鞘动作' }] };
  // 首次响应就会拒绝这条证据（3.2 秒不是抽到的时点）。
  assert.throws(() => normalizeReview(evidence, options), /REVIEW_TIME_NOT_SAMPLED:3.2/);
  writeJson(path.join(directory, 'operations', 'video-check-a-r0.json'), { id: 'video-check-a-r0', status: 'succeeded',
    fingerprint: 'x', spec: { prompt: 'p', images: ['a', 'b', 'c', 'd', 'e'], review: { digest: binding.digest, rules: 2 } },
    result: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(evidence) } }] } });
  // 从缓存恢复必须同样拒绝，不能因为读缓存就放宽定位规则。
  assert.equal(readStoredReview(directory, 'video-check-a-r0', { ...options, binding }), null);
  // 旧协议记录按原覆盖边界复用：标记 legacy 与覆盖张数，不假装满足新协议的定位要求。
  writeJson(path.join(directory, 'operations', 'frame-check-b-r0.json'), { id: 'frame-check-b-r0', status: 'succeeded',
    fingerprint: 'y', spec: { prompt: '更旧的提示词', images: ['h1', 'h2', 'h3'] },
    result: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ pass: true, issues: [] }) } }] } });
  const legacy = readStoredReview(directory, 'frame-check-b-r0', { duration: 2, imageCount: 3, images: ['h1', 'h2', 'h3'] });
  assert.equal(legacy.report.legacy, true);
  assert.equal(legacy.provenance.protocol, 'legacy');
  assert.equal(legacy.provenance.coverage, 3);
  assert.match(legacy.provenance.note, /旧协议记录/);
  // 输入不同则任何协议下都不得复用。
  assert.equal(readStoredReview(directory, 'frame-check-b-r0', { duration: 2, imageCount: 3, images: ['h1', 'h2', 'h9'] }), null);
  fs.rmSync(directory, { recursive: true });
});

test('the adjacent check binding covers both shots, both videos, both contracts, the times and the rules', () => {
  const make = extra => reviewBinding({ shotId: 'b', revision: 0, first: 'prevTargetLast', last: 'curActualStart',
    video: 'curVideo', contract: 'contractB', promptVersion: 1, sampling: { count: 2, times: [0.03, 4.9] },
    extra: { kind: 'adjacent', from: 'a', fromRevision: 0, adjacentVideo: 'prevVideo', adjacentContract: 'contractA',
      adjacentSampling: [0.03, 4.9], ...extra } });
  const base = make({});
  assert.equal(reviewIsReusable({ binding: base }, make({})), true);
  // 只改变前镜实际视频也必须让相邻检查失效。
  assert.equal(reviewIsReusable({ binding: base }, make({ adjacentVideo: 'prevVideo2' })), false);
  assert.equal(reviewIsReusable({ binding: base }, make({ video: 'curVideo2' })), false);
  assert.equal(reviewIsReusable({ binding: base }, make({ adjacentContract: 'contractA2' })), false);
  assert.equal(reviewIsReusable({ binding: base }, make({ first: 'otherTarget' })), false);
  assert.equal(reviewIsReusable({ binding: base }, make({ from: 'a2' })), false);
  assert.equal(reviewIsReusable({ binding: base }, make({ sampling: { count: 2, times: [0.03, 2.5] } })), false);
  assert.equal(reviewIsReusable({ binding: base }, reviewBinding({ shotId: 'b', revision: 0, first: 'prevTargetLast',
    last: 'curActualStart', video: 'curVideo', contract: 'contractB', promptVersion: 1,
    sampling: { count: 2, times: [0.03, 4.9] }, rules: 99,
    extra: { kind: 'adjacent', from: 'a', fromRevision: 0, adjacentVideo: 'prevVideo', adjacentContract: 'contractA',
      adjacentSampling: [0.03, 4.9] } })), false);
});

  const prompt = videoCheckPrompt({ shot: { id: 'a', scene: '府衙', action: '拔剑' }, images: labels, duration: 5,
    contract: '约束文本', docFirst: true });
  assert.ok(prompt.includes('图1=目标首帧'));
  assert.ok(prompt.includes('图5=目标尾帧'));
  assert.ok(prompt.includes(String(plan.times[1])));
  assert.ok(prompt.includes('瞬移'), '视频检查必须问可见的瞬移、滑步与形变，而不是只问是否自然');
  assert.ok(framesCheckPrompt({ shot: { id: 'a' }, images: labels.slice(0, 2), contract: '', docFirst: false }).includes('图1=目标首帧'));
  assert.ok(adjacentCheckPrompt({ pair: { from: 'a', to: 'b', handoff: '承接站位', fromEndState: '站立', toStartState: '半蹲' },
    images: [{ label: '前镜实际结束' }, { label: '后镜实际开始' }], duration: 5, docFirst: false }).includes('场景或时间切换'));
});

