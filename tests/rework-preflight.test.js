const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget } = require('../services/aliyun/budget');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { applyRework, reworkGuard } = require('../workflows/rework');
const ROOT = path.resolve(__dirname, '..');
const PLANNER = 'qwen3.8-omni-flash';

// No media is generated here: a preflight must be decided from records alone, before anything is spent.
function fixture({ needsLastFrame = true } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'rw-preflight-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: PLANNER, promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'config/project.json'), readJson(path.join(ROOT, 'config/project.json')));
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'rw-preflight-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const production = { id: 'rw-preflight-film', description: '预检隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image: 'hero.png', voiceSample: 'voice.wav', traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  const base = { type: 'narration', characters: [], speaker: 'character01', scene: '场景', action: '动作',
    endScene: '尾帧', duration: 5 };
  const shots = [{ ...base, id: 'shot01', needsLastFrame, text: '台词一' },
    { ...base, id: 'shot02', needsLastFrame, text: '台词二' }];
  const directory = path.join(root, 'jobs', 'aliyun', 'rw-preflight-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'rw-preflight-film',
    characters: {}, approvals: {}, assets: {}, revisions: {},
    reworkAdvice: { 'frames-shot01': [{ model: PLANNER, advice: '分镜动作不连贯，重做该镜画面', scope: 'frames',
      requiresPaidRetry: true, userAction: '用户决定', checkedBy: { model: config.models.vision, operation: 'frame-check-shot01-r0' },
      at: new Date().toISOString() }], 'speech-shot01': [{ model: PLANNER, advice: '语气不对，重做配音', scope: 'speech',
      requiresPaidRetry: true, userAction: '用户决定', checkedBy: { model: config.models.vision, operation: 'video-check-shot01-r0' },
      at: new Date().toISOString() }] },
    script: { title: '测试', shots } });
  const context = loadContext(root, 'production.json');
  return { root, directory, config, context, stateFile: path.join(directory, 'state.json'),
    ledgerFile: path.join(directory, 'api-ledger.json'), opsDir: path.join(directory, 'operations') };
}
function opFile(f, id) { return path.join(f.opsDir, id + '.json'); }
function writeOp(f, id, status, extra = {}) {
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents: 20 };
  writeJson(opFile(f, id), { id, fingerprint: hash(spec), status, spec, ...extra });
}
async function reserveOp(f, id, cents = 20) {
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents };
  await new Budget(f.root, f.config, f.directory).reserve(id, cents, hash(spec));
  return spec;
}
function countingClient() {
  const posts = [];
  return { posts, request: async (endpoint, body) => { posts.push({ endpoint, body }); throw new Error('SHOULD_NOT_BE_CALLED'); } };
}
function snapshots(f) {
  return { state: fileHash(f.stateFile),
    ledger: fs.existsSync(f.ledgerFile) ? fileHash(f.ledgerFile) : null,
    ops: fs.existsSync(f.opsDir)
      ? fs.readdirSync(f.opsDir).sort().map(name => name + ':' + fileHash(path.join(f.opsDir, name))).join(',') : '' };
}
function assertUnchanged(f, before) {
  const after = snapshots(f);
  assert.equal(after.state, before.state);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.ops, before.ops);
}

test('every frames operation is checked before anything is spent', async () => {
  for (const prefix of ['first', 'last', 'frame-check', 'video', 'video-check']) {
    const f = fixture();
    writeOp(f, prefix + '-shot01-r0', 'submitting');
    const client = countingClient();
    const before = snapshots(f);
    await assert.rejects(applyRework(f.context, 'frames-shot01', '用户确认', { client, log: () => {} }),
      new RegExp('REWORK_BLOCKED_UNRESOLVED_OPERATION:' + prefix + '-shot01-r0:submitting'));
    assert.equal(client.posts.length, 0);
    assertUnchanged(f, before);
  }
});

test('a speech rework is blocked by an unresolved downstream operation of the same shot', async () => {
  for (const prefix of ['speech', 'video', 'video-check']) {
    const f = fixture();
    writeOp(f, prefix + '-shot01-r0', 'running');
    const client = countingClient();
    const before = snapshots(f);
    await assert.rejects(applyRework(f.context, 'speech-shot01', '用户确认', { client, log: () => {} }),
      new RegExp('REWORK_BLOCKED_UNRESOLVED_OPERATION:' + prefix + '-shot01-r0:running'));
    assert.equal(client.posts.length, 0);
    assertUnchanged(f, before);
  }
});

test('the frames scope follows needsLastFrame instead of assuming a tail frame', async () => {
  const withoutLast = fixture({ needsLastFrame: false });
  writeOp(withoutLast, 'last-shot01-r0', 'submitting');
  assert.deepEqual(reworkGuard(withoutLast.context, readJson(withoutLast.stateFile), 'frames-shot01').map(a => a.id), []);
  const withLast = fixture();
  writeOp(withLast, 'last-shot01-r0', 'submitting');
  assert.throws(() => reworkGuard(withLast.context, readJson(withLast.stateFile), 'frames-shot01'),
    /REWORK_BLOCKED_UNRESOLVED_OPERATION:last-shot01-r0:submitting/);
});

test('a reservation without its record, a corrupt record and a missing ledger entry all stop the rework', async () => {
  const missing = fixture();
  await reserveOp(missing, 'video-shot01-r0');
  let client = countingClient(), before = snapshots(missing);
  await assert.rejects(applyRework(missing.context, 'video-shot01', '用户确认', { client, log: () => {} }),
    /REWORK_RESERVED_OPERATION_RECORD_MISSING:video-shot01-r0/);
  assert.equal(client.posts.length, 0);
  assertUnchanged(missing, before);

  const corrupt = fixture();
  fs.mkdirSync(corrupt.opsDir, { recursive: true });
  fs.writeFileSync(opFile(corrupt, 'video-shot01-r0'), '{ 这不是合法 JSON');
  client = countingClient(); before = snapshots(corrupt);
  await assert.rejects(applyRework(corrupt.context, 'video-shot01', '用户确认', { client, log: () => {} }),
    /REWORK_OPERATION_RECORD_CORRUPT:video-shot01-r0/);
  assert.equal(client.posts.length, 0);
  assertUnchanged(corrupt, before);

  const noLedger = fixture();
  writeOp(noLedger, 'video-shot01-r0', 'succeeded');
  client = countingClient(); before = snapshots(noLedger);
  await assert.rejects(applyRework(noLedger.context, 'video-shot01', '用户确认', { client, log: () => {} }),
    /REWORK_LEDGER_ENTRY_MISSING:video-shot01-r0/);
  assert.equal(client.posts.length, 0);
  assertUnchanged(noLedger, before);

  const spent = fixture();
  writeJson(spent.stateFile, { ...readJson(spent.stateFile),
    revisions: { 'video-shot01': 1, 'video-check-shot01': 1 } });
  writeJson(path.join(spent.directory, 'unit-attempts.json'), { version: 1, units: { 'video-shot01': {
    generations: 4, reworks: 3, consumed: {}, pending: null,
    exhausted: { at: '2026-09-22T00:00:00.000Z', generations: 4, reason: '测试：三次返工仍未通过' } } } });
  for (const base of ['video-shot01', 'video-check-shot01']) {
    await reserveOp(spent, base + '-r1');
    writeOp(spent, base + '-r1', 'succeeded');
  }
  client = countingClient(); before = snapshots(spent);
  await assert.rejects(applyRework(spent.context, 'video-shot01', '用户确认', { client, log: () => {} }),
    /REWORK_ATTEMPTS_EXHAUSTED:video-shot01-r1/);
  assert.equal(client.posts.length, 0);
  assertUnchanged(spent, before);
});
