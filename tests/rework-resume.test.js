const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { applyRework } = require('../workflows/rework');
const { reviseScript } = require('../workflows/revise');
const ROOT = path.resolve(__dirname, '..');
const PLANNER = 'qwen3.8-omni-flash';
const TARGET = 'video-shot01';

// Isolated job with a recorded advisory, one succeeded video group and one rework-capable planner.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'rw-resume-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: PLANNER, promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'rw-resume-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  const production = { id: 'rw-resume-film', description: '返工恢复隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  const script = readJson(path.join(ROOT, 'examples/script.json'));
  const directory = path.join(root, 'jobs', 'aliyun', 'rw-resume-film');
  const source = { id: 'character01', image: media.image(image).hash, sample: media.audio(sample, true).hash, front: null };
  const registryKey = hash({ source, traits: production.characters[0].traits,
    speechModel: config.models.speech, portraitModel: config.models.portrait });
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'rw-resume-film',
    characters: { character01: { original: image, front: image, sample, traits: '测试', originalHash: fileHash(image),
      frontHash: fileHash(image), sampleHash: fileHash(sample), accepted: true,
      registryFile: path.join(root, 'jobs', 'aliyun', 'characters', registryKey, 'character.json') } },
    approvals: { 'video-shot01': 'digest-before', 'video-shot02': 'digest-other' },
    assets: { shot01: { first: image, last: image, video: image, frameReview: { pass: true, issues: [] } } },
    script, reworkAdvice: { [TARGET]: [{ model: PLANNER, advice: '第一镜动作不连贯，重做该镜动作', scope: 'video',
      requiresPaidRetry: true, userAction: '用户决定是否付费重做',
      checkedBy: { model: config.models.vision, operation: 'video-check-shot01-r0' }, at: new Date().toISOString() }] } });
  const context = loadContext(root, 'production.json');
  return { root, directory, config, media, context, script, stateFile: path.join(directory, 'state.json') };
}
async function succeededOp(f, id, cents = 20) {
  const budget = new Budget(f.root, f.config, f.directory);
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents };
  await budget.reserve(id, cents, hash(spec));
  writeJson(path.join(f.directory, 'operations', id + '.json'), { id, fingerprint: hash(spec), status: 'succeeded', spec });
}
// Provider stand-in that answers by purpose and can be made to fail a chosen purpose once.
function plannerClient({ failReview = false, posts = [] } = {}) {
  const reply = json => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(json) } }] });
  return { posts, request: async (endpoint, body) => {
    const purpose = JSON.stringify(body.messages || []);
    posts.push({ endpoint, model: body.model, purpose });
    if (!endpoint.includes('chat/completions') || body.model !== PLANNER) throw new Error('NON_PLANNER_REQUEST:' + endpoint + ':' + body.model);
    if (purpose.includes('返工执行模型')) return reply({ shotId: 'shot01', scope: 'video',
      patch: { videoAction: '按返工意见重做动作' }, rationale: '最小改动' });
    if (purpose.includes('独立审核模型')) {
      if (failReview) throw new Error('timeout');
      return reply({ verdict: 'pass', summary: '修订后可用', contextIssues: [], durationIssues: [],
        estimatedDurationSeconds: 9, longShots: [], advice: null });
    }
    throw new Error('UNEXPECTED_PLANNER_PROMPT');
  } };
}
const replyJson = json => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(json) } }] });

test('an interrupted review resumes without paying twice or applying the change twice', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const posts = [];
  await assert.rejects(applyRework(f.context, TARGET, '用户确认按建议返工',
    { client: plannerClient({ failReview: true, posts }), log: () => {} }),
  /REWORK_REVIEW_BLOCKED_UNCERTAIN:rework-1-video-shot01/);
  const afterFirst = readJson(f.stateFile);
  assert.equal(posts.filter(p => p.purpose.includes('返工执行模型')).length, 1);
  assert.equal(posts.filter(p => p.purpose.includes('独立审核模型')).length, 1);
  assert.equal(afterFirst.script.shots[0].videoAction, '按返工意见重做动作');   // the change was applied once
  assert.equal(afterFirst.editRevision, 1);
  assert.equal(afterFirst.revisions['video-shot01'], 1);
  const job = afterFirst.rework['rework-1-video-shot01'];
  assert.equal(job.stage, 'review');
  assert.match(job.blocked.reason, /SUBMISSION_UNCERTAIN/);

  const opsDir = path.join(f.directory, 'operations');
  const reviewName = fs.readdirSync(opsDir).find(name => name.startsWith('plan-script-review-'));
  const reviewOp = readJson(path.join(opsDir, reviewName));
  assert.equal(reviewOp.status, 'uncertain');                                  // evidence kept, never resent

  // A resumed run must not resend the unresolved review nor apply the change a second time.
  await assert.rejects(applyRework(f.context, TARGET, '用户确认按建议返工',
    { client: plannerClient({ posts }), log: () => {} }), /REWORK_REVIEW_BLOCKED_UNCERTAIN/);
  assert.equal(posts.length, 2);                                               // nothing new was sent
  const afterSecond = readJson(f.stateFile);
  assert.equal(afterSecond.editRevision, 1);
  assert.equal(afterSecond.revisions['video-shot01'], 1);
  assert.equal(afterSecond.reworkApplied, undefined);

  // The user verified the original submission, then the same command continues on the same operation id.
  new Operations(opsDir, plannerClient(), new Budget(f.root, f.config, f.directory)).adoptResponse(reviewOp.id,
    { operationId: reviewOp.id, fingerprint: reviewOp.fingerprint, result: { request_id: 'req-1', choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify({ verdict: 'pass', summary: '修订后可用', contextIssues: [], durationIssues: [],
        estimatedDurationSeconds: 9, longShots: [], advice: null }) } }] } },
    '控制台确认该请求已完成，返回结构与预期一致');
  const done = await applyRework(f.context, TARGET, '用户确认按建议返工', { client: plannerClient({ posts }), log: () => {} });
  assert.equal(done.review.verdict, 'pass');
  assert.equal(posts.length, 2);                                               // the reconciled result was reused
  const finished = readJson(f.stateFile);
  assert.equal(finished.rework['rework-1-video-shot01'].stage, 'done');
  assert.equal(finished.reworkApplied.length, 1);
  assert.equal(finished.editRevision, 1);
  const settled = fileHash(f.stateFile);
  const again = await applyRework(f.context, TARGET, '用户确认按建议返工', { client: plannerClient({ posts }), log: () => {} });
  assert.equal(again.alreadyApplied, true);
  assert.equal(posts.length, 2);
  assert.equal(fileHash(f.stateFile), settled);                                // a repeated command changes nothing
});

test('an instruction that became stale is refused instead of overwriting a newer revision', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const posts = [];
  const base = plannerClient({ posts });
  const widening = { ...base, request: async (endpoint, body) => {
    const purpose = JSON.stringify(body.messages || []);
    if (!purpose.includes('返工执行模型')) return base.request(endpoint, body);
    posts.push({ endpoint, purpose });
    return replyJson({ shotId: 'shot01', scope: 'speech', patch: { text: '被替换的台词' }, rationale: '扩大范围' });
  } };
  // The instruction widens the scope, so the apply stage refuses and the job stays parked at 'apply'.
  await assert.rejects(applyRework(f.context, TARGET, '用户确认', { client: widening, log: () => {} }),
    /REWORK_SCOPE_EXPANSION_REQUIRES_USER:speech-shot01/);
  const parked = readJson(f.stateFile);
  assert.equal(parked.rework['rework-1-video-shot01'].stage, 'apply');
  assert.equal(parked.script.shots[0].text, f.script.shots[0].text);           // nothing was applied

  // Another revision finishes while the instruction is parked.
  const next = structuredClone(parked.script);
  next.shots[1].action = '第二镜动作已由其它修订改动';
  await reviseScript(f.context, next, '另一条修订先完成');
  const newer = readJson(f.stateFile);
  assert.equal(newer.script.shots[1].action, '第二镜动作已由其它修订改动');

  await assert.rejects(applyRework(f.context, TARGET, '用户确认', { client: plannerClient({ posts }), log: () => {} }),
    /REWORK_STALE_INPUT:rework-1-video-shot01/);
  const after = readJson(f.stateFile);
  assert.equal(after.script.shots[1].action, '第二镜动作已由其它修订改动');     // the newer state survived
  assert.equal(after.script.shots[0].text, f.script.shots[0].text);
  assert.equal(after.editRevision, newer.editRevision);                        // no extra revision or apply
  assert.ok(!after.revisions['video-shot01']);                                 // the parked instruction was never applied
});

test('two concurrent apply-rework calls submit and apply at most once', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const posts = [];
  const client = { posts, request: async (endpoint, body) => {
    const purpose = JSON.stringify(body.messages || []);
    posts.push({ endpoint, purpose });
    await new Promise(resolve => setTimeout(resolve, 60));
    if (purpose.includes('返工执行模型'))
      return replyJson({ shotId: 'shot01', scope: 'video', patch: { videoAction: '按返工意见重做动作' }, rationale: '最小改动' });
    if (purpose.includes('独立审核模型'))
      return replyJson({ verdict: 'pass', summary: '修订后可用', contextIssues: [], durationIssues: [],
        estimatedDurationSeconds: 9, longShots: [], advice: null });
    throw new Error('UNEXPECTED_PLANNER_PROMPT');
  } };
  const results = await Promise.allSettled([applyRework(f.context, TARGET, '并发确认一', { client, log: () => {} }),
    applyRework(f.context, TARGET, '并发确认二', { client, log: () => {} })]);
  assert.equal(posts.filter(p => p.purpose.includes('返工执行模型')).length, 1);      // one paid instruction
  assert.ok(posts.filter(p => p.purpose.includes('独立审核模型')).length <= 1);
  const state = readJson(f.stateFile);
  assert.equal(state.editRevision, 1);                                               // applied exactly once
  assert.equal(state.revisions['video-shot01'], 1);
  assert.equal(state.reworkApplied.length, 1);
  const ledger = readJson(path.join(f.directory, 'api-ledger.json')).entries;
  assert.equal(ledger.filter(e => e.id.startsWith('plan-rework-instruction-')).length, 1);
  for (const result of results) if (result.status === 'rejected')
    assert.match(result.reason.message,
      /BUSY_OR_STALE_LOCK|SUBMISSION_CLAIM_HELD|REWORK_STALE_INPUT|OPERATION_REQUIRES_RECONCILIATION|REWORK_REVIEW_BLOCKED_UNCERTAIN/);
});
