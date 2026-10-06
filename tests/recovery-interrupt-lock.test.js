const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson, withLock } = require('../services/aliyun/io');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { Models } = require('../services/aliyun/models');
const { UnitAttempts } = require('../services/aliyun/units');
const { recoverScriptPlan, runLockFile, listDecisions } = require('../workflows/recover-script');
const { main } = require('../index');
const ROOT = path.resolve(__dirname, '..');
const REAL_OPERATION = path.join(ROOT, 'jobs', 'aliyun', 'second-film', 'operations', 'plan-script.json');
const REAL_MANIFEST = path.join(ROOT, 'input', 'second-film', 'production.json');
const REAL_EVIDENCE = path.join(ROOT, 'input', 'second-film', 'plan-script-provider-evidence.json');

// Registration has to survive an interruption between its two writes, coordinate with `run` through the one
// shared state lock, and never lose a field written by another entry point. Everything below runs against
// isolated copies: the real second-film records are only read, and no provider client exists except the
// mock used to prove how many generation POSTs happen.
function makeJob(root, id) {
  const directory = path.join(root, 'jobs', 'aliyun', id);
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  fs.copyFileSync(REAL_OPERATION, path.join(directory, 'operations', 'plan-script.json'));
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: id, stage: 'script',
    brief: { storySummary: 's', shotGuidance: 'g' }, sentinel: id + '-keep' });
  writeJson(path.join(directory, 'unit-attempts.json'), { version: 1, checks: {}, units: { script: {
    generations: 1, reworks: 0, consumed: { 'plan-script': { at: '2026-09-21T22:26:53.761Z', status: 'uncertain' } },
    pending: null, exhausted: null, limitReached: null, lastOperation: 'plan-script', lastStatus: 'uncertain' } } });
  return directory;
}
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'recovery-lock-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'project.json'), path.join(root, 'config', 'project.json'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config', 'aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'second-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 50 });
  fs.mkdirSync(path.join(root, 'input', 'second-film'), { recursive: true });
  fs.copyFileSync(REAL_MANIFEST, path.join(root, 'input', 'second-film', 'production.json'));
  fs.copyFileSync(REAL_EVIDENCE, path.join(root, 'input', 'second-film', 'plan-script-provider-evidence.json'));
  const directory = makeJob(root, 'second-film');
  const firstDirectory = makeJob(root, 'first-film');
  const context = { root, directory, config, production: readJson(path.join(root, 'input', 'second-film', 'production.json')) };
  return { root, directory, firstDirectory, config, context, stateFile: path.join(directory, 'state.json'),
    ledgerFile: path.join(directory, 'unit-attempts.json'), decisions: path.join(directory, 'recovery'),
    evidenceFile: 'input/second-film/plan-script-provider-evidence.json',
    options: { evidenceFile: 'input/second-film/plan-script-provider-evidence.json', decision: 'regenerate', reason: '供应商记录已核实，原请求未取得可用正文' } };
}
const decisionsOf = f => path.join(f.decisions, 'plan-script-recovery-1.json');
function snapshot(directory) {
  const out = {};
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(directory, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(directory);
  return out;
}
function mockPlanClient() {
  const state = { posts: [] };
  return { state,
    request: async (endpoint, body, options) => {
      state.posts.push({ endpoint, body, options });
      return { id: 'resp-1', choices: [{ finish_reason: 'stop', message: { content: '{"title":"受控重试稿","shots":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
    task: async () => { throw new Error('NO_TASK_EXPECTED'); },
    download: async () => { throw new Error('NO_DOWNLOAD_EXPECTED'); } };
}
// __NEXT__

test('a recovery and a run share one state lock: the competitor is refused, nothing is lost and the lock is released', async () => {
  const f = fixture();
  // A foreign holder (another process) owns the lock: the file exists and is not part of this call chain.
  writeJson(runLockFile(f.context), { pid: process.pid, createdAt: new Date().toISOString() });
  await assert.rejects(recoverScriptPlan(f.context, f.options), /BUSY_OR_STALE_LOCK/);
  assert.equal(fs.existsSync(f.decisions), false, '被拒绝的登记不留决策文件');
  fs.unlinkSync(runLockFile(f.context));
  // The other side of the rule: a run writes state first, then the recovery completes inside its own lock
  // and preserves every field the run wrote.
  await withLock(runLockFile(f.context), async () => {
    const state = readJson(f.stateFile);
    state.writtenByRun = 'keep-me';
    state.revisions = { video: 2 };
    writeJson(f.stateFile, state);
  });
  const result = await recoverScriptPlan(f.context, f.options);
  assert.equal(result.completed, true);
  const state = readJson(f.stateFile);
  assert.equal(state.writtenByRun, 'keep-me', 'run 写的字段不得被恢复入口覆盖');
  assert.deepEqual(state.revisions, { video: 2 });
  assert.equal(state.scriptPlanRecovery.retryOperation, result.retryOperation);
  assert.equal(fs.existsSync(runLockFile(f.context)), false, '恢复入口必须释放共享锁');
});

test('two identical registrations race safely: one valid decision, the loser refused or idempotent', async () => {
  const f = fixture();
  const results = await Promise.allSettled([recoverScriptPlan(f.context, f.options), recoverScriptPlan(f.context, f.options)]);
  const fulfilled = results.filter(item => item.status === 'fulfilled');
  const rejected = results.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length + rejected.length, 2);
  assert.ok(rejected.length <= 1, '最多一方被拒绝');
  if (rejected.length) assert.match(rejected[0].reason.message, /BUSY_OR_STALE_LOCK/);
  assert.ok(fulfilled.length >= 1);
  assert.equal(listDecisions(f.context).length, 1, '并发下最多一个有效决策');
  assert.equal(readJson(f.stateFile).scriptPlanRecovery.retryOperation, fulfilled[0].value.retryOperation);
  // Whatever the race did, a later registration is safely idempotent and changes nothing.
  const later = await recoverScriptPlan(f.context, f.options);
  assert.equal(later.idempotent, true);
  assert.equal(later.retryOperation, fulfilled[0].value.retryOperation);
  assert.equal(listDecisions(f.context).length, 1);
});

test('the real CLI needs the manifest, acts only on the isolated second film, and never touches the first film', async () => {
  const f = fixture();
  const firstBefore = snapshot(f.firstDirectory);
  const quiet = console.log; console.log = () => {};
  try {
    await assert.rejects(main(['recover-script'], { root: f.root }), /MANIFEST_REQUIRED/);
    await assert.rejects(main(['recover-script', 'input/second-film/production.json'], { root: f.root }), /RECOVERY_EVIDENCE_FILE_REQUIRED/);
    await assert.rejects(main(['recover-script', 'input/second-film/production.json', '--evidence', f.evidenceFile, '--unknown', 'x'],
      { root: f.root }), /INVALID_ARGUMENTS/);
    await main(['recover-script', 'input/second-film/production.json', '--evidence', f.evidenceFile,
      '--decision', 'regenerate', '--reason', '供应商记录已核实，原请求未取得可用正文'], { root: f.root });
  } finally { console.log = quiet; }
  const state = readJson(f.stateFile);
  assert.equal(state.productionId, 'second-film');
  assert.equal(state.scriptPlanRecovery.retryOperation, 'plan-script-retry-1');
  assert.equal(state.sentinel, 'second-film-keep');
  assert.deepEqual(snapshot(f.firstDirectory), firstBefore, '隔离首片字节不得变化');
  assert.equal(readJson(f.ledgerFile).units.script.generations, 1, '登记不消耗轮次');
});

test('registration then the controlled run spends one rework and at most one generation POST', async () => {
  const f = fixture();
  const applied = await recoverScriptPlan(f.context, f.options);
  const attempts = new UnitAttempts(f.directory);
  assert.equal(attempts.status('script').generations, 1, '原不确定尝试仍计首次生成');
  const client = mockPlanClient();
  const ops = new Operations(path.join(f.directory, 'operations'), client, new Budget(f.root, f.config, f.directory), () => {}, 0, 0, attempts);
  const media = { visionImage: file => file, image: file => ({ hash: file, width: 1, height: 1 }),
    audio: () => ({ duration: 1 }), normalizeAudio: source => source, command: () => {} };
  const models = new Models(f.config, ops, media, path.join(f.directory, 'vision-cache'));
  const first = await models.plan(applied.retryOperation, { purpose: 'script', prompt: 'p', reservationCents: 20 });
  assert.equal(first.json.title, '受控重试稿');
  assert.equal(client.state.posts.length, 1, '受控重生成只提交一次');
  const after = attempts.status('script');
  assert.equal(after.generations, 2);
  assert.equal(after.reworks, 1, '只消耗一次返工');
  assert.equal(after.exhausted, null);
  assert.equal(after.remainingReworks, 2);
  assert.equal(readJson(f.ledgerFile).units.script.consumed['plan-script'].status, 'uncertain', '原记录与证据保留');
  // Resume after an interruption right after the response: the stored result is reused, nothing is re-posted.
  const again = await models.plan(applied.retryOperation, { purpose: 'script', prompt: 'p', reservationCents: 20 });
  assert.deepEqual(again.json, first.json);
  assert.equal(client.state.posts.length, 1, '恢复复用既有结果，不重复提交');
  assert.equal(attempts.status('script').generations, 2, '恢复不重复计轮次');
  // The registration is still idempotent after the retry ran, and never rewrites the counts.
  const repeat = await recoverScriptPlan(f.context, f.options);
  assert.equal(repeat.idempotent, true);
  assert.equal(repeat.retryOperation, applied.retryOperation);
  assert.equal(attempts.status('script').generations, 2);
});


test('an interruption between the decision file and the state completes the same decision on the next run', async () => {
  const f = fixture();
  const first = await recoverScriptPlan(f.context, f.options);
  const retry = first.retryOperation;
  // Reproduce the crash window exactly: the decision is durable but still 'registered', and the state
  // never received it.
  const decision = readJson(decisionsOf(f));
  decision.application = { ...decision.application, status: 'registered', appliedAt: null };
  writeJson(decisionsOf(f), decision);
  const state = readJson(f.stateFile);
  delete state.scriptPlanRecovery;
  state.writtenByRun = 'keep-me';
  writeJson(f.stateFile, state);
  const resumed = await recoverScriptPlan(f.context, f.options);
  assert.equal(resumed.completed, true, '登记完成的含义是决策与制作状态一致');
  assert.equal(resumed.resumed, true, '必须报告为补齐既有决策，而不是新登记');
  assert.equal(resumed.retryOperation, retry, '补齐必须复用原重试号');
  assert.equal(listDecisions(f.context).length, 1, '不得新建第二个决策');
  assert.equal(readJson(decisionsOf(f)).application.status, 'applied');
  assert.equal(typeof readJson(decisionsOf(f)).application.appliedAt, 'string');
  const applied = readJson(f.stateFile);
  assert.equal(applied.scriptPlanRecovery.retryOperation, retry);
  assert.equal(applied.writtenByRun, 'keep-me', '补齐不得丢失其它状态字段');
  assert.equal(readJson(f.ledgerFile).units.script.generations, 1, '登记不消耗生成轮次');
});

test('a crash after the state write only repairs the marker: no new decision and no extra round', async () => {
  const f = fixture();
  const first = await recoverScriptPlan(f.context, f.options);
  const decision = readJson(decisionsOf(f));
  decision.application = { ...decision.application, status: 'registered', appliedAt: null };
  writeJson(decisionsOf(f), decision);
  const before = readJson(f.stateFile);
  const again = await recoverScriptPlan(f.context, f.options);
  assert.equal(again.idempotent, true);
  assert.equal(again.completed, true);
  assert.equal(again.retryOperation, first.retryOperation);
  assert.equal(readJson(decisionsOf(f)).application.status, 'applied', '只补写完成标记');
  assert.deepEqual(readJson(f.stateFile), before, '状态内容逐字不变');
  assert.equal(listDecisions(f.context).length, 1);
  assert.equal(readJson(f.ledgerFile).units.script.generations, 1);
  assert.equal(fs.readdirSync(f.decisions).length, 1, '不新增决策文件');
});

test('a newer decision, a changed original fingerprint or another production are refused without overwriting', async () => {
  const f = fixture();
  const first = await recoverScriptPlan(f.context, f.options);
  // A corrected evidence document is a newer decision; it may move the state forward and keeps the old one.
  const secondEvidence = path.join(f.root, 'input', 'second-film', 'plan-script-provider-evidence-2.json');
  const corrected = readJson(path.join(f.root, f.options.evidenceFile));
  corrected.requestId = corrected.requestId + '-corrected';
  writeJson(secondEvidence, corrected);
  const newer = await recoverScriptPlan(f.context, { ...f.options, evidenceFile: 'input/second-film/plan-script-provider-evidence-2.json' });
  assert.equal(newer.retryOperation, 'plan-script-retry-2');
  const forward = readJson(f.stateFile);
  assert.equal(forward.scriptPlanRecovery.retryOperation, 'plan-script-retry-2');
  assert.equal(forward.scriptPlanRecoveryHistory.length, 1, '被替换的决策保留为历史，不丢失');
  assert.equal(forward.scriptPlanRecoveryHistory[0].previous.retryOperation, first.retryOperation);
  // The older decision must not overwrite or roll the state back.
  const stateBefore = fs.readFileSync(f.stateFile);
  await assert.rejects(recoverScriptPlan(f.context, f.options), /RECOVERY_SUPERSEDED_BY_NEWER_DECISION/);
  assert.deepEqual(fs.readFileSync(f.stateFile), stateBefore, '拒绝时原状态保持逐字不变');
  // A changed original fingerprint cannot be completed blindly.
  const g = fixture();
  await recoverScriptPlan(g.context, g.options);
  const gDecision = readJson(decisionsOf(g));
  gDecision.application = { ...gDecision.application, status: 'registered', appliedAt: null };
  writeJson(decisionsOf(g), gDecision);
  const gState = readJson(g.stateFile);
  delete gState.scriptPlanRecovery;
  writeJson(g.stateFile, gState);
  const originalFile = path.join(g.directory, 'operations', 'plan-script.json');
  const original = readJson(originalFile);
  original.fingerprint = 'changed-by-someone-else';
  writeJson(originalFile, original);
  await assert.rejects(recoverScriptPlan(g.context, g.options), /RECOVERY_ORIGINAL_FINGERPRINT_CHANGED/);
  assert.equal(readJson(g.stateFile).scriptPlanRecovery, undefined, '拒绝时不得写入半成品状态');
  // Another production cannot register against this job directory.
  const h = fixture();
  await assert.rejects(recoverScriptPlan({ ...h.context, production: { ...h.context.production, id: 'first-film' } }, h.options),
    /RECOVERY_PRODUCTION_MISMATCH/);
  assert.equal(fs.existsSync(h.decisions), false);
});

