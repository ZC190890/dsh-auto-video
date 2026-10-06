const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../index');
const { Media } = require('../services/aliyun/media');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

// Isolated project root: own config, own manifest, own job directory, own output tree.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'cli-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  // onlineEnabled stays false on purpose: the local-edit command must not need any authorization.
  writeJson(path.join(root, 'config/aliyun.json'), readJson(path.join(ROOT, 'config/aliyun.json')));
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  const audio = path.join(root, 'line.wav'), video = path.join(root, 'clip.mp4');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', audio]);
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  const production = { id: 'cli-film', description: '隔离测试故事，不是真实成片素材', style: '测试', targetDurationSeconds: 7,
    maxDurationSeconds: 60, intakeFile: 'input/director-brief.json',
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'input/production.json'), production);
  writeJson(path.join(root, 'input/director-brief.json'), { preparedBy: 'codex', status: 'ready', productionId: 'cli-film',
    descriptionHash: hash(production.description), storySummary: '测试简报', shotGuidance: '仅隔离测试',
    characters: [{ id: 'character01', imageSha256: fileHash(image), voiceSha256: fileHash(sample), frontSha256: null,
      visualAnalysis: '合成测试图', voiceAnalysis: '合成测试音调，不是用户语音' }] });
  const shot = { id: 'shot01', type: 'narration', characters: [], speaker: 'character01', text: '测试台词', scene: '场景',
    action: '动作', duration: 3, speechDuration: 2.9, start: 0, end: 3 };
  const directory = path.join(root, 'jobs', 'aliyun', 'cli-film');
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'cli-film', characters: {}, approvals: {},
    assets: { shot01: { video, audio } }, script: { title: '测试', shots: [shot] },
    timed: { title: '测试', totalDuration: 3, shots: [shot] }, stage: 'video' });
  return { root, directory, media, video };
}

test('local-edit through the real CLI entry clips, exports and reserves nothing', async () => {
  const f = fixture();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  try {
    await main(['local-edit', 'input/production.json', 'shot01', '--from', '0', '--to', '3', '--duration', '3.9', '--reason', '避开畸变'],
      { root: f.root });
  } finally { global.fetch = originalFetch; }
  const state = readJson(path.join(f.directory, 'state.json'));
  assert.equal(state.stage, 'final');
  assert.equal(state.acceptance, 'awaiting_user_playback');
  assert.equal(state.localVideoEdits.shot01.sourceStart, 0);
  assert.equal(state.localVideoEdits.shot01.sourceEnd, 3);
  assert.equal(state.localVideoEdits.shot01.targetDuration, 3.9);
  assert.equal(state.localVideoEdits.shot01.reason, '避开畸变');
  assert.equal(state.localVideoEdits.shot01.sourceHash, fileHash(f.video));
  assert.ok(state.localVideoEdits.shot01.editedHash);
  assert.ok(fs.existsSync(state.localVideoEdits.shot01.edited));
  assert.equal(state.output, path.join(f.root, 'output', 'cli-film', 'final.mp4'));
  assert.ok(fs.existsSync(state.output));
  assert.ok(Number(f.media.probe(state.output).format.duration) > 0);
  assert.ok(fs.existsSync(path.join(f.root, 'output', 'cli-film', 'local-edit-record.json')));
  // Local editing never contacts a provider and never reserves budget.
  assert.equal(fs.existsSync(path.join(f.directory, 'api-ledger.json')), false);
  assert.equal(readJson(path.join(f.root, 'config/aliyun.json')).onlineEnabled, false);
});

test('local-edit through the real CLI entry rejects bad arguments before changing anything', async () => {
  const f = fixture();
  const before = fileHash(path.join(f.directory, 'state.json'));
  const manifest = 'input/production.json';
  await assert.rejects(main(['local-edit', manifest, 'shot01', '--from', '0', '--to', '3'], { root: f.root }),
    /LOCAL_EDIT_SHOT_AND_OPTIONS_REQUIRED/);
  await assert.rejects(main(['local-edit', manifest, 'shot01', '--from', '0', '--to', '3', '--duration', '2', '--reason', 'x'], { root: f.root }),
    /LOCAL_EDIT_TOO_SHORT_FOR_SHOT/);
  await assert.rejects(main(['local-edit', manifest, 'shot09', '--from', '0', '--to', '3', '--duration', '3.9', '--reason', 'x'], { root: f.root }),
    /SHOT_NOT_FOUND/);
  await assert.rejects(main(['local-edit'], { root: f.root }), /MANIFEST_REQUIRED/);
  await assert.rejects(main(['not-a-command', manifest], { root: f.root }), /UNKNOWN_COMMAND/);
  assert.equal(fileHash(path.join(f.directory, 'state.json')), before);
  assert.equal(fs.existsSync(path.join(f.directory, 'video-local')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'output', 'cli-film')), false);
});
