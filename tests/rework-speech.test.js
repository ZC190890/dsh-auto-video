const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { Budget } = require('../services/aliyun/budget');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext } = require('../workflows/production');
const { reviseScript } = require('../workflows/revise');
const ROOT = path.resolve(__dirname, '..');
const SPEECH = 'qwen-audio-3.0-tts-plus';
const LINE = '愿陛下忍数日之辱';

// A registered, audio-accepted shot: the state a rework meets in a real job.
function fixture({ speechRevision = 0, instruction = '平稳朗读' } = {}) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'rw-speech-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'rw-speech-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav'), audio = path.join(root, 'shot01.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=24000', '-t', '3', '-ac', '1', audio]);
  const production = { id: 'rw-speech-film', description: '返工配音联动隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  const base = { type: 'narration', characters: [], speaker: 'character01', scene: '场景', action: '动作',
    endScene: '尾帧', needsLastFrame: true, duration: 5 };
  const shots = [{ ...base, id: 'shot01', text: LINE, emotion: '隐忍', speechRate: 1, speechLeadSeconds: 0 },
    { ...base, id: 'shot02', text: '第二句台词', emotion: '平静' }];
  const timed = { title: '测试', totalDuration: 10,
    shots: shots.map((s, i) => ({ ...s, start: i * 5, end: i * 5 + 5, speechDuration: 3 })) };
  const directory = path.join(root, 'jobs', 'aliyun', 'rw-speech-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'rw-speech-film',
    characters: { character01: { original: image, front: image, sample, traits: '测试', originalHash: fileHash(image),
      frontHash: fileHash(image), sampleHash: fileHash(sample), accepted: true, voice: 'voice-1' } },
    approvals: { 'video-shot01': 'digest-a', 'video-shot02': 'digest-b' },
    assets: { shot01: { first: image, last: image, audio, audioHash: fileHash(audio), video: image },
      shot02: { first: image, last: image, audio, audioHash: fileHash(audio), video: image } },
    revisions: { 'speech-shot01': speechRevision, 'speech-shot02': 0 },
    speechProfile: { models: { speech: SPEECH, voiceEnrollment: 'voice-enrollment' },
      delivery: { shot01: { instruction, rate: 1 }, shot02: { instruction: '平静朗读', rate: 1 } } },
    audioRecords: { shot01: { model: SPEECH, performance: { instruction, rate: 1, hotFix: 'not-needed' } },
      shot02: { model: SPEECH, performance: { instruction: '平静朗读', rate: 1, hotFix: 'not-needed' } } },
    audioReviews: { shot01: { shotId: 'shot01', reviewStatus: 'accepted-by-user' } },
    audioReview: { status: 'accepted', model: SPEECH, note: '接受' }, script: { title: '测试', shots }, timed, stage: 'video' });
  const context = loadContext(root, 'production.json');
  return { root, directory, config, media, context, shots, stateFile: path.join(directory, 'state.json'), audio };
}
// A succeeded operation with its ledger reservation, so the untouched parts pass the preflight.
async function succeededOp(f, id, cents = 20) {
  const budget = new Budget(f.root, f.config, f.directory);
  const spec = { endpoint: '/test/' + id, model: 'qwen-vl-plus', kind: 'vision', prompt: id, images: ['a'], cents };
  await budget.reserve(id, cents, hash(spec));
  writeJson(path.join(f.directory, 'operations', id + '.json'), { id, fingerprint: hash(spec), status: 'succeeded', spec });
}
async function succeededSpeechGroup(f, shotId) {
  for (const prefix of ['speech', 'video', 'video-check']) await succeededOp(f, prefix + '-' + shotId + '-r0');
}
const opsPath = (f, id) => path.join(f.directory, 'operations', id + '.json');

test('a changed performance instruction invalidates speech, its downstream and the old acceptance', async () => {
  const f = fixture();
  await succeededSpeechGroup(f, 'shot01');
  const before = readJson(f.stateFile);
  const next = structuredClone(before.script);
  const result = await reviseScript(f.context, next, '模型返工指令：放慢并加重语气',
    { speechProfilePatch: { shotId: 'shot01', instruction: '放慢语速并加重语气' } });
  const after = readJson(f.stateFile);
  // The instruction is a real request parameter, so speech and every downstream asset is invalidated.
  assert.equal(after.speechProfile.delivery.shot01.instruction, '放慢语速并加重语气');
  assert.equal(after.revisions['speech-shot01'], 1);
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(after.revisions['video-check-shot01'], 1);
  assert.equal(after.assets.shot01.audio, undefined);
  assert.equal(after.assets.shot01.audioHash, undefined);
  assert.equal(after.assets.shot01.video, undefined);
  // The unrelated shot keeps its audio, revision and approval.
  assert.equal(after.revisions['speech-shot02'], 0);
  assert.equal(after.assets.shot02.audio, f.audio);
  assert.equal(after.approvals['video-shot02'], 'digest-b');
  // The previous acceptance and its per-shot analysis can no longer stand.
  assert.equal(after.audioReview.status, 'pending');
  assert.equal(after.audioRecords.shot01, undefined);
  assert.equal(after.audioReviews.shot01, undefined);
  assert.equal(after.audioRecords.shot02.model, SPEECH);
  assert.deepEqual(result.deliveryChanges, ['shot01']);
  assert.equal(result.networkRequests, 0);                    // nothing was sent anywhere
  // The superseded parameters are preserved in history, deep-copied.
  const history = after.history.at(-1);
  assert.equal(history.speechProfile.delivery.shot01.instruction, '平稳朗读');
  assert.equal(history.audioRecords.shot01.performance.instruction, '平稳朗读');
  assert.equal(history.audioReview.status, 'accepted');
  after.speechProfile.delivery.shot01.instruction = '被改写';
  assert.equal(readJson(f.stateFile).history.at(-1).speechProfile.delivery.shot01.instruction, '平稳朗读');
});

test('an emotion edit and an instruction edit are invalidated together without double counting', async () => {
  const f = fixture();
  await succeededSpeechGroup(f, 'shot01');
  const next = structuredClone(readJson(f.stateFile).script);
  next.shots[0].emotion = '暴怒';
  await reviseScript(f.context, next, '返工：情绪改成暴怒并加重语气',
    { speechProfilePatch: { shotId: 'shot01', instruction: '愤怒、重音在最后两字' } });
  const after = readJson(f.stateFile);
  assert.equal(after.script.shots[0].emotion, '暴怒');
  assert.equal(after.revisions['speech-shot01'], 1);          // advanced exactly once
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(after.history.at(-1).deliveryChanges.length, 1);
  assert.equal(after.audioReview.status, 'pending');
});

test('a new line plus a new instruction invalidates speech once and keeps other shots intact', async () => {
  const f = fixture();
  await succeededSpeechGroup(f, 'shot01');
  const next = structuredClone(readJson(f.stateFile).script);
  next.shots[0].text = '愿陛下忍三日之辱';
  await reviseScript(f.context, next, '返工：改台词并按新台词重配语气',
    { speechProfilePatch: { shotId: 'shot01', instruction: '按新台词重配语气' } });
  const after = readJson(f.stateFile);
  assert.equal(after.script.shots[0].text, '愿陛下忍三日之辱');
  assert.equal(after.revisions['speech-shot01'], 1);
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(after.revisions['speech-shot02'], 0);
  assert.equal(after.approvals['video-shot01'], undefined);
  assert.equal(after.stage, 'script');
});

test('a blocked or exhausted speech operation refuses the instruction and never writes the profile', async () => {
  const blocked = fixture();
  await succeededOp(blocked, 'speech-shot01-r0');
  writeJson(opsPath(blocked, 'speech-shot01-r0'),
    { ...readJson(opsPath(blocked, 'speech-shot01-r0')), status: 'submitting' });
  const stateBefore = fileHash(blocked.stateFile);
  const ledgerBefore = fileHash(path.join(blocked.directory, 'api-ledger.json'));
  await assert.rejects(reviseScript(blocked.context, structuredClone(readJson(blocked.stateFile).script),
    '不应写入 profile', { speechProfilePatch: { shotId: 'shot01', instruction: '新的表演指令' } }),
  /REVISION_BLOCKED_UNRESOLVED_OPERATION:speech-shot01-r0:submitting/);
  assert.equal(fileHash(blocked.stateFile), stateBefore);     // no half-applied performance change
  assert.equal(fileHash(path.join(blocked.directory, 'api-ledger.json')), ledgerBefore);
  assert.equal(readJson(blocked.stateFile).speechProfile.delivery.shot01.instruction, '平稳朗读');

  const spent = fixture({ speechRevision: 1 });
  await succeededOp(spent, 'speech-shot01-r1');
  // Four generations used: the speech unit of that shot is paused by the round ledger.
  writeJson(path.join(spent.directory, 'unit-attempts.json'), { version: 1, units: { 'speech-shot01': {
    generations: 4, reworks: 3, consumed: {}, pending: null,
    exhausted: { at: '2026-09-22T00:00:00.000Z', generations: 4, reason: '测试：三次返工仍未通过' } } } });
  const spentState = fileHash(spent.stateFile);
  await assert.rejects(reviseScript(spent.context, structuredClone(readJson(spent.stateFile).script),
    '耗尽后不得继续', { speechProfilePatch: { shotId: 'shot01', instruction: '第三次尝试' } }),
  /REVISION_ATTEMPTS_EXHAUSTED:speech-shot01-r1/);
  assert.equal(fileHash(spent.stateFile), spentState);
  assert.equal(readJson(spent.stateFile).speechProfile.delivery.shot01.instruction, '平稳朗读');
});

