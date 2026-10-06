const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { redo } = require('../workflows/redo');
const { Budget } = require('../services/aliyun/budget');
const { productionPlan } = require('../workflows/production-plan');
const { Media } = require('../services/aliyun/media');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext, runProduction, approve } = require('../workflows/production');
const { recordAudioDecision } = require('../workflows/audio-review');
const ROOT = path.resolve(__dirname, '..');

test('offline full pipeline: mock providers, real audio timing, FFmpeg and resume without duplicate POST', { timeout: 150000 }, async () => {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'pipeline-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav'), speech = path.join(root, 'speech.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '1', '-ac', '1', speech]);
  const clips = {};
  for (const seconds of [2, 5]) {
    const file = path.join(root, 'clip-' + seconds + '.mp4');
    media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    clips[seconds] = file;
  }
  // Deliberately no brief file: a new task must reach the full flow with the planner model producing
  // material analysis and the brief during the run.
  const production = { id: 'test-film', description: '离线测试故事，不是真实成片素材', style: '测试', targetDurationSeconds: 7, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  const config = readJson(path.join(ROOT, 'config/aliyun.json'));
  config.onlineEnabled = true; config.authorizationFile = 'auth.json'; config.pollTimeoutSeconds = 0;
  config.planner = { ...config.planner, reservationCents: 20 };
  writeJson(path.join(root, 'config/project.json'), project); writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'production.json'), production);
  writeJson(path.join(root, 'auth.json'), { enabled: true, region: 'cn-beijing', productionId: 'test-film', providers: ['aliyun'],
    approvedBudgetCny: 70, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const script = readJson(path.join(ROOT, 'examples/script.json')); script.shots[0].text = '测试台词'; script.shots[0].duration = 2;
  let posts = 0, pauseVideo = false; const tasks = new Map();
  const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  const client = {
    request: async (endpoint, body) => {
      posts++;
      if (endpoint.includes('chat/completions')) {
        const prompt = JSON.stringify(body.messages);
        if (body.model === 'qwen3.8-omni-flash') {
          // The planner model owns analysis, brief, script and rework advice in this flow.
          if (prompt.includes('美术与选角分析')) return reply({ id: 'character01', visualAnalysis: '合成测试图', voiceAnalysis: '合成测试音调' });
          if (prompt.includes('制作简报模型')) return reply({ storySummary: '测试简报', shotGuidance: '仅隔离测试' });
          if (prompt.includes('编剧与分镜模型')) return reply(script);
          if (prompt.includes('独立审核模型')) return reply({ verdict: 'pass', summary: '上下文连贯，时长在范围内', contextIssues: [],
            durationIssues: [], estimatedDurationSeconds: 9, longShots: [], advice: null });
          if (prompt.includes('返工执行模型')) return reply({ shotId: 'shot01', scope: 'video', patch: { videoAction: '按返工意见重做动作' },
            speechInstruction: null, rationale: '按记录意见最小改动' });
          if (prompt.includes('返工决策模型')) return reply({ advice: '按检查问题重做该镜', scope: 'video', requiresPaidRetry: true, userAction: '用户决定是否付费重做' });
          return reply({});
        }
        const content = prompt.includes('frontUsable') ? { usable: true, frontUsable: true, traits: '测试人物', issues: [] } : { pass: true, issues: [] };
        return reply(content);
      }
      if (body.model === 'qwen-voice-enrollment') return { output: { voice: 'test-voice' } };
      if (body.model.startsWith('qwen3-tts')) return { output: { audio: { url: 'https://test.aliyuncs.com/speech.wav' } } };
      if (body.model.startsWith('qwen-image')) return { output: { choices: [{ message: { content: [{ image: 'https://test.aliyuncs.com/image.png' }] } }] } };
      const id = 'task-' + posts;
      tasks.set(id, body.model.startsWith('qwen-image') ?
        { output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://test.aliyuncs.com/image.png' }] } }] } } :
        { output: { task_status: 'SUCCEEDED', video_url: 'https://test.aliyuncs.com/clip-' + body.parameters.duration + '.mp4' } });
      return { output: { task_id: id } };
    },
    task: async id => pauseVideo && tasks.get(id).output.video_url ? { output: { task_status: 'RUNNING' } } : tasks.get(id),
    upload: async () => 'oss://test/audio.wav',
    download: async (url, destination) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const source = url.endsWith('image.png') ? image : url.endsWith('speech.wav') ? speech : clips[Number(url.match(/clip-(\d+)/)[1])];
      fs.copyFileSync(source, destination);
    }
  };
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('REAL_NETWORK_FORBIDDEN_IN_TEST'); };
  try {
    const context = loadContext(root, 'production.json');
    // Two gates are asserted rather than bypassed: the script must be approved before speech is
    // generated, and the speech must be accepted before any video work starts.
    const briefed = await runProduction(context, { client, log: () => {}, until: 'script' });
    assert.equal(briefed.brief.generatedBy, 'qwen3.8-omni-flash');
    assert.equal(briefed.brief.characters[0].imageSha256, fileHash(image));
    assert.ok(fs.existsSync(briefed.briefFile));
    assert.equal(briefed.briefSource, undefined);
    await assert.rejects(runProduction(context, { client, log: () => {}, until: 'audio' }), /REVIEW_REQUIRED:script/);
    await approve(context, 'script');
    const audioState = await runProduction(context, { client, log: () => {}, until: 'audio' });
    const budget = new Budget(root, context.config, context.directory);
    const exactCost = budget.checkPlan(productionPlan(audioState, config)).projectedCents;
    const auth = readJson(path.join(root, 'auth.json')); auth.approvedBudgetCny = exactCost / 100; writeJson(path.join(root, 'auth.json'),auth);
    await assert.rejects(runProduction(context, { client, log: () => {}, until: 'frames' }), /AUDIO_NOT_ACCEPTED/);
    await recordAudioDecision(context, 'accepted', '离线测试：用户接受当前配音');
    await runProduction(context, { client, log: () => {}, until: 'frames' });
    const framePosts=posts;
    await runProduction(context, { client, log: () => {}, until: 'frames' });
    assert.equal(posts,framePosts);
    pauseVideo=true;
    await assert.rejects(runProduction(context,{client,log:()=>{}}),/TASK_PENDING/);
    const pendingPosts=posts;
    pauseVideo=false;
    const result = await runProduction(context, { client, log: () => {} });
    assert.equal(posts-pendingPosts,3); // resumed GET, two quality checks, one remaining video

    assert.equal(result.stage, 'final');
    assert.equal(result.timed.totalDuration, 7);
    assert.equal(result.acceptance, 'awaiting_user_playback');
    assert.ok(fs.existsSync(result.output)); assert.ok(fs.existsSync(path.join(context.directory, 'review.html')));
    const info = media.video(result.output, 7, true);
    assert.equal(info.width, 1920); assert.equal(info.height, 1080);
    const character = Object.values(result.characters)[0];
    fs.unlinkSync(character.original); fs.unlinkSync(character.sample);
    fs.writeFileSync(character.registryFile, '{corrupt');
    const initialPosts = posts;
    await runProduction(context, { client, log: () => {}, until: 'audio' });
    assert.equal(posts, initialPosts);
    assert.equal(result.budget.actualCostKnown, false);
    const originalVideo=result.assets.shot01.video, otherVideo=result.assets.shot02.video;
    const originalFinal=result.output, originalFinalHash=fileHash(result.output);
    await redo(context,'shot01','video','模拟局部动作重做');
    const afterRedoPosts=posts;
    // The historical amount is below the projected cost, and it no longer blocks: the redone shot is
    // generated once and recorded. Only the real usage is tracked from here on.
    const redone=await runProduction(context,{client,log:()=>{}});
    assert.equal(posts-afterRedoPosts,2);
    assert.equal(redone.assets.shot02.video,otherVideo);
    assert.notEqual(redone.assets.shot01.video,originalVideo);
    assert.ok(fs.existsSync(originalVideo));
    assert.equal(fileHash(originalFinal),originalFinalHash);
    assert.notEqual(redone.output,originalFinal);
    assert.equal(redone.budget.committedCents,exactCost+220);
    assert.equal(redone.budget.committedCents > exactCost, true);   // the run went past the historical amount
  } finally { global.fetch = originalFetch; }
});
