const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reviseScript } = require('../workflows/revise');
const { loadContext } = require('../workflows/production');
const { Operations } = require('../services/aliyun/operations');
const { Budget } = require('../services/aliyun/budget');
const { Media } = require('../services/aliyun/media');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'revise-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'revise-film', providers: ['deepseek', 'aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav'), first = path.join(root, 'first.png');
  const last = path.join(root, 'last.png'), audio = path.join(root, 'line.wav'), video = path.join(root, 'clip.mp4');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'color=c=green:s=512x512', '-frames:v', '1', first]);
  media.command(['-f', 'lavfi', '-i', 'color=c=red:s=512x512', '-frames:v', '1', last]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', audio]);
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  const production = { id: 'revise-film', description: '修订隔离测试故事，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60, intakeFile: 'input/director-brief.json',
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'input/production.json'), production);
  writeJson(path.join(root, 'input/director-brief.json'), { preparedBy: 'codex', status: 'ready', productionId: 'revise-film',
    descriptionHash: hash(production.description), storySummary: '测试简报', shotGuidance: '仅隔离测试',
    characters: [{ id: 'character01', imageSha256: fileHash(image), voiceSha256: fileHash(sample), frontSha256: null,
      visualAnalysis: '合成测试图', voiceAnalysis: '合成测试音调，不是用户语音' }] });
  const base = { type: 'narration', characters: [], speaker: 'character01', scene: '场景', action: '动作', endScene: '尾帧',
    needsLastFrame: true, duration: 5 };
  const shot01 = { ...base, id: 'shot01', text: '旧台词一', lastFrameDirection: '旧尾帧修正' };
  const shot02 = { ...base, id: 'shot02', text: '旧台词二', lastFrameDirection: '无关镜头修正' };
  const directory = path.join(root, 'jobs', 'aliyun', 'revise-film');
  const editedPath = id => path.join(directory, 'video-local', id + '-local-edit.mp4');
  const assets = id => ({ first, last, audio, video, frameReview: { pass: true, issues: [] }, videoReview: { pass: true, issues: [] } });
  const state = { version: 1, productionId: 'revise-film',
    characters: { character01: { original: image, front: image, sample, traits: '测试', registryFile: path.join(root, 'registry.json'), voice: 'voice-id' } },
    approvals: { 'frames-shot01': 'digest-frames-1', 'video-shot01': 'digest-video-1', 'video-shot02': 'digest-video-2' },
    assets: { shot01: assets('shot01'), shot02: assets('shot02') },
    localVideoEdits: {
      shot01: { source: video, sourceHash: fileHash(video), edited: editedPath('shot01'), editedHash: 'hash-01',
        sourceStart: 0, sourceEnd: 3, targetDuration: 3.9, reason: '避开畸变' },
      shot02: { source: video, sourceHash: fileHash(video), edited: editedPath('shot02'), editedHash: 'hash-02',
        sourceStart: 1, sourceEnd: 4, targetDuration: 5, reason: '无关镜头修复' } },
    revisions: {}, script: { title: '测试片', shots: [shot01, shot02] },
    timed: { title: '测试片', totalDuration: 10, shots: [shot01, shot02] }, stage: 'final', editRevision: 3,
    output: path.join(root, 'output', 'revise-film', 'revision-3', 'final.mp4') };
  writeJson(path.join(directory, 'state.json'), state);
  const f = { root, directory, config, state,
    context: loadContext(root, 'input/production.json'), budget: new Budget(root, config, directory) };
  f.succeedOperation = async (id, cents = 22) => {
    const spec = { endpoint: '/test/' + id, model: 'qwen-image-3.0', kind: 'image', prompt: id, images: ['a'], cents };
    await f.budget.reserve(id, cents, hash(spec));
    writeJson(path.join(directory, 'operations', id + '.json'), { id, fingerprint: hash(spec), status: 'succeeded', spec });
    return spec;
  };
  f.stateFile = path.join(directory, 'state.json');
  return f;
}

test('changing only lastFrameDirection advances the tail-frame operation instead of reusing the old id', async () => {
  const f = fixture();
  const operations = path.join(f.directory, 'operations');
  // A shot that already has frames, a clip and approvals has one recorded operation per prefix.
  for (const id of ['first-shot01-r0', 'frame-check-shot01-r0', 'video-shot01-r0', 'video-check-shot01-r0'])
    await f.succeedOperation(id);
  const oldSpec = await f.succeedOperation('last-shot01-r0');
  const changedSpec = { ...oldSpec, prompt: '新的尾帧提示。导演修正：新尾帧修正' };
  // Mock provider only: no real request is issued anywhere in this test.
  const mock = { request: async () => ({ output: { choices: [{ message: { content: [{ image: 'https://test.aliyuncs.com/new.png' }] } }] } }) };
  // Reproduce the reported failure: the new prompt under the OLD operation id collides with the
  // recorded fingerprint, so resuming would throw instead of generating the corrected tail frame.
  await assert.rejects(new Operations(operations, mock, f.budget).execute('last-shot01-r0', changedSpec, async () => ({})),
    /OPERATION_INPUT_CHANGED/);
  const next = structuredClone(f.state.script);
  next.shots[0].lastFrameDirection = '新尾帧修正';
  const result = await reviseScript(f.context, next, '只调整尾帧导演修正');
  const after = readJson(f.stateFile);
  assert.deepEqual(result.affectedShots, ['shot01']);
  assert.equal(result.networkRequests, 0);
  assert.equal(after.revisions['last-shot01'], 1);
  assert.equal(after.revisions['first-shot01'], 1);
  assert.equal(after.revisions['frame-check-shot01'], 1);
  assert.equal(after.revisions['video-shot01'], 1);
  assert.equal(after.revisions['video-check-shot01'], 1);
  assert.ok(after.history.at(-1).previousOperations.includes('last-shot01-r0'));
  // The unrelated shot keeps its frames, its approval and its operation revision.
  assert.equal(after.revisions['last-shot02'], undefined);
  assert.equal(after.assets.shot02.last, f.state.assets.shot02.last);
  assert.equal(after.approvals['video-shot02'], 'digest-video-2');
  // The revised shot loses its stale frames, clip and approvals.
  assert.equal(after.assets.shot01.last, undefined);
  assert.equal(after.assets.shot01.first, undefined);
  assert.equal(after.assets.shot01.video, undefined);
  assert.equal(after.approvals['frames-shot01'], undefined);
  assert.equal(after.approvals['video-shot01'], undefined);
  // Recovery uses the advanced id, so the provider call is a new operation without a fingerprint clash.
  const resumed = await new Operations(operations, mock, f.budget).execute('last-shot01-r1', changedSpec, async () => ({}));
  assert.ok(resumed.output.choices[0].message.content[0].image);
  const entries = new Budget(f.root, f.config, f.directory).report().entries;
  assert.equal(entries.find(e => e.id === 'last-shot01-r0').reservedCents, 22);
  assert.equal(entries.find(e => e.id === 'last-shot01-r1').reservedCents, 22);
  assert.equal(readJson(path.join(operations, 'last-shot01-r0.json')).status, 'succeeded');
});

test('a script revision stores the previous local edits and clears only the affected shot', async () => {
  const f = fixture();
  for (const id of ['first-shot02-r0', 'last-shot02-r0', 'frame-check-shot02-r0', 'video-shot02-r0', 'video-check-shot02-r0'])
    await f.succeedOperation(id);
  const next = structuredClone(f.state.script);
  next.shots[1].action = '动作二改';
  await reviseScript(f.context, next, '只改第二镜动作');
  const after = readJson(f.stateFile);
  const history = after.history.at(-1);
  assert.equal(history.kind, 'script-revision');
  // The whole previous map is deep-copied into the revision history, like redo does.
  assert.deepEqual(Object.keys(history.localVideoEdits).sort(), ['shot01', 'shot02']);
  for (const key of ['source', 'sourceHash', 'edited', 'editedHash', 'sourceStart', 'sourceEnd', 'targetDuration', 'reason'])
    assert.equal(history.localVideoEdits.shot01[key], f.state.localVideoEdits.shot01[key]);
  assert.equal(history.localVideoEdits.shot02.sourceStart, 1);
  assert.equal(history.localVideoEdits.shot02.targetDuration, 5);
  assert.equal(history.localVideoEdits.shot02.reason, '无关镜头修复');
  // The affected shot loses the live record, the unrelated shot keeps it.
  assert.deepEqual(after.localVideoEdits, { shot01: f.state.localVideoEdits.shot01 });
  assert.equal(after.revisions['last-shot02'], 1);
  assert.equal(after.assets.shot02.last, undefined);
  // Mutating the live state afterwards cannot rewrite the stored history copy.
  after.localVideoEdits.shot01.reason = '被改写';
  assert.equal(history.localVideoEdits.shot01.reason, '避开畸变');
  assert.equal(readJson(f.stateFile).history.at(-1).localVideoEdits.shot01.reason, '避开畸变');
  // Previous clips and the exported film are kept on disk and the export record is preserved.
  assert.ok(fs.existsSync(f.state.assets.shot01.video));
  assert.ok(fs.existsSync(f.state.assets.shot02.video));
  assert.equal(history.output, f.state.output);
});

test('an unresolved tail-frame operation blocks the revision without changing state or ledger', async () => {
  const f = fixture();
  const spec = { endpoint: '/test/last-shot01-r0', model: 'qwen-image-3.0', kind: 'image', prompt: '旧的', images: ['a'], cents: 22 };
  await f.budget.reserve('last-shot01-r0', 22, hash(spec));
  writeJson(path.join(f.directory, 'operations', 'last-shot01-r0.json'), { id: 'last-shot01-r0', fingerprint: hash(spec), status: 'submitting', spec });
  const stateHash = fileHash(f.stateFile), ledgerHash = fileHash(f.budget.file);
  const next = structuredClone(f.state.script);
  next.shots[0].lastFrameDirection = '不应生效的修正';
  await assert.rejects(reviseScript(f.context, next, '未决任务应阻断'), /REVISION_BLOCKED_UNRESOLVED_OPERATION:last-shot01-r0/);
  assert.equal(fileHash(f.stateFile), stateHash);
  assert.equal(fileHash(f.budget.file), ledgerHash);
});

