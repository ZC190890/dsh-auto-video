const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authorityPrompt, contractDigest, contractOf, contractPrompt, declaredPairs, hasContract,
  planContinuity, validateContract, validateScriptPlan } = require('../workflows/shot-contract');
const { coverageGap, framesCheckPrompt, normalizeReview, readStoredReview, recordedPrompt, reviewBinding,
  reviewIsReusable, reworkDecision, samplingPlan, videoCheckPrompt } = require('../services/aliyun/quality');
const { writeJson } = require('../services/aliyun/io');

// The contract is model-authored text: these tests only check the structure, the declared hand-off and the
// fact that one single wording reaches generation and both checks.
const contractShot = (id, extra = {}) => ({ id, duration: 5,
  startState: '站在府衙台阶前，右手按剑柄，身体朝向左侧', endState: '半蹲稳住重心，剑指向左前方的士兵',
  primaryAction: '拔剑并指向左前方', beats: ['起势：右脚后撤，右手握紧剑柄', '接触：拔剑出鞘指向左前方'],
  cut: 'continuous', handoff: '承接上一镜的站位、视线方向与右手持剑状态', ...extra });
const legacyShot = (id, extra = {}) => ({ id, duration: 5, ...extra });

test('a declared action contract is accepted while a half-filled one is refused', () => {
  assert.equal(hasContract(legacyShot('a')), false);
  assert.equal(contractOf(legacyShot('a')), null);
  const outcome = validateContract(contractShot('a'));
  assert.equal(outcome.mode, 'contract');
  assert.equal(outcome.contract.beats.length, 2);
  // A partially migrated shot is refused instead of being half-checked.
  assert.throws(() => validateContract({ ...contractShot('a'), handoff: '' }), /SHOT_CONTRACT_INCOMPLETE:a:handoff/);
  assert.throws(() => validateContract({ id: 'a', startState: '只填了一个字段' }), /SHOT_CONTRACT_INCOMPLETE:a/);
  // One primary action per short shot: three beats inside a two-second shot is refused.
  assert.throws(() => validateContract(contractShot('a', { duration: 2, beats: ['起势', '接触', '收势'] }),
    { duration: 2 }), /CONTRACT_TOO_MANY_BEATS_FOR_DURATION/);
});

test('same-scene neighbours must declare a continuation, and a scene or time change must not claim one', () => {
  const first = contractShot('a');
  validateContract(contractShot('b'), { duration: 5, sceneId: 'doc02', previousSceneId: 'doc02', previous: first });
  assert.throws(() => validateContract(contractShot('b', { cut: 'scene' }),
    { duration: 5, sceneId: 'doc02', previousSceneId: 'doc02', previous: first }), /CONTRACT_SAME_SCENE_MUST_CONTINUE/);
  // A different scene is allowed, but it may not pretend to continue the previous shot.
  assert.throws(() => validateContract(contractShot('b'),
    { duration: 5, sceneId: 'doc03', previousSceneId: 'doc02', previous: first }), /CONTRACT_CUT_CLAIMS_CONTINUITY_ACROSS_SCENE/);
  validateContract(contractShot('b', { cut: 'time' }), { duration: 5, sceneId: 'doc03', previousSceneId: 'doc02', previous: first });
});

test('a scene change or a time jump is recorded as an allowed gap, never as broken continuity', () => {
  const shots = [contractShot('a'), contractShot('b', { cut: 'scene' }), contractShot('c', { cut: 'time' })];
  const continuity = planContinuity(shots, shot => (shot.id === 'a' ? 'doc01' : shot.id === 'b' ? 'doc02' : 'doc03'));
  assert.equal(continuity.mode, 'contract');
  assert.deepEqual(continuity.pairs, []);
  assert.deepEqual(continuity.gaps.map(gap => gap.reason), ['FIRST_SHOT', 'ALLOWED_SCENE_CUT', 'ALLOWED_TIME_CUT']);
  // The same scene with a declared continuation produces exactly one checkable pair with its hand-off.
  const sameScene = planContinuity([contractShot('a'), contractShot('b')], () => 'doc01');
  assert.equal(sameScene.pairs.length, 1);
  assert.equal(sameScene.pairs[0].handoff, '承接上一镜的站位、视线方向与右手持剑状态');
  assert.equal(sameScene.pairs[0].fromEndState, '半蹲稳住重心，剑指向左前方的士兵');
});

test('the script path follows the declaration itself and a legacy script is never forced into continuity', () => {
  const plan = validateScriptPlan([contractShot('shot01'), contractShot('shot02')]);
  assert.equal(plan.mode, 'contract');
  assert.equal(plan.pairs.length, 1);
  const legacy = validateScriptPlan([legacyShot('shot01'), legacyShot('shot02')]);
  assert.equal(legacy.mode, 'legacy');
  assert.deepEqual(legacy.pairs, []);
  assert.ok(legacy.gaps.every(gap => gap.reason === 'CONTRACT_MISSING' || gap.reason === 'FIRST_SHOT'));
  assert.equal(declaredPairs([contractShot('a'), contractShot('b', { cut: 'time' })]).pairs.length, 0);
  assert.throws(() => validateScriptPlan([legacyShot('a'), { ...contractShot('b'), beats: [] }]), /SCRIPT_CONTRACT_INVALID/);
});

test('generation and both checks share one authority rule and one contract wording', () => {
  const shot = contractShot('a');
  const generation = contractPrompt(shot, { docFirst: true });
  const frames = framesCheckPrompt({ shot, images: [{ label: '目标首帧' }, { label: '目标尾帧' }], contract: generation, docFirst: true });
  const video = videoCheckPrompt({ shot, images: [{ label: '目标首帧' }, { label: '视频0.1秒抽帧' }, { label: '目标尾帧' }],
    duration: 5, contract: generation, docFirst: true });
  const authority = authorityPrompt({ docFirst: true });
  for (const text of [generation, frames, video]) {
    assert.ok(text.includes(authority), '每处提示词都必须使用同一条依据优先级');
    assert.ok(text.includes('起始状态：站在府衙台阶前'), '同一份动作约束必须同时进入生成与审核');
    assert.ok(text.includes('结束状态：半蹲稳住重心'));
  }
  // The user document wins for props and actions, so a reference weapon can no longer be demanded at the
  // same time: that contradiction is exactly what the shared rule removes.
  assert.ok(authority.includes('参考图只约束身份、脸型、服饰与画风'));
  assert.ok(!generation.includes('保持参考身份、脸型、服饰和武器'));
  assert.equal(contractPrompt(legacyShot('a'), { docFirst: true }), '');
});

test('one contract digest drives the image, video and review bindings, and a change invalidates them', () => {
  const shot = contractShot('a');
  const digest = contractDigest(shot, 1);
  assert.equal(digest, contractDigest(contractShot('a'), 1));
  assert.notEqual(digest, contractDigest(contractShot('a', { endState: '另一个结束状态' }), 1));
  assert.equal(contractDigest(legacyShot('a'), 1), null);
  const binding = reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v1', contract: digest,
    promptVersion: 1, sampling: samplingPlan(5) });
  const same = () => reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v1', contract: digest,
    promptVersion: 1, sampling: samplingPlan(5) });
  assert.equal(reviewIsReusable({ binding }, same()), true);
  assert.equal(reviewIsReusable({ binding }, reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v2',
    contract: digest, promptVersion: 1, sampling: samplingPlan(5) })), false);
  assert.equal(reviewIsReusable({ binding }, reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v1',
    contract: contractDigest(contractShot('a', { startState: '改过的起始状态' }), 1), promptVersion: 1,
    sampling: samplingPlan(5) })), false);
  assert.equal(reviewIsReusable({ binding }, reviewBinding({ shotId: 'a', revision: 0, first: 'f1', last: 'l1', video: 'v1',
    contract: digest, promptVersion: 1, rules: 99, sampling: samplingPlan(5) })), false);
});

test('an existing operation keeps the prompt and the result it was sent with', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-reuse-'));
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  writeJson(path.join(directory, 'operations', 'video-check-a-r0.json'), { id: 'video-check-a-r0', status: 'succeeded',
    fingerprint: 'x', spec: { prompt: '旧提示词：图1目标首帧，其后4张抽帧。', images: ['h1', 'h2', 'h3', 'h4'] },
    result: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ pass: true, issues: [] }) } }] } });
  writeJson(path.join(directory, 'operations', 'video-check-b-r0.json'), { id: 'video-check-b-r0', status: 'succeeded',
    fingerprint: 'y', spec: { prompt: '旧提示词B', images: ['h1'] },
    result: { choices: [{ finish_reason: 'stop', message: { content: '不是JSON' } }] } });
  assert.equal(recordedPrompt(directory, 'video-check-a-r0', '升级后的提示词'), '旧提示词：图1目标首帧，其后4张抽帧。');
  assert.equal(recordedPrompt(directory, 'video-check-b-r0', '升级后的提示词'), '旧提示词B');
  assert.equal(recordedPrompt(directory, 'video-check-c-r0', '升级后的提示词'), '升级后的提示词');
  const stored = readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 4, images: ['h1', 'h2', 'h3', 'h4'] });
  assert.equal(stored.report.verdict, 'pass');
  assert.equal(stored.report.legacy, true);
  assert.equal(stored.provenance.proof, 'material');
  // 只给了图片哈希但数量不同：不能复用。
  assert.equal(readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 4, images: ['h1', 'h2'] }), null);
  assert.equal(readStoredReview(directory, 'video-check-a-r0', { duration: 5, imageCount: 4 }), null);
  // A record that is not valid JSON is never reused, so the new standard applies instead of a guess.
  assert.equal(readStoredReview(directory, 'video-check-b-r0', { duration: 5, imageCount: 1 }), null);
  // A reused verdict states what it did not look at instead of pretending to be a fuller check.
  assert.match(coverageGap(stored.spec, [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }]),
    /旧质检结果.*5张/);
  assert.equal(coverageGap(stored.spec, [{ label: 'a' }]), null);
  fs.rmSync(directory, { recursive: true });
});
