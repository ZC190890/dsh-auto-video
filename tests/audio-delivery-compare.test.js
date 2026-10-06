const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget } = require('../services/aliyun/budget');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { deliveryChange, effectiveDelivery, recordedDelivery } = require('../workflows/operations-map');
const { reviseScript } = require('../workflows/revise');
const ROOT = path.resolve(__dirname, '..');
const SPEECH = 'qwen-audio-3.0-tts-plus';
const LINE = '愿陛下忍数日之辱';
const INSTRUCTION = '放慢语速并加重语气';
const MODEL_RATE = 1.2;
const LOCAL_RATE = 1.0;

// The audio record exactly as workflows/production.js writes it: modelParams are the parameters that
// reached the request, localPostProcess are the local knobs, and performance keeps the historical note.
function audioRecord({ includeModelParams = true, instruction = INSTRUCTION, modelRate = MODEL_RATE, localRate = LOCAL_RATE } = {}) {
  return { operation: 'speech-shot01-r0', model: SPEECH, voice: 'voice-1',
    text: { digest: LINE, hash: hash(LINE), characters: [...LINE].length },
    performance: { scriptEmotion: '隐忍', instruction, rate: localRate, hotFix: 'none',
      emotionHandling: 'instruction-sent', note: null },
    ...(includeModelParams ? { modelParams: { voice: 'voice-1', text: LINE, format: 'wav', sampleRate: 24000,
      languageHints: ['zh'], instruction, rate: modelRate, hotFix: false, profile: 'speech-profile' } } : {}),
    localPostProcess: { speechRate: localRate, speechLeadSeconds: 0, drivingAudio: 'normalized 24k mono, minimum 2s' },
    requestId: 'req-1', result: { file: 'audio/driving-shot01-r0.wav', hash: 'audio-hash', durationSeconds: 3, format: 'wav' },
    reviewStatus: 'accepted-by-user', at: '2026-09-21T00:00:00.000Z' };
}
// A shot whose speech was already generated with the record above, at model rate 1.2 and local rate 1.0.
function stateWith(record, { delivery = { instruction: INSTRUCTION, rate: MODEL_RATE }, shotRate = LOCAL_RATE } = {}) {
  return { script: { title: '测试', shots: [{ id: 'shot01', type: 'narration', characters: [], speaker: 'character01',
    text: LINE, emotion: '隐忍', scene: '场景', action: '动作', endScene: '尾帧', needsLastFrame: true,
    duration: 5, speechRate: shotRate }] },
  speechProfile: { models: { speech: SPEECH }, delivery: { shot01: delivery } },
  audioRecords: { shot01: record }, revisions: { 'speech-shot01': 0 }, assets: { shot01: { audioHash: 'audio-hash' } },
  audioReview: { status: 'accepted' } };
}
const config = () => ({ models: { speech: SPEECH, vision: 'qwen-vl-plus' } });

test('a model rate that did not change is not reported as a change, even with a different local rate', () => {
  const state = stateWith(audioRecord());
  const result = deliveryChange(state, 'shot01', config());
  assert.equal(result.changed, false);                       // the reported false positive
  assert.equal(result.reason, 'UNCHANGED');
  assert.equal(result.before.rate, MODEL_RATE);              // the model rate, not the local speed
  assert.equal(result.after.rate, MODEL_RATE);
});

test('a changed model rate is reported as a change', () => {
  const state = stateWith(audioRecord(), { delivery: { instruction: INSTRUCTION, rate: LOCAL_RATE } });
  const result = deliveryChange(state, 'shot01', config());
  assert.equal(result.changed, true);                        // the reported false negative
  assert.equal(result.reason, 'MODEL_PARAMS_CHANGED');
  assert.equal(result.before.rate, MODEL_RATE);
  assert.equal(result.after.rate, LOCAL_RATE);
});

test('a local post-processing speed is never used as the model rate', () => {
  const state = stateWith(audioRecord(), { shotRate: 1.3, delivery: { instruction: INSTRUCTION, rate: MODEL_RATE } });
  state.audioRecords.shot01.localPostProcess.speechRate = 1.3;
  const recorded = recordedDelivery(state.audioRecords.shot01);
  assert.equal('speechRate' in recorded, false);              // local knobs stay out of the comparison
  assert.equal('speechLeadSeconds' in recorded, false);
  assert.equal(deliveryChange(state, 'shot01', config()).changed, false);
  assert.equal(effectiveDelivery(state, 'shot01', config()).rate, MODEL_RATE);
});

test('a record without model parameters is handled conservatively and is never rewritten', () => {
  const legacy = audioRecord({ includeModelParams: false });
  // The legacy block stores the LOCAL rate (1.0) under performance.rate: that is not a model rate.
  assert.equal(legacy.performance.rate, LOCAL_RATE);
  const state = stateWith(legacy, { delivery: { instruction: INSTRUCTION, rate: MODEL_RATE } });
  const result = deliveryChange(state, 'shot01', config());
  assert.equal(result.changed, true);                        // unknown is never assumed to be "the same"
  assert.equal(result.reason, 'LEGACY_RECORD_WITHOUT_MODEL_PARAMS');
  assert.equal(result.before.verified, false);
  assert.equal(result.before.rate, null);
  // A legacy instruction that really differs is still reported as a parameter change.
  const other = stateWith(legacy, { delivery: { instruction: '改成怒吼', rate: MODEL_RATE } });
  assert.equal(deliveryChange(other, 'shot01', config()).reason, 'MODEL_PARAMS_CHANGED');
  // The stored legacy record itself is returned untouched, so old evidence is never adapted in place.
  const snapshot = JSON.stringify(legacy);
  deliveryChange(state, 'shot01', config());
  assert.equal(JSON.stringify(state.audioRecords.shot01), snapshot);
  assert.deepEqual(state.audioRecords.shot01, legacy);
});

// A job with the operations and ledger a real revision would meet.
function fixture({ record = audioRecord(), delivery = { instruction: INSTRUCTION, rate: MODEL_RATE } } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'audio-cmp-'));
  const configJson = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), configJson);
  writeJson(path.join(root, 'config/project.json'), readJson(path.join(ROOT, 'config/project.json')));
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'audio-cmp-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  writeJson(path.join(root, 'production.json'), { id: 'audio-cmp-film', description: '配音参数比较隔离测试，不是真实成片素材',
    style: '测试', targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image: 'hero.png', voiceSample: 'voice.wav', traits: '测试' }] });
  const base = { type: 'narration', characters: [], speaker: 'character01', scene: '场景', action: '动作',
    endScene: '尾帧', needsLastFrame: true, duration: 5 };
  const shots = [{ ...base, id: 'shot01', text: LINE, emotion: '隐忍', speechRate: LOCAL_RATE },
    { ...base, id: 'shot02', text: '第二句台词' }];
  const directory = path.join(root, 'jobs', 'aliyun', 'audio-cmp-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'audio-cmp-film', characters: {}, approvals: {},
    assets: { shot01: { audio: 'driving.wav', audioHash: 'audio-hash', video: 'old.mp4' } }, revisions: { 'speech-shot01': 0 },
    speechProfile: { models: { speech: SPEECH }, delivery: { shot01: delivery } },
    audioRecords: { shot01: record }, audioReview: { status: 'accepted' },
    script: { title: '测试', shots }, stage: 'video' });
  return { root, directory, config: configJson, context: loadContext(root, 'production.json'),
    stateFile: path.join(directory, 'state.json'), ledgerFile: path.join(directory, 'api-ledger.json') };
}
async function succeededOp(f, id, cents = 20) {
  const budget = new Budget(f.root, f.config, f.directory);
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents };
  await budget.reserve(id, cents, hash(spec));
  writeJson(path.join(f.directory, 'operations', id + '.json'), { id, fingerprint: hash(spec), status: 'succeeded', spec });
}

test('the revision flow follows the recorded model parameters and never invents work', async () => {
  const f = fixture();
  for (const prefix of ['speech', 'video', 'video-check']) await succeededOp(f, prefix + '-shot01-r0');
  const before = readJson(f.stateFile);
  const revisionBefore = before.editRevision || 0;
  const ledgerBefore = fileHash(f.ledgerFile);
  const opsBefore = fs.readdirSync(path.join(f.directory, 'operations')).sort();
  // (a) the same model parameters: no revision, no redo, no reservation and no version bump.
  await assert.rejects(reviseScript(f.context, structuredClone(before.script), '相同的模型参数不应产生变化',
    { speechProfilePatch: { shotId: 'shot01', instruction: INSTRUCTION, rate: MODEL_RATE } }), /SCRIPT_UNCHANGED/);
  const untouched = readJson(f.stateFile);
  assert.equal(untouched.editRevision, before.editRevision);   // the refusal wrote nothing at all
  assert.equal(untouched.revisions['speech-shot01'], 0);
  assert.equal(fileHash(f.ledgerFile), ledgerBefore);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'operations')).sort(), opsBefore);
  assert.equal(untouched.audioReview.status, 'accepted');
  assert.deepEqual(untouched.audioRecords.shot01, before.audioRecords.shot01);

  // (b) a really changed model rate: speech, its downstream and the old acceptance go exactly once.
  const result = await reviseScript(f.context, structuredClone(before.script), '模型语速改为 1.0',
    { speechProfilePatch: { shotId: 'shot01', instruction: INSTRUCTION, rate: LOCAL_RATE } });
  assert.deepEqual(result.deliveryChanges, ['shot01']);
  assert.equal(result.deliveryChangeReasons.shot01, 'MODEL_PARAMS_CHANGED');
  const after = readJson(f.stateFile);
  assert.equal(after.revisions['speech-shot01'], 1);
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(after.assets.shot01.audio, undefined);
  assert.equal(after.audioReview.status, 'pending');
  assert.match(after.audioReview.note, /MODEL_PARAMS_CHANGED/);
  assert.equal(after.audioRecords.shot01, undefined);
  assert.deepEqual(after.history.at(-1).audioRecords.shot01, before.audioRecords.shot01);   // kept as-is
  assert.equal(after.editRevision, revisionBefore + 1);

  // (c) a local post-processing speed plus a new line: no model parameter is blamed.
  const g = fixture();
  for (const prefix of ['speech', 'video', 'video-check']) await succeededOp(g, prefix + '-shot01-r0');
  const localNext = structuredClone(readJson(g.stateFile).script);
  localNext.shots[0].speechRate = 1.3;
  localNext.shots[0].text = '愿陛下忍三日之辱';
  const local = await reviseScript(g.context, localNext, '只改本地后处理语速与台词');
  assert.deepEqual(local.deliveryChangeReasons, {});
  const localState = readJson(g.stateFile);
  assert.equal(localState.revisions['speech-shot01'], 1);      // the changed line still invalidates speech
  assert.equal(localState.audioReview.status, 'pending');
  assert.deepEqual(localState.history.at(-1).audioRecords.shot01, audioRecord());
});
