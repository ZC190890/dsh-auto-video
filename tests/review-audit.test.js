const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Models } = require('../services/aliyun/models');
const { readJson, writeJson, hash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { reviewInputDigest, reviewScript } = require('../workflows/planner');
const ROOT = path.resolve(__dirname, '..');

// Distinct markers per field, so the test can prove which production data really reached the request.
const SCRIPT = { title: '独立审核测试', shots: [
  { id: 'shot01', type: 'narration', characters: ['character01'], speaker: 'character01', text: '第一句台词',
    emotion: 'EMOTION-MARK-01', scene: 'SCENE-MARK-01', action: 'ACTION-MARK-01', endScene: 'END-MARK-01',
    videoScene: 'VIDEOSCENE-MARK-01', videoAction: 'VIDEOACTION-MARK-01', speechRate: 1.1, speechLeadSeconds: 0.4,
    needsLastFrame: true, duration: 5 },
  { id: 'shot02', type: 'action', characters: ['character01'], speaker: null, text: '', emotion: '',
    scene: 'SCENE-MARK-02', action: 'ACTION-MARK-02', endScene: 'END-MARK-02', needsLastFrame: true, duration: 5 } ] };
const GOOD = { verdict: 'pass', summary: '上下文连贯，时长在范围内', contextIssues: [], durationIssues: [],
  estimatedDurationSeconds: 10, longShots: [], advice: null };

function fixture({ promptVersion = 1 } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'review-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: 'qwen3.8-omni-flash', promptVersion, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'config/project.json'), readJson(path.join(ROOT, 'config/project.json')));
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'review-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const production = { id: 'review-film', description: '独立审核隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image: 'hero.png', voiceSample: 'voice.wav', traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  const directory = path.join(root, 'jobs', 'aliyun', 'review-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'review-film', characters: {},
    approvals: {}, assets: {}, revisions: {}, script: structuredClone(SCRIPT), stage: 'script' });
  const context = loadContext(root, 'production.json');
  return { root, directory, config, context, script: structuredClone(SCRIPT),
    stateFile: path.join(directory, 'state.json') };
}
// Provider stand-in: records the request it was asked to build, then answers with the given payload.
function fakeOps(payload = GOOD) {
  const calls = [];
  return { calls, execute: async (id, spec, build) => {
    const body = await build();
    calls.push({ id, spec, body, prompt: JSON.stringify(body.messages || []) });
    if (payload instanceof Error) throw payload;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 900 } };
  } };
}
function modelsFor(f, ops) { return new Models(f.config, ops, null, path.join(f.root, 'vision-cache')); }

test('the review request carries the real scene, action, start and end state of every shot', async () => {
  const f = fixture(), ops = fakeOps();
  const review = await reviewScript(f.context, { models: modelsFor(f, ops), state: readJson(f.stateFile), log: () => {} });
  assert.equal(ops.calls.length, 1);
  const { prompt, id, spec } = ops.calls[0];
  for (const marker of ['SCENE-MARK-01', 'ACTION-MARK-01', 'END-MARK-01', 'VIDEOSCENE-MARK-01', 'VIDEOACTION-MARK-01',
    'EMOTION-MARK-01', 'SCENE-MARK-02', 'ACTION-MARK-02', 'END-MARK-02', 'character01'])
    assert.match(prompt, new RegExp(marker), '评测请求缺少 ' + marker);
  assert.match(prompt, /1\.1/);                                  // the local speech rate reached the request
  assert.match(prompt, /0\.4/);                                  // as did the lead-in seconds
  assert.equal(spec.kind, 'planner');
  assert.equal(spec.cents, 20);                                  // the configured reservation, not a claimed price
  assert.equal(id, 'plan-script-review-' + review.reviewInputDigest.slice(0, 12));
  assert.equal(id, 'plan-script-review-' + reviewInputDigest(f.context.production, undefined, f.script, 1).slice(0, 12));
  assert.equal(review.verdict, 'pass');
});

test('a changed action or a changed prompt version makes the previous review unusable', async () => {
  const f = fixture({ promptVersion: 1 }), ops = fakeOps();
  const first = await reviewScript(f.context, { models: modelsFor(f, ops), state: readJson(f.stateFile), log: () => {} });
  const moved = structuredClone(f.script);
  moved.shots[1].action = 'ACTION-MARK-02-改';
  assert.notEqual(reviewInputDigest(f.context.production, undefined, moved, 1), first.reviewInputDigest);
  const second = await reviewScript(f.context, { models: modelsFor(f, ops),
    state: { ...readJson(f.stateFile), script: moved }, log: () => {} });
  assert.match(ops.calls[1].prompt, /ACTION-MARK-02-改/);        // the new action is in the new request
  assert.notEqual(ops.calls[1].id, ops.calls[0].id);             // a new operation, so no verdict is reused
  assert.notEqual(second.reviewInputDigest, first.reviewInputDigest);
  // The prompt version is part of the digest, so rewording the review prompt invalidates old verdicts.
  const bumped = fixture({ promptVersion: 2 });
  const third = await reviewScript(bumped.context, { models: modelsFor(bumped, ops),
    state: readJson(bumped.stateFile), log: () => {} });
  assert.equal(third.promptVersion, 2);
  assert.notEqual(third.reviewInputDigest, first.reviewInputDigest);
  assert.notEqual(ops.calls[2].id, ops.calls[0].id);
  assert.equal(ops.calls[2].spec.promptVersion, 2);
});

test('an incomplete or invented review result can never advance the flow', async () => {
  const f = fixture();
  const cases = [
    { payload: { ...GOOD, verdict: 'approved' }, name: 'verdict outside the allowed set' },
    { payload: { ...GOOD, longShots: ['shot99'] }, name: 'a shot id that does not exist' },
    { payload: { ...GOOD, longShots: 'shot01' }, name: 'a non-array longShots' },
    { payload: { ...GOOD, contextIssues: [1] }, name: 'a non-string issue entry' },
    { payload: { ...GOOD, estimatedDurationSeconds: 0 }, name: 'a duration that is not positive' },
    { payload: { ...GOOD, advice: 42 }, name: 'an advice that is not text' },
    { payload: { verdict: 'pass' }, name: 'a missing summary' }];
  for (const { payload, name } of cases) {
    const before = hash(readJson(f.stateFile));
    await assert.rejects(reviewScript(f.context, { models: modelsFor(f, fakeOps(payload)),
      state: readJson(f.stateFile), log: () => {} }), /SCRIPT_REVIEW_SHAPE_INVALID/, name);
    assert.equal(hash(readJson(f.stateFile)), before, name);     // no verdict was recorded
  }
  // A provider failure is surfaced as a failure, never as an approval.
  await assert.rejects(reviewScript(f.context, { models: modelsFor(f, fakeOps(new Error('timeout'))),
    state: readJson(f.stateFile), log: () => {} }), /timeout/);
});
