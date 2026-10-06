const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { main } = require('../index.js');
const ROOT = path.resolve(__dirname, '..');
const ID = 'video-shot01-r0';
const TASK = 'task-abc123';
const SPEC = { endpoint: '/api/v1/services/aigc/video-generation/video-synthesis', model: 'wan2.7-i2v', async: true,
  kind: 'video', resolution: '1080P', cents: 100, shot: { id: 'shot01' } };

function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'submitted-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    pollIntervalSeconds: 1, pollTimeoutSeconds: 5 };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'config/project.json'), readJson(path.join(ROOT, 'config/project.json')));
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'submitted-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  writeJson(path.join(root, 'production.json'), { id: 'submitted-film', description: '异步任务恢复隔离测试，不是真实成片素材',
    style: '测试', targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image: 'hero.png', voiceSample: 'voice.wav', traits: '测试' }] });
  const directory = path.join(root, 'jobs', 'aliyun', 'submitted-film');
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  return { root, directory, config, opsDir: path.join(directory, 'operations'),
    opFile: path.join(directory, 'operations', ID + '.json'),
    ledgerFile: path.join(directory, 'api-ledger.json') };
}
// A record left behind exactly as the runtime writes it before it dies mid-recovery.
async function record(f, { status = 'submitted', taskId = TASK } = {}) {
  const fingerprint = hash(SPEC);
  await new Budget(f.root, f.config, f.directory).reserve(ID, SPEC.cents, fingerprint);
  writeJson(f.opFile, { id: ID, fingerprint, status, spec: SPEC, attemptedAt: '2026-09-22T00:00:00.000Z',
    ...(taskId ? { taskId } : {}) });
  return fingerprint;
}
// A real child process takes the claim and exits without releasing it: a genuine leftover claim.
async function leftoverClaim(f, id) {
  const script = 'const { claimFile } = require(process.env.IO_MODULE); claimFile(process.env.CLAIM_PATH); process.exit(0);';
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore',
    env: { ...process.env, IO_MODULE: path.join(ROOT, 'services/aliyun/io.js'),
      CLAIM_PATH: path.join(f.opsDir, id + '.submit.lock') } });
  await new Promise(resolve => child.on('exit', resolve));
}
function opsFor(f, client) {
  return new Operations(f.opsDir, client, new Budget(f.root, f.config, f.directory), () => {}, 1, 5);
}
function recordingClient() {
  const client = { posts: [], queries: [],
    request: async () => { client.posts.push('post'); throw new Error('SHOULD_NOT_POST'); },
    task: async taskId => { client.queries.push(taskId);
      return { output: { task_id: taskId, task_status: 'SUCCEEDED', video_url: 'https://example.invalid/v.mp4' } }; } };
  return client;
}

test('a submitted task with a known task id is recovered and only queried', async () => {
  const f = fixture();
  const fingerprint = await record(f);
  const opBefore = fileHash(f.opFile), ledgerBefore = fileHash(f.ledgerFile);
  await leftoverClaim(f, ID);
  const client = recordingClient();
  const ops = opsFor(f, client);
  await assert.rejects(ops.execute(ID, SPEC, async () => ({})), /SUBMISSION_CLAIM_HELD/);
  assert.equal(client.posts.length, 0);
  assert.throws(() => ops.releaseStaleClaim(ID, ''), /CLAIM_RELEASE_EVIDENCE_REQUIRED/);
  // The public recovery entry: the existing unlock command with the verification note.
  await main(['unlock', 'production.json', ID, '供应商控制台显示该任务仍在运行，原占用进程已退出'], { root: f.root });
  const released = readJson(path.join(f.opsDir, ID + '.claim-release.json'));
  assert.equal(released.releases.length, 1);
  assert.equal(released.releases[0].taskId, TASK);
  assert.match(released.releases[0].note, /绝不重新提交/);
  assert.equal(fileHash(f.opFile), opBefore);            // id, taskId, fingerprint, status, evidence kept
  assert.equal(fileHash(f.ledgerFile), ledgerBefore);    // the reservation is untouched
  const kept = readJson(f.opFile);
  assert.equal(kept.taskId, TASK);
  assert.equal(kept.fingerprint, fingerprint);
  assert.equal(kept.status, 'submitted');

  const result = await ops.execute(ID, SPEC, async () => { throw new Error('SHOULD_NOT_BUILD_A_BODY'); });
  assert.equal(client.posts.length, 0);                  // never posts again
  assert.deepEqual(client.queries, [TASK]);              // only queries the original task
  assert.equal(result.output.video_url, 'https://example.invalid/v.mp4');
  assert.equal(readJson(f.opFile).status, 'succeeded');
  const ledger = readJson(f.ledgerFile).entries;
  assert.equal(ledger.length, 1);                        // no second reservation
  assert.equal(ledger[0].id, ID);
  const again = await ops.execute(ID, SPEC, async () => { throw new Error('SHOULD_NOT_BUILD_A_BODY'); });
  assert.equal(again.output.video_url, 'https://example.invalid/v.mp4');
  assert.equal(client.queries.length, 1);                // the finished result is reused, not re-queried
});

test('an active holder is refused and an unresolved record still needs reconciliation', async () => {
  const f = fixture();
  await record(f);
  const script = 'const { claimFile } = require(process.env.IO_MODULE); claimFile(process.env.CLAIM_PATH);' +
    'console.log("held"); setTimeout(() => process.exit(0), 1500);';
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, IO_MODULE: path.join(ROOT, 'services/aliyun/io.js'),
      CLAIM_PATH: path.join(f.opsDir, ID + '.submit.lock') } });
  await new Promise(resolve => child.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve(); }));
  const live = opsFor(f, recordingClient());
  assert.throws(() => live.releaseStaleClaim(ID, '就想清掉这个占用'), /CLAIM_OWNER_STILL_RUNNING:/);
  await assert.rejects(live.execute(ID, SPEC, async () => ({})), /SUBMISSION_CLAIM_HELD/);
  await new Promise(resolve => child.on('exit', resolve));

  // No task id yet: adopt-task is the reconciliation, and only then may the claim go.
  const g = fixture();
  await record(g, { status: 'uncertain', taskId: null });
  await leftoverClaim(g, ID);
  const pendingClient = recordingClient();
  const pending = opsFor(g, pendingClient);
  assert.throws(() => pending.releaseStaleClaim(ID, '没有任务号也放行'),
    /CLAIM_RELEASE_REQUIRES_RECONCILIATION:video-shot01-r0:uncertain/);
  await assert.rejects(pending.execute(ID, SPEC, async () => ({})), /SUBMISSION_CLAIM_HELD/);
  pending.adoptTask(ID, TASK, '控制台显示该任务 ID 属实');
  assert.equal(readJson(g.opFile).taskId, TASK);
  assert.equal(readJson(g.opFile).status, 'submitted');
  const released = pending.releaseStaleClaim(ID, '已核实任务 ID 属实且原占用进程已退出');
  assert.equal(released.taskId, TASK);
  assert.equal(pendingClient.queries.length, 0);         // releasing a claim never queries or posts by itself
});

test('two concurrent recoveries still query the original task once', async () => {
  const f = fixture();
  await record(f);
  await leftoverClaim(f, ID);
  const client = recordingClient();
  client.task = async taskId => { client.queries.push(taskId);
    await new Promise(resolve => setTimeout(resolve, 40));
    return { output: { task_id: taskId, task_status: 'SUCCEEDED', video_url: 'https://example.invalid/v.mp4' } }; };
  const ops = opsFor(f, client);
  ops.releaseStaleClaim(ID, '原占用进程已退出，供应商侧确认任务存在');
  const results = await Promise.allSettled([ops.execute(ID, SPEC, async () => ({})), ops.execute(ID, SPEC, async () => ({}))]);
  assert.equal(client.posts.length, 0);                  // no generation request, ever
  assert.equal(client.queries.length, 1);                // one query for the original task
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results) if (result.status === 'rejected')
    assert.match(result.reason.message, /SUBMISSION_CLAIM_HELD/);
  assert.equal(readJson(f.ledgerFile).entries.length, 1);
});
