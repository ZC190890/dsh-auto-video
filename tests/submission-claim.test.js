const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { readJson, writeJson, withLock, claimFile } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

// An isolated job directory: no provider is ever contacted, every client here is a stand-in.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'claim-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'claim-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const directory = path.join(root, 'jobs', 'aliyun', 'claim-film');
  fs.mkdirSync(directory, { recursive: true });
  return { root, directory, config, opsDir: path.join(directory, 'operations'),
    budget: new Budget(root, config, directory) };
}
const specOf = id => ({ endpoint: '/compatible-mode/v1/chat/completions', model: 'qwen3.8-omni-flash',
  kind: 'planner', purpose: 'script-review', prompt: 'p', cents: 20 });
function countingClient() {
  const posts = [];
  return { posts, request: async (endpoint, body) => {
    posts.push({ endpoint, body });
    return { request_id: 'r' + posts.length, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] };
  } };
}
const claimPath = (f, id) => path.join(f.opsDir, id + '.submit.lock');
// A pid that is provably gone: a child process that has already exited.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise(resolve => child.on('exit', resolve));
  return pid;
}
async function writeDeadClaim(f, id, token = 'dead-owner-token') {
  const pid = await deadPid();
  writeJson(claimPath(f, id), { pid, token, createdAt: new Date().toISOString() });
  return pid;
}

test('a second process cannot post the same operation while the claim is held', async () => {
  const f = fixture();
  const id = 'plan-script-review-abcdef123456';
  const script = 'const { claimFile } = require(process.env.IO_MODULE);' +
    'const release = claimFile(process.env.CLAIM_PATH);' +
    'console.log("held");setTimeout(() => { release(); process.exit(0); }, 1500);';
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, IO_MODULE: path.join(ROOT, 'services/aliyun/io.js'), CLAIM_PATH: claimPath(f, id) } });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve(); });
    child.on('error', reject);
  });
  const client = countingClient();
  const ops = new Operations(f.opsDir, client, f.budget);
  await assert.rejects(ops.execute(id, specOf(id), async () => ({ model: 'x' })), /SUBMISSION_CLAIM_HELD/);
  assert.equal(client.posts.length, 0);
  await new Promise(resolve => child.on('exit', resolve));
  // Once the other process is gone, the same operation is submitted exactly once.
  await ops.execute(id, specOf(id), async () => ({ model: 'x' }));
  assert.equal(client.posts.length, 1);
  assert.equal(readJson(path.join(f.opsDir, id + '.json')).status, 'succeeded');
  assert.equal(fs.existsSync(claimPath(f, id)), false);       // the claim is released with the submission
});

test('a leftover claim refuses a resend and only clears on recorded evidence', async () => {
  const f = fixture();
  const id = 'plan-script-review-deadbeef0000';
  // A crashed process left the claim behind: nothing may be posted until a user checks the provider side.
  const ownerPid = await writeDeadClaim(f, id);
  const client = countingClient();
  const ops = new Operations(f.opsDir, client, f.budget);
  await assert.rejects(ops.execute(id, specOf(id), async () => ({ model: 'x' })), /SUBMISSION_CLAIM_HELD/);
  assert.equal(client.posts.length, 0);
  assert.throws(() => ops.releaseStaleClaim(id, '   '), /CLAIM_RELEASE_EVIDENCE_REQUIRED/);
  const released = ops.releaseStaleClaim(id, '控制台查无此请求记录，已核实确未提交');
  assert.equal(released.operationStatus, 'missing');
  assert.equal(released.ownerPid, ownerPid);
  assert.match(released.note, /核实/);                        // clearing a claim is not proof of no submission
  assert.equal(fs.existsSync(claimPath(f, id)), false);
  assert.equal(readJson(path.join(f.opsDir, id + '.claim-release.json')).releases.length, 1);
  await ops.execute(id, specOf(id), async () => ({ model: 'x' }));
  assert.equal(client.posts.length, 1);
});

test('an uncertain submission is never resent, not even after clearing a claim', async () => {
  const f = fixture();
  const id = 'plan-script-review-uncertain1';
  const failing = { request: async () => { throw new Error('timeout'); } };
  const ops = new Operations(f.opsDir, failing, f.budget);
  await assert.rejects(ops.execute(id, specOf(id), async () => ({ model: 'x' })), /SUBMISSION_UNCERTAIN/);
  assert.equal(readJson(path.join(f.opsDir, id + '.json')).status, 'uncertain');
  await writeDeadClaim(f, id, 'uncertain-token');
  assert.throws(() => ops.releaseStaleClaim(id, '试图清除占用'),
    /CLAIM_RELEASE_REQUIRES_RECONCILIATION:.*uncertain/);
  const client = countingClient();
  await assert.rejects(new Operations(f.opsDir, client, f.budget).execute(id, specOf(id), async () => ({ model: 'x' })),
    /SUBMISSION_CLAIM_HELD|OPERATION_REQUIRES_RECONCILIATION/);
  assert.equal(client.posts.length, 0);                       // no automatic resend, ever
});

test('the run lock is re-entrant inside one call chain but refuses a concurrent outsider', async () => {
  const f = fixture();
  const lock = path.join(f.root, 'jobs', 'aliyun', 'run.lock');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const outer = withLock(lock, async () => {
    await gate;
    // A workflow may lock the same file again while it holds it (rework applies a revision while locked).
    return withLock(lock, async () => 'nested-ok');
  });
  const outsider = withLock(lock, async () => 'should-not-run');
  await assert.rejects(outsider, /BUSY_OR_STALE_LOCK/);
  release();
  assert.equal(await outer, 'nested-ok');
  assert.equal(fs.existsSync(lock), false);                   // released exactly once, by the outermost call
});

test('a claim whose owner is still running is never cleared', async () => {
  const f = fixture();
  const id = 'plan-script-review-liveowner1';
  const ops = new Operations(f.opsDir, countingClient(), f.budget);
  writeJson(claimPath(f, id), { pid: process.pid, token: 'live-token', createdAt: new Date().toISOString() });
  assert.throws(() => ops.releaseStaleClaim(id, '看起来没人用了'), /CLAIM_OWNER_STILL_RUNNING:/);
  assert.equal(fs.existsSync(claimPath(f, id)), true);         // an alive claim is left alone
  fs.unlinkSync(claimPath(f, id));
  // A foreign process that really is alive is refused as well, and releases its own claim when it ends.
  const script = 'const { claimFile } = require(process.env.IO_MODULE);' +
    'const release = claimFile(process.env.CLAIM_PATH); console.log("held");' +
    'setTimeout(() => { release(); process.exit(0); }, 1200);';
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, IO_MODULE: path.join(ROOT, 'services/aliyun/io.js'), CLAIM_PATH: claimPath(f, id) } });
  await new Promise(resolve => child.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve(); }));
  assert.throws(() => ops.releaseStaleClaim(id, '试图清除'), /CLAIM_OWNER_STILL_RUNNING:/);
  assert.equal(fs.existsSync(claimPath(f, id)), true);
  await new Promise(resolve => child.on('exit', resolve));
  assert.equal(fs.existsSync(claimPath(f, id)), false);        // the holder removed its own claim
});

test('an unverifiable claim is refused instead of guessed away', async () => {
  const f = fixture();
  const ops = new Operations(f.opsDir, countingClient(), f.budget);
  writeJson(claimPath(f, 'op-unreadable'), '{ 这不是 JSON');
  writeJson(claimPath(f, 'op-nopid'), { note: '既没有 pid 也没有 token' });
  assert.throws(() => ops.releaseStaleClaim('op-unreadable', '核对过'), /CLAIM_OWNER_UNVERIFIABLE:op-unreadable/);
  assert.throws(() => ops.releaseStaleClaim('op-nopid', '核对过'), /CLAIM_OWNER_UNVERIFIABLE:op-nopid/);
  assert.equal(fs.existsSync(claimPath(f, 'op-unreadable')), true);
  assert.equal(fs.existsSync(claimPath(f, 'op-nopid')), true);
  assert.throws(() => ops.releaseStaleClaim('op-missing', '核对过'), /NO_SUBMISSION_CLAIM:op-missing/);
});

test('the holder never removes a claim that was created after its own', async () => {
  const f = fixture();
  const id = 'plan-script-review-newerclaim';
  const release = claimFile(claimPath(f, id));
  assert.equal(readJson(claimPath(f, id)).pid, process.pid);
  release();                                                   // the holder releases its own claim
  assert.equal(fs.existsSync(claimPath(f, id)), false);
  // An operator cleared it and a new holder took it: a late release must never delete the new claim.
  await writeDeadClaim(f, id, 'taken-over-token');
  release();
  assert.equal(fs.existsSync(claimPath(f, id)), true);
  assert.equal(readJson(claimPath(f, id)).token, 'taken-over-token');
});

test('a submitting operation cannot be released into a resend', async () => {
  const f = fixture();
  const id = 'plan-script-review-submitting';
  writeJson(path.join(f.opsDir, id + '.json'), { id, fingerprint: 'f', status: 'submitting', spec: specOf(id) });
  await writeDeadClaim(f, id, 'submitting-token');
  const client = countingClient();
  const ops = new Operations(f.opsDir, client, f.budget);
  assert.throws(() => ops.releaseStaleClaim(id, '想直接重发'),
    /CLAIM_RELEASE_REQUIRES_RECONCILIATION:plan-script-review-submitting:submitting/);
  assert.equal(fs.existsSync(claimPath(f, id)), true);         // the claim stays, the record stays authoritative
  await assert.rejects(ops.execute(id, specOf(id), async () => ({ model: 'x' })),
    /SUBMISSION_CLAIM_HELD|OPERATION_REQUIRES_RECONCILIATION/);
  assert.equal(client.posts.length, 0);
});
