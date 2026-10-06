const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { Budget } = require('../services/aliyun/budget');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { applyRework } = require('../workflows/rework');
const ROOT = path.resolve(__dirname, '..');
const PLANNER = 'qwen3.8-omni-flash';
const TARGET = 'video-shot01';

function fixture({ videoStatus = 'succeeded', videoRevision = 0 } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'rework-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: PLANNER, promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'rework-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  const production = { id: 'rework-film', description: '返工闭环隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  const script = readJson(path.join(ROOT, 'examples/script.json'));
  const directory = path.join(root, 'jobs', 'aliyun', 'rework-film');
  const source = { id: 'character01', image: media.image(image).hash, sample: media.audio(sample, true).hash, front: null };
  const registryKey = hash({ source, traits: production.characters[0].traits,
    speechModel: config.models.speech, portraitModel: config.models.portrait });
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'rework-film',
    characters: { character01: { original: image, front: image, sample, traits: '测试', originalHash: fileHash(image),
      frontHash: fileHash(image), sampleHash: fileHash(sample), accepted: true,
      registryFile: path.join(root, 'jobs', 'aliyun', 'characters', registryKey, 'character.json') } },
    approvals: { 'video-shot01': 'digest-before', 'video-shot02': 'digest-other' },
    assets: { shot01: { first: image, last: image, video: image, frameReview: { pass: true, issues: [] } } },
    revisions: videoRevision ? { 'video-shot01': videoRevision, 'video-check-shot01': videoRevision } : {},
    script, reworkAdvice: { [TARGET]: [{ model: PLANNER, advice: '第五镜动作不连贯，重做该镜动作', scope: 'video',
      requiresPaidRetry: true, userAction: '用户决定是否付费重做', checkedBy: { model: config.models.vision, operation: 'video-check-shot01-r0' },
      at: new Date().toISOString() }] } });
  const context = loadContext(root, 'production.json');
  return { root, directory, config, media, context, script, image };
}
async function succeededOp(f, id, cents = 20) {
  const budget = new Budget(f.root, f.config, f.directory);
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents };
  await budget.reserve(id, cents, hash(spec));
  writeJson(path.join(f.directory, 'operations', id + '.json'), { id, fingerprint: hash(spec), status: 'succeeded', spec });
  return budget;
}
function plannerClient(overrides = {}) {
  const seen = [];
  const reply = json => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(json) } }] });
  return { seen, request: async (endpoint, body) => {
    const prompt = JSON.stringify(body.messages || []);
    seen.push({ endpoint, model: body.model, prompt });
    if (!endpoint.includes('chat/completions') || body.model !== PLANNER) throw new Error('NON_PLANNER_REQUEST:' + endpoint + ':' + body.model);
    if (prompt.includes('返工执行模型')) return reply(overrides.instruction || { shotId: 'shot01', scope: 'video',
      patch: { videoAction: '按返工意见重做动作' }, rationale: '最小改动' });
    if (prompt.includes('独立审核模型')) return reply(overrides.review || { verdict: 'pass', summary: '修订后可用', contextIssues: [],
      durationIssues: [], estimatedDurationSeconds: 9, longShots: [], advice: null });
    throw new Error('UNEXPECTED_PLANNER_PROMPT');
  } };
}

test('a recorded advisory becomes a revision instruction and is re-reviewed without generating media', async () => {
  const f = fixture();
  await succeededOp(f, 'video-shot01-r0');
  await succeededOp(f, 'video-check-shot01-r0');
  const client = plannerClient();
  const result = await applyRework(f.context, TARGET, '用户确认按建议返工', { client, log: () => {} });
  assert.equal(result.instruction.shotId, 'shot01');
  assert.deepEqual(result.instruction.patch, ['videoAction']);
  assert.equal(result.review.verdict, 'pass');
  const state = readJson(path.join(f.directory, 'state.json'));
  assert.equal(state.script.shots[0].videoAction, '按返工意见重做动作'); // the model instruction reached the script
  assert.equal(state.script.shots[1].videoAction, f.script.shots[1].videoAction);
  assert.equal(state.revisions['video-shot01'], 1);                      // existing controlled invalidation
  assert.equal(state.revisions['video-check-shot01'], 1);
  assert.equal(state.revisions['video-shot02'], undefined);
  assert.equal(state.approvals['video-shot01'], undefined);              // the user must approve again
  assert.equal(state.approvals['video-shot02'], 'digest-other');
  assert.equal(state.stage, 'script');
  assert.equal(state.pendingReview, undefined);
  assert.equal(state.scriptReview.scriptHash, hash(state.script));       // re-reviewed against the new digest
  assert.equal(state.scriptReview.verdict, 'pass');
  assert.equal(state.reworkAdvice[TARGET].length, 1);                    // the advisory is preserved
  assert.equal(state.reworkApplied.length, 1);
  assert.equal(state.reworkApplied[0].instruction.basedOn.checkedBy.operation, 'video-check-shot01-r0');
  assert.equal(state.reworkApplied[0].review.scriptHash, hash(state.script));
  assert.equal(client.seen.length, 2);                                   // instruction + re-review only
  assert.deepEqual(client.seen.map(x => x.model), [PLANNER, PLANNER]);
  assert.equal(client.seen.some(x => /image|video-synthesis|tts|uploads/.test(x.endpoint)), false);
  const ledger = readJson(path.join(f.directory, 'api-ledger.json')).entries;
  assert.deepEqual(ledger.filter(e => e.id.startsWith('plan-')).map(e => e.reservedCents), [20, 20]);
  assert.equal(ledger.filter(e => e.id === 'video-shot01-r0').length, 1);
});

test('rework refuses before spending anything when the limit is reached or the operation is unresolved', async () => {
  const limited = fixture({ videoRevision: 1 });
  await succeededOp(limited, 'video-shot01-r1');
  await succeededOp(limited, 'video-check-shot01-r1');
  // The unit used its first generation and all three reworks: the round ledger pauses it.
  writeJson(path.join(limited.directory, 'unit-attempts.json'), { version: 1, units: { 'video-shot01': {
    generations: 4, reworks: 3, consumed: {}, pending: null,
    exhausted: { at: '2026-09-22T00:00:00.000Z', generations: 4, reason: '测试：三次返工仍未通过' } } } });
  const limitedState = path.join(limited.directory, 'state.json');
  const limitedLedger = path.join(limited.directory, 'api-ledger.json');
  const stateBefore = fileHash(limitedState), ledgerBefore = fileHash(limitedLedger);
  const limitClient = plannerClient();
  await assert.rejects(applyRework(limited.context, TARGET, '用户确认', { client: limitClient, log: () => {} }),
    /REWORK_ATTEMPTS_EXHAUSTED:video-shot01-r1/);
  assert.equal(limitClient.seen.length, 0);
  assert.equal(fileHash(limitedState), stateBefore);
  assert.equal(fileHash(limitedLedger), ledgerBefore);

  const blocked = fixture();
  await succeededOp(blocked, 'video-shot01-r0');
  const opFile = path.join(blocked.directory, 'operations', 'video-shot01-r0.json');
  writeJson(opFile, { ...readJson(opFile), status: 'submitting' });
  const blockedState = path.join(blocked.directory, 'state.json');
  const blockedLedger = path.join(blocked.directory, 'api-ledger.json');
  const opBefore = fileHash(opFile), blockedStateBefore = fileHash(blockedState), blockedLedgerBefore = fileHash(blockedLedger);
  const blockedClient = plannerClient();
  await assert.rejects(applyRework(blocked.context, TARGET, '用户确认', { client: blockedClient, log: () => {} }),
    /REWORK_BLOCKED_UNRESOLVED_OPERATION:video-shot01-r0:submitting/);
  assert.equal(blockedClient.seen.length, 0);
  assert.equal(fileHash(opFile), opBefore);                    // evidence kept, nothing resent
  assert.equal(fileHash(blockedState), blockedStateBefore);
  assert.equal(fileHash(blockedLedger), blockedLedgerBefore);
});
