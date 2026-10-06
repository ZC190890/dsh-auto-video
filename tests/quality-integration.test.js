const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, fileHash } = require('../services/aliyun/io');
const { Media } = require('../services/aliyun/media');
const { loadContext, runProduction, approve, loadState } = require('../workflows/production');
const { recordAudioDecision } = require('../workflows/audio-review');
const { redo } = require('../workflows/redo');
const { audioBinding, runExternalVideo } = require('../workflows/external-script-video');
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- shared fixtures
function newRoot(name) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', name + '-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  const config = readJson(path.join(ROOT, 'config/aliyun.json'));
  config.onlineEnabled = true; config.authorizationFile = 'auth.json'; config.pollTimeoutSeconds = 0;
  config.planner = { ...config.planner, reservationCents: 20 };
  writeJson(path.join(root, 'config/project.json'), project);
  writeJson(path.join(root, 'config/aliyun.json'), config);
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav'), speech = path.join(root, 'speech.wav');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '2', '-ac', '1', speech]);
  const clips = {};
  for (const seconds of [2, 5]) {
    const file = path.join(root, 'clip-' + seconds + '.mp4');
    media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    clips[seconds] = file;
  }
  writeJson(path.join(root, 'auth.json'), { enabled: true, region: 'cn-beijing', productionId: name === 'ext' ? 'ext-film' : 'test-film',
    providers: ['aliyun'], approvedBudgetCny: 70, expiresAt: new Date(Date.now() + 86400000).toISOString() });
  return { root, project, config, media, image, sample, speech, clips };
}
const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
// One mock client for both paths. It counts generation requests separately from check requests, so a test can
// prove that "cannot tell" pauses without asking for another image or video.
function mockClient({ image, speech, clips, checks = {}, onChat = null }) {
  const counts = { generation: 0, chat: 0, video: 0, image: 0, all: 0 };
  const tasks = new Map();
  const client = {
    counts,
    request: async (endpoint, body) => {
      counts.all++;
      if (endpoint.includes('chat/completions')) {
        counts.chat++;
        const prompt = JSON.stringify(body.messages);
        if (onChat) { const answer = onChat({ prompt, body, reply, counts }); if (answer) return answer; }
        if (prompt.includes('美术与选角分析')) return reply({ id: 'jiang_wei', visualAnalysis: '合成测试图', voiceAnalysis: '合成测试音调' });
        if (prompt.includes('制作简报模型')) return reply({ storySummary: '测试简报', shotGuidance: '仅隔离测试' });
        if (prompt.includes('独立审核模型')) return reply({ verdict: 'pass', summary: '上下文连贯', contextIssues: [], durationIssues: [],
          estimatedDurationSeconds: 10, longShots: [], advice: null });
        if (prompt.includes('返工决策模型')) return reply({ advice: '按检查问题重做该镜', scope: 'video', requiresPaidRetry: true, userAction: '用户决定' });
        if (prompt.includes('返工执行模型')) return reply({ shotId: 'shot01', scope: 'video', patch: { videoAction: '重做动作' },
          speechInstruction: null, rationale: '按记录意见最小改动' });
        if (prompt.includes('检查武将立绘')) return reply({ usable: true, frontUsable: true, traits: '测试人物', issues: [] });
        if (prompt.includes('正面补图')) return reply({ identityMatches: true, frontUsable: true, issues: [] });
        // 更具体的匹配优先，避免同一个提示词同时命中两个场景。
        for (const [key, value] of Object.entries(checks).sort((left, right) => right[0].length - left[0].length))
          if (prompt.includes(key)) return reply(typeof value === 'function' ? value({ prompt, counts }) : value);
        return reply({ pass: true, issues: [] });
      }
      if (body.model === 'qwen-voice-enrollment') return { output: { voice: 'test-voice' } };
      if (body.model.startsWith('qwen3-tts')) return { output: { audio: { url: 'https://test.aliyuncs.com/speech.wav' } } };
      if (body.model.startsWith('qwen-image')) {
        counts.generation++; counts.image++;
        return { output: { choices: [{ message: { content: [{ image: 'https://test.aliyuncs.com/image.png' }] } }] } };
      }
      counts.generation++; counts.video++;
      const id = 'task-' + counts.all;
      tasks.set(id, { output: { task_status: 'SUCCEEDED', video_url: 'https://test.aliyuncs.com/clip-' + body.parameters.duration + '.mp4' } });
      return { output: { task_id: id } };
    },
    task: async id => tasks.get(id),
    upload: async () => 'oss://test/audio.wav',
    download: async (url, destination) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const source = url.endsWith('image.png') ? image : url.endsWith('speech.wav') ? speech : clips[Number(url.match(/clip-(\d+)/)[1])];
      fs.copyFileSync(source, destination);
    }
  };
  return client;
}

// ---------------------------------------------------------------- normal production path
const CONTRACT = extra => ({ startState: '站在城楼前，右手按剑柄，身体朝向左侧', endState: '半蹲稳住重心，剑指向左前方',
  primaryAction: '拔剑并指向左前方', beats: ['起势：右脚后撤，右手握紧剑柄', '接触：拔剑出鞘指向左前方'],
  cut: 'continuous', handoff: '承接上一镜的站位、视线方向与右手持剑状态', ...extra });
function productionFixture({ contract = true } = {}) {
  const f = newRoot('prod');
  writeJson(path.join(f.root, 'production.json'), { id: 'test-film', description: '离线集成测试故事，不是真实素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'jiang_wei', name: '测试角色', image: f.image, voiceSample: f.sample, traits: '测试' }] });
  const directory = path.join(f.root, 'jobs', 'aliyun', 'test-film');
  const shot = (id, extra) => ({ id, type: 'action', characters: ['jiang_wei'], speaker: null, text: '', emotion: '',
    scene: '城楼前的武将，横屏近景，背景简洁', action: '武将缓慢握紧剑柄并拔剑前指',
    endScene: '同一机位，武将拔剑前指', needsLastFrame: true, duration: 5,
    ...(contract ? CONTRACT(extra) : {}) });
  writeJson(path.join(directory, 'script.json'), { title: '集成测试', shots: [shot('shot01', { cut: 'scene' }), shot('shot02')] });
  f.context = loadContext(f.root, 'production.json');
  f.directory = directory;
  return f;
}
const PASS = { verdict: 'pass', issues: [], targetInvalid: false, uncovered: [], fixScope: [] };
async function runToFrames(f, client, until = 'frames') {
  await runProduction(f.context, { client, log: () => {}, until: 'script' });
  // 脚本闸门：审核通过后仍需用户 approve 才能进入配音。
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'audio' }), /REVIEW_REQUIRED:script/);
  await approve(f.context, 'script');
  await runProduction(f.context, { client, log: () => {}, until: 'audio' });
  await recordAudioDecision(f.context, 'accepted', '集成测试：接受合成配音');
  return runProduction(f.context, { client, log: () => {}, until });
}


test('a structured pass from the model drives the frame and video stages without being rejected', { timeout: 180000 }, async () => {
  const f = productionFixture();
  const client = mockClient({ ...f, checks: { '检查分镜首尾画面': PASS, '检查视频质量': PASS, '检查相邻两镜的衔接': PASS } });
  const state = await runToFrames(f, client, 'video');
  assert.equal(state.stage, 'video');
  for (const shot of state.timed.shots) {
    const asset = state.assets[shot.id];
    assert.equal(asset.frameReview.verdict, 'pass', '新格式的通过结论必须被接受');
    assert.equal(asset.frameReview.legacy, false);
    assert.equal(asset.videoReview.verdict, 'pass');
    assert.ok(asset.frameReview.binding.digest, '每条结论都绑定当次输入');
  }
  // 契约模式下相邻承接对被真的检查了，且检查不消耗生成轮次。
  assert.deepEqual(state.continuity.checkedPairs, ['shot02']);
  assert.equal(state.adjacencyReviews.shot02.report.verdict, 'pass');
  assert.equal(client.counts.video, 2, '每镜一次视频生成');
  assert.equal(readJson(path.join(f.directory, 'unit-attempts.json')).units['video-shot01'].generations, 1);
});

test('a located major problem enters the rework branch instead of failing on a missing function', { timeout: 180000 }, async () => {
  const f = productionFixture();
  const client = mockClient({ ...f, checks: {
    '检查分镜首尾画面': PASS,
    '检查视频质量': { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['first'],
      issues: [{ category: 'pose', severity: 'major', at: 4.95, frameIndex: 4, observed: '视频结束时剑仍在鞘内',
        expected: '结束状态要求剑已出鞘并前指', detail: '结束状态没有到达', fix: '重做首帧，让右手已经握剑出鞘' }] }
  } });
  await assert.rejects(runToFrames(f, client, 'video'), error => {
    assert.ok(!/is not a function/.test(error.message), '不得出现函数缺失：' + error.message);
    assert.match(error.message, /REVIEW_REQUIRED:video-shot01/);
    return true;
  });
  const state = loadState(f.context);
  assert.equal(state.assets.shot01.qualityPause.code, 'FRAMES', '问题在首尾画面时只登记画面返工');
  assert.match(state.assets.shot01.qualityPause.fix, /重做首帧/);
  assert.deepEqual(state.assets.shot01.qualityPause.scope, ['first']);
  assert.equal(readJson(path.join(f.directory, 'unit-attempts.json')).units['video-shot01'].generations, 1, '暂停不消耗视频轮次');
});

test('a stored pass is never rebound to changed material or a changed contract', { timeout: 240000 }, async () => {
  const f = productionFixture();
  const client = mockClient({ ...f, checks: { '检查分镜首尾画面': PASS, '检查视频质量': PASS, '检查相邻两镜的衔接': PASS } });
  const first = await runToFrames(f, client, 'frames');
  assert.equal(first.assets.shot02.frameReview.verdict, 'pass');
  const chatAfterFirst = client.counts.chat, imageAfterFirst = client.counts.image;
  // 同一材料重跑：结论被复用，不再产生检查请求。
  await runProduction(f.context, { client, log: () => {}, until: 'frames' });
  assert.equal(client.counts.chat, chatAfterFirst);
  assert.equal(client.counts.image, imageAfterFirst);
  // 未经受控修订就改写契约：旧通过结论不得被重新绑定后放行（先经过既有的脚本与配音闸门）。
  const drifted = loadState(f.context);
  drifted.script.shots[1].endState = '被外部改写的结束状态';
  writeJson(path.join(f.directory, 'state.json'), drifted);
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'frames' }), /REVIEW_REQUIRED:script/);
  await approve(f.context, 'script');
  // 只改动作约束不影响配音验收绑定（台词未变），但帧检查的请求身份已经变化：必须停下而不是复用旧通过结论。
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'frames' }), /OPERATION_INPUT_CHANGED/);
  // 走既有的受控修订入口后，新的操作号重新生成并按新契约检查。
  await redo(f.context, 'shot02', 'frames', '集成测试：按新契约重做该镜首尾帧');
  const redone = await runProduction(f.context, { client, log: () => {}, until: 'frames' });
  assert.equal(redone.assets.shot02.frameReview.verdict, 'pass');
  assert.ok(client.counts.image > imageAfterFirst, '受控修订后确实重新生成了画面');
});


test('evidence rejected on the first response stays rejected on every recovery', { timeout: 240000 }, async () => {
  const f = productionFixture();
  const client = mockClient({ ...f, checks: {
    '检查分镜首尾画面': PASS,
    // 未被抽到的时间（5 秒镜头的抽帧时点是 0.1/2.525/4.95）：首次必须拒绝，恢复时不得放宽。
    '检查视频质量': { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['video'],
      issues: [{ category: 'action', severity: 'major', at: 3.2, frameIndex: 3, observed: '视频结束时剑仍在鞘内', fix: '重做该镜视频' }] }
  } });
  await assert.rejects(runToFrames(f, client, 'video'), /REVIEW_TIME_NOT_SAMPLED:3.2/);
  const recordFile = path.join(f.directory, 'operations', 'video-check-shot01-r0.json');
  const record = readJson(recordFile);
  assert.equal(record.status, 'succeeded', '原始响应保留，不篡改也不删除');
  const generation = client.counts.generation, chat = client.counts.chat;
  // 重新执行：同一操作号、同一份证据，必须仍然拒绝，且不得产生新的生成请求。
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'video' }), /REVIEW_TIME_NOT_SAMPLED:3.2/);
  assert.equal(client.counts.generation, generation, '恢复不得产生新的生成请求');
  assert.equal(client.counts.chat, chat, '恢复走同一操作号的缓存，不新增审核请求');
  const after = readJson(recordFile);
  assert.equal(after.fingerprint, record.fingerprint, '同一操作记录，未换号也未重绑');
  assert.equal(after.status, 'succeeded');
  const state = loadState(f.context);
  assert.equal(state.assets.shot01.videoReview, undefined, '被拒绝的响应不得写进状态当作结论');
});

test('the adjacent check revision, operation number and evidence stay in step and resume cleanly', { timeout: 300000 }, async () => {
  const f = productionFixture();
  let adjacent = 0;
  const client = mockClient({ ...f, checks: { '检查分镜首尾画面': PASS, '检查视频质量': PASS,
    '检查相邻两镜的衔接': () => { adjacent++; return PASS; } } });
  await runToFrames(f, client, 'video');
  assert.equal(adjacent, 1);
  const first = loadState(f.context);
  assert.equal(first.adjacencyReviews.shot02.binding.revision, first.revisions['adjacent-check-shot02'] || 0);
  // 受控修订：只重做前镜视频，相邻检查的输入随之变化。
  await redo(f.context, 'shot01', 'video', '集成测试：重做前镜视频');
  const state = await runProduction(f.context, { client, log: () => {}, until: 'video' });
  assert.equal(adjacent, 2, '输入变化后必须重做相邻检查一次');
  const revision = state.revisions['adjacent-check-shot02'];
  assert.ok(revision >= 1, '相邻检查走受控修订');
  assert.equal(state.adjacencyReviews.shot02.binding.revision, revision, '状态绑定与最终修订号一致');
  assert.equal(state.adjacencyReviews.shot02.revision, revision);
  const record = readJson(path.join(f.directory, 'operations', 'adjacent-check-shot02-r' + revision + '.json'));
  assert.equal(record.status, 'succeeded');
  assert.equal(record.spec.review.digest, state.adjacencyReviews.shot02.binding.digest, '请求证据与状态绑定同源');
  // 输入不变连续恢复两次：零新增审核请求，修订号不变。
  await runProduction(f.context, { client, log: () => {}, until: 'video' });
  await runProduction(f.context, { client, log: () => {}, until: 'video' });
  assert.equal(adjacent, 2, '连续恢复不得重复审核');
  assert.equal(loadState(f.context).revisions['adjacent-check-shot02'], revision, '连续恢复不得推进修订号');
});

test('an undetermined result pauses while the generation request count stays where it was', { timeout: 180000 }, async () => {
  const f = productionFixture();
  const client = mockClient({ ...f, checks: { '检查分镜首尾画面': { verdict: 'undetermined', issues: [],
    targetInvalid: false, uncovered: ['0.1秒抽帧看不清右手是否换手'], fixScope: [] } } });
  await assert.rejects(runToFrames(f, client, 'frames'), /REVIEW_REQUIRED:frames-shot01/);
  const generation = client.counts.generation, images = client.counts.image;
  const state = loadState(f.context);
  assert.equal(state.assets.shot01.qualityPause.code, 'UNDETERMINED');
  assert.equal(state.assets.shot01.qualityPause.review.verdict, 'undetermined');
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'frames' }), /REVIEW_REQUIRED:frames-shot01/);
  assert.equal(client.counts.generation, generation, '无法判断不得产生新的生成请求');
  assert.equal(client.counts.image, images);
  assert.equal(readJson(path.join(f.directory, 'unit-attempts.json')).units['first-shot01'].generations, 1);
});


// ---------------------------------------------------------------- external script path
const EXTERNAL_CONTRACT = extra => ({ startState: '站在台阶前，右手按剑柄，身体朝向画面左侧',
  endState: '半蹲稳住重心，剑指向左前方', primaryAction: '拔剑并指向左前方',
  beats: ['起势：右手握紧剑柄', '接触：拔剑出鞘'], cut: 'continuous', handoff: '承接上一镜的站位、视线与右手持剑状态', ...extra });
function externalFixture() {
  const f = newRoot('ext');
  writeJson(path.join(f.root, 'production.json'), { id: 'ext-film', description: '离线外部脚本集成测试', style: '国风插画',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'jiang_wei', name: '姜维', image: f.image, voiceSample: f.sample, traits: '测试' }] });
  const directory = path.join(f.root, 'jobs', 'aliyun', 'ext-film');
  fs.mkdirSync(directory, { recursive: true });
  const source = { title: '集成测试', scenes: [{ id: 'doc01', visual: '府衙内，姜维面对士兵，光线昏暗' }],
    lines: [{ id: 'doc01-line01', sceneId: 'doc01', role: 'jiang_wei', text: '', emotion: '' },
      { id: 'doc01-line02', sceneId: 'doc01', role: 'jiang_wei', text: '', emotion: '' }], endingCaption: '片尾' };
  const externalScript = { status: 'audio-awaiting-user', source,
    audio: { 'doc01-line01': { file: f.speech, duration: 2 }, 'doc01-line02': { file: f.speech, duration: 2 } },
    media: {}, mediaRevisions: {}, acceptance: 'accepted' };
  externalScript.acceptedBinding = audioBinding(externalScript);
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'ext-film',
    characters: { jiang_wei: { name: '姜维', original: f.image, front: f.image, sample: f.sample, traits: '测试',
      registryFile: path.join(directory, 'character.json') } },
    assets: {}, revisions: {}, approvals: {}, stage: 'audio', externalScript });
  f.context = loadContext(f.root, 'production.json');
  f.directory = directory;
  return f;
}
const VISUAL_PLAN = { shots: [
  { id: 'doc01-line01', type: 'narration', characters: ['jiang_wei'], scene: '府衙内景，姜维站在台阶前，右手按剑柄，横屏中景',
    endScene: '同一机位，姜维微微侧身看向画面左侧', action: '姜维缓慢抬手按住剑柄并轻微转头',
    ...EXTERNAL_CONTRACT({ cut: 'scene' }) },
  { id: 'doc01-line02', type: 'narration', characters: ['jiang_wei'], scene: '同一机位，姜维半蹲稳住重心，剑指向左前方',
    endScene: '同一机位，姜维收剑回鞘站直', action: '姜维拔剑前指后收剑回鞘', ...EXTERNAL_CONTRACT({}) }] };

test('a frame repair in the external path invalidates the video downstream and is idempotent', { timeout: 240000 }, async () => {
  const { queueFramesRepair } = require('../workflows/external-script-video');
  const f = externalFixture();
  const frameChecks = {};
  const client = mockClient({ ...f, checks: {
    '你仅把原场景适配为逐段视频首尾画面': VISUAL_PLAN,
    // 每镜的第一次首尾帧检查失败一次，返工后的第二次通过：验证返工会推进下游修订号而不是死循环。
    '用户文档场景是道具与动作的最高依据': ({ prompt }) => {
      const id = prompt.includes('doc01-line01') ? 'doc01-line01' : 'doc01-line02';
      frameChecks[id] = (frameChecks[id] || 0) + 1;
      return frameChecks[id] === 1
        ? { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['first'],
          issues: [{ category: 'pose', severity: 'major', frameIndex: 1, observed: '首帧右手没有按在剑柄上',
            fix: '首帧改为右手按住剑柄，身体朝向画面左侧' }] }
        : PASS;
    },
    '检查视频质量': PASS, '检查相邻两镜的衔接': PASS
  } });
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  const e = loadState(f.context).externalScript;
  // 首尾帧返工后，视频与其检查必须一起失效：否则会拿旧操作号配新首帧。
  assert.ok(e.mediaRevisions['frames-doc01-line01'] >= 1, '帧修订号推进');
  assert.ok(e.mediaRevisions['video-doc01-line01'] >= 1, '视频修订号必须一起推进');
  assert.equal(e.media['doc01-line01'].videoReview.revision, e.mediaRevisions['video-doc01-line01'], '视频质检绑定当前视频修订');
  assert.equal(e.status, 'video-ready');
  const videoOps = Object.keys(readJson(path.join(f.directory, 'unit-attempts.json')).units).filter(unit => unit.startsWith('video-doc01-line01'));
  assert.equal(videoOps.length, 1, '同一单元只登记一次视频轮次台账');
  // 登记的幂等：同一返工再登记一次不得重复增加修订号，且会一并失效受影响的下游与相邻检查。
  const fake = { media: { a: {} }, adjacencyReviews: { b: { from: 'a' }, c: { from: 'z' } },
    mediaRevisions: { 'frames-a': 0, 'video-a': 0 } };
  const queued = queueFramesRepair(fake, 'a', { fix: '重做首帧', reason: '相邻衔接不符', from: 'b' });
  const again = queueFramesRepair(fake, 'a', { fix: '重做首帧', reason: '相邻衔接不符', from: 'b' });
  assert.equal(queued.queued, true);
  assert.equal(again.already, true, '重复登记必须被识别为已完成');
  assert.deepEqual(fake.mediaRevisions, { 'frames-a': 1, 'video-a': 1 }, '帧与视频修订号同时推进，且只推进一次');
  assert.deepEqual(Object.keys(fake.adjacencyReviews), ['c'], '受影响的前/后相邻检查被清空以走受控修订');
});


test('a stale adjacent binding is re-reviewed under one controlled revision and resumes without extra audits', { timeout: 240000 }, async () => {
  const { reviewBinding } = require('../services/aliyun/quality');
  const f = externalFixture();
  let adjacent = 0;
  const client = mockClient({ ...f, checks: { '你仅把原场景适配为逐段视频首尾画面': VISUAL_PLAN,
    '用户文档场景是道具与动作的最高依据': PASS, '检查视频质量': PASS,
    '检查相邻两镜的衔接': () => { adjacent++; return PASS; } } });
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  assert.equal(adjacent, 1);
  // 模拟旧版留下的绑定（缺前镜实际视频等输入）：失配分支必须走受控修订，而不是复用旧结论。
  const state = loadState(f.context);
  const stale = state.externalScript.adjacencyReviews['doc01-line02'];
  stale.binding = reviewBinding({ ...stale.binding, extra: { kind: 'adjacent', from: stale.from } });
  writeJson(path.join(f.directory, 'state.json'), state);
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  assert.equal(adjacent, 2, '失配后重做一次');
  const e = loadState(f.context).externalScript;
  const revision = e.adjacencyRevisions['doc01-line02'];
  assert.ok(revision >= 1, '相邻检查走受控修订');
  assert.equal(e.adjacencyReviews['doc01-line02'].binding.revision, revision, '状态绑定与最终修订号一致');
  assert.equal(e.adjacencyReviews['doc01-line02'].revision, revision);
  const record = readJson(path.join(f.directory, 'operations', 'adjacent-check-doc01-line02-r' + revision + '.json'));
  assert.equal(record.spec.review.digest, e.adjacencyReviews['doc01-line02'].binding.digest, '请求证据与状态绑定同源');
  // 输入不变连续恢复两次：零新增审核请求，修订号不变。
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  assert.equal(adjacent, 2, '输入不变时不得重复审核');
  assert.equal(loadState(f.context).externalScript.adjacencyRevisions['doc01-line02'], revision, '修订号不得再次推进');
});


test('a legacy success record is recovered as-is, and an unresolved one is never resent', { timeout: 300000 }, async () => {
  const f = productionFixture({ contract: false });
  const client = mockClient({ ...f, checks: { '检查分镜首尾画面': PASS, '检查视频质量': PASS } });
  await runToFrames(f, client, 'video');
  const recordFile = path.join(f.directory, 'operations', 'video-check-shot01-r0.json');
  const record = readJson(recordFile);
  // 升级前的真实结构：旧提示词 + 首帧与 3 个旧时点抽帧（5 秒镜头的 0.1/2.5/4.8），旧 legacy 结论。
  assert.match(record.spec.prompt, /图1是目标首帧，随后三张/);
  assert.equal(record.spec.images.length, 4);
  assert.equal(record.spec.review, undefined, '旧操作不带新协议的绑定摘要');
  const chat = client.counts.chat, generation = client.counts.generation;
  // 重启（丢掉状态里的结论）后连续恢复两次：同一操作号零 POST、无指纹冲突、覆盖边界如实保留。
  const dropReview = () => {
    const state = loadState(f.context);
    delete state.assets.shot01.videoReview;
    writeJson(path.join(f.directory, 'state.json'), state);
  };
  dropReview();
  const restored = await runProduction(f.context, { client, log: () => {}, until: 'video' });
  assert.equal(client.counts.chat, chat, '旧成功记录恢复时不得新增请求');
  assert.equal(client.counts.generation, generation, '不得产生新的生成请求');
  assert.equal(restored.assets.shot01.videoReview.verdict, 'pass');
  assert.equal(restored.assets.shot01.videoReview.provenance.protocol, 'legacy');
  assert.equal(restored.assets.shot01.videoReview.provenance.coverage, 4);
  assert.equal(restored.assets.shot01.videoReview.reusedFrom, 'video-check-shot01-r0');
  dropReview();
  await runProduction(f.context, { client, log: () => {}, until: 'video' });
  assert.equal(client.counts.chat, chat, '第二次恢复同样零新增请求');
  assert.equal(readJson(recordFile).fingerprint, record.fingerprint, '指纹与记录未被改动');
  // 未决记录（待核实）不得重发：只报需要核实，不产生新请求。
  writeJson(recordFile, { ...readJson(recordFile), status: 'uncertain' });
  dropReview();
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'video' }), /OPERATION_REQUIRES_RECONCILIATION/);
  assert.equal(client.counts.chat, chat, '未决记录不得重发');
  assert.equal(client.counts.generation, generation);
});

test('a legacy video check is neither rebound nor renumbered when its input cannot be proven', { timeout: 240000 }, async () => {
  const f = externalFixture();
  const client = mockClient({ ...f, checks: { '你仅把原场景适配为逐段视频首尾画面': VISUAL_PLAN,
    '用户文档场景是道具与动作的最高依据': PASS, '检查视频质量': PASS, '检查相邻两镜的衔接': PASS } });
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  const recordFile = path.join(f.directory, 'operations', 'video-check-doc01-line01-r0.json');
  const recorded = readJson(recordFile);
  // 升级前的真实结构：首帧 + 4 个旧时点抽帧，提示词也不是现在的。原始响应与指纹保持不动。
  const legacySpec = { ...recorded.spec, prompt: '图1目标首帧，其后4张为视频按时间顺序的抽帧。旧协议提示词。',
    images: ['old-first', 'old-0', 'old-1', 'old-2', 'old-3'] };
  delete legacySpec.review;
  writeJson(recordFile, { ...recorded, spec: legacySpec });
  const clearReview = () => {
    const state = loadState(f.context);
    delete state.externalScript.media['doc01-line01'].videoReview;
    writeJson(path.join(f.directory, 'state.json'), state);
  };
  clearReview();
  const chat = client.counts.chat, generation = client.counts.generation;
  await assert.rejects(runExternalVideo(f.context, { until: 'video', client, log: () => {} }),
    /EXTERNAL_CHECK_INPUT_CHANGED:video-check-doc01-line01-r0/);
  assert.equal(client.counts.chat, chat, '不得换号重新请求');
  assert.equal(client.counts.generation, generation, '不得重新生成');
  const untouched = readJson(recordFile);
  assert.equal(untouched.status, 'succeeded');
  assert.equal(untouched.spec.prompt, legacySpec.prompt, '旧记录不被改写');
  assert.deepEqual(untouched.spec.images, ['old-first', 'old-0', 'old-1', 'old-2', 'old-3'], '旧输入语义保留');
  assert.equal(loadState(f.context).externalScript.media['doc01-line01'].qualityPause.code, 'CHECK_INPUT_CHANGED');
  // 待核实的旧记录：同样明确暂停，不换号、不重绑。
  writeJson(recordFile, { ...untouched, status: 'uncertain' });
  clearReview();
  await assert.rejects(runExternalVideo(f.context, { until: 'video', client, log: () => {} }),
    /EXTERNAL_CHECK_INPUT_CHANGED:video-check-doc01-line01-r0/);
  assert.equal(client.counts.chat, chat);
});

test('an unparsable cached review stays rejected and asks for no new generation', { timeout: 240000 }, async () => {
  const f = externalFixture();
  const client = mockClient({ ...f, checks: { '你仅把原场景适配为逐段视频首尾画面': VISUAL_PLAN,
    '用户文档场景是道具与动作的最高依据': PASS, '检查视频质量': PASS, '检查相邻两镜的衔接': PASS } });
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  const recordFile = path.join(f.directory, 'operations', 'video-check-doc01-line01-r0.json');
  const recorded = readJson(recordFile);
  // 结果解析失败：同一操作号、同一份坏响应，输入语义未变，必须继续被拒绝。
  writeJson(recordFile, { ...recorded,
    result: { choices: [{ finish_reason: 'stop', message: { content: '这不是JSON' } }] } });
  const state = loadState(f.context);
  delete state.externalScript.media['doc01-line01'].videoReview;
  writeJson(path.join(f.directory, 'state.json'), state);
  const generation = client.counts.generation, chat = client.counts.chat;
  await assert.rejects(runExternalVideo(f.context, { until: 'video', client, log: () => {} }), /PLANNER_OUTPUT_INVALID_JSON/);
  assert.equal(client.counts.generation, generation, '不得产生新的生成请求');
  assert.equal(client.counts.chat, chat, '走同一操作号的缓存，不新增审核请求');
  assert.equal(readJson(recordFile).spec.prompt, recorded.spec.prompt, '原记录不被改写');
});

test('a controlled frames repair of the previous shot invalidates the adjacent check', { timeout: 240000 }, async () => {
  // 说明：本用例通过 queueFramesRepair 走受控修订（会推进修订号并清空相邻结论），证明的是"受控返工后相邻检查被一并失效"；
  // "只改输入内容而不动修订号"的失配分支由 'a stale adjacent binding …' 用例单独覆盖。
  const { queueFramesRepair } = require('../workflows/external-script-video');
  const f = externalFixture();
  let adjacent = 0;
  const client = mockClient({ ...f, checks: {
    '你仅把原场景适配为逐段视频首尾画面': VISUAL_PLAN,
    '用户文档场景是道具与动作的最高依据': PASS, '检查视频质量': PASS,
    '检查相邻两镜的衔接': () => { adjacent++; return PASS; }
  } });
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  assert.equal(adjacent, 1, '同场景承接对检查一次');
  const state = loadState(f.context);
  assert.equal(state.externalScript.adjacencyReviews['doc01-line02'].report.verdict, 'pass');
  const oldDigest = state.externalScript.adjacencyReviews['doc01-line02'].binding.digest;
  // 受控修订：登记前镜首尾帧返工（会一并失效它的视频与相关相邻检查），并让新的视频生成产出不同画面。
  f.media.command(['-f', 'lavfi', '-i', 'color=c=red:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(f.root, 'clip-red.mp4')]);
  fs.copyFileSync(path.join(f.root, 'clip-red.mp4'), f.clips[2]);
  queueFramesRepair(state.externalScript, 'doc01-line01', { fix: '首帧改为右手按住剑柄', reason: '相邻衔接不符', from: 'doc01-line02' });
  writeJson(path.join(f.directory, 'state.json'), state);
  await runExternalVideo(f.context, { until: 'video', client, log: () => {} });
  const after = loadState(f.context).externalScript;
  assert.equal(adjacent, 2, '前镜实际视频变化后相邻检查必须重做，不能复用旧通过结论');
  assert.notEqual(after.adjacencyReviews['doc01-line02'].binding.digest, oldDigest);
  assert.ok(after.adjacencyReviews['doc01-line02'].binding.extra.adjacentVideo, '绑定必须包含前镜实际视频');

test('a rejected adjacent locator in the normal path is rejected again on every recovery', { timeout: 300000 }, async () => {
  const f = productionFixture();
  let adjacent = 0;
  const client = mockClient({ ...f, checks: { '检查分镜首尾画面': PASS, '检查视频质量': PASS,
    // major 问题把图序指向目标图（图1＝前镜目标尾帧，不是实际抽帧）：首次与恢复都必须拒绝。
    '检查相邻两镜的衔接': () => { adjacent++; return { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['first'],
      issues: [{ category: 'continuity', severity: 'major', frameIndex: 1, observed: '后镜起始姿态与前镜结束不一致',
        expected: '应从半蹲前指继续', detail: '引用的是目标图而不是实际抽帧', fix: '按承接说明重做后镜首帧' }] }; } } });
  await assert.rejects(runToFrames(f, client, 'video'), /REVIEW_LOCATOR_NOT_VIDEO_FRAME:1/);
  const recordFile = path.join(f.directory, 'operations', 'adjacent-check-shot02-r0.json');
  const record = readJson(recordFile);
  assert.equal(record.status, 'succeeded', '原始操作响应保留');
  const raw = record.result.choices[0].message.content;
  const chat = client.counts.chat, generation = client.counts.generation;
  const before = loadState(f.context);
  // 连续恢复两次：缓存恢复必须与首次响应同样严格。
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'video' }), /REVIEW_LOCATOR_NOT_VIDEO_FRAME:1/);
  await assert.rejects(runProduction(f.context, { client, log: () => {}, until: 'video' }), /REVIEW_LOCATOR_NOT_VIDEO_FRAME:1/);
  assert.equal(adjacent, 1, '不得重复请求相邻审核');
  assert.equal(client.counts.chat, chat, '零新增审核请求');
  assert.equal(client.counts.generation, generation, '零新增生成请求');
  const after = loadState(f.context);
  assert.deepEqual(after.adjacencyReviews, {}, '不保存有效审核结论');
  assert.deepEqual(after.adjacencyDecisions, {}, '不登记返工');
  assert.equal(after.revisions['adjacent-check-shot02'], before.revisions['adjacent-check-shot02'], '不推进修订号');
  const kept = readJson(recordFile);
  assert.equal(kept.fingerprint, record.fingerprint, '同一操作记录，未换号也未重绑');
  assert.equal(kept.result.choices[0].message.content, raw, '原始响应字节未变');
});

test('an adjacent check with an unsampled time is rejected again on recovery in the external path', { timeout: 240000 }, async () => {
  const f = externalFixture();
  let adjacent = 0;
  const client = mockClient({ ...f, checks: { '你仅把原场景适配为逐段视频首尾画面': VISUAL_PLAN,
    '用户文档场景是道具与动作的最高依据': PASS, '检查视频质量': PASS,
    // 1.0 秒不是相邻检查抽到的时点（实际为后镜 0.03 秒与前镜结束时刻）。
    '检查相邻两镜的衔接': () => { adjacent++; return { verdict: 'rework', targetInvalid: false, uncovered: [], fixScope: ['adjacent'],
      issues: [{ category: 'continuity', severity: 'major', at: 1, frameIndex: 4, observed: '后镜开始位置与前镜结束位置不符',
        expected: '承接站位与朝向', detail: '引用了未抽样的时间', fix: '按承接说明重做后镜首帧' }] }; } } });
  await assert.rejects(runExternalVideo(f.context, { until: 'video', client, log: () => {} }), /REVIEW_TIME_NOT_SAMPLED:1/);
  const recordFile = path.join(f.directory, 'operations', 'adjacent-check-doc01-line02-r0.json');
  const record = readJson(recordFile);
  assert.equal(record.status, 'succeeded', '原始操作响应保留');
  const raw = record.result.choices[0].message.content;
  const chat = client.counts.chat, generation = client.counts.generation;
  const before = loadState(f.context).externalScript;
  await assert.rejects(runExternalVideo(f.context, { until: 'video', client, log: () => {} }), /REVIEW_TIME_NOT_SAMPLED:1/);
  await assert.rejects(runExternalVideo(f.context, { until: 'video', client, log: () => {} }), /REVIEW_TIME_NOT_SAMPLED:1/);
  assert.equal(adjacent, 1, '不得重复请求相邻审核');
  assert.equal(client.counts.chat, chat, '零新增审核请求');
  assert.equal(client.counts.generation, generation, '零新增生成请求');
  const after = loadState(f.context).externalScript;
  assert.deepEqual(after.adjacencyReviews, {}, '不保存有效审核结论');
  assert.deepEqual(after.adjacencyDecisions || {}, {}, '不登记返工');
  assert.deepEqual(after.framesRepairQueue || {}, {}, '不登记首尾帧返工');
  assert.deepEqual(after.mediaRevisions, before.mediaRevisions, '不推进修订号');
  const kept = readJson(recordFile);
  assert.equal(kept.fingerprint, record.fingerprint, '同一操作记录，未换号也未重绑');
  assert.equal(kept.result.choices[0].message.content, raw, '原始响应字节未变');
});

test('the coverage description follows the checks that actually exist and keeps older boundaries', () => {
  const { coverageBoundary } = require('../workflows/external-script-video');
  const lines = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const state = { media: {
    a: { videoReview: { binding: { sampling: { times: [0.1, 2.525, 4.95] } }, evidence: { imageCount: 5 } } },
    b: { videoReview: { provenance: { protocol: 'legacy', coverage: 4 } } },
    c: {}
  } };
  const text = coverageBoundary(state, lines);
  assert.match(text, /3个时点（0\.1\/2\.525\/4\.95秒）/, '按实际记录的时点描述，而不是写死旧说法');
  assert.match(text, /旧记录按原覆盖边界保留（b：4张输入图）/, '旧记录保留自己的输入边界');
  assert.ok(!text.includes('4时点'), '不再出现与现有方案不符的固定说法');
  assert.match(text, /不代表逐帧动作、口型或声音已验收/);
  assert.match(coverageBoundary({ media: {} }, lines), /无抽帧记录/);
});

});
