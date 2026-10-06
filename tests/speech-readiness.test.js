const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext, runProduction, speechReadiness } = require('../workflows/production');
const { reviewInputDigest } = require('../workflows/planner');
const ROOT = path.resolve(__dirname, '..');
const CAPABLE = 'qwen-audio-3.0-tts-plus';

function fixture({ speechModel = CAPABLE, emotion = '隐忍', instruction = '平稳朗读', speaker = 'character01' } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'speech-ready-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: 'qwen3.8-omni-flash', promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'speech-ready-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  const production = { id: 'speech-ready-film', description: '配音前置检查隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  const base = { type: 'narration', characters: [], speaker, scene: '场景', action: '动作', endScene: '尾帧', needsLastFrame: true };
  const shots = [{ ...base, id: 'shot01', text: '第一句台词', emotion, duration: 5 },
    { ...base, id: 'shot02', text: '第二句台词', emotion, duration: 5 }];
  const script = { title: '测试', shots };
  const directory = path.join(root, 'jobs', 'aliyun', 'speech-ready-film');
  // The same registry key the runtime computes, so the cached character is reused without a paid check.
  const source = { id: 'character01', image: media.image(image).hash, sample: media.audio(sample, true).hash, front: null };
  const registryKey = hash({ source, traits: production.characters[0].traits,
    speechModel: config.models.speech, portraitModel: config.models.portrait });
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'speech-ready-film',
    characters: { character01: { original: image, front: image, sample, traits: '测试', originalHash: fileHash(image),
      frontHash: fileHash(image), sampleHash: fileHash(sample), accepted: true, voice: 'voice-1',
      registryFile: path.join(root, 'jobs', 'aliyun', 'characters', registryKey, 'character.json') } },
    approvals: { script: hash(script) }, assets: {}, revisions: {},
    audioRecords: { shot01: { model: speechModel, performance: { instruction: '平稳朗读', rate: 1, hotFix: 'not-needed' } } },
    speechProfile: { models: { speech: speechModel, voiceEnrollment: 'voice-enrollment' },
      delivery: { shot01: { instruction, rate: 1 } } },
    brief: { storySummary: '隔离测试简报', shotGuidance: '仅隔离测试', characters: [] },
    script, stage: 'script',
    scriptReview: { model: 'qwen3.8-omni-flash', promptVersion: 1, verdict: 'pass', summary: '结构可用',
      contextIssues: [], durationIssues: [], estimatedDurationSeconds: 10, longShots: [],
      reviewInputDigest: reviewInputDigest(production, undefined, script, 1), scriptHash: hash(script) } });
  const context = loadContext(root, 'production.json');
  // The review digest must be computed from the context the runtime itself holds (resolved paths).
  const stored = readJson(path.join(directory, 'state.json'));
  stored.scriptReview = { model: 'qwen3.8-omni-flash', promptVersion: 1, verdict: 'pass', summary: '结构可用',
    contextIssues: [], durationIssues: [], estimatedDurationSeconds: 10, longShots: [],
    reviewInputDigest: reviewInputDigest(context.production, stored.brief, script, 1), scriptHash: hash(script) };
  writeJson(path.join(directory, 'state.json'), stored);
  return { root, directory, config, production, media, context, script, shot: shots[1],
    stateFile: path.join(directory, 'state.json'), ledgerFile: path.join(directory, 'api-ledger.json') };
}
function recordedPosts() {
  const posts = [];
  return { posts, request: async (endpoint, body) => {
    posts.push({ endpoint, body }); throw new Error('SHOULD_NOT_BE_CALLED:' + endpoint);
  } };
}

test('a later shot without the required performance parameters stops the audio stage with zero requests', async () => {
  const f = fixture();
  const client = recordedPosts();
  await assert.rejects(runProduction(f.context, { until: 'audio', client, log: () => {} }),
    /SPEECH_PERFORMANCE_PARAMS_MISSING: shot02（EMOTION_NOT_HANDLED: 该模型支持情绪指令但缺少 instruction）/);
  assert.equal(client.posts.length, 0);                       // no enrollment, no speech, no review
  assert.equal(fs.existsSync(f.ledgerFile), false);           // no reservation was made either
  assert.equal(fs.existsSync(path.join(f.directory, 'operations')), false);   // no voice registration was attempted
  const state = readJson(f.stateFile);
  assert.equal(state.speechReadiness, undefined);             // recorded only when the check passes
  assert.equal(state.assets.shot01, undefined);               // no speech asset was produced for any shot
  assert.equal(state.audioRecords.shot01.performance.instruction, '平稳朗读');   // the seeded record is untouched
});

test('the readiness report names the shot and the exact missing parameter', () => {
  const f = fixture();
  const ready = speechReadiness(f.production, readJson(f.stateFile), f.config);
  assert.equal(ready.model, CAPABLE);
  assert.equal(ready.supportsInstruction, true);
  assert.deepEqual(ready.problems, [{ shotId: 'shot02', reason: 'EMOTION_NOT_HANDLED: 该模型支持情绪指令但缺少 instruction' }]);
  // A model without instruction support cannot be blamed for an emotion it cannot express.
  const plain = fixture({ speechModel: 'qwen3-tts-vc-2026-01-22' });
  assert.deepEqual(speechReadiness(plain.production, readJson(plain.stateFile), plain.config).problems, []);
  // An unregistered speaker, a missing reference voice and an out-of-range rate are all reported.
  const broken = readJson(f.stateFile);
  broken.script.shots[0].speaker = 'character99';
  delete broken.characters.character01.sample;
  broken.speechProfile.delivery.shot01.rate = 9;
  const problems = speechReadiness(f.production, broken, f.config).problems.map(p => p.shotId + ':' + p.reason);
  assert.ok(problems.includes('shot01:SPEAKER_NOT_REGISTERED:character99'));
  assert.ok(problems.includes('shot02:VOICE_SAMPLE_MISSING'));
  assert.ok(problems.includes('shot01:INVALID_DELIVERY_RATE'));
});

test('only the parameters that reach the request count as model parameters', async () => {
  const { effectiveDelivery, recordedDelivery, speechDeliveryChanged } = require('../workflows/operations-map');
  const f = fixture();
  const state = readJson(f.stateFile);
  // The delivery map also carries local post-processing knobs; they never enter a request.
  state.speechProfile.delivery.shot01 = { instruction: '放慢', rate: 0.9, speechRate: 1.1, speechLeadSeconds: 0.3 };
  const effective = effectiveDelivery(state, 'shot01', f.config);
  assert.deepEqual(effective, { model: CAPABLE, instruction: '放慢', rate: 0.9, hotFix: false });
  assert.equal('speechRate' in effective, false);
  assert.equal('speechLeadSeconds' in effective, false);
  // A record written from that request is identical to what would be sent, so it is reusable.
  // A record written by the current runtime carries the parameters that really reached the request.
  const recorded = recordedDelivery({ model: CAPABLE, modelParams: { instruction: '放慢', rate: 0.9, hotFix: false } });
  assert.deepEqual(recorded, { verified: true, ...effective });
  assert.equal(speechDeliveryChanged({ ...state,
    audioRecords: { shot01: { model: CAPABLE, modelParams: { instruction: '放慢', rate: 0.9, hotFix: false } } } },
  'shot01', f.config), false);
  assert.equal(speechDeliveryChanged(state, 'shot01', f.config), true);       // the fixture record differs
  // A legacy record cannot prove the model rate, so it counts as changed instead of being assumed equal.
  assert.equal(speechDeliveryChanged({ ...state,
    audioRecords: { shot01: { model: CAPABLE, performance: { instruction: '放慢', rate: 0.9, hotFix: 'none' } } } },
  'shot01', f.config), true);
  assert.equal(speechDeliveryChanged(state, 'shot01', f.config, { instruction: '更慢' }), true);
});
