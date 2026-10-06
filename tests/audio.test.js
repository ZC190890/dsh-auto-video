const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Models } = require('../services/aliyun/models');
const { Media } = require('../services/aliyun/media');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { analyzeShotAudio, audioReviewBase, normalizeText, recordAudioDecision, reviewPrompt, runAudioReviews } =
  require('../workflows/audio-review');
const ROOT = path.resolve(__dirname, '..');

const VALID_REPORT = { shotId: 'shot01', transcript: '愿陛下忍数日之辱', delivery: '低沉稳重，语速适中',
  expressiveness: 'moderate', issues: [], uncertainWords: [] };
const LINE = '愿陛下忍数日之辱';

function fixture({ reservationCents = 20, onlineEnabled = false } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'audio-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled, authorizationFile: 'auth.json',
    audioReview: { model: 'qwen3.8-omni-flash', promptVersion: 1, reservationCents } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'audio-film', providers: ['deepseek', 'aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav'), speech = path.join(root, 'shot01.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '3', '-ac', '1', speech]);
  const production = { id: 'audio-film', description: '音频流程隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60, intakeFile: 'input/director-brief.json',
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'input/production.json'), production);
  writeJson(path.join(root, 'input/director-brief.json'), { preparedBy: 'codex', status: 'ready', productionId: 'audio-film',
    descriptionHash: hash(production.description), storySummary: '测试简报', shotGuidance: '仅隔离测试',
    characters: [{ id: 'character01', imageSha256: fileHash(image), voiceSha256: fileHash(sample), frontSha256: null,
      visualAnalysis: '合成测试图', voiceAnalysis: '合成测试音调，不是用户语音' }] });
  const shot = { id: 'shot01', type: 'narration', characters: [], speaker: 'character01', text: LINE, emotion: '隐忍而坚定',
    scene: '场景', action: '动作', duration: 3, speechDuration: 2.9, start: 0, end: 3 };
  const directory = path.join(root, 'jobs', 'aliyun', 'audio-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'audio-film', characters: {}, approvals: {},
    assets: { shot01: { speechRaw: speech, audio: speech } }, script: { title: '测试', shots: [shot] },
    timed: { title: '测试', totalDuration: 3, shots: [shot] }, stage: 'audio' });
  return { root, directory, config, media, speech, state: readJson(path.join(directory, 'state.json')),
    context: loadContext(root, 'input/production.json') };
}
function fakeOps(result = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(VALID_REPORT) } }],
  usage: { total_tokens: 900 } }) {
  const calls = [];
  return { calls, execute: async (id, spec, build) => {
    calls.push({ id, spec, body: await build() });
    if (result instanceof Error) throw result;
    return result;
  } };
}
function options(f, prompt = reviewPrompt('shot01')) {
  return { shotId: 'shot01', shotTextHash: hash(LINE), audio: f.speech, prompt, reservationCents: 20 };
}
function modelsFor(f, ops) { return new Models(f.config, ops, f.media, path.join(f.directory, 'vision-cache')); }

test('the audio-review request uses the verified model ID and protocol only', async () => {
  const f = fixture(), ops = fakeOps();
  const { report } = await modelsFor(f, ops).audioReview('audio-review-qwen38omniflash-shot01-r0', options(f));
  assert.equal(ops.calls.length, 1);
  const { spec, body } = ops.calls[0];
  assert.equal(spec.endpoint, '/compatible-mode/v1/chat/completions');
  assert.equal(spec.model, 'qwen3.8-omni-flash');
  assert.equal(spec.kind, 'audio-review');
  assert.equal(spec.shotId, 'shot01');
  assert.equal(spec.promptVersion, 1);
  assert.equal(spec.audio, fileHash(f.speech));
  assert.equal(spec.expectedText, hash(LINE));
  assert.equal(spec.cents, 20);
  assert.equal(body.model, 'qwen3.8-omni-flash');
  assert.deepEqual(body.modalities, ['text']);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const [audioPart, textPart] = body.messages[0].content;
  assert.equal(audioPart.type, 'input_audio');
  assert.equal(audioPart.input_audio.format, 'wav');
  assert.ok(audioPart.input_audio.data.startsWith('data:audio/wav;base64,'));
  assert.equal(textPart.type, 'text');
  assert.match(textPart.text, /shot01/);
  assert.equal('audio' in body, false);
  assert.equal(JSON.stringify(body).includes('voice'), false);
  assert.equal(report.shotId, 'shot01');
});

test('per-shot analysis stores correctness, technical, performance and voice similarity separately', async () => {
  const f = fixture(), ops = fakeOps(), state = structuredClone(f.state);
  const record = await analyzeShotAudio(f.context, { shotId: 'shot01', models: modelsFor(f, ops), media: f.media, state, log: () => {} });
  assert.equal(record.shotId, 'shot01');
  assert.equal(record.model, 'qwen3.8-omni-flash');
  assert.equal(record.operation, 'audio-review-qwen38omniflash-shot01-r0');
  assert.equal(record.textCheck.expected, LINE);
  assert.equal(record.textCheck.transcript, LINE);
  assert.equal(record.textCheck.normalizedMatch, true);
  assert.match(record.textCheck.note, /人工/);
  assert.ok(record.technical.duration > 2.5 && record.technical.rmsDb < 0);
  assert.equal(record.technical.basis, '本地解码测量，不含表演判断');
  assert.equal(record.performance.expressiveness, 'moderate');
  assert.match(record.performance.basis, /不是用户验收/);
  assert.equal(record.voiceSimilarity.assessed, false);
  assert.match(record.voiceSimilarity.reason, /参考音频/);
  assert.equal(record.reviewStatus, 'awaiting-user-acceptance');
  assert.equal(ops.calls.length, 1);
  assert.ok(fs.existsSync(path.join(f.directory, 'audio-review', 'shot01.json')));
  assert.equal(state.audioReviews.shot01.operation, record.operation);
  assert.equal(normalizeText('愿陛下忍数日之辱！'), normalizeText(LINE));
  assert.notEqual(normalizeText(LINE), normalizeText('愿陛下忍数日之苦'));
});

test('unsupported capability, format and unverified price are refused explicitly', async () => {
  const f = fixture(), ops = fakeOps();
  const withReview = audioReview => new Models({ ...f.config, audioReview }, ops, f.media, f.root);
  await assert.rejects(withReview({ model: 'qwen3-omni-flash', promptVersion: 1, reservationCents: 20 })
    .audioReview('audio-review-x-shot01-r0', options(f)), /UNSUPPORTED_AUDIO_REVIEW_MODEL/);
  // An unverified price no longer blocks the analysis: the request goes out and the cost stays unknown.
  const unpricedReview = await modelsFor(f, ops).audioReview('audio-review-x-shot01-r0', { ...options(f), reservationCents: null });
  assert.equal(unpricedReview.report.shotId, 'shot01');
  assert.equal(ops.calls.at(-1).spec.cents, null);
  for (const call of ops.calls) assert.notEqual(call.spec.cents, 0);
  const unpriced = fixture({ reservationCents: null });
  const unpricedOps = fakeOps();
  const record = await analyzeShotAudio(unpriced.context, { shotId: 'shot01', models: modelsFor(unpriced, unpricedOps),
    media: unpriced.media, state: structuredClone(unpriced.state), log: () => {} });
  assert.equal(record.shotId, 'shot01');
  assert.equal(unpricedOps.calls.length, 1);
  assert.equal(unpricedOps.calls[0].spec.cents, null);
  assert.equal(unpricedOps.calls[0].id, 'audio-review-qwen38omniflash-shot01-r0');
  await assert.rejects(withReview({ model: 'qwen3.8-omni-flash', promptVersion: 0, reservationCents: 20 })
    .audioReview('audio-review-x-shot01-r0', options(f)), /AUDIO_REVIEW_PROMPT_VERSION_REQUIRED/);
  const mp3 = path.join(f.root, 'line.mp3');
  f.media.command(['-i', f.speech, '-c:a', 'libmp3lame', mp3]);
  await assert.rejects(modelsFor(f, ops).audioReview('audio-review-x-shot01-r0', { ...options(f), audio: mp3 }),
    /UNSUPPORTED_AUDIO_FORMAT/);
  const asSpeech = new Models({ ...f.config, models: { ...f.config.models, speech: 'qwen3.8-omni-flash' } }, ops, f.media, f.root);
  await assert.rejects(asSpeech.speech('speech-shot01-r0', LINE, 'voice-1', path.join(f.root, 'out.wav')),
    /MODEL_HAS_NO_SPEECH_OUTPUT/);
  // Exactly one request was made, and it is the unpriced-but-allowed analysis above: every refusal
  // happened before the provider was contacted.
  assert.equal(ops.calls.length, 1);
  assert.equal(ops.calls[0].id, 'audio-review-x-shot01-r0');
});

test('truncated and malformed responses never count as success', async () => {
  const f = fixture();
  const reply = payload => new Models(f.config, fakeOps({ choices: [{ finish_reason: 'stop', message: { content: payload } }] }), f.media, f.root);
  const truncated = new Models(f.config, fakeOps({ choices: [{ finish_reason: 'length', message: { content: '{"shotId":"shot01"' } }] }), f.media, f.root);
  await assert.rejects(truncated.audioReview('audio-review-a-shot01-r0', options(f)), /AUDIO_REVIEW_INCOMPLETE/);
  await assert.rejects(reply('not json').audioReview('audio-review-b-shot01-r0', options(f)), /AUDIO_REVIEW_INVALID_JSON/);
  await assert.rejects(reply(JSON.stringify({ ...VALID_REPORT, shotId: 'shot09' })).audioReview('audio-review-c-shot01-r0', options(f)),
    /AUDIO_REVIEW_SHAPE_INVALID/);
  await assert.rejects(reply(JSON.stringify({ ...VALID_REPORT, expressiveness: 'epic' })).audioReview('audio-review-d-shot01-r0', options(f)),
    /AUDIO_REVIEW_SHAPE_INVALID/);
  await assert.rejects(reply(JSON.stringify({ ...VALID_REPORT, transcript: '   ' })).audioReview('audio-review-e-shot01-r0', options(f)),
    /AUDIO_REVIEW_SHAPE_INVALID/);
  await assert.rejects(reply(JSON.stringify({ ...VALID_REPORT, uncertainWords: 'none' })).audioReview('audio-review-g-shot01-r0', options(f)),
    /AUDIO_REVIEW_SHAPE_INVALID/);
  const aborted = new Models(f.config, fakeOps(new Error('STREAM_RESPONSE_INCOMPLETE')), f.media, f.root);
  await assert.rejects(aborted.audioReview('audio-review-f-shot01-r0', options(f)), /STREAM_RESPONSE_INCOMPLETE/);
});

test('changing the audio model neither reuses the old operation id nor silently reuses results', async () => {
  assert.notEqual(audioReviewBase('qwen3.8-omni-flash', 'shot01'), audioReviewBase('qwen3-omni-flash', 'shot01'));
  assert.equal(audioReviewBase('qwen3.8-omni-flash', 'shot01'), 'audio-review-qwen38omniflash-shot01');
  const f = fixture({ onlineEnabled: true });
  const budget = new Budget(f.root, f.config, f.directory);
  // The provider stand-in answers exactly like a successful Chat Completions call.
  const client = { request: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(VALID_REPORT) } }],
    usage: { total_tokens: 900 } }) };
  const operations = new Operations(path.join(f.directory, 'operations'), client, budget, () => {}, 0, 0);
  const models = new Models(f.config, operations, f.media, f.root);
  await models.audioReview('audio-review-qwen38omniflash-shot01-r0', options(f));
  await assert.rejects(models.audioReview('audio-review-qwen38omniflash-shot01-r0', options(f, reviewPrompt('shot01') + '（改版）')),
    /OPERATION_INPUT_CHANGED/);
  await assert.rejects(new Models({ ...f.config, audioReview: { ...f.config.audioReview, model: 'qwen3-omni-flash' } },
    operations, f.media, f.root).audioReview('audio-review-qwen3omniflash-shot01-r0', options(f)), /UNSUPPORTED_AUDIO_REVIEW_MODEL/);
  assert.equal(budget.report().entries.filter(e => e.id.includes('audio-review')).length, 1);
});

test('without authorization the analyzer sends nothing', async () => {
  const f = fixture({ onlineEnabled: false });
  let posts = 0;
  await assert.rejects(runAudioReviews(f.context, [], { client: { request: async () => { posts++; } }, log: () => {} }),
    /ONLINE_DISABLED/);
  assert.equal(posts, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'api-ledger.json')), false);
});

test('an uncertain audio submission is preserved and never resent automatically', async () => {
  const f = fixture({ onlineEnabled: true });
  let posts = 0;
  const client = { request: async () => { posts++; throw new Error('timeout'); } };
  await assert.rejects(runAudioReviews(f.context, [], { client, log: () => {} }), /SUBMISSION_UNCERTAIN/);
  await assert.rejects(runAudioReviews(f.context, [], { client, log: () => {} }), /OPERATION_REQUIRES_RECONCILIATION/);
  assert.equal(posts, 1);
  const ledger = readJson(path.join(f.directory, 'api-ledger.json'));
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].reservedCents, 20);
  assert.equal(ledger.entries[0].actualCents, null);
  assert.equal(ledger.entries[0].status, 'reserved');
  assert.equal(readJson(path.join(f.directory, 'state.json')).audioReviews, undefined);
});

test('the user decision is recorded and only acceptance releases the video stage', async () => {
  const f = fixture({ onlineEnabled: true });
  const state = readJson(path.join(f.directory, 'state.json'));
  state.audioReview = { status: 'pending' };
  writeJson(path.join(f.directory, 'state.json'), state);
  await assert.rejects(recordAudioDecision(f.context, 'maybe', '用户觉得还行'), /AUDIO_DECISION_REQUIRED/);
  await assert.rejects(recordAudioDecision(f.context, 'rejected', '   '), /AUDIO_DECISION_NOTE_REQUIRED/);
  const rejected = await recordAudioDecision(f.context, 'rejected', '第二句吞字且重音偏，需重做该句并放慢语速');
  assert.equal(rejected.blocksVideo, true);
  assert.equal(rejected.autoRetry, 'disabled');
  const afterReject = readJson(path.join(f.directory, 'state.json'));
  assert.equal(afterReject.audioReview.status, 'rejected');
  assert.match(afterReject.audioReview.rework, /吞字/);
  assert.equal(afterReject.audioReview.reworkScope, 'speech');
  const accepted = await recordAudioDecision(f.context, 'accepted', '用户试听后接受当前配音');
  assert.equal(accepted.blocksVideo, false);
  assert.equal(readJson(path.join(f.directory, 'state.json')).audioReview.status, 'accepted');
});
