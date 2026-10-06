const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { Budget } = require('../services/aliyun/budget');
const { readJson, writeJson, fileHash } = require('../services/aliyun/io');
const { applyLocalEdits, parseLocalEditArgs, planLocalEdit, recordLocalEdit } = require('../workflows/local-edit');
const { loadState } = require('../workflows/production');
const { redo } = require('../workflows/redo');
const ROOT = path.resolve(__dirname, '..');

function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'local-edit-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'edit-film', providers: ['deepseek', 'aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const directory = path.join(root, 'jobs', 'aliyun', 'edit-film');
  fs.mkdirSync(directory, { recursive: true });
  const media = new Media(root, project);
  const video = path.join(directory, 'clip.mp4'), audio = path.join(directory, 'voice.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', audio]);
  const shot = { id: 'shot01', type: 'narration', characters: [], speaker: null, text: '测试台词', scene: '场景', action: '动作',
    duration: 3, speechDuration: 2.9, start: 0, end: 3 };
  const state = { version: 1, productionId: 'edit-film', characters: {}, approvals: {}, assets: { shot01: { video, audio } },
    script: { title: '测试', shots: [shot] }, timed: { title: '测试', totalDuration: 3, shots: [shot] }, stage: 'video' };
  return { root, directory, project, config, media, video, audio, state,
    context: { root, production: { id: 'edit-film' }, config, project, directory } };
}

test('local-edit arguments require exactly the documented flags', () => {
  assert.deepEqual(parseLocalEditArgs(['shot06', '--from', '0', '--to', '3', '--duration', '3.9', '--reason', '避开畸变']).options,
    { from: '0', to: '3', duration: '3.9', reason: '避开畸变' });
  const bad = [[], ['shot06'], ['shot06', '--from', '0'], ['shot06', '--from', '0', '--to', '3', '--duration', '3.9'],
    ['shot06', '--from', '0', '--to', '3', '--duration', '3.9', '--why', 'x'],
    ['shot06', '--from', '0', '--from', '1', '--to', '3', '--duration', '3.9', '--reason', 'x']];
  for (const args of bad) assert.throws(() => parseLocalEditArgs(args), /LOCAL_EDIT/);
});

test('local-edit plan rejects unknown shots, reversed ranges and slots shorter than the timeline', () => {
  const f = fixture();
  assert.throws(() => planLocalEdit(f.state, 'shot09', { from: 0, to: 3, duration: 3.9, reason: 'x' }), /SHOT_NOT_FOUND/);
  assert.throws(() => planLocalEdit(f.state, 'shot01', { from: 3, to: 1, duration: 3, reason: 'x' }), /RANGE/);
  assert.throws(() => planLocalEdit(f.state, 'shot01', { from: 0, to: 3, duration: 2, reason: 'x' }), /TOO_SHORT_FOR_SHOT/);
  assert.throws(() => planLocalEdit(f.state, 'shot01', { from: 0, to: 3, duration: 3.9, reason: ' ' }), /REASON/);
  assert.deepEqual(planLocalEdit(f.state, 'shot01', { from: 0, to: '3', duration: '3.9', reason: ' 避开畸变 ' }),
    { sourceStart: 0, sourceEnd: 3, targetDuration: 3.9, reason: '避开畸变' });
});

test('a recorded local edit is rebuilt from its source, reused by hash and never invents a source', () => {
  const f = fixture(), editDirectory = path.join(f.directory, 'video-local'), sourceHash = fileHash(f.video);
  const state = structuredClone(f.state);
  state.localVideoEdits = { shot01: { source: f.video, sourceHash, sourceStart: 0, sourceEnd: 3, targetDuration: 3.9, reason: '慢放可用前段' } };
  const first = applyLocalEdits(f.media, state, state.assets, editDirectory);
  const edited = first.applied.shot01.edited;
  assert.ok(fs.existsSync(edited));
  assert.equal(first.applied.shot01.reused, false);
  assert.ok(Math.abs(Number(f.media.probe(edited).format.duration) - 3.9) < 0.15);
  const reused = applyLocalEdits(f.media, { ...state, localVideoEdits: { shot01: first.applied.shot01 } }, state.assets, editDirectory);
  assert.equal(reused.applied.shot01.reused, true);
  assert.equal(fileHash(reused.assets.shot01.video), first.applied.shot01.editedHash);
  // The provider output itself is untouched and still recorded in the assets.
  assert.equal(fileHash(f.video), sourceHash);
  const changed = structuredClone(state);
  changed.localVideoEdits.shot01.sourceHash = 'deadbeef';
  changed.localVideoEdits.shot01.edited = path.join(editDirectory, 'missing.mp4');
  assert.throws(() => applyLocalEdits(f.media, changed, changed.assets, editDirectory), /LOCAL_EDIT_SOURCE_CHANGED/);
  const gone = structuredClone(state);
  gone.localVideoEdits.shot01.source = path.join(editDirectory, 'missing.mp4');
  gone.localVideoEdits.shot01.edited = path.join(editDirectory, 'missing.mp4');
  assert.throws(() => applyLocalEdits(f.media, gone, gone.assets, editDirectory), /LOCAL_EDIT_SOURCE_MISSING/);
});

test('recording a local edit exports a revision, keeps the previous one and needs no provider', async () => {
  const f = fixture();
  writeJson(path.join(f.directory, 'state.json'), f.state);
  const first = await recordLocalEdit(f.context, 'shot01', { from: 0, to: 3, duration: 3.9, reason: '避开畸变' });
  assert.equal(first.networkRequests, 0);
  assert.equal(first.previousExportKept, false);
  assert.equal(path.basename(path.dirname(first.output)), 'edit-film');
  assert.ok(fs.existsSync(first.output));
  const saved = readJson(path.join(f.directory, 'state.json'));
  assert.equal(saved.stage, 'final');
  assert.equal(saved.acceptance, 'awaiting_user_playback');
  assert.equal(saved.localVideoEdits.shot01.reused, true);
  assert.ok(saved.localVideoEdits.shot01.editedHash);
  assert.ok(fs.existsSync(path.join(path.dirname(first.output), 'local-edit-record.json')));
  const second = await recordLocalEdit(f.context, 'shot01', { from: 0, to: 3, duration: 4.2, reason: '再慢一点' });
  assert.equal(second.previousExportKept, true);
  assert.equal(path.basename(path.dirname(second.output)), 'revision-1');
  assert.notEqual(second.output, first.output);
  assert.ok(fs.existsSync(first.output));
  // A later final assembly re-applies the recorded edit instead of discarding it.
  const state = loadState(f.context);
  const applied = applyLocalEdits(f.media, state, state.assets, path.join(f.directory, 'video-local'));
  assert.equal(applied.applied.shot01.reused, true);
  assert.equal(fileHash(applied.assets.shot01.video), state.localVideoEdits.shot01.editedHash);
});

test('a local edit is refused before the video stage and while a review is pending', async () => {
  const f = fixture();
  writeJson(path.join(f.directory, 'state.json'), { ...f.state, stage: 'audio' });
  await assert.rejects(recordLocalEdit(f.context, 'shot01', { from: 0, to: 3, duration: 3.9, reason: 'x' }), /REQUIRES_VIDEO_STAGE/);
  writeJson(path.join(f.directory, 'state.json'), { ...f.state, pendingReview: { key: 'video-shot01' } });
  await assert.rejects(recordLocalEdit(f.context, 'shot01', { from: 0, to: 3, duration: 3.9, reason: 'x' }), /PENDING_REVIEW/);
  assert.equal(fs.existsSync(path.join(f.directory, 'video-local')), false);
});

test('redo drops the local edit of a regenerated shot and keeps it in history', async () => {
  const f = fixture();
  f.state.localVideoEdits = { shot01: { source: f.video, sourceHash: fileHash(f.video), edited: 'old.mp4', editedHash: 'hash', sourceStart: 0, sourceEnd: 3, targetDuration: 3.9, reason: '第一版修复' } };
  writeJson(path.join(f.directory, 'state.json'), f.state);
  const budget = new Budget(f.root, f.context.config, f.directory);
  for (const id of ['video-shot01-r0', 'video-check-shot01-r0']) {
    await budget.reserve(id, 20, id);
    writeJson(path.join(f.directory, 'operations', id + '.json'), { id, status: 'succeeded', taskId: 't', result: { output: { task_status: 'SUCCEEDED' } } });
  }
  await redo(f.context, 'shot01', 'video', '动作不自然');
  const after = readJson(path.join(f.directory, 'state.json'));
  assert.equal(after.localVideoEdits, undefined);
  assert.equal(after.history.at(-1).localVideoEdits.shot01.reason, '第一版修复');
  assert.equal(after.editRevision, 1);
});

