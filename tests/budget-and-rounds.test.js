const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget, estimateCents } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { Models } = require('../services/aliyun/models');
const { UnitAttempts, REWORK_LIMIT, GENERATIONS_PER_UNIT, unitForOperation } = require('../services/aliyun/units');
const { readJson, writeJson, hash } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

// An isolated job with a mock provider: no real network is possible from here.
function fixture({ onlineEnabled = true, approvedBudgetCny = 0.5 } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'rounds-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'rounds-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny });
  const directory = path.join(root, 'jobs', 'aliyun', 'rounds-film');
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  const ref = path.join(root, 'ref.png'), sample = path.join(root, 'voice.wav');
  fs.writeFileSync(ref, 'reference-image'); fs.writeFileSync(sample, 'reference-voice');
  const client = mockClient();
  const budget = new Budget(root, config, directory);
  const attempts = new UnitAttempts(directory);
  const ops = new Operations(path.join(directory, 'operations'), client, budget, () => {}, 0, 0, attempts);
  const media = { visionImage: file => file, image: file => ({ hash: hash(file), width: 1, height: 1 }),
    audio: () => ({ duration: 1 }), normalizeAudio: source => source, command: () => {} };
  const models = new Models(config, ops, media, path.join(directory, 'vision-cache'));
  return { root, directory, config, client, budget, attempts, ops, models, ref, sample, directory_ops: path.join(directory, 'operations'),
    ledger: path.join(directory, 'api-ledger.json'), out: name => path.join(directory, 'out', name) };
}
function mockClient() {
  const state = { posts: [], queries: [], downloads: [], uncertainNext: 0 };
  const url = index => 'https://example.invalid/media-' + index + '.bin';
  return { state,
    request: async (endpoint, body) => {
      const index = state.posts.push({ endpoint, model: body?.model || null });
      if (state.uncertainNext > 0) { state.uncertainNext -= 1; throw new Error('network timeout'); }
      if (endpoint.includes('video-synthesis')) return { request_id: 'req-' + index, output: { task_id: 'task-' + index, task_status: 'PENDING' } };
      const input = body?.input || {};
      if (input.voice || input.action) return { request_id: 'req-' + index, output: { finish_reason: 'stop', audio: { url: url(index) } } };
      return { request_id: 'req-' + index, output: { choices: [{ message: { content: [{ image: url(index) }] } }] } };
    },
    task: async taskId => { state.queries.push(taskId);
      return { request_id: 'query-' + state.queries.length, output: { task_id: taskId, task_status: 'SUCCEEDED', video_url: url(900 + state.queries.length) } }; },
    download: async (source, destination) => { state.downloads.push(source);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'media:' + source); }
  };
}
const statusOf = (f, id) => (fs.existsSync(path.join(f.directory_ops, id + '.json')) ? readJson(path.join(f.directory_ops, id + '.json')).status : 'missing');

test('an unpriced unit and a total above the historical amount still generate and record an unknown cost', async () => {
  const f = fixture({ approvedBudgetCny: 0.01 });               // a historical 1-cent authorization
  for (let i = 0; i < 5; i += 1) await f.budget.reserve('check-' + i, 5000, 'h' + i);
  assert.equal(f.budget.report().committedCents, 25000);        // far above 50/70 CNY
  assert.equal(f.budget.checkAvailable(100000).blocking, false);
  f.config.models.portrait = 'qwen-image-unverified';           // a model without a verified price
  const destination = f.out('front-character01.png');
  const saved = await f.models.image('front-character01-r0', 'portrait', [f.ref], destination, true);
  assert.equal(saved, destination);
  assert.equal(f.client.state.posts.length, 1);
  const entry = readJson(f.ledger).entries.find(e => e.id === 'front-character01-r0');
  assert.equal(entry.reservedCents, null);                      // unknown, never zero
  assert.equal(entry.costStatus, 'unknown-price-awaiting-bill');
  assert.equal(entry.actualCents, null);
  assert.equal(f.attempts.status('front-character01').generations, 1);
  assert.equal(f.attempts.status('front-character01').reworks, 0);
});

test('without an online authorization nothing is generated and no round is consumed', async () => {
  const f = fixture({ onlineEnabled: false });
  await assert.rejects(f.models.image('first-shot01-r0', 'p', [f.ref], f.out('a.png')), /ONLINE_DISABLED/);
  assert.equal(f.client.state.posts.length, 0);
  assert.equal(fs.existsSync(f.ledger), false);
  const rounds = f.attempts.status('first-shot01');
  assert.equal(rounds.generations, 0);                          // a refusal that never submitted costs nothing
  assert.equal(rounds.pending, null);
});

test('the first generation and three reworks run, and the fourth is refused before any request', async () => {
  const f = fixture();
  for (let round = 0; round < GENERATIONS_PER_UNIT; round += 1) {
    const id = 'first-shot01-r' + round;
    await f.models.image(id, 'p', [f.ref], f.out(id + '.png'));
    const rounds = f.attempts.status('first-shot01');
    assert.equal(rounds.generations, round + 1, 'generations after round ' + round);
    assert.equal(rounds.reworks, round, 'reworks after round ' + round);
  }
  assert.equal(f.client.state.posts.length, GENERATIONS_PER_UNIT);
  const spent = f.attempts.status('first-shot01');
  assert.equal(spent.remainingReworks, 0);
  assert.equal(spent.hasRoundsLeft, false);
  // The 4th round cannot be repeated, but it is not a failure: only a failed check at the end of the rounds
  // turns into the rework-exhausted pause.
  assert.equal(spent.exhausted, null, '第4轮成功不得被标记为返工耗尽暂停');
  assert.ok(spent.limitReached, '只记录"无剩余返工机会"');
  const before = f.client.state.posts.length;
  await assert.rejects(f.models.image('first-shot01-r4', 'p', [f.ref], f.out('r4.png')),
    /UNIT_NO_GENERATION_ROUNDS_LEFT:first-shot01/);
  assert.equal(f.client.state.posts.length, before);             // refused before the provider was contacted
  assert.equal(statusOf(f, 'first-shot01-r4'), 'missing');
  assert.equal(readJson(f.ledger).entries.filter(e => e.id === 'first-shot01-r4').length, 0);
});

test('units count independently, and a revision, a model switch or a restart cannot reset them', async () => {
  const f = fixture();
  await f.models.image('first-shot01-r0', 'p', [f.ref], f.out('a.png'));
  await f.models.image('first-shot02-r0', 'p', [f.ref], f.out('b.png'));
  await f.models.image('last-shot01-r0', 'p', [f.ref], f.out('c.png'));
  assert.equal(f.attempts.status('first-shot01').generations, 1);
  assert.equal(f.attempts.status('first-shot02').generations, 1);
  assert.equal(f.attempts.status('last-shot01').generations, 1);
  // A higher revision is a rework of the same unit, not a new unit.
  await f.models.image('first-shot01-r1', 'p', [f.ref], f.out('d.png'));
  assert.equal(f.attempts.status('first-shot01').generations, 2);
  assert.equal(f.attempts.status('first-shot01').reworks, 1);
  // Switching the speech model does not reset the shot's speech unit either.
  await f.models.speech('speech-shot01-r0', '台词', 'qwen3-tts-vc-2026-01-22-general', f.out('e.wav'), {});
  f.config.models.speech = 'qwen-audio-3.0-tts-plus';
  await f.models.speech('speech-shot01-r1', '台词', 'qwen-audio-3.0-tts-plus-general', f.out('f.wav'), {});
  assert.equal(f.attempts.status('speech-shot01').generations, 2);
  // The ledger is keyed by unit: a restart (a new reader) and another rework job id see the same count.
  assert.equal(new UnitAttempts(f.directory).status('first-shot01').generations, 2);
  assert.deepEqual(Object.keys(readJson(path.join(f.directory, 'unit-attempts.json')).units).sort(),
    ['first-shot01', 'first-shot02', 'last-shot01', 'speech-shot01']);
});

test('querying and reusing a finished result never consume a round, while a remake of the unit does', async () => {
  const f = fixture();
  const shot = { id: 'shot01', type: 'narration', duration: 5, scene: 's', action: 'a', needsLastFrame: true };
  await f.models.video('video-shot01-r0', shot, f.ref, f.ref, null, f.out('v0.mp4'));
  assert.equal(f.attempts.status('video-shot01').generations, 1);
  assert.equal(f.client.state.queries.length, 1);                // the async task was queried, not re-generated
  const posts = f.client.state.posts.length;
  await f.models.video('video-shot01-r0', shot, f.ref, f.ref, null, f.out('v0.mp4'));
  assert.equal(f.client.state.posts.length, posts);              // cached result, no post and no extra round
  assert.equal(f.attempts.status('video-shot01').generations, 1);
  // An upstream change becomes a new revision of the same downstream unit: that is one rework.
  await f.models.video('video-shot01-r1', { ...shot, scene: 's2' }, f.ref, f.ref, null, f.out('v1.mp4'));
  const rounds = f.attempts.status('video-shot01');
  assert.equal(rounds.generations, 2);
  assert.equal(rounds.reworks, 1);
  assert.equal(f.client.state.downloads.length >= 2, true);
});

test('two concurrent attempts on the last available round submit at most once', async () => {
  const f = fixture();
  for (let round = 0; round < REWORK_LIMIT; round += 1)
    await f.models.image('video-shot01-r' + round, 'p', [f.ref], f.out('v' + round + '.png'));
  assert.equal(f.attempts.status('video-shot01').remainingReworks, 1);
  const before = f.client.state.posts.length;
  const results = await Promise.allSettled([
    f.models.image('video-shot01-r3', 'p', [f.ref], f.out('v3a.png')),
    f.models.image('video-shot01-r3', 'p', [f.ref], f.out('v3b.png'))]);
  assert.equal(f.client.state.posts.length, before + 1);          // exactly one generation went out
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /SUBMISSION_CLAIM_HELD|UNIT_ROUND_IN_FLIGHT|BUSY_OR_STALE_LOCK/);
  assert.equal(f.attempts.status('video-shot01').generations, GENERATIONS_PER_UNIT);
  // A different operation id cannot slip into a round that is already open.
  const g = fixture();
  for (let round = 0; round < REWORK_LIMIT; round += 1)
    await g.models.image('video-shot01-r' + round, 'p', [g.ref], g.out('v' + round + '.png'));
  const open = g.models.image('video-shot01-r3', 'p', [g.ref], g.out('open.png'));
  await assert.rejects(g.models.image('video-shot01-r9', 'p', [g.ref], g.out('other.png')),
    /UNIT_ROUND_IN_FLIGHT|UNIT_REWORK_LIMIT_REACHED|BUSY_OR_STALE_LOCK/);
  await open;
  assert.equal(g.attempts.status('video-shot01').generations, GENERATIONS_PER_UNIT);
});

test('an interrupted round is never counted twice, and an uncertain round is never refunded', async () => {
  const f = fixture();
  // A round claimed by a process that stopped before submitting is released and counted exactly once.
  await f.attempts.reserve('first-shot01', 'first-shot01-r0', { reason: 'interrupted before submit' });
  assert.equal(f.attempts.status('first-shot01').pending.operation, 'first-shot01-r0');
  await f.models.image('first-shot01-r0', 'p', [f.ref], f.out('a.png'));
  assert.equal(f.attempts.status('first-shot01').generations, 1);
  assert.equal(f.client.state.posts.length, 1);
  // A round whose submission happened keeps its round when the verdict was never written, and the
  // uncertain operation may not be replaced by a new id (that would be a resend under another name).
  const g = fixture();
  writeJson(path.join(g.directory, 'unit-attempts.json'), { version: 1, units: { 'first-shot02': {
    generations: 0, reworks: 0, consumed: {}, exhausted: null,
    pending: { operation: 'first-shot02-r1', at: '2026-09-22T00:00:00.000Z', attempt: 1 } } } });
  writeJson(path.join(g.directory_ops, 'first-shot02-r1.json'), { id: 'first-shot02-r1', fingerprint: 'f', status: 'uncertain', spec: {} });
  await assert.rejects(g.attempts.reserve('first-shot02', 'first-shot02-r2'),
    /UNIT_ROUND_IN_FLIGHT:first-shot02:first-shot02-r1/);
  const kept = g.attempts.status('first-shot02');
  assert.equal(kept.generations, 1);                            // kept, never refunded
  assert.equal(kept.pending, null);                             // settled instead of left dangling
  // Resuming the original operation reuses that same round: no extra round is consumed.
  const resumed = await g.attempts.reserve('first-shot02', 'first-shot02-r1');
  assert.equal(resumed.already, true);
  assert.equal(g.attempts.status('first-shot02').generations, 1);
});

test('an uncertain submission keeps its round, is never resent, and an exhausted unit stays paused', async () => {
  const f = fixture();
  f.client.state.uncertainNext = 1;
  await assert.rejects(f.models.image('first-shot01-r0', 'p', [f.ref], f.out('a.png')), /SUBMISSION_UNCERTAIN/);
  assert.equal(f.client.state.posts.length, 1);
  assert.equal(statusOf(f, 'first-shot01-r0'), 'uncertain');
  assert.equal(f.attempts.status('first-shot01').generations, 1);   // the attempt keeps its round
  assert.equal(f.attempts.status('first-shot01').pending, null);
  await assert.rejects(f.models.image('first-shot01-r0', 'p', [f.ref], f.out('a.png')), /OPERATION_REQUIRES_RECONCILIATION/);
  assert.equal(f.client.state.posts.length, 1);                     // no automatic resend, ever
  assert.equal(f.attempts.status('first-shot01').generations, 1);
  // A restarted process reads the same paused state and refuses before the provider is contacted.
  writeJson(path.join(f.directory, 'unit-attempts.json'), { version: 1, units: { 'first-shot01': {
    generations: GENERATIONS_PER_UNIT, reworks: REWORK_LIMIT, consumed: {}, pending: null,
    exhausted: { at: '2026-09-22T00:00:00.000Z', generations: GENERATIONS_PER_UNIT, reason: '三次返工仍未通过' } } } });
  const restarted = new Models(f.config, new Operations(f.directory_ops, f.client, f.budget, () => {}, 0, 0,
    new UnitAttempts(f.directory)), f.models.media, f.root);
  await assert.rejects(restarted.image('first-shot01-r9', 'p', [f.ref], f.out('b.png')), /UNIT_REWORK_LIMIT_REACHED/);
  assert.equal(f.client.state.posts.length, 1);
});

test('a legacy task rebuilds its rounds from verifiable records, asks for audit when it cannot, and the shared preflight agrees', async () => {
  const f = fixture();
  for (const [id, status] of [['video-shot01-r0', 'succeeded'], ['video-shot01-r1', 'failed']])
    writeJson(path.join(f.directory_ops, id + '.json'), { id, fingerprint: 'f', status, spec: {} });
  const migrated = await f.attempts.reserve('video-shot01', 'video-shot01-r2');
  assert.equal(migrated.generations, 2);                            // from the records, never assumed 0
  assert.equal(migrated.reworks, 1);
  await f.attempts.release('video-shot01', 'video-shot01-r2');
  assert.equal(readJson(path.join(f.directory, 'unit-attempts.json')).units['video-shot01'].migratedFrom, 'operation-records');
  // A reservation without its authoritative record cannot be judged: the unit asks for an audit.
  const g = fixture();
  await g.budget.reserve('video-shot01-r0', 100, 'fp');
  await assert.rejects(g.models.image('video-shot01-r0', 'p', [g.ref], g.out('a.png')), /UNIT_ATTEMPTS_NEED_AUDIT:video-shot01/);
  assert.equal(g.client.state.posts.length, 0);
  assert.equal(g.attempts.status('video-shot01').needsAudit, 'RESERVED_OPERATION_RECORD_MISSING:video-shot01-r0');
  await g.budget.reserve('video-shot01-r0', 100, 'fp');             // ledger writes stay idempotent
  assert.equal(readJson(g.ledger).entries.filter(e => e.id === 'video-shot01-r0').length, 1);
  // The shared preflight used by the rework/revise entries refuses the paused unit as well.
  const h = fixture();
  writeJson(path.join(h.directory_ops, 'video-shot01-r0.json'), { id: 'video-shot01-r0', fingerprint: 'f', status: 'succeeded', spec: {} });
  writeJson(path.join(h.ledger), { version: 1, entries: [{ id: 'video-shot01-r0', fingerprint: 'f', reservedCents: 100, actualCents: null, status: 'reserved' }] });
  writeJson(path.join(h.directory, 'unit-attempts.json'), { version: 1, units: { 'video-shot01': {
    generations: GENERATIONS_PER_UNIT, reworks: REWORK_LIMIT, consumed: {}, pending: null,
    exhausted: { at: '2026-09-22T00:00:00.000Z', generations: GENERATIONS_PER_UNIT, reason: '三次返工仍未通过' } } } });
  const { reworkGuard } = require('../workflows/rework');
  const state = { script: { title: 't', shots: [{ id: 'shot01', type: 'narration', needsLastFrame: true }] }, revisions: {} };
  assert.throws(() => reworkGuard(h, state, 'video-shot01'), /REWORK_ATTEMPTS_EXHAUSTED:video-shot01/);
  assert.equal(h.client.state.posts.length, 0);
});
