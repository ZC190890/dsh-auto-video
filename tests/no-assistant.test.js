const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Models } = require('../services/aliyun/models');
const { Media } = require('../services/aliyun/media');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadBrief } = require('../services/brief');
const { loadContext, runProduction } = require('../workflows/production');
const { adviseRework, analyzeMaterials, generateScript, planRevision, reviewInputDigest, reviewScript } = require('../workflows/planner');
const ROOT = path.resolve(__dirname, '..');
const PLANNER = 'qwen3.8-omni-flash';

// A task with no brief file and no human authoring step: the planner model must carry analysis, brief,
// script, revision and rework advice. Characters are pre-registered so these tests stay fast.
function fixture({ legacyBrief = false } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'noassist-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: PLANNER, promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'assist-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  const production = { id: 'assist-film', description: '职责分离隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60, intakeFile: 'brief.json',
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  if (legacyBrief) {
    writeJson(path.join(root, 'brief.json'), { preparedBy: 'legacy-assistant', status: 'ready', productionId: 'assist-film',
      descriptionHash: hash(production.description), storySummary: '历史简报', shotGuidance: '历史指导',
      characters: [{ id: 'character01', imageSha256: fileHash(image), voiceSha256: fileHash(sample), frontSha256: null,
        visualAnalysis: '历史素材分析', voiceAnalysis: '历史语音分析' }] });
  }
  const directory = path.join(root, 'jobs', 'aliyun', 'assist-film');
  // Same registry key the characters stage computes, so the cached path is taken and no vision call
  // is needed in these tests.
  const source = { id: 'character01', image: media.image(image).hash, sample: media.audio(sample, true).hash, front: null };
  const registryKey = hash({ source, traits: production.characters[0].traits,
    speechModel: config.models.speech, portraitModel: config.models.portrait });
  const registered = { original: image, front: image, sample, traits: '测试',
    originalHash: fileHash(image), frontHash: fileHash(image), sampleHash: fileHash(sample),
    registryFile: path.join(root, 'jobs', 'aliyun', 'characters', registryKey, 'character.json'), accepted: true };
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'assist-film',
    characters: { character01: registered }, approvals: {}, assets: {}, revisions: {} });
  return { root, directory, config, media, image, sample,
    context: loadContext(root, legacyBrief ? 'production.json' : 'production.json'), state: readJson(path.join(directory, 'state.json')) };
}
// Provider stand-in: records every request and answers by prompt purpose.
function plannerOps(script, overrides = {}) {
  const calls = [];
  const reply = json => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(json) } }] });
  return { calls, execute: async (id, spec, build) => {
    const body = await build();
    calls.push({ id, spec, body });
    const prompt = JSON.stringify(body.messages);
    if (prompt.includes('美术与选角分析')) return reply(overrides.material || { id: 'character01', visualAnalysis: '图', voiceAnalysis: '音' });
    if (prompt.includes('制作简报模型')) return reply(overrides.brief || { storySummary: '模型简报', shotGuidance: '模型指导' });
    if (prompt.includes('编剧与分镜模型')) return reply(overrides.script || script);
    if (prompt.includes('独立审核模型')) return reply(overrides.review || { verdict: 'pass', summary: '上下文连贯，时长在范围内',
      contextIssues: [], durationIssues: [], estimatedDurationSeconds: 9, longShots: [], advice: null });
    if (prompt.includes('返工执行模型')) return reply(overrides.instruction || { shotId: 'shot01', scope: 'video',
      patch: { videoAction: '按返工意见重做动作' }, rationale: '按记录意见最小改动' });
    if (prompt.includes('返工决策模型')) return reply(overrides.rework || { advice: '重做该镜', scope: 'video', requiresPaidRetry: true, userAction: '用户决定' });
    return reply({});
  } };
}

test('a new task needs neither a brief file nor any authoring step by an assistant', async () => {
  const f = fixture(), script = readJson(path.join(ROOT, 'examples/script.json'));
  assert.equal(loadBrief(f.root, f.context.production, f.context.directory), null);
  const ops = plannerOps(script);
  const models = new Models(f.config, ops, f.media, f.root);
  const brief = await analyzeMaterials(f.context, { models, state: f.state, log: () => {} });
  assert.equal(brief.generatedBy, PLANNER);
  assert.equal(brief.characters[0].imageSha256, fileHash(f.image));
  assert.match(brief.storySummary, /模型简报/);
  const generated = await generateScript(f.context, { models, state: { ...f.state, brief }, log: () => {} });
  assert.equal(generated.title, script.title);
  assert.equal(ops.calls.length, 3);
  assert.deepEqual(ops.calls.map(call => call.spec.purpose), ['material-analysis', 'production-brief', 'script']);
  assert.equal(fs.existsSync(path.join(f.root, 'brief.json')), false);
});

test('analysis, script, revision and rework all route to the planner model', async () => {
  const f = fixture(), script = readJson(path.join(ROOT, 'examples/script.json'));
  const ops = plannerOps(script), models = new Models(f.config, ops, f.media, f.root);
  const brief = await analyzeMaterials(f.context, { models, state: f.state, log: () => {} });
  const state = { ...f.state, brief, script, editRevision: 2 };
  await generateScript(f.context, { models, state, log: () => {} });
  const revised = await planRevision(f.context, { models, state, instructions: '把第一镜台词缩短', log: () => {} });
  assert.equal(revised.title, script.title);
  const advice = await adviseRework(f.context, { models, state, target: 'video-shot01', issues: ['动作不连贯'] });
  assert.match(advice.advice, /重做/);
  assert.equal(advice.requiresPaidRetry, true);
  assert.deepEqual(ops.calls.map(call => call.spec.purpose),
    ['material-analysis', 'production-brief', 'script', 'script-revision', 'rework-advice']);
  for (const call of ops.calls) {
    assert.equal(call.spec.kind, 'planner');
    assert.equal(call.spec.model, PLANNER);
    assert.equal(call.spec.cents, 20);
    assert.equal(call.spec.promptVersion, 1);
    assert.equal(call.body.modalities.join(','), 'text');
  }
  assert.match(ops.calls[3].spec.prompt, /导演指令/);
  assert.match(ops.calls[3].spec.prompt, /把第一镜台词缩短/);
  assert.match(ops.calls[3].spec.prompt, new RegExp(script.title));
});

test('a planner failure is surfaced and never routed to another provider', async () => {
  const f = fixture();
  let calls = 0;
  const failing = { execute: async () => { calls++; throw new Error('PROVIDER_TIMEOUT'); } };
  const models = new Models(f.config, failing, f.media, f.root);
  await assert.rejects(analyzeMaterials(f.context, { models, state: f.state, log: () => {} }), /PROVIDER_TIMEOUT/);
  assert.equal(calls, 1); // the failure stops the run; there is no second provider to fall back to
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'deepseek.js')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'services', 'intake.js')), false);
});

test('extra injected fields on a structurally valid script cannot approve, discount or renumber anything', async () => {
  const f = fixture(), script = readJson(path.join(ROOT, 'examples/script.json'));
  // This payload is structurally complete and passes validateScript, so the protections asserted below
  // are not a side effect of an invalid document.
  const hostile = { ...script, approved: true, reviewStatus: 'accepted-by-user', cents: 0, reservationCents: 0,
    operationId: 'forged', status: 'succeeded', digest: 'forged-digest',
    shots: script.shots.map(shot => ({ ...shot, approved: true, cents: 0, operationId: 'forged-' + shot.id })) };
  const ops = plannerOps(script, { script: hostile });
  const models = new Models(f.config, ops, f.media, f.root);
  const brief = await analyzeMaterials(f.context, { models, state: f.state, log: () => {} });
  const accepted = await generateScript(f.context, { models, state: { ...f.state, brief }, log: () => {} });
  assert.equal(accepted.title, script.title);
  assert.equal(accepted.approved, true); // extra fields stay inert data, they change no control flow
  const scriptCall = ops.calls.find(call => call.spec.purpose === 'script');
  assert.equal(scriptCall.id, 'plan-script'); // the operation id comes from the pipeline, not the payload
  assert.equal(scriptCall.spec.operationId, undefined);
  for (const call of ops.calls) assert.equal(call.spec.cents, 20); // reservations come from config
  const state = readJson(path.join(f.directory, 'state.json'));
  assert.deepEqual(state.approvals, {});
  assert.equal(state.audioReview, undefined);
  assert.equal(fs.existsSync(path.join(f.directory, 'api-ledger.json')), false);
});

test('the runtime contains no assistant step and no second text provider', () => {
  const runtime = ['index.js', 'services/brief.js', 'services/aliyun/models.js', 'services/aliyun/budget.js',
    'workflows/production.js', 'workflows/planner.js', 'workflows/audio-review.js', 'workflows/redo.js',
    'workflows/revise.js', 'workflows/switch-speech.js', 'config/aliyun.json'];
  const forbidden = /codex|CODEX_|preparedBy\s*[!=]==?\s*'codex'|require\([^)]*deepseek|DEEPSEEK_API_KEY|api\.deepseek\.com/i;
  for (const file of runtime) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), forbidden, file);
  assert.equal(readJson(path.join(ROOT, 'config/aliyun.json')).planner.model, PLANNER);
});

test('a historical brief is readable as data and starts no model briefing', async () => {
  const f = fixture({ legacyBrief: true });
  const loaded = loadBrief(f.root, f.context.production, f.context.directory);
  assert.equal(loaded.source.historical, true);
  assert.equal(loaded.source.role, 'external-source');
  const state = await runProduction(f.context, { client: { request: async () => { throw new Error('NO_REQUEST_EXPECTED'); } },
    log: () => {}, until: 'characters' });
  assert.equal(state.briefSource.role, 'external-source');
  assert.equal(state.brief.generatedBy, undefined);
  assert.equal(state.brief.storySummary, '历史简报');
  assert.equal(loadBrief(f.root, f.context.production, f.context.directory).brief.storySummary, '历史简报');
});

test('the flow pauses at the user script decision with the review verdict attached', async () => {
  const f = fixture({ legacyBrief: true }), script = readJson(path.join(ROOT, 'examples/script.json'));
  const brief = loadBrief(f.root, f.context.production, f.context.directory).brief;
  writeJson(path.join(f.directory, 'state.json'), { ...f.state, brief, script });
  let posts = 0;
  // Only the independent script review is allowed to reach a provider here; anything else is an error.
  const client = { request: async (endpoint, body) => {
    const prompt = JSON.stringify(body.messages || []);
    if (!endpoint.includes('chat/completions') || body.model !== PLANNER || !prompt.includes('独立审核模型'))
      throw new Error('NO_OTHER_REQUEST_EXPECTED');
    posts++;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ verdict: 'revise', summary: '第三镜偏长',
      contextIssues: ['因果跳跃'], durationIssues: ['shot02 偏长'], estimatedDurationSeconds: 12, longShots: ['shot02'],
      advice: '把 shot02 缩短两字' }) } }] };
  } };
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'audio' }), /REVIEW_REQUIRED:script/);
  const state = readJson(path.join(f.directory, 'state.json'));
  assert.equal(posts, 1);
  assert.equal(state.scriptReview.model, PLANNER);
  assert.equal(state.scriptReview.verdict, 'revise');
  assert.equal(state.scriptReview.scriptHash, hash(script));
  assert.equal(state.pendingReview.key, 'script');
  assert.match(state.pendingReview.reason, /用户/);
  assert.match(state.pendingReview.reason, /独立审核|审核模型/);
  assert.match(state.pendingReview.reason, /shot02 偏长/);
  assert.deepEqual(state.approvals, {});
  assert.equal(state.assets.shot01?.audio, undefined); // no media generation happened
});

test('the script is content-reviewed by a separate request bound to its digest', async () => {
  const f = fixture({ legacyBrief: true }), script = readJson(path.join(ROOT, 'examples/script.json'));
  const override = { verdict: 'revise', summary: '第三镜台词过长', contextIssues: ['因果跳跃'], durationIssues: ['shot02 偏长'],
    estimatedDurationSeconds: 12, longShots: ['shot02'], advice: '把 shot02 缩短' };
  const ops = plannerOps(script, { review: override });
  const models = new Models(f.config, ops, f.media, f.root);
  const brief = loadBrief(f.root, f.context.production, f.context.directory).brief;
  const state = { ...f.state, brief, script };
  const review = await reviewScript(f.context, { models, state, log: () => {} });
  assert.equal(review.model, PLANNER);
  assert.equal(review.verdict, 'revise');
  assert.equal(review.scriptHash, hash(script));
  assert.deepEqual(review.durationIssues, ['shot02 偏长']);
  assert.equal(review.contextIssues[0], '因果跳跃');
  assert.equal(ops.calls.length, 1);
  assert.equal(ops.calls[0].spec.purpose, 'script-review');
  assert.equal(ops.calls[0].spec.kind, 'planner');
  assert.equal(ops.calls[0].id, 'plan-script-review-' +
    reviewInputDigest(f.context.production, brief, script, f.config.planner.promptVersion).slice(0, 12));
  const revised = structuredClone(script);
  revised.shots[0].text = '改过的台词';
  const second = await reviewScript(f.context, { models, state: { ...state, script: revised }, log: () => {} });
  assert.notEqual(second.scriptHash, review.scriptHash);
  assert.notEqual(ops.calls[1].id, ops.calls[0].id);
  assert.equal(ops.calls.length, 2);
});

