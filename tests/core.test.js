const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget, estimateCents } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { readJson, writeJson, hash, withLock, redact, fileHash } = require('../services/aliyun/io');
const { validateProduction, validateScript, timedScript } = require('../services/aliyun/schema');
const { subtitles } = require('../services/aliyun/media');
const { videoRequest } = require('../services/aliyun/models');
const { AliyunClient } = require('../services/aliyun/client');
const ROOT = path.resolve(__dirname, '..');
function fixture(limit = 70) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'unit-'));
  const config = { onlineEnabled: true, authorizationFile: 'auth.json', region: 'cn-beijing' };
  const directory = path.join(root, 'film');
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'film', providers: ['deepseek', 'aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: limit });
  return { root, config, directory, budget: new Budget(root, config, directory) };
}
function scriptFixture() {
  const p = readJson(path.join(ROOT, 'examples/production.json'));
  const script = readJson(path.join(ROOT, 'examples/script.json'));
  return { p, script };
}
const SPEC = { endpoint: '/example', model: 'example', cents: 20, async: true };

test('BOM JSON and atomic persistence', () => {
  const f = fixture(), file = path.join(f.root, 'bom.json');
  fs.writeFileSync(file, '\ufeff{"value":1}'); assert.equal(readJson(file).value, 1);
  writeJson(file, { value: 2 }); assert.equal(fs.readFileSync(file)[0], 123);
});
test('unknown prices are reported as unknown and invalid units are still rejected', () => {
  // An unverified price is no longer an error: it is reported as unknown so the caller can record it.
  assert.equal(estimateCents('video', 'unknown'), null);
  assert.throws(() => estimateCents('speech', 'qwen3-tts-vc-2026-01-22', NaN), /INVALID_BUDGET_UNITS/);
  assert.throws(() => estimateCents('video', 'wan2.7-i2v', 0), /INVALID_BUDGET_UNITS/);
  assert.equal(estimateCents('video', 'wan2.2-kf2v-flash', 5), 240);
  assert.equal(estimateCents('image', 'qwen-image-3.0', 1, 3), 24);
});
test('no online authorization means no reservation or request', async () => {
  const f = fixture(); f.config.onlineEnabled = false;
  let calls = 0;
  const o = new Operations(path.join(f.directory, 'operations'), { request: async () => { calls++; } }, f.budget);
  await assert.rejects(o.execute('one', SPEC, async () => ({})), /ONLINE_DISABLED/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(f.budget.file), false);
});
test('expired and wrong-film authorizations are rejected with a precise reason', async () => {
  const f = fixture(), auth = readJson(path.join(f.root, 'auth.json'));
  auth.productionId = 'another'; writeJson(path.join(f.root, 'auth.json'), auth);
  await assert.rejects(f.budget.reserve('a', 1, 'h'), /API_AUTHORIZATION_PRODUCTION_MISMATCH/);
  auth.productionId = 'film'; auth.expiresAt = '2020-01-01'; writeJson(path.join(f.root, 'auth.json'), auth);
  await assert.rejects(f.budget.reserve('a', 1, 'h'), /API_AUTHORIZATION_EXPIRED/);
  auth.expiresAt = new Date(Date.now() + 86400000).toISOString(); auth.enabled = false; writeJson(path.join(f.root, 'auth.json'), auth);
  await assert.rejects(f.budget.reserve('a', 1, 'h'), /API_AUTHORIZATION_DISABLED/);
});
test('budget records reservations idempotently and no longer blocks on the historical amount', async () => {
  const f = fixture(1);
  await f.budget.reserve('a', 80, 'h'); await f.budget.reserve('a', 80, 'h');
  assert.equal(f.budget.report().committedCents, 80);
  // Above the historical amount the reservation is still recorded; the work is never blocked.
  const entry = await f.budget.reserve('b', 21, 'h2');
  assert.equal(entry.reservedCents, 21);
  assert.equal(entry.actualCents, null);
  assert.equal(entry.estimateIsNotActualCharge, true);
  assert.equal(f.budget.report().committedCents, 101);
  assert.equal(f.budget.checkAvailable(5000).blocking, false);
  // An unknown price is recorded as unknown: not counted as an amount and never as zero.
  const unknown = await f.budget.reserve('c', null, 'h3');
  assert.equal(unknown.reservedCents, null);
  assert.equal(unknown.costStatus, 'unknown-price-awaiting-bill');
  assert.equal(f.budget.report().committedCents, 101);
  assert.equal(f.budget.report().unknownEntries, 1);
  await assert.rejects(f.budget.reserve('a', 70, 'changed'), /CONFLICT/);
});
test('settlement requires evidence; a real cost above the reservation is recorded without blocking', async () => {
  const f = fixture(1);
  await f.budget.reserve('a', 80, 'h');
  await assert.rejects(f.budget.settle('a', 0, ''), /EVIDENCE/);
  await f.budget.settle('a', 120, 'provider bill reference');
  await f.budget.settle('a', 120, 'provider bill reference');
  assert.equal(f.budget.report().committedCents, 120);
  // The settled cost is above both the reservation and the historical amount: still no block.
  const entry = await f.budget.reserve('b', 1, 'b');
  assert.equal(entry.reservedCents, 1);
  assert.equal(f.budget.report().committedCents, 121);
  assert.equal(f.budget.report().actualCostKnown, false);
});
test('concurrent reservations cannot overspend', async () => {
  const f = fixture(1);
  const result = await Promise.allSettled([f.budget.reserve('a', 80, 'a'), f.budget.reserve('b', 80, 'b')]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.budget.report().committedCents, 80);
});
test('POST timeout stays uncertain and resume never resubmits', async () => {
  const f = fixture(); let calls = 0;
  const o = new Operations(path.join(f.directory, 'operations'), { request: async () => { calls++; throw new Error('timeout'); } }, f.budget);
  await assert.rejects(o.execute('a', SPEC, async () => ({})), /UNCERTAIN/);
  await assert.rejects(o.execute('a', SPEC, async () => ({})), /RECONCILIATION/);
  assert.equal(calls, 1); assert.equal(f.budget.report().committedCents, 20);
});
test('pending async tasks resume by GET and do not POST twice', async () => {
  const f = fixture(); let posts = 0, ready = false;
  const client = { request: async () => { posts++; return { output: { task_id: 'provider-task' } }; },
    task: async () => ({ output: { task_status: ready ? 'SUCCEEDED' : 'RUNNING', video_url: 'https://example.aliyuncs.com/a.mp4' } }) };
  const o = new Operations(path.join(f.directory, 'operations'), client, f.budget, () => {}, 0, 0);
  await assert.rejects(o.execute('a', SPEC, async () => ({})), /TASK_PENDING/);
  ready = true;
  await o.execute('a', SPEC, async () => ({})); await o.execute('a', SPEC, async () => ({}));
  assert.equal(posts, 1); assert.equal(f.budget.report().committedCents, 20);
  assert.equal(f.budget.report().actualCostKnown, false);
});
test('failed task does not release reservation or auto retry', async () => {
  const f = fixture(); let posts = 0;
  const o = new Operations(path.join(f.directory, 'operations'),
    { request: async () => { posts++; return { output: { task_id: 'p' } }; }, task: async () => ({ output: { task_status: 'FAILED' } }) }, f.budget);
  await assert.rejects(o.execute('a', SPEC, async () => ({})), /PROVIDER_TASK_FAILED/);
  await assert.rejects(o.execute('a', SPEC, async () => ({})), /RECONCILIATION/);
  assert.equal(posts, 1); assert.equal(f.budget.report().committedCents, 20);
});
test('changed operation cannot replace an existing request', async () => {
  const f = fixture();
  const o = new Operations(path.join(f.directory, 'operations'), { request: async () => ({ output: { voice: 'v' } }) }, f.budget);
  await o.execute('a', { ...SPEC, async: false }, async () => ({}));
  await assert.rejects(o.execute('a', { ...SPEC, async: false, model: 'other' }, async () => ({})), /INPUT_CHANGED/);
});
test('adopt an uncertain async task only with evidence', async () => {
  const f = fixture(), o = new Operations(path.join(f.directory, 'operations'), { request: async () => { throw new Error('timeout'); } }, f.budget);
  await assert.rejects(o.execute('a', SPEC, async () => ({})));
  assert.throws(() => o.adoptTask('a', 'found-task', ''), /EVIDENCE/);
  o.adoptTask('a', 'found-task', 'matched on provider console');
  assert.equal(readJson(path.join(f.directory, 'operations', 'a.json')).taskId, 'found-task');
});
test('script rejects wrong speakers, unsupported duration and duplicate ids', () => {
  const { p, script } = scriptFixture(); validateProduction(p); validateScript(script, p);
  const bad = structuredClone(script); bad.shots[0].speaker = 'unknown';
  assert.throws(() => validateScript(bad, p), /SPEAKER/);
  bad.shots = [structuredClone(script.shots[1])]; bad.shots[0].duration = 6;
  assert.throws(() => validateScript(bad, p), /5_SECONDS/);
  bad.shots = [script.shots[1], script.shots[1]];
  assert.throws(() => validateScript(bad, p), /DUPLICATE/);
});
test('actual speech length sets timeline; long speech is never truncated', () => {
  const { p, script } = scriptFixture();
  const timed = timedScript(script, { shot01: 6.4 }, p);
  assert.equal(timed.shots[0].duration, 7); assert.equal(timed.shots[1].start, 7);
  assert.equal(timed.totalDuration, 12);
  assert.match(subtitles(timed), /00:00:00,000 --> 00:00:06,400/);
  assert.throws(() => timedScript(script, { shot01: 15 }, p), /DIALOGUE_TOO_LONG/);
});
test('video request uses separate documented contracts and audio drives dialogue', () => {
  const config = readJson(path.join(ROOT, 'config/aliyun.json')), { script } = scriptFixture();
  const talk = videoRequest(config, script.shots[0], 'first', 'last', 'sound');
  assert.equal(talk.body.model, 'wan2.7-i2v');
  assert.deepEqual(talk.body.input.media.map(m => m.type), ['first_frame', 'last_frame', 'driving_audio']);
  const action = videoRequest(config, script.shots[1], 'f', 'l', null);
  assert.equal(action.body.input.last_frame_url, 'l'); assert.equal(action.body.parameters.duration, 5);
  assert.throws(() => videoRequest(config, { ...script.shots[1], duration: 10 }, 'f', 'l', null));
});
test('there is no second text provider and image-less generation is refused', async () => {
  const { Models } = require('../services/aliyun/models');
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'deepseek.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'intake.js')), false);
  const models = new Models({ models: { vision: 'qwen-vl-plus' } }, { execute: async () => ({}) }, { visionImage: () => 'x' }, ROOT);
  await assert.rejects(models.json('script-r0', '写一个脚本'), /PLANNER_REQUIRED_FOR_TEXT/);
});
test('downloads reject non-provider destinations without network', async () => {
  let calls = 0;
  const client = new AliyunClient({ apiKey: 'test', fetchImpl: async () => { calls++; } });
  await assert.rejects(client.download('https://example.com/a', 'unused'), /UNTRUSTED/);
  assert.equal(calls, 0);
});
test('logs redact keys, data URIs, and signed result links', () => {
  const result = redact('Bearer abc sk-secrethere data:image/png;base64,abcd https://x.aliyuncs.com/a?token=secret');
  assert.ok(!result.includes('abc')); assert.ok(!result.includes('secrethere')); assert.ok(!result.includes('token='));
});
test('a brief binds the current materials without requiring any author field', () => {
  const { loadBrief, briefState } = require('../services/brief');
  const f = fixture(), image = path.join(f.root, 'image.png'), sample = path.join(f.root, 'sample.wav');
  fs.writeFileSync(image, 'image'); fs.writeFileSync(sample, 'voice');
  const p = { id: 'film', description: 'story', intakeFile: 'brief.json', characters: [{ id: 'a', image, voiceSample: sample }] };
  const payload = { productionId: 'film', descriptionHash: hash('story'), storySummary: 'story', shotGuidance: 'guidance',
    characters: [{ id: 'a', imageSha256: fileHash(image), voiceSha256: fileHash(sample), frontSha256: null, visualAnalysis: 'inspected', voiceAnalysis: 'reviewed' }] };
  writeJson(path.join(f.root, 'brief.json'), { ...payload, preparedBy: 'legacy-assistant' });
  const historical = loadBrief(f.root, p, null);
  assert.equal(historical.brief.storySummary, 'story');
  assert.equal(historical.source.historical, true);
  assert.equal(historical.source.role, 'external-source');
  assert.equal(briefState({ ...payload, preparedBy: 'anything-at-all' }, p).usable, true);
  writeJson(path.join(f.root, 'brief.json'), { ...payload, generatedBy: 'qwen3.8-omni-flash' });
  assert.equal(loadBrief(f.root, p, null).source.role, 'model');
  fs.writeFileSync(sample, 'changed');
  assert.equal(loadBrief(f.root, p, null), null);
  assert.match(briefState(payload, p).reason, /MATERIALS_MISMATCH/);
});

test('remaining plan counts settled and pending operations only once at the exact limit', async () => {
  const f = fixture(1);
  await f.budget.reserve('audio-r0', 20, 'audio');
  await f.budget.reserve('video-r0', 60, 'video');
  const plan = [{id:'audio-r0',cents:20},{id:'video-r0',cents:60},{id:'check-r0',cents:20}];
  const first = f.budget.checkPlan(plan);
  assert.equal(first.additionalCents, 20, JSON.stringify(first));
  assert.equal(first.committedCents, 80);
  assert.equal(first.projectedCents, 100);
  assert.equal(first.blocking, false);
  await f.budget.completed('audio-r0', {});
  await f.budget.settle('audio-r0', 10, 'bill-a');
  assert.equal(f.budget.checkPlan(plan).projectedCents,90);
  // A plan above the historical amount is projected, never refused.
  const over = f.budget.checkPlan([...plan,{id:'new-r0',cents:11}]);
  assert.equal(over.projectedCents, 101);
  assert.equal(over.blocking, false);
  // Unknown prices are counted as unknown items and add no amount.
  const unknown = f.budget.checkPlan([{id:'unpriced-r0',cents:null}]);
  assert.equal(unknown.unknownItems, 1);
  assert.equal(unknown.additionalCents, 0);
  assert.throws(()=>f.budget.checkPlan([{id:'video-r0',cents:59}]),/CONFLICT/);
  assert.throws(()=>f.budget.checkPlan([plan[0],plan[0]]),/INVALID/);
});
test('production cost plan includes audio, exact frame references and both quality checks', () => {
  const { productionPlan } = require('../workflows/production-plan');
  const { script } = scriptFixture(), config=readJson(path.join(ROOT,'config/aliyun.json'));
  const state={script,characters:{character01:{original:'a',front:'b'}},revisions:{'video-shot01':1}};
  const plan=productionPlan(state,config);
  assert.equal(plan.find(p=>p.id==='first-shot01-r0').cents,22);
  assert.equal(plan.find(p=>p.id==='last-shot02-r0').cents,24);
  assert.ok(plan.some(p=>p.id==='voice-character01-r0'));
  assert.ok(plan.some(p=>p.id==='video-shot01-r1'));
  assert.equal(plan.filter(p=>p.id.includes('check-')).length,4);
  state.characters.character01.voice='cached';
  assert.equal(productionPlan(state,config).some(p=>p.id.startsWith('voice-')),false);
  assert.equal(productionPlan(state,config,true).length,4);
});

const { redo } = require('../workflows/redo');
async function redoFixture(status = 'succeeded', scope = 'video') {
  const f=fixture(), {script}=scriptFixture();
  f.config.maxAttemptsPerAsset=2;
  const ctx={root:f.root,directory:f.directory,config:f.config,production:{id:'film'}};
  const state={productionId:'film',script,characters:{},assets:{
    shot01:{audio:'audio-original.wav',first:'first-original.png',video:'video-original.mp4'},
    shot02:{video:'other-shot.mp4'}},revisions:{},approvals:{'video-shot01':'old'},stage:'final',
    output:'old-final.mp4',preview:'old-preview.mp4',timed:{...script,totalDuration:10}};
  writeJson(path.join(f.directory,'state.json'),state);
  const base=scope==='frames'?'first':scope==='speech'?'speech':'video';
  const id=base+'-shot01-r0';
  await f.budget.reserve(id,20,'old');
  writeJson(path.join(f.directory,'operations',id+'.json'),{id,status,taskId:'task',
    result:{output:{task_status:status==='failed'?'FAILED':status==='submitted'?'RUNNING':'SUCCEEDED'}}});
  return {...f,ctx,state,id};
}
test('local video redo preserves other shots, original assets and historical budget',async()=>{
  const f=await redoFixture(); f.config.onlineEnabled=false;
  const before=JSON.stringify(f.budget.report());
  const result=await redo(f.ctx,'shot01','video','武器动作不自然');
  const state=readJson(path.join(f.directory,'state.json'));
  assert.equal(result.revision,1);assert.equal(state.revisions['video-shot01'],1);
  assert.equal(state.assets.shot01.audio,'audio-original.wav');
  assert.equal(state.assets.shot01.first,'first-original.png');
  assert.equal(state.assets.shot02.video,'other-shot.mp4');
  assert.equal(state.assets.shot01.video,undefined);
  assert.equal(state.history[0].assets.video,'video-original.mp4');
  assert.equal(state.history[0].output,'old-final.mp4');
  assert.equal(state.output,undefined);
  assert.equal(JSON.stringify(f.budget.report()),before);
});
test('redo refuses every ambiguous or running target without changing state',async()=>{
  for(const status of ['uncertain','unknown','submitting','submitted']){
    const f=await redoFixture(status), before=fileHash(path.join(f.directory,'state.json'));
    await assert.rejects(redo(f.ctx,'shot01','video','test'),/UNRESOLVED/);
    assert.equal(fileHash(path.join(f.directory,'state.json')),before);
  }
});
test('frames redo is blocked by a running downstream video',async()=>{
  const f=await redoFixture('succeeded','frames');
  const id='video-shot01-r0';await f.budget.reserve(id,20,'running');
  writeJson(path.join(f.directory,'operations',id+'.json'),{id,status:'submitted'});
  await assert.rejects(redo(f.ctx,'shot01','frames','test'),/UNRESOLVED/);
  assert.equal(readJson(path.join(f.directory,'state.json')).revisions['first-shot01'],undefined);
});
test('confirmed failed task can be redone but its reservation stays committed',async()=>{
  const f=await redoFixture('failed');
  await redo(f.ctx,'shot01','video','provider confirmed failure');
  assert.equal(f.budget.report().committedCents,20);
});
test('redo refuses a missing operation record with an existing reservation',async()=>{
  const f=await redoFixture('succeeded','frames');
  await f.budget.reserve('video-shot01-r0',20,'lost');
  await assert.rejects(redo(f.ctx,'shot01','frames','test'),/RECORD_MISSING/);
});
test('redo enforces attempt limit and requires an actually attempted target',async()=>{
  const f=await redoFixture();
  await redo(f.ctx,'shot01','video','first redo');
  await assert.rejects(redo(f.ctx,'shot01','video','again before running'),/NOT_ATTEMPTED/);
  const id='video-shot01-r1';await f.budget.reserve(id,20,'second');
  writeJson(path.join(f.directory,'operations',id+'.json'),{id,status:'succeeded'});
  // The authoritative limit is the per-unit round ledger: four generations = the first plus 3 reworks.
  const { UnitAttempts } = require('../services/aliyun/units');
  const exhausted = { at: '2026-09-22T00:00:00.000Z', generations: 4, reason: '测试：三次返工仍未通过' };
  writeJson(path.join(f.directory,'unit-attempts.json'), { version: 1, units: { 'video-shot01': {
    generations: 4, reworks: 3, consumed: {}, pending: null, exhausted } } });
  assert.equal(new UnitAttempts(f.directory).status('video-shot01').remainingReworks, 0);
  await assert.rejects(redo(f.ctx,'shot01','video','fourth'),/REDO_ATTEMPTS_EXHAUSTED/);
  // A history that cannot be verified from records pauses the unit for audit instead of assuming zero.
  writeJson(path.join(f.directory,'unit-attempts.json'), { version: 1, units: { 'video-shot01': {
    generations: 0, reworks: 0, consumed: {}, pending: null, exhausted: null,
    needsAudit: 'RESERVED_OPERATION_RECORD_MISSING:video-shot01-r9' } } });
  await assert.rejects(redo(f.ctx,'shot01','video','unverifiable'),/REDO_ATTEMPTS_EXHAUSTED/);
});
test('speech redo invalidates duration and video but preserves frame assets',async()=>{
  const f=await redoFixture('succeeded','speech');
  await redo(f.ctx,'shot01','speech','语音停顿需要重做');
  const state=readJson(path.join(f.directory,'state.json'));
  assert.equal(state.assets.shot01.audio,undefined);
  assert.equal(state.assets.shot01.video,undefined);
  assert.equal(state.assets.shot01.first,'first-original.png');
  assert.equal(state.timed,undefined);
  assert.equal(state.revisions['driving-shot01'],1);
});
test('frame redo invalidates only affected frame and video assets',async()=>{
  const f=await redoFixture('succeeded','frames');
  await redo(f.ctx,'shot01','frames','面部不一致');
  const state=readJson(path.join(f.directory,'state.json'));
  assert.equal(state.assets.shot01.first,undefined);
  assert.equal(state.assets.shot01.video,undefined);
  assert.equal(state.assets.shot01.audio,'audio-original.wav');
  assert.equal(state.revisions['first-ready-shot01'],1);
});

test('corrupt derived cache is disposable while authoritative JSON fails closed', () => {
  const { readCache } = require('../services/aliyun/io');
  const f = fixture(), file = path.join(f.root, 'cache.json');
  fs.writeFileSync(file, '{broken');
  assert.equal(readCache(file), null);
  assert.throws(() => readJson(file));
  assert.equal(readCache(file + '.missing'), null);
});
test('expired asynchronous asset queries the original task without another POST', async () => {
  const { Models } = require('../services/aliyun/models');
  const f = fixture(); let posts = 0, queries = 0, downloads = 0;
  const client = {
    request: async () => { posts++; return { output: { task_id: 'original' } }; },
    task: async () => { queries++; return { output: { task_id: 'original', task_status: 'SUCCEEDED', video_url: queries === 1 ? 'expired' : 'fresh' } }; },
    download: async (url, dest) => { downloads++; if (url === 'expired') throw Error('DOWNLOAD_FAILED:403'); fs.writeFileSync(dest, 'media'); }
  };
  const ops = new Operations(path.join(f.directory, 'operations'), client, f.budget, () => {}, 0, 0);
  const models = new Models({}, ops, {}, f.root), dest = path.join(f.root, 'video.mp4');
  await models.asset('asset', SPEC, async () => ({}), dest, r => r.output.video_url);
  assert.equal(posts, 1); assert.equal(queries, 2); assert.equal(downloads, 2);
  fs.writeFileSync(dest + '.download.json', '{corrupt');
  await models.asset('asset', SPEC, async () => ({}), dest, r => r.output.video_url);
  assert.equal(posts, 1); assert.equal(downloads, 3);
  assert.equal(f.budget.report().entries.length, 1);
});
test('synchronous lost response recovery binds original fingerprint and never resubmits', async () => {
  const f = fixture(); let posts = 0;
  const ops = new Operations(path.join(f.directory, 'operations'), { request: async () => { posts++; throw Error('connection lost'); } }, f.budget);
  const spec = { endpoint: '/compatible-mode/v1/chat/completions', kind: 'planner', model: 'qwen3.8-omni-flash', cents: 50 };
  await assert.rejects(ops.execute('script', spec, async () => ({})), /UNCERTAIN/);
  const recovered = { operationId: 'script', fingerprint: hash(spec), result: { id: 'verified-response', choices: [{ finish_reason: 'stop', message: { content: '{"shots":[]}' } }] } };
  assert.throws(() => ops.adoptResponse('script', { ...recovered, fingerprint: 'wrong' }, 'verified provider record'), /EVIDENCE/);
  ops.adoptResponse('script', recovered, 'verified provider record');
  assert.deepEqual(await ops.execute('script', spec, async () => ({})), recovered.result);
  assert.equal(posts, 1);
  assert.equal(f.budget.report().entries[0].actualCents, null);
});
test('failed result refresh preserves succeeded task and synchronous URLs never resubmit', async () => {
  const { Models } = require('../services/aliyun/models');
  const f = fixture(), directory = path.join(f.directory, 'operations');
  writeJson(path.join(directory, 'video.json'), { id: 'video', status: 'succeeded', spec: SPEC, taskId: 'original', result: { output: { video_url: 'old' } } });
  const ops = new Operations(directory, { task: async () => ({ output: { task_status: 'UNKNOWN' } }) }, f.budget);
  await assert.rejects(ops.refresh('video'), /UNAVAILABLE/);
  assert.equal(readJson(path.join(directory, 'video.json')).result.output.video_url, 'old');
  let posts = 0;
  ops.client = { request: async () => { posts++; return { output: { audio: { url: 'expired' } } }; }, download: async () => { throw Error('DOWNLOAD_FAILED:410'); } };
  const models = new Models({}, ops, {}, f.root);
  await assert.rejects(models.asset('speech', { endpoint: '/speech', cents: 1 }, async () => ({}), path.join(f.root, 'a.wav'), r => r.output.audio.url), /RECOVERY_REQUIRED/);
  assert.equal(posts, 1);
});
test('planner requests require the verified model, an explicit reservation and a versioned prompt', async () => {
  const { Models } = require('../services/aliyun/models');
  const f = fixture();
  const specs = [];
  const models = config => new Models(config, { execute: async (id, spec) => { specs.push({ id, spec });
    return { choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }; } },
  { visionImage: () => 'x' }, f.root);
  await assert.rejects(models({ planner: { model: 'qwen3-flash', promptVersion: 1 } }).plan('p', { purpose: 'x', prompt: 'p', reservationCents: 20 }), /UNSUPPORTED_PLANNER_MODEL/);
  // Without a verified price the request still runs and the cost is recorded as unknown, never as zero.
  await models({ planner: { model: 'qwen3.8-omni-flash', promptVersion: 1 } }).plan('p', { purpose: 'x', prompt: 'p', reservationCents: null });
  assert.equal(specs.at(-1).spec.cents, null);
  await models({ planner: { model: 'qwen3.8-omni-flash', promptVersion: 1 } }).plan('p', { purpose: 'x', prompt: 'p', reservationCents: 20 });
  assert.equal(specs.at(-1).spec.cents, 20);
  await assert.rejects(models({ planner: { model: 'qwen3.8-omni-flash' } }).plan('p', { purpose: 'x', prompt: 'p', reservationCents: 20 }), /PLANNER_PROMPT_VERSION_REQUIRED/);
  await assert.rejects(models({ planner: { model: 'qwen3.8-omni-flash', promptVersion: 1 } }).plan('p', { purpose: 'x', prompt: 'p', reservationCents: 20, audio: 'a.mp3' }), /PLANNER_AUDIO_MUST_BE_WAV/);
});

test('script revision preserves unaffected shots and changes speech without regenerating frames', async () => {
  const { reviseScript } = require('../workflows/revise');
  const f = await redoFixture('succeeded', 'speech');
  f.ctx.production = scriptFixture().p;
  f.config.onlineEnabled = false;
  const next = structuredClone(f.state.script); next.shots[0].text = '新的台词。';
  const before = f.budget.report().committedCents;
  const result = await reviseScript(f.ctx, next, '缩短台词');
  const state = readJson(path.join(f.directory, 'state.json'));
  assert.deepEqual(result.affectedShots, ['shot01']);
  assert.equal(state.assets.shot01.first, 'first-original.png');
  assert.equal(state.assets.shot01.audio, undefined);
  assert.equal(state.assets.shot02.video, 'other-shot.mp4');
  assert.equal(state.history[0].script.shots[0].text, f.state.script.shots[0].text);
  assert.equal(state.revisions['speech-shot01'], 1);
  assert.equal(f.budget.report().committedCents, before);
});
test('script revision is atomic on invalid script and unresolved downstream video', async () => {
  const { reviseScript } = require('../workflows/revise');
  const f = await redoFixture('submitted'), file = path.join(f.directory, 'state.json'), digest = fileHash(file);
  f.ctx.production = scriptFixture().p;
  const next = structuredClone(f.state.script); next.shots[0].scene += '新的场景';
  await assert.rejects(reviseScript(f.ctx, next, '纠正场景'), /UNRESOLVED/);
  assert.equal(fileHash(file), digest);
  next.shots[0].speaker = 'unknown';
  await assert.rejects(reviseScript(f.ctx, next, '错误输入'));
  assert.equal(fileHash(file), digest);
});
test('changing only edit positions does not change a video generation fingerprint', async () => {
  const { Models } = require('../services/aliyun/models');
  const f = fixture(), first = path.join(f.root, 'first.png'), last = path.join(f.root, 'last.png');
  fs.writeFileSync(first, 'first'); fs.writeFileSync(last, 'last');
  const specs = [];
  const model = new Models({models:{actionVideo:'wan2.2-kf2v-flash'},resolution:'1080P'}, {}, {}, f.root);
  model.asset = async (id, spec) => { specs.push(spec); };
  const shot = scriptFixture().script.shots.find(s => s.type !== 'dialogue');
  await model.video('video', {...shot, start:2,end:7}, first,last,null,'unused');
  await model.video('video', {...shot, start:4,end:9}, first,last,null,'unused');
  assert.equal(hash(specs[0]),hash(specs[1]));
});

test('silent audio is rejected locally and corrupted normalization cache is rebuilt', () => {
  const { Media } = require('../services/aliyun/media');
  const f = fixture(), media = new Media(ROOT, readJson(path.join(ROOT, 'config/project.json')));
  const silent = path.join(f.root, 'silent.wav'), audible = path.join(f.root, 'tone.wav'), normalized = path.join(f.root, 'normalized.wav');
  media.command(['-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','3',silent]);
  assert.throws(() => media.audio(silent, true), /SILENT/);
  media.command(['-f','lavfi','-i','sine=frequency=440:sample_rate=24000','-t','3',audible]);
  assert.ok(media.audio(audible, true).quality.rmsDb > -60);
  media.normalizeAudio(audible, normalized);
  fs.writeFileSync(normalized + '.meta.json', '{corrupt');
  fs.writeFileSync(normalized, 'broken');
  media.normalizeAudio(audible, normalized);
  assert.equal(media.audio(normalized).sampleRate, 24000);
});
test('lock cleanup removes only a verifiably exited owner', () => {
  const { unlock } = require('../services/aliyun/io');
  const { execFileSync } = require('node:child_process');
  const f = fixture(), file = path.join(f.root, 'ledger.lock');
  writeJson(file, {pid: process.pid});
  assert.throws(() => unlock(file), /STILL_RUNNING/);
  assert.ok(fs.existsSync(file));
  const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {windowsHide:true, encoding:'utf8'}));
  writeJson(file, {pid}); unlock(file);
  assert.equal(fs.existsSync(file), false);
  writeJson(file, {pid: -1});
  assert.throws(() => unlock(file), /INVALID/);
  assert.ok(fs.existsSync(file));
});

test('single narrator may speak over silent characters and ending counts toward hard duration', () => {
  const {p,script}=scriptFixture(); p.narrator=p.characters[0].id;
  p.characters.push({id:'silent',name:'无声配角',image:'image.png',speaks:false});
  p.ending={image:'card.png',cardSeconds:2.5,blackSeconds:0.5};
  validateProduction(p);
  script.shots[0]={...script.shots[0],type:'narration',duration:5,characters:['silent'],needsLastFrame:true,endScene:'尾帧'};
  validateScript(script,p);
  const timed=timedScript(script,{shot01:4},p);
  assert.equal(timed.totalDuration,13);
  assert.equal(timed.ending.start,10);
  assert.throws(()=>timedScript(script,{shot01:5.1},p),/NARRATION_TOO_LONG/);
  p.maxDurationSeconds=12;
  assert.throws(()=>validateScript(script,p),/FILM_TOO_LONG/);
  p.maxDurationSeconds=45;script.shots[0].speaker='silent';
  assert.throws(()=>validateScript(script,p),/AUTHORIZED_NARRATOR/);
});
test('required historic quotation survives punctuation and shot boundaries', () => {
  const {p,script}=scriptFixture();
  p.requiredQuotes=['愿陛下忍数日之辱'];
  script.shots[0].text='愿陛下，忍数日之辱！';
  validateScript(script,p);
  script.shots[0].text='随意删减名言';
  assert.throws(()=>validateScript(script,p),/REQUIRED_QUOTE/);
});
test('voiceover video never uploads narrator audio or asks for lip motion',async()=>{
  const {Models}=require('../services/aliyun/models');
  const f=fixture(),image=path.join(f.root,'frame.png');fs.writeFileSync(image,'frame');
  const config={models:{actionVideo:'wan2.2-kf2v-flash'},resolution:'1080P'};
  const models=new Models(config,{client:{upload:()=>{throw Error('unexpected upload')}}},{},f.root);
  let spec,body;
  models.asset=async(id,s,b)=>{spec=s;body=await b();};
  await models.video('shot',{type:'narration',duration:5,scene:'战场',action:'冲阵'},image,image,'nonexistent-audio.wav','out');
  assert.equal(spec.audio,null);
  assert.match(body.input.prompt,/闭口/);
  assert.equal(body.input.first_frame_url.startsWith('data:image/png'),true);
});

test('real FFmpeg voiceover ending preserves audio and finishes in black within total duration', () => {
  const { Media }=require('../services/aliyun/media');
  const f=fixture(),media=new Media(ROOT,readJson(path.join(ROOT,'config/project.json')));
  const img=path.join(f.root,'card.png'),audio=path.join(f.root,'voice.wav');
  media.command(['-f','lavfi','-i','color=c=green:s=512x512','-frames:v','1',img]);
  media.command(['-f','lavfi','-i','sine=frequency=600:sample_rate=24000','-t','4',audio]);
  const script={shots:[{id:'s1',type:'narration',text:'测试旁白',duration:5,start:0,end:5,speechDuration:4}],totalDuration:8,
    ending:{image:img,start:5,cardSeconds:2.5,blackSeconds:0.5,caption:'结局据演义改编'}};
  const output=media.assemble(script,{s1:{first:img,audio}},path.join(f.root,'edit'),{preview:true});
  assert.ok(Math.abs(media.video(output,8,true).duration-8)<0.15);
  assert.ok(media.audio(output).quality.rmsDb>-60);
  const last=media.command(['-ss','7.8','-i',output,'-frames:v','1','-vf','scale=16:16','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.ok(last.length>0 && [...last].every(v=>v<=3));
});

test('provider structured character traits are normalized without dropping fields', () => {
 const {normalizeTraits}=require('../workflows/production');
 assert.equal(normalizeTraits({发型:'长发',配色:'绿色'}),'发型：长发；配色：绿色');
 assert.equal(normalizeTraits('长发绿袍'),'长发绿袍');
 assert.throws(()=>normalizeTraits({bad:{nested:true}}),/INVALID_CHARACTER_TRAITS/);
});

test('Qwen image edit uses synchronous multimodal endpoint without async header', async () => {
 const {Models}=require('../services/aliyun/models');const f=fixture(),img=path.join(f.root,'i.png');fs.writeFileSync(img,'image');
 const config={models:{image:'qwen-image-3.0'},imageSize:'1664*936'};
 const models=new Models(config,{}, {},f.root);
 let spec;models.asset=async(id,s)=>{spec=s;};
 await models.image('image','prompt',[img],'out');
 assert.equal(spec.async,false);
 assert.equal(spec.endpoint,'/api/v1/services/aigc/multimodal-generation/generation');
});

test('provider HTTP audio links are upgraded to HTTPS without exposing credentials',async()=>{
 const f=fixture();let requested;
 const client=new AliyunClient({apiKey:'test',fetchImpl:async(url,options)=>{requested={url,options};return new Response(Buffer.from('audio'));}});
 await client.download('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sign=example',path.join(f.root,'a.wav'));
 assert.equal(requested.url,'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sign=example');
 assert.equal(requested.options.headers,undefined);
 assert.equal(fs.readFileSync(path.join(f.root,'a.wav'),'utf8'),'audio');
 await assert.rejects(client.download('http://evil.example/file',path.join(f.root,'bad')),/UNTRUSTED/);
});

test('precise narration timing preserves every audio sample within 45 seconds and bills generated seconds',()=>{
 const p={maxDurationSeconds:45,characters:[{id:'j'}],ending:{image:'card',cardSeconds:2.5,blackSeconds:0.5}};
 const durations=[5.68,6.32,6,4.32,9.2,4.8,3.04], script={title:'计',preciseTiming:true,shots:durations.map((d,i)=>({id:'s'+i,type:i===4?'dialogue':'narration',characters:['j'],speaker:'j',text:'台词',scene:'画面',action:'动作',endScene:'末帧',needsLastFrame:true,duration:i===4?10:5,...(i===6?{minimumVisualSeconds:5}:{})}))};
 const timed=timedScript(script,Object.fromEntries(durations.map((d,i)=>['s'+i,d])),p);
 assert.ok(timed.totalDuration<=45);
 timed.shots.forEach((s,i)=>assert.ok(s.duration>=durations[i]+0.09));
 const cfg={models:{dialogueVideo:'wan2.7-i2v',actionVideo:'wan2.2-kf2v-flash'},resolution:'1080P'};
 const long=videoRequest(cfg,timed.shots[1],'first','last',null);
 assert.equal(long.body.model,'wan2.7-i2v');assert.equal(long.body.parameters.duration,7);
 assert.equal(long.body.input.media.some(m=>m.type==='driving_audio'),false);
 const short=videoRequest(cfg,timed.shots[3],'first','last',null);
 assert.equal(short.body.model,'wan2.2-kf2v-flash');assert.equal(short.body.parameters.duration,5);
});

test('structured visual findings retain severity and contradictory success requires review',()=>{
 const {checkBooleanReport}=require('../workflows/production');const r={pass:true,issues:[{issue:'身份',description:'需检查',severity:'严重'}]};
 checkBooleanReport(r,['pass']);assert.equal(r.pass,false);assert.deepEqual(r.issues,['严重：身份：需检查']);
 assert.throws(()=>checkBooleanReport({pass:true,issues:[{description:{nested:true}}]},['pass']),/INVALID_VISUAL_REPORT/);
});

test('visual pass observations are retained separately from failures',()=>{
 const {checkBooleanReport}=require('../workflows/production');const r={pass:true,issues:[{issue:'身份',description:'一致',status:'pass'}]};checkBooleanReport(r,['pass']);assert.equal(r.pass,true);assert.equal(r.issues.length,0);assert.deepEqual(r.observations,['pass：身份：一致']);
 const bad={pass:true,issues:[{issue:'手部',description:'多指',status:'fail'}]};checkBooleanReport(bad,['pass']);assert.equal(bad.pass,false);assert.equal(bad.issues.length,1);
});

test('incomplete visual JSON becomes a review failure without submitting again',async()=>{
 const {Models}=require('../services/aliyun/models');const f=fixture(),img=path.join(f.root,'x.png');fs.writeFileSync(img,'x');let calls=0;const m=new Models({models:{vision:'qwen-vl-plus'}},{execute:async()=>{calls++;return {choices:[{finish_reason:'stop',message:{content:'{\"pass\":true,\"issues\":[]'}}]};}},{visionImage:()=>img},f.root);const r=await m.json('frame-check-x-r0','check',[img]);assert.equal(r.pass,false);assert.equal(r.degraded,'INVALID_JSON');assert.equal(calls,1);assert.match(r.issues[0],/JSON/);
});

test('speech pacing preserves pitch and adds lead without truncating content',()=>{
 const {Media}=require('../services/aliyun/media'),f=fixture(),m=new Media(ROOT,readJson(path.join(ROOT,'config/project.json')));const src=path.join(f.root,'source.wav'),dst=path.join(f.root,'performed.wav');m.command(['-f','lavfi','-i','sine=frequency=400:sample_rate=24000','-t','4',src]);m.performanceAudio(src,dst,1.25,0.5);const d=m.audio(dst).duration;assert.ok(Math.abs(d-3.7)<0.06);const pcm=m.command(['-ss','1','-i',dst,'-t','1','-ac','1','-ar','24000','-f','s16le','pipe:1']);let crossings=0;for(let i=2;i<pcm.length;i+=2)if(pcm.readInt16LE(i-2)<=0&&pcm.readInt16LE(i)>0)crossings++;assert.ok(Math.abs(crossings-400)<3);assert.throws(()=>m.performanceAudio(src,dst,2,0),/PACING/);
});

test('length-truncated media checks require review while scripts and character checks remain blocked',async()=>{
 const {Models}=require('../services/aliyun/models');const f=fixture(),img=path.join(f.root,'x.png');fs.writeFileSync(img,'x');let calls=0;const {noteDegradation}=require('../workflows/production');const state={};const m=new Models({models:{vision:'qwen-vl-plus',text:'deepseek-flash'}},{execute:async()=>{calls++;return {choices:[{finish_reason:'length',message:{content:'{"pass":true}'}}]};}},{visionImage:()=>img},f.root);
 for(const id of ['frame-check-x-r0','video-check-x-r0']) {const r=await m.json(id,'check',[img]);assert.equal(r.pass,false);assert.equal(r.degraded,'TRUNCATED');assert.match(r.issues[0],/截断/);noteDegradation(state,id,r);}
 assert.equal(state.qualityDegradations.length,2);noteDegradation(state,'video-check-x-r0',{degraded:'TRUNCATED',issues:['截断']});assert.equal(state.qualityDegradations.length,2);
 const planner=new Models({models:{vision:'qwen-vl-plus'},planner:{model:'qwen3.8-omni-flash',promptVersion:1}},{execute:async()=>{calls++;return {choices:[{finish_reason:'length',message:{content:'{"title":"x"}'}}]};}},{visionImage:()=>img},f.root);
 await assert.rejects(m.json('inspect-x-r0','check',[img]),/MODEL_OUTPUT_INCOMPLETE/);await assert.rejects(planner.plan('plan-script',{purpose:'script',prompt:'script',reservationCents:20}),/PLANNER_OUTPUT_INCOMPLETE/);assert.equal(calls,4);
});

test('Plus speech uses new enrollment and instruction contract and resumes without new POST',async()=>{
 const {Models}=require('../services/aliyun/models');const f=fixture(),sample=path.join(f.root,'s.wav'),out=path.join(f.root,'out.wav');fs.writeFileSync(sample,'sample');let uploads=0,posts=[];
 const client={upload:async(model)=>{uploads++;assert.equal(model,'voice-enrollment');return 'oss://test/sample.wav';},request:async(endpoint,body)=>{posts.push({endpoint,body});return body.model==='voice-enrollment'?{output:{voice_id:'qwen-audio-3.0-tts-plus-test-id'}}:{output:{finish_reason:'stop',audio:{url:'https://example.aliyuncs.com/audio.wav'}}};},download:async(url,file)=>fs.writeFileSync(file,'audio')};
 const ops=new Operations(path.join(f.directory,'operations'),client,f.budget),m=new Models({models:{speech:'qwen-audio-3.0-tts-plus',voiceEnrollment:'voice-enrollment'}},ops,{},f.root);
 const voice=await m.voice('voice-r1',sample);assert.equal(await m.voice('voice-r1',sample),voice);assert.equal(uploads,1);assert.equal(posts[0].body.input.action,'create_voice');assert.equal(posts[0].body.input.audio,undefined);
 const delivery={instruction:'压低声音，隐忍而坚定',rate:1.1};await m.speech('speech-r1','愿陛下忍数日之辱',voice,out,delivery);await m.speech('speech-r1','愿陛下忍数日之辱',voice,out,delivery);assert.equal(posts.length,2);assert.equal(posts[1].endpoint,'/api/v1/services/audio/tts/SpeechSynthesizer');assert.equal(posts[1].body.input.instruction,delivery.instruction);assert.equal(posts[1].body.parameters,undefined);assert.equal(f.budget.report().committedCents,2);
 await assert.rejects(m.speech('wrong','text','old-voice',out,delivery),/VOICE_MODEL_MISMATCH/);await assert.rejects(m.speech('speech-r1','愿陛下忍数日之辱',voice,out,{...delivery,instruction:'惊怒'}),/OPERATION_INPUT_CHANGED/);assert.equal(posts.length,2);
});

test('speech model migration preserves frames history and fees and refuses unresolved work',async()=>{
 const {switchSpeech}=require('../workflows/switch-speech');
 for(const bad of [false,true]){const f=fixture();f.config.maxAttemptsPerAsset=2;f.config.models={speech:'qwen3-tts-vc-2026-01-22'};f.production={id:'film'};const state={script:{title:'x',shots:[{id:'s1',type:'dialogue',speaker:'hero',speechRate:1.3}]},characters:{hero:{voice:'old'}},assets:{s1:{first:'first.png',last:'last.png',audio:'old.wav'}},revisions:{},approvals:{},timed:{totalDuration:5}};
 writeJson(path.join(f.directory,'state.json'),state);for(const id of ['voice-hero-r0','speech-s1-r0']){await f.budget.reserve(id,1,id);writeJson(path.join(f.directory,'operations',id+'.json'),{id,status:bad?'uncertain':'succeeded'});}
 const profile={models:{speech:'qwen-audio-3.0-tts-plus',voiceEnrollment:'voice-enrollment'},delivery:{s1:{instruction:'坚定',rate:1.1}}};const before=fileHash(path.join(f.directory,'state.json'));
 if(bad){await assert.rejects(switchSpeech(f,profile,'user requested'),/UNRESOLVED/);assert.equal(fileHash(path.join(f.directory,'state.json')),before);}else{await switchSpeech(f,profile,'user requested');const after=readJson(path.join(f.directory,'state.json'));assert.equal(after.assets.s1.first,'first.png');assert.equal(after.assets.s1.last,'last.png');assert.equal(after.assets.s1.audio,undefined);assert.equal(after.history[0].assets.s1.audio,'old.wav');assert.equal(after.characters.hero.voice,'old');assert.equal(after.revisions['speech-s1'],1);assert.equal(after.script.shots[0].speechRate,1);assert.equal(f.budget.report().committedCents,2);assert.equal((await switchSpeech(f,profile,'resume')).alreadyPrepared,true);}
 }
});

test('normal-speed delivery preserves exact samples while adding only the planned lead',()=>{
 const {Media}=require('../services/aliyun/media'),f=fixture(),m=new Media(ROOT,readJson(path.join(ROOT,'config/project.json')));const src=path.join(f.root,'source.wav'),dst=path.join(f.root,'performed.wav');m.command(['-f','lavfi','-i','sine=frequency=400:sample_rate=24000','-t','1.37','-ac','1',src]);m.performanceAudio(src,dst,1,0.5);const raw=m.command(['-i',src,'-f','s16le','pipe:1']),actual=m.command(['-i',dst,'-f','s16le','pipe:1']);assert.equal(actual.length,raw.length+24000);assert.ok(actual.subarray(0,24000).every(b=>b===0));assert.deepEqual(actual.subarray(24000),raw);
});

test('streamed text handles split Unicode and usage, and rejects incomplete streams',async()=>{
 const {collectTextStream}=require('../services/aliyun/client');const content='data: '+JSON.stringify({id:'x',choices:[{delta:{content:'隐忍'}}]})+'\r\n\r\n'+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'+'data: '+JSON.stringify({choices:[],usage:{total_tokens:12}})+'\n\n'+'data: [DONE]\n\n';const bytes=Buffer.from(content);const stream=async function*(){for(let i=0;i<bytes.length;i+=7)yield bytes.subarray(i,i+7);};const r=await collectTextStream({status:200,body:stream()});assert.equal(r.choices[0].message.content,'隐忍');assert.equal(r.usage.total_tokens,12);await assert.rejects(collectTextStream({status:200,body:(async function*(){yield Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'x'}}]})+'\n\n');})()}),/INCOMPLETE/);
});

test('video-only direction overrides staging without changing the image scene',()=>{const config={models:{dialogueVideo:'wan2.7-i2v',actionVideo:'wan2.2-kf2v-flash'},resolution:'1080P'};const shot={type:'narration',duration:9,scene:'image scene',action:'image action',videoScene:'actual first frame',videoAction:'drop spear then fight'};const r=videoRequest(config,shot,'first','last',null);assert.match(r.body.input.prompt,/actual first frame。drop spear then fight/);assert.equal(shot.scene,'image scene');assert.equal(r.body.input.media.some(x=>x.type==='driving_audio'),false);});

test('subtitle starts with delayed speech and preserves its complete end time',()=>{const result=subtitles({shots:[{text:'吾计不成，乃天命也！',start:20,end:29,speechDuration:8.82,speechLeadSeconds:4.5}]});assert.match(result,/00:00:24,500 --> 00:00:28,820/);assert.doesNotMatch(result,/00:00:20,000/);});

test('frame-indexed visual findings are retained and require review',()=>{const {checkBooleanReport}=require('../workflows/production');const r={pass:true,issues:[{frame:2,description:'identity consistent'}]};checkBooleanReport(r,['pass']);assert.equal(r.pass,false);assert.match(r.issues[0],/frame 2.*identity consistent/);assert.throws(()=>checkBooleanReport({pass:true,issues:[{frame:-1,description:'x'}]},['pass']),/INVALID_VISUAL_REPORT/);});
