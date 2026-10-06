const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { Models } = require('../services/aliyun/models');
const { UnitAttempts, GENERATIONS_PER_UNIT, REWORK_LIMIT, unitForOperation } = require('../services/aliyun/units');
const { readJson, writeJson, hash } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

// "First generation plus at most 3 reworks" must not be confused with "the 4th result is unusable". Every
// assertion runs through the production entry points (Operations.execute / Models / the shared preflight)
// against a mock provider, so the counters alone can never make the test green.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'round4-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'round4-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 50 });
  const directory = path.join(root, 'jobs', 'aliyun', 'round4-film');
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  const ref = path.join(root, 'ref.png'); fs.writeFileSync(ref, 'reference-image');
  const client = mockClient();
  const budget = new Budget(root, config, directory);
  const attempts = new UnitAttempts(directory);
  const ops = new Operations(path.join(directory, 'operations'), client, budget, () => {}, 0, 0, attempts);
  const media = { visionImage: file => file, image: file => ({ hash: hash(file), width: 1, height: 1 }),
    audio: () => ({ duration: 1 }), normalizeAudio: source => source, command: () => {} };
  const models = new Models(config, ops, media, path.join(directory, 'vision-cache'));
  return { root, directory, config, client, budget, attempts, ops, models, ref,
    directoryOps: path.join(directory, 'operations'), ledger: path.join(directory, 'api-ledger.json'),
    out: name => path.join(directory, 'out', name) };
}
function mockClient() {
  const state = { posts: [], queries: [], downloads: [] };
  const url = index => 'https://example.invalid/media-' + index + '.bin';
  return { state,
    request: async (endpoint, body) => {
      const index = state.posts.push({ endpoint, model: body?.model || null });
      if (endpoint.includes('video-synthesis'))
        return { request_id: 'req-' + index, output: { task_id: 'task-' + index, task_status: 'PENDING' } };
      return { request_id: 'req-' + index, output: { choices: [{ message: { content: [{ image: url(index) }] } }] } };
    },
    task: async taskId => { state.queries.push(taskId);
      return { request_id: 'query-' + state.queries.length, output: { task_id: taskId, task_status: 'SUCCEEDED',
        video_url: url(900 + state.queries.length) } }; },
    download: async (source, destination) => { state.downloads.push(source);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'media:' + source); }
  };
}
const four = async (f, prefix) => {
  for (const id of [prefix + '-r0', prefix + '-r1', prefix + '-r2', prefix + '-r3'])
    await f.models.image(id, 'p', [f.ref], f.out(id + '.png'));
};
const stateOf = (f, units) => writeJson(path.join(f.directory, 'unit-attempts.json'), { version: 1, units });

test('the fourth successful round is recorded as no rounds left, never as a failure, and stays readable', async () => {
  const f = fixture();
  await four(f, 'first-shot01');
  assert.equal(f.client.state.posts.length, 4);
  const round = f.attempts.status('first-shot01');
  assert.equal(round.generations, GENERATIONS_PER_UNIT);
  assert.equal(round.remainingReworks, 0);
  assert.equal(round.hasRoundsLeft, false);
  assert.equal(round.exhausted, null, '用完轮次不等于暂停或失败');
  assert.ok(round.limitReached, '必须准确记为已无剩余返工机会');
  assert.deepEqual(f.attempts.summary().filter(r => r.exhausted), [], 'pausedUnits 不能包含已成功的第4轮');
  assert.equal(f.attempts.summary().filter(r => !r.hasRoundsLeft && !r.exhausted).length, 1);
  const again = await f.models.image('first-shot01-r3', 'p', [f.ref], f.out('again.png'));
  assert.ok(again);
  assert.equal(f.client.state.posts.length, 4);
  assert.equal(f.attempts.status('first-shot01').generations, GENERATIONS_PER_UNIT);
});

test('an accepted fourth async round keeps querying, downloading and flowing downstream', async () => {
  const f = fixture();
  const spec = { endpoint: '/api/v1/services/aigc/video-generation/video-synthesis', model: 'wan2.7-i2v',
    kind: 'video', prompt: 'p', cents: 20 };
  stateOf(f, { 'video-shot01': { generations: GENERATIONS_PER_UNIT, reworks: REWORK_LIMIT,
    consumed: { 'video-shot01-r3': { at: 'x', status: 'submitted' } }, pending: null, exhausted: null,
    limitReached: { at: 'x', generations: GENERATIONS_PER_UNIT, reason: '已用完首次生成与 3 次返工' },
    lastOperation: 'video-shot01-r3', lastStatus: 'submitted' } });
  writeJson(path.join(f.directoryOps, 'video-shot01-r3.json'), { id: 'video-shot01-r3', fingerprint: hash(spec),
    status: 'submitted', spec, taskId: 'task-fourth', result: { output: { task_id: 'task-fourth', task_status: 'RUNNING' } } });
  writeJson(f.ledger, { version: 1, entries: [{ id: 'video-shot01-r3', fingerprint: hash(spec),
    reservedCents: 20, actualCents: null, status: 'reserved' }] });
  assert.equal(readJson(path.join(f.directory, 'unit-attempts.json')).units['video-shot01'].lastStatus, 'submitted',
    '待结果/待审核时不得提前当失败');
  const result = await f.ops.execute('video-shot01-r3', spec, async () => { throw new Error('SHOULD_NOT_POST'); });
  assert.equal(result.output.task_status, 'SUCCEEDED');
  assert.equal(f.client.state.queries.length, 1, '已提交的第四轮必须能继续查询');
  assert.equal(f.client.state.posts.length, 0, '查询不是新增生成，不得被轮次上限拦截');
  await f.client.download(result.output.video_url, f.out('fourth.mp4'));
  assert.equal(f.client.state.downloads.length, 1, '已存在的结果必须能继续下载');
  const round = f.attempts.status('video-shot01');
  assert.equal(round.exhausted, null, '第4轮结果可用，不能被当成失败暂停');
  assert.equal(round.limitReached !== null, true);
  assert.equal(round.lastStatus, 'succeeded', '查询成功后第4轮正常推进到成功');
});

test('a pending fourth round waits, and only a failed fourth round is the pause', async () => {
  const f = fixture();
  stateOf(f, { 'first-shot01': { generations: 3, reworks: 2,
    consumed: { 'first-shot01-r0': { at: 'x', status: 'succeeded' }, 'first-shot01-r1': { at: 'x', status: 'succeeded' },
      'first-shot01-r2': { at: 'x', status: 'succeeded' } }, pending: null, exhausted: null, limitReached: null } });
  const reserved = await f.attempts.reserve('first-shot01', 'first-shot01-r3', { reason: 'image' });
  assert.equal(reserved.attempt, 4);
  const committed = await f.attempts.commit('first-shot01', 'first-shot01-r3', 'submitted');
  assert.equal(committed.generations, GENERATIONS_PER_UNIT);
  assert.equal(committed.exhausted, null);
  const waiting = f.attempts.status('first-shot01');
  assert.equal(waiting.exhausted, null);
  assert.equal(waiting.hasRoundsLeft, false);
  assert.equal(f.attempts.summary().filter(r => r.exhausted).length, 0);
  await f.attempts.markExhausted('first-shot01', '第三次返工仍不合格');
  assert.equal(f.attempts.status('first-shot01').exhausted.reason, '第三次返工仍不合格');
  await assert.rejects(f.models.image('first-shot01-r4', 'p', [f.ref], f.out('e.png')), /UNIT_REWORK_LIMIT_REACHED/);
  assert.equal(f.client.state.posts.length, 0);
});

test('the fifth round submits nothing, even after a restart, a new operation number or another model', async () => {
  const f = fixture();
  await four(f, 'first-shot01');
  await assert.rejects(f.models.image('first-shot01-r4', 'p', [f.ref], f.out('x.png')), /UNIT_NO_GENERATION_ROUNDS_LEFT/);
  await assert.rejects(f.models.image('first-shot01-r5', 'p', [f.ref], f.out('y.png')), /UNIT_NO_GENERATION_ROUNDS_LEFT/);
  const changed = { ...f.config, models: { ...f.config.models, image: 'qwen-image-9.9' } };
  const restarted = new Models(changed, new Operations(f.directoryOps, f.client, f.budget, () => {}, 0, 0,
    new UnitAttempts(f.directory)), f.models.media, path.join(f.directory, 'vision-cache'));
  await assert.rejects(restarted.image('first-shot01-r9', 'p', [f.ref], f.out('z.png')), /UNIT_NO_GENERATION_ROUNDS_LEFT/);
  assert.equal(f.client.state.posts.length, 4, '第5轮零提交');
});

test('the shared preflight refuses a new generation without rounds left and says reading is unaffected', () => {
  const f = fixture();
  writeJson(path.join(f.directoryOps, 'video-shot01-r0.json'), { id: 'video-shot01-r0', fingerprint: 'f', status: 'succeeded', spec: {} });
  writeJson(f.ledger, { version: 1, entries: [{ id: 'video-shot01-r0', fingerprint: 'f', reservedCents: 20, actualCents: null, status: 'reserved' }] });
  stateOf(f, { 'video-shot01': { generations: GENERATIONS_PER_UNIT, reworks: REWORK_LIMIT,
    consumed: { 'video-shot01-r0': { at: 'x', status: 'succeeded' } }, pending: null, exhausted: null,
    limitReached: { at: 'x', generations: GENERATIONS_PER_UNIT, reason: '已用完首次生成与 3 次返工' } } });
  const context = { root: f.root, config: f.config, directory: f.directory };
  const { preflight } = require('../workflows/operations-map');
  let message = '';
  try { preflight(context, { revisions: {} }, ['video-shot01']); } catch (error) { message = error.message; }
  assert.match(message, /REVISION_ATTEMPTS_EXHAUSTED:video-shot01-r0/);
  assert.match(message, /不能再新增生成/);
  assert.match(message, /查询、下载、审核、验收与下游不受影响/);
  assert.equal(f.client.state.posts.length, 0);
  assert.equal(readJson(path.join(f.directoryOps, 'video-shot01-r0.json')).status, 'succeeded', '已有结果记录保持可读');
  assert.equal(unitForOperation('video-shot01-r9'), 'video-shot01');
});


