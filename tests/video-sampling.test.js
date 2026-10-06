const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { samplingPlan, videoCheckPrompt } = require('../services/aliyun/quality');
const { readJson } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

// Real FFmpeg on synthetic media: the point is to prove that the sampling plan maps to the frames it
// claims (a dark moment, a red moment, a bright moment) instead of only constructing parameters.
test('a synthetic clip proves the sampling times, the frame size and the reading order', { timeout: 120000 }, () => {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'sampling-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  const media = new Media(root, project);
  try {
    // Five seconds in three colours: black 0-1.6, red 1.6-3.3, white 3.3-5.
    const clips = [['black', 1.6], ['red', 1.7], ['white', 1.7]].map(([color, seconds], index) => {
      const file = path.join(root, 'part-' + index + '.mp4');
      media.command(['-f', 'lavfi', '-i', 'color=c=' + color + ':s=320x240:r=30', '-f', 'lavfi',
        '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
      return file;
    });
    fs.writeFileSync(path.join(root, 'concat.txt'), clips.map(file => "file '" + path.basename(file) + "'").join('\n') + '\n');
    const video = path.join(root, 'clip.mp4');
    media.command(['-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', video], root);
    const plan = samplingPlan(5);
    const samples = media.sampleFramesAt(video, path.join(root, 'check'), plan.times, 'v-');
    assert.equal(samples.length, plan.count);
    assert.deepEqual(samples.map(entry => entry.at), plan.times);
    assert.ok(samples.every(entry => fs.existsSync(entry.file) && fs.statSync(entry.file).size > 0));
    const colors = samples.map(entry => media.averageColor(entry.file));
    // The first sample lands inside the dark segment, the middle one inside the red one and the last one
    // inside the bright segment: a wrong time mapping could not produce this.
    assert.ok(colors[0].r < 40 && colors[0].g < 40 && colors[0].b < 40, JSON.stringify(colors[0]));
    assert.ok(colors[1].r > 150 && colors[1].g < 80, JSON.stringify(colors[1]));
    assert.ok(colors[2].r > 200 && colors[2].g > 200 && colors[2].b > 200, JSON.stringify(colors[2]));
    // Every frame stays readable on its own (no montage), and the order plus the exact time is printed
    // inside the request so a human reading the record later knows what each picture is.
    for (const entry of samples) {
      const info = media.image(entry.file);
      assert.ok(info.width >= 384 && info.height >= 384 && info.width <= 512 && info.height <= 512, JSON.stringify(info));
    }
    const labels = [{ label: '目标首帧' }, ...samples.map(entry => ({ label: '视频' + entry.at + '秒抽帧' })), { label: '目标尾帧' }];
    const prompt = videoCheckPrompt({ shot: { id: 'doc01-line01', scene: '府衙', action: '拔剑指向士兵' },
      images: labels, duration: 5, contract: '', docFirst: true });
    labels.forEach((label, index) => assert.ok(prompt.includes('图' + (index + 1) + '=' + label.label), label.label));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
