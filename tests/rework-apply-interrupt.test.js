const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget } = require('../services/aliyun/budget');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const ROOT = path.resolve(__dirname, '..');
const PLANNER = 'qwen3.8-omni-flash';
const TARGET = 'video-shot01';

// The fault is injected between "the change is saved" and "the rework marks itself applied", which is the
// window this test exists for. It is done by wrapping the state writer of the rework module only: the
// mutation itself (revise/redo) writes through the same wrapper but never matches the trigger.
const production = require('../workflows/production');
const realSaveState = production.saveState;
let interrupt = null;
production.saveState = (context, state) => {
  realSaveState(context, state);
  if (interrupt && interrupt(state)) { interrupt = null; throw new Error('SIMULATED_CRASH_AFTER_CHANGE'); }
};
const { applyRework } = require('../workflows/rework');
// Loaded after the wrapper is installed, so the mutation itself writes through the monitored writer.
const { reviseScript } = require('../workflows/revise');

test.before(() => { assert.equal(typeof production.saveState, 'function'); });
test.after(() => { production.saveState = realSaveState; });

function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'rw-interrupt-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: PLANNER, promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'config/project.json'), readJson(path.join(ROOT, 'config/project.json')));
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'rw-interrupt-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const productionJson = { id: 'rw-interrupt-film', description: '返工中断窗口隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image: 'hero.png', voiceSample: 'voice.wav', traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), productionJson);
  const base = { type: 'narration', characters: [], speaker: 'character01', scene: '场景', action: '动作',
    endScene: '尾帧', needsLastFrame: true, duration: 5 };
  const shots = [{ ...base, id: 'shot01', text: '第一句台词', videoAction: '旧动作' },
    { ...base, id: 'shot02', text: '第二句台词', videoAction: '第二镜旧动作' }];
  const directory = path.join(root, 'jobs', 'aliyun', 'rw-interrupt-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'rw-interrupt-film',
    characters: {}, approvals: { 'video-shot01': 'digest-before' }, assets: { shot01: { video: 'old.mp4' } }, revisions: {},
    reworkAdvice: { [TARGET]: [{ model: PLANNER, advice: '第一镜动作不连贯，重做该镜动作', scope: 'video',
      requiresPaidRetry: true, userAction: '用户决定', checkedBy: { model: config.models.vision, operation: 'video-check-shot01-r0' },
      at: new Date().toISOString() }] },
    script: { title: '测试', shots } });
  const context = loadContext(root, 'production.json');
  return { root, directory, config, context, script: { title: '测试', shots },
    stateFile: path.join(directory, 'state.json'), ledgerFile: path.join(directory, 'api-ledger.json') };
}
async function succeededOp(f, id, cents = 20) {
  const budget = new Budget(f.root, f.config, f.directory);
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents };
  await budget.reserve(id, cents, hash(spec));
  writeJson(path.join(f.directory, 'operations', id + '.json'), { id, fingerprint: hash(spec), status: 'succeeded', spec });
}
const reply = json => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(json) } }] });
const REVIEW_OK = { verdict: 'pass', summary: '修订后可用', contextIssues: [], durationIssues: [],
  estimatedDurationSeconds: 9, longShots: [], advice: null };
// Provider stand-in: the instruction reply is selectable so the redo path can be exercised too.
function plannerClient({ instruction = { shotId: 'shot01', scope: 'video', patch: { videoAction: '按返工意见重做动作' }, rationale: '最小改动' },
  posts = [] } = {}) {
  return { posts, request: async (endpoint, body) => {
    const purpose = JSON.stringify(body.messages || []);
    posts.push({ endpoint, model: body.model, purpose });
    if (!endpoint.includes('chat/completions') || body.model !== PLANNER) throw new Error('NON_PLANNER_REQUEST:' + endpoint + ':' + body.model);
    if (purpose.includes('返工执行模型')) return reply(instruction);
    if (purpose.includes('独立审核模型')) return reply(REVIEW_OK);
    throw new Error('UNEXPECTED_PLANNER_PROMPT');
  } };
}
const historyFor = (state, kind) => (state.history || []).filter(entry => entry.kind === kind);

test('an interrupt between the change and the applied mark resumes to review with one application', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const posts = [];
  // The mutation's own save has already landed, while the "applied" commit must not be written.
  interrupt = state => Object.values(state.rework || {}).some(job => job.applying && !job.applied &&
    (state.editRevision || 0) !== job.applying.expectedRevision);
  await assert.rejects(applyRework(f.context, TARGET, '用户确认按建议返工', { client: plannerClient({ posts }), log: () => {} }),
    /SIMULATED_CRASH_AFTER_CHANGE/);
  const interrupted = readJson(f.stateFile);
  const jobId = Object.keys(interrupted.rework)[0];
  assert.equal(interrupted.script.shots[0].videoAction, '按返工意见重做动作');   // the change did land
  assert.equal(interrupted.editRevision, 1);
  assert.equal(interrupted.revisions['video-shot01'], 1);
  assert.equal(interrupted.rework[jobId].stage, 'apply');                       // but the mark did not
  assert.ok(interrupted.rework[jobId].applying);                                // the durable intent remains
  assert.equal(interrupted.rework[jobId].applied, undefined);
  const revisionBefore = interrupted.editRevision;
  const operationsBefore = fs.readdirSync(path.join(f.directory, 'operations')).sort();
  const ledgerIdsBefore = readJson(f.ledgerFile).entries.map(entry => entry.id);

  const resumed = await applyRework(f.context, TARGET, '用户确认按建议返工', { client: plannerClient({ posts }), log: () => {} });
  assert.equal(resumed.review.verdict, 'pass');
  const after = readJson(f.stateFile);
  assert.equal(after.rework[jobId].stage, 'done');
  assert.equal(after.rework[jobId].applied.mode, 'revise');
  assert.equal(after.rework[jobId].applied.recovered, true);
  assert.equal(after.rework[jobId].recovered.mode, 'revise');
  assert.equal(after.rework[jobId].applying, undefined);
  assert.equal(after.reworkApplied.length, 1);
  // Exactly one application: no extra revision, no extra history entry, no extra paid call.
  assert.equal(after.editRevision, revisionBefore);
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(historyFor(after, 'script-revision').length, 1);
  // The only newly paid call is the review that had never been submitted: the mutation was not re-paid.
  const ledgerIdsAfter = readJson(f.ledgerFile).entries.map(entry => entry.id);
  assert.deepEqual(ledgerIdsAfter.filter(id => !ledgerIdsBefore.includes(id)).map(id => id.startsWith('plan-script-review-')), [true]);
  const operationsAfter = fs.readdirSync(path.join(f.directory, 'operations')).sort();
  assert.deepEqual(operationsAfter.filter(name => !operationsBefore.includes(name)).map(name => name.startsWith('plan-script-review-')), [true]);
  assert.equal(operationsAfter.filter(name => name.startsWith('plan-rework-instruction-')).length, 1);
  assert.equal(posts.filter(p => p.purpose.includes('返工执行模型')).length, 1);
  assert.equal(posts.filter(p => p.purpose.includes('独立审核模型')).length, 1);
  const settled = fileHash(f.stateFile);
  const again = await applyRework(f.context, TARGET, '用户确认按建议返工', { client: plannerClient({ posts }), log: () => {} });
  assert.equal(again.alreadyApplied, true);
  assert.equal(fileHash(f.stateFile), settled);
  assert.equal(posts.length, 2);
});

test('the same interrupt on the redo path also resumes with a single application', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const posts = [];
  const instruction = { shotId: 'shot01', scope: 'video', patch: {}, rationale: '直接重做该镜视频' };
  interrupt = state => Object.values(state.rework || {}).some(job => job.applying && !job.applied &&
    (state.editRevision || 0) !== job.applying.expectedRevision);
  await assert.rejects(applyRework(f.context, TARGET, '用户确认按建议返工',
    { client: plannerClient({ posts, instruction }), log: () => {} }), /SIMULATED_CRASH_AFTER_CHANGE/);
  const interrupted = readJson(f.stateFile);
  const jobId = Object.keys(interrupted.rework)[0];
  assert.equal(interrupted.rework[jobId].applying.mode, 'redo');
  assert.equal(interrupted.editRevision, 1);
  assert.equal(interrupted.revisions['video-shot01'], 1);
  assert.equal(interrupted.revisions['video-check-shot01'], 1);
  assert.equal(historyFor(interrupted, 'redo').length, 1);
  const revisionBefore = interrupted.editRevision;

  const resumed = await applyRework(f.context, TARGET, '用户确认按建议返工',
    { client: plannerClient({ posts, instruction }), log: () => {} });
  assert.equal(resumed.review.verdict, 'pass');
  const after = readJson(f.stateFile);
  assert.equal(after.rework[jobId].applied.mode, 'redo');
  assert.equal(after.rework[jobId].applied.recovered, true);
  assert.equal(after.editRevision, revisionBefore);        // the redo did not run a second time
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(historyFor(after, 'redo').length, 1);
  assert.equal(after.assets.shot01.video, undefined);      // regenerated once, not twice
  assert.equal(posts.filter(p => p.purpose.includes('返工执行模型')).length, 1);
});

test('an intent that never landed retries, while an external change is still refused', async () => {
  // (a) intent recorded, change never made, nothing else touched: the apply simply runs again.
  const retry = fixture();
  await succeededOp(retry, 'video-shot01-r0');
  await succeededOp(retry, 'video-check-shot01-r0');
  const retryPosts = [];
  let injected = false;
  interrupt = state => {
    const job = Object.values(state.rework || {})[0];
    if (!job?.applying || injected) return false;
    injected = true; return true;
  };
  await assert.rejects(applyRework(retry.context, TARGET, '用户确认',
    { client: plannerClient({ posts: retryPosts }), log: () => {} }), /SIMULATED_CRASH_AFTER_CHANGE/);
  const parked = readJson(retry.stateFile);
  const parkedJob = Object.keys(parked.rework)[0];
  assert.equal(parked.rework[parkedJob].stage, 'apply');
  assert.ok(parked.rework[parkedJob].applying);
  assert.equal(parked.editRevision, undefined);            // nothing was applied
  assert.equal(historyFor(parked, 'script-revision').length, 0);
  const resumed = await applyRework(retry.context, TARGET, '用户确认',
    { client: plannerClient({ posts: retryPosts }), log: () => {} });
  assert.equal(resumed.review.verdict, 'pass');
  const applied = readJson(retry.stateFile);
  assert.equal(applied.rework[parkedJob].applied.mode, 'revise');
  assert.equal(applied.rework[parkedJob].applied.recovered, undefined);   // re-run, not "marked applied"
  assert.equal(applied.editRevision, 1);
  assert.equal(historyFor(applied, 'script-revision').length, 1);
  assert.equal(retryPosts.filter(p => p.purpose.includes('返工执行模型')).length, 1);

  // (b) intent recorded, another revision finishes instead: the parked instruction stays refused.
  const stale = fixture();
  await succeededOp(stale, 'video-shot01-r0');
  await succeededOp(stale, 'video-check-shot01-r0');
  const stalePosts = [];
  let once = false;
  interrupt = state => {
    const job = Object.values(state.rework || {})[0];
    if (!job?.applying || once) return false;
    once = true; return true;
  };
  await assert.rejects(applyRework(stale.context, TARGET, '用户确认',
    { client: plannerClient({ posts: stalePosts }), log: () => {} }), /SIMULATED_CRASH_AFTER_CHANGE/);
  const next = structuredClone(readJson(stale.stateFile).script);
  next.shots[1].action = '其它修订改动的第二镜动作';
  await reviseScript(stale.context, next, '另一条修订先完成');
  const external = readJson(stale.stateFile);
  const externalJob = Object.keys(external.rework)[0];
  assert.ok(external.rework[externalJob].applying);        // the intent is still parked
  await assert.rejects(applyRework(stale.context, TARGET, '用户确认',
    { client: plannerClient({ posts: stalePosts }), log: () => {} }), /REWORK_STALE_INPUT:/);
  const after = readJson(stale.stateFile);
  assert.equal(after.script.shots[1].action, '其它修订改动的第二镜动作');   // the newer state survived
  assert.equal(after.editRevision, external.editRevision);
  assert.equal(historyFor(after, 'script-revision').length, 1);           // only the external revision
  assert.equal(after.assets.shot01.video, 'old.mp4');                     // the rework never touched it
  assert.equal(stalePosts.filter(p => p.purpose.includes('返工执行模型')).length, 1);
});

test('a look-alike history entry with the same note is never mistaken for this rework own change', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const posts = [];
  let once = false;
  interrupt = state => {
    const job = Object.values(state.rework || {})[0];
    if (!job?.applying || once) return false;
    once = true; return true;                       // park the intent before any change is made
  };
  await assert.rejects(applyRework(f.context, TARGET, '用户确认', { client: plannerClient({ posts }), log: () => {} }),
    /SIMULATED_CRASH_AFTER_CHANGE/);
  const parked = readJson(f.stateFile);
  const jobId = Object.keys(parked.rework)[0];
  assert.ok(parked.rework[jobId].applying);
  // A manual revision that reuses exactly the same wording — and even the same revision step — is not ours.
  const note = '模型返工指令（' + TARGET + '）：最小改动；用户确认：用户确认';
  const next = structuredClone(parked.script);
  next.shots[1].action = '手工修订改动的第二镜动作';
  await reviseScript(f.context, next, note);
  const lookAlike = readJson(f.stateFile);
  assert.equal(historyFor(lookAlike, 'script-revision').length, 1);
  assert.equal(lookAlike.history.at(-1).reason, note);         // the note matches ours exactly
  assert.equal(lookAlike.editRevision, 1);                     // and the revision step matches too
  await assert.rejects(applyRework(f.context, TARGET, '用户确认', { client: plannerClient({ posts }), log: () => {} }),
    /REWORK_STALE_INPUT:/);
  const after = readJson(f.stateFile);
  assert.equal(after.rework[jobId].applied, undefined);        // never claimed as applied
  assert.ok(after.rework[jobId].applying);                     // the intent stays parked for a real decision
  assert.equal(after.script.shots[0].videoAction, '旧动作');    // our patch was never written
  assert.equal(after.script.shots[1].action, '手工修订改动的第二镜动作');
});
