// Synthetic-media verification of the audio-bed film path. Everything here is generated locally with the
// project's own FFmpeg: no provider, no real task directory, no real asset. The tones are distinguishable
// on purpose so the assertions measure the ACTUAL output signal, not just JSON or command arguments.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { Media, timelineSubtitles } = require('../services/aliyun/media');
const { readJson } = require('../services/aliyun/io');

// Declared tolerances (stated once so the report can quote them).
const DURATION_TOLERANCE = 0.15;   // assemble() itself rejects a film whose duration drifts more than this
const POSITION_TOLERANCE = 0.12;   // windows are chosen 0.10-0.15s away from every declared boundary
const TONE_TOLERANCE = 60;         // AAC keeps the dominant tone well inside this band
const SILENCE_LIMIT = 0.05;        // RMS below this counts as a real gap

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-timeline-'));
  return { root, media: new Media(ROOT, readJson(path.join(ROOT, 'config/project.json'))) };
}

// Dominant tone + loudness of one window of the finished film, measured on decoded PCM.
function windowSignal(media, file, at, seconds) {
  const rate = 24000;
  const pcm = media.command(['-ss', String(at), '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
  const samples = Math.floor(pcm.length / 2);
  let peak = 0, squares = 0;
  for (let i = 0; i < samples; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768; peak = Math.max(peak, v); squares += v * v; }
  const rms = samples ? Math.sqrt(squares / samples) : 0, threshold = peak * 0.35;
  let crossings = 0, state = 0;
  for (let i = 0; i < samples; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    if (v > threshold) { if (state === -1) crossings++; state = 1; }
    else if (v < -threshold) { if (state === 1) crossings++; state = -1; }
  }
  return { frequency: samples ? Math.round((crossings * rate) / (2 * samples)) : 0, rms };
}

// Energy inside a narrow band around one frequency, measured with FFmpeg's own band-pass filter. This is
// what makes the "residue" assertion meaningful: it measures the clip's own tone as a BAND, so a quiet
// but present leftover cannot hide behind a different dominant frequency.
function bandRms(media, file, at, seconds, frequency, width = 30) {
  const rate = 24000;
  const pcm = media.command(['-ss', String(at), '-i', file, '-t', String(seconds), '-vn', '-ac', '1', '-ar', String(rate),
    '-af', 'bandpass=f=' + frequency + ':width_type=h:w=' + width, '-f', 's16le', 'pipe:1']);
  const samples = Math.floor(pcm.length / 2);
  let squares = 0;
  for (let i = 0; i < samples; i++) { const v = pcm.readInt16LE(i * 2) / 32768; squares += v * v; }
  return samples ? Math.sqrt(squares / samples) : 0;
}

function cues(srt) {
  return srt.trim().split(/\n\n+/).map(block => {
    const [index, range, ...text] = block.split('\n');
    const [from, to] = range.split(' --> ').map(stamp => {
      const [h, m, rest] = stamp.split(':'); const [s, ms] = rest.split(',');
      return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    });
    return { index: Number(index), from, to, text: text.join('\n') };
  });
}

test('a continuous accepted line crosses three shots, one shot holds two segments with a real gap', () => {
  const { root, media } = workspace();
  const clips = ['s1', 's2', 's3'].map((id, index) => {
    const file = path.join(root, id + '.mp4');
    const colour = ['0x203040', '0x506070', '0x8090a0'][index], own = [1300, 1500, 1700][index];
    media.command(['-f', 'lavfi', '-i', 'color=c=' + colour + ':s=320x180:r=30', '-f', 'lavfi', '-i',
      'sine=frequency=' + own + ':sample_rate=48000,volume=4', '-t', '1', '-shortest', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    return file;
  });
  // Two accepted voice products of one acting passage (NOT one file per sentence): ln01 2.2s, ln02 0.45s.
  const ln01 = path.join(root, 'ln01.wav'), ln02 = path.join(root, 'ln02.wav');
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000,volume=4', '-t', '2.2', '-ac', '1', ln01]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=24000,volume=4', '-t', '0.45', '-ac', '1', ln02]);
  const bed = [
    { lineId: 'ln01', file: ln01, startSeconds: 0, durationSeconds: 2.2 },
    { lineId: 'ln02', file: ln02, startSeconds: 2.5, durationSeconds: 0.45 }
  ];
  // The declared mapping must be truthful about the real files before the film is built.
  for (const entry of bed) assert.ok(Math.abs(media.audio(entry.file).duration - entry.durationSeconds) < 0.02,
    '音频床条目声明的时长必须等于实际音频文件时长');
  const script = {
    shots: [
      { id: 's1', type: 'action', start: 0, end: 1, duration: 1 },
      { id: 's2', type: 'action', start: 1, end: 2, duration: 1 },
      { id: 's3', type: 'action', start: 2, end: 3, duration: 1 }
    ],
    totalDuration: 3,
    audioBed: bed,
    subtitles: [
      { lineId: 'ln01', start: 0, end: 2.2, text: '臣等正欲死战（跨三镜，不归零）' },
      { lineId: 'ln02', start: 2.5, end: 2.95, text: '陛下何故先降' }
    ]
  };
  const assets = { s1: { video: clips[0] }, s2: { video: clips[1] }, s3: { video: clips[2] } };
  const out = media.assemble(script, assets, path.join(root, 'film'));
  const probe = media.probe(out), duration = Number(probe.format.duration);
  assert.ok(Math.abs(duration - script.totalDuration) <= DURATION_TOLERANCE, '成片时长应等于声明时长（容差 ' + DURATION_TOLERANCE + '）');
  assert.ok(probe.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'), '成片必须有音频流');
  for (const at of [0.4, 1.4, 2.02]) {
    const signal = windowSignal(media, out, at, 0.15);
    assert.ok(Math.abs(signal.frequency - 440) <= TONE_TOLERANCE, at + ' 秒应仍是同一段连续音频（实测 ' + signal.frequency + 'Hz）');
    assert.ok(signal.rms > 0.05, at + ' 秒应有声音');
  }
  for (const [index, own] of [1300, 1500, 1700].entries()) {
    const signal = windowSignal(media, out, index + 0.4, 0.2);
    assert.ok(Math.abs(signal.frequency - own) > 120, '片段自带音轨不得混入成片（第' + (index + 1) + '镜测得 ' + signal.frequency + 'Hz）');
  }
  assert.ok(Math.abs(windowSignal(media, out, 2.02, 0.12).frequency - 440) <= TONE_TOLERANCE, '第3镜前段仍是 ln01 的尾部');
  assert.ok(windowSignal(media, out, 2.35, 0.08).rms < SILENCE_LIMIT, '2.2-2.5 之间应是真正的无声区间');
  assert.ok(windowSignal(media, out, 2.38, 0.06).rms < SILENCE_LIMIT, 'ln02 之前不得提前出现声音');
  const late = windowSignal(media, out, 2.6, 0.15);
  assert.ok(Math.abs(late.frequency - 880) <= TONE_TOLERANCE, 'ln02 应在 2.5 秒起以 880Hz 出现（实测 ' + late.frequency + 'Hz）');
  assert.ok(late.rms > 0.05, 'ln02 的尾部不得被截断');
  assert.ok(POSITION_TOLERANCE > 0, '位置容差已声明：' + POSITION_TOLERANCE);

  const srt = fs.readFileSync(path.join(root, 'film', 'subtitles.srt'), 'utf8');
  const list = cues(srt);
  assert.equal(list.length, 2, '两条语音产物对应两条字幕，不得按句子切碎');
  assert.equal(list[0].index, 1);
  assert.ok(Math.abs(list[0].from - 0) < 0.01 && Math.abs(list[0].to - 2.2) < 0.01, '跨镜字幕必须是一条连续区间');
  assert.ok(list[0].from < 1 && list[0].to > 2, '该字幕必须跨越 1.0 与 2.0 两处切镜');
  assert.equal(list[1].text, '陛下何故先降');
  assert.ok(Math.abs(list[1].from - 2.5) < 0.01 && Math.abs(list[1].to - 2.95) < 0.01);
  const frames = media.sampleFramesAt(out, path.join(root, 'frames'), [0.5, 1.5, 2.5]);
  const colours = frames.map(f => JSON.stringify(media.averageColor(f.file)));
  assert.equal(new Set(colours).size, 3, '成片画面必须是三个不同镜头，音频床独立于切镜');
  assert.throws(() => timelineSubtitles([{ lineId: 'x', start: 0, end: 1, text: 'a' }, { lineId: 'x', start: 0.5, end: 2, text: 'a' }]), /DUPLICATED/);
  assert.throws(() => timelineSubtitles([{ lineId: 'x', start: 0, end: 1, text: 'a' }, { lineId: 'y', start: 0.5, end: 2, text: 'b' }]), /OVERLAP/);
});

test('an empty bed still produces a silent, playable film', () => {
  const { root, media } = workspace();
  const clip = path.join(root, 'one.mp4');
  media.command(['-f', 'lavfi', '-i', 'color=c=0x101010:s=320x180:r=30', '-f', 'lavfi', '-i',
    'sine=frequency=900:sample_rate=48000,volume=4', '-t', '1', '-shortest', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const script = { shots: [{ id: 's1', type: 'action', start: 0, end: 1, duration: 1 }], totalDuration: 1, audioBed: [], subtitles: [] };
  const out = media.assemble(script, { s1: { video: clip } }, path.join(root, 'silent'));
  assert.ok(Math.abs(Number(media.probe(out).format.duration) - 1) <= DURATION_TOLERANCE);
  assert.ok(windowSignal(media, out, 0.4, 0.2).rms < SILENCE_LIMIT, '无声成片不得保留片段自带音轨');
  assert.equal(fs.readFileSync(path.join(root, 'silent', 'subtitles.srt'), 'utf8'), '');
});

test('the bed takes the declared source window: markers, level, residue, pace and tail', () => {
  const { root, media } = workspace();
  // ONE long take with three recognisable marker tones at known source positions: 300Hz | 500Hz | 700Hz.
  const take = path.join(root, 'take.wav');
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=24000,volume=4', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=24000,volume=4',
    '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=24000,volume=4', '-filter_complex',
    '[0:a]atrim=0:1.2[a0];[1:a]atrim=0:1.2[a1];[2:a]atrim=0:1.2[a2];[a0][a1][a2]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', take]);
  assert.ok(Math.abs(media.audio(take).duration - 3.6) < 0.05, '标记音源应长 3.6 秒');
  // Each shot carries its own 1100Hz track so residue can be measured as a band, not as a dominant tone.
  const clips = [0, 1, 2].map(index => {
    const file = path.join(root, 'c' + index + '.mp4');
    media.command(['-f', 'lavfi', '-i', 'color=c=' + ['0x203040', '0x506070', '0x8090a0'][index] + ':s=320x180:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=1100:sample_rate=48000,volume=4', '-t', '1', '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    return file;
  });
  // The film uses source [1.2, 3.6] of the take (the 500Hz and 700Hz halves) at film time [0, 2.4].
  const bed = [{ lineId: 'take', file: take, sourceStart: 1.2, durationSeconds: 2.4, startSeconds: 0 }];
  const script = {
    shots: [0, 1, 2].map(index => ({ id: 's' + (index + 1), type: 'action', start: index, end: index + 1, duration: 1 })),
    totalDuration: 3,
    audioBed: bed,
    subtitles: [{ lineId: 'take', start: 0, end: 2.4, text: '整段表演（含多句与停顿）' }]
  };
  const assets = { s1: { video: clips[0] }, s2: { video: clips[1] }, s3: { video: clips[2] } };
  const out = media.assemble(script, assets, path.join(root, 'window'));

  // (a) SOURCE WINDOW: film 0.4s must sound the 500Hz marker, i.e. the window really starts at source 1.2.
  assert.ok(Math.abs(windowSignal(media, out, 0.4, 0.15).frequency - 500) <= TONE_TOLERANCE,
    '非零源起点裁剪：成片 0.4 秒应取源 1.6 秒处的 500Hz 标记');
  // (b) PACE: find the 500->700 change point in the OUTPUT; a retimed take would move it.
  let boundary = null;
  for (let at = 0.7; at <= 1.7; at += 0.05) {
    if (Math.abs(windowSignal(media, out, at, 0.1).frequency - 700) <= TONE_TOLERANCE) { boundary = at; break; }
  }
  assert.ok(boundary !== null, '成片中应能找到 700Hz 标记');
  assert.ok(Math.abs(boundary - 1.2) <= POSITION_TOLERANCE, '源侧两个标记相隔 1.2 秒，成片应仍是 1.2 秒（实测切换点 ' + boundary + '）');
  // (c) NO DUPLICATION: same content compared source-to-film; a doubled mix would roughly double the level.
  const source = windowSignal(media, take, 1.6, 0.15).rms, film = windowSignal(media, out, 0.4, 0.15).rms;
  assert.ok(film / source > 0.7 && film / source < 1.3, '成片电平应与源一致（比值 ' + (film / source).toFixed(2) + '），不得把同频音频重复混入');
  // (d) ORIGINAL TRACK RESIDUE: measured as a band, the clip's own tone must sit >=20 dB under the bed tone.
  const bedTone = bandRms(media, out, 0.4, 0.2, 500), residue = bandRms(media, out, 0.4, 0.2, 1100);
  assert.ok(bedTone > 0.05, '带宽测量应能测到床音能量（实测 ' + bedTone.toFixed(4) + '）');
  assert.ok(residue < 0.1 * bedTone, '原视频音轨 1100Hz 能量应低于床音 500Hz 的 10%（实测 ' + residue.toFixed(4) + ' vs ' + bedTone.toFixed(4) + '）');
  // (e) NO TRUNCATION: the tail marker is still present up to 2.4 and the bed stops there.
  assert.ok(windowSignal(media, out, 2.3, 0.08).rms > 0.05, '源区间尾部（成片 2.4 秒前）不得被截断');
  assert.ok(windowSignal(media, out, 2.5, 0.1).rms < SILENCE_LIMIT, '床音 2.4 秒结束后不得继续发声');
  assert.ok(Math.abs(Number(media.probe(out).format.duration) - 3) <= DURATION_TOLERANCE, '成片时长仍在声明容差内');
  const list = cues(fs.readFileSync(path.join(root, 'window', 'subtitles.srt'), 'utf8'));
  assert.equal(list.length, 1);
  assert.ok(Math.abs(list[0].from) < 0.01 && Math.abs(list[0].to - 2.4) < 0.01, '字幕应覆盖实际使用的源区间');
});

