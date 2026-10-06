const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { readJson, writeJson, hash, fileHash } = require('../services/aliyun/io');
const { loadContext, runProduction, approve } = require('../workflows/production');
const { recordAudioDecision } = require('../workflows/audio-review');
const ROOT = path.resolve(__dirname, '..');
const PLANNER = 'qwen3.8-omni-flash';

// A task shaped like an older one: a brief whose author field names the former assistant, no
// speechProfile, no modern review records, and one async operation whose outcome was never confirmed.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'legacy-'));
  const project = readJson(path.join(ROOT, 'config/project.json'));
  project.tools.ffmpeg = path.join(ROOT, project.tools.ffmpeg);
  project.tools.ffprobe = path.join(ROOT, project.tools.ffprobe);
  writeJson(path.join(root, 'config/project.json'), project);
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json',
    planner: { model: PLANNER, promptVersion: 1, reservationCents: 20, includeVoiceSample: true } };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'legacy-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 70 });
  const media = new Media(root, project);
  const image = path.join(root, 'hero.png'), sample = path.join(root, 'voice.wav');
  const speech = path.join(root, 'line.wav'), shortClip = path.join(root, 'clip-2.mp4'), longClip = path.join(root, 'clip-5.mp4');
  media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=512x512', '-frames:v', '1', image]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '3', '-ac', '1', sample]);
  media.command(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000', '-t', '1.5', '-ac', '1', speech]);
  for (const [file, seconds] of [[shortClip, 2], [longClip, 5]])
    media.command(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const production = { id: 'legacy-film', description: '旧任务兼容隔离测试，不是真实成片素材', style: '测试',
    targetDurationSeconds: 10, maxDurationSeconds: 60,
    characters: [{ id: 'character01', name: '测试角色', image, voiceSample: sample, traits: '测试' }] };
  writeJson(path.join(root, 'production.json'), production);
  // The legacy brief is the only brief in this task: it is read as data and never regenerated.
  writeJson(path.join(root, 'input', 'director-brief.json'), { preparedBy: 'codex', status: 'ready', productionId: 'legacy-film',
    descriptionHash: hash(production.description), storySummary: '历史简报', shotGuidance: '历史指导',
    characters: [{ id: 'character01', imageSha256: fileHash(image), voiceSha256: fileHash(sample), frontSha256: null,
      visualAnalysis: '历史素材分析', voiceAnalysis: '历史语音分析' }] });
  const script = readJson(path.join(ROOT, 'examples/script.json'));
  const directory = path.join(root, 'jobs', 'aliyun', 'legacy-film');
  const source = { id: 'character01', image: media.image(image).hash, sample: media.audio(sample, true).hash, front: null };
  const registryKey = hash({ source, traits: production.characters[0].traits,
    speechModel: config.models.speech, portraitModel: config.models.portrait });
  writeJson(path.join(directory, 'state.json'), { version: 1, productionId: 'legacy-film',
    characters: { character01: { original: image, front: image, sample, traits: '测试', originalHash: fileHash(image),
      frontHash: fileHash(image), sampleHash: fileHash(sample), accepted: true, voice: 'legacy-voice-id',
      registryFile: path.join(root, 'jobs', 'aliyun', 'characters', registryKey, 'character.json') } },
    approvals: {}, assets: {}, revisions: {} });
  return { root, directory, config, media, script: script, image,
    client: legacyClient({ image, speech, shortClip, longClip, script }), context: loadContext(root, 'production.json') };
}
function legacyClient(files) {
  const log = [], tasks = new Map();
  const reply = content => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  return {
    log,
    request: async (endpoint, body) => {
      const prompt = JSON.stringify(body.messages || []);
      log.push({ endpoint, model: body.model, prompt });
      if (endpoint.includes('chat/completions')) {
        if (body.model === PLANNER) {
          if (prompt.includes('美术与选角分析')) return reply({ id: 'character01', visualAnalysis: '图', voiceAnalysis: '音' });
          if (prompt.includes('制作简报模型')) return reply({ storySummary: '模型简报', shotGuidance: '模型指导' });
          if (prompt.includes('编剧与分镜模型')) return reply(files.script);
          if (prompt.includes('独立审核模型')) return reply({ verdict: 'pass', summary: 'ok', contextIssues: [], durationIssues: [],
            estimatedDurationSeconds: 9, longShots: [], advice: null });
          return reply({});
        }
        return reply(prompt.includes('frontUsable') ? { usable: true, frontUsable: true, traits: '测试人物', issues: [] }
          : { pass: true, issues: [] });
      }
      if (body.model === 'qwen-voice-enrollment') return { output: { voice: 'voice-1' } };
      if (body.model.startsWith('qwen3-tts')) return { output: { audio: { url: 'https://test.aliyuncs.com/line.wav' } } };
      if (body.model.startsWith('qwen-image')) return { output: { choices: [{ message: { content: [{ image: 'https://test.aliyuncs.com/image.png' }] } }] } };
      const taskId = 'task-' + log.length;
      tasks.set(taskId, { output: { task_status: 'SUCCEEDED', video_url: 'https://test.aliyuncs.com/clip-' + body.parameters.duration + '.mp4' } });
      return { output: { task_id: taskId } };
    },
    task: async id => tasks.get(id),
    upload: async () => 'oss://test/audio.wav',
    download: async (url, destination) => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const file = url.endsWith('image.png') ? files.image : url.endsWith('line.wav') ? files.speech
        : Number(url.match(/clip-(\d+)/)[1]) === 2 ? files.shortClip : files.longClip;
      fs.copyFileSync(file, destination);
    }
  };
}

test('a legacy-shaped task stays readable, reuses results and never resends unresolved work', async () => {
  const f = fixture(), context = f.context, directory = f.directory;
  const requests = () => f.client.log.length;
  await runProduction(context, { client: f.client, log: () => {}, until: 'script' });
  await assert.rejects(runProduction(context, { client: f.client, log: () => {}, until: 'audio' }), /REVIEW_REQUIRED:script/);
  await approve(context, 'script');
  await runProduction(context, { client: f.client, log: () => {}, until: 'audio' });
  await recordAudioDecision(context, 'accepted', '历史任务：用户曾接受配音');
  await runProduction(context, { client: f.client, log: () => {}, until: 'video' });
  const stateFile = path.join(directory, 'state.json');
  assert.ok(readJson(stateFile).approvals.script);
  // Degrade the task into an older shape: legacy author field, no modern records, one unresolved op.
  const legacy = readJson(stateFile);
  delete legacy.brief; delete legacy.briefFile; delete legacy.scriptReview; delete legacy.characterChecks;
  delete legacy.audioRecords; delete legacy.audioReviews; delete legacy.qualityDegradations; delete legacy.speechProfile;
  legacy.characters.character01.voice = 'legacy-voice-id';
  delete legacy.characters.character01.voices;
  writeJson(stateFile, legacy);
  const videoOp = path.join(directory, 'operations', 'video-shot01-r0.json');
  writeJson(videoOp, { ...readJson(videoOp), status: 'submitting', error: { message: 'legacy outcome unknown' } });
  const videoOpBefore = fileHash(videoOp);
  const legacyTextSpec = { endpoint: '/chat/completions', kind: 'text', model: 'deepseek-flash', prompt: 'legacy script', cents: 50 };
  await new Budget(f.root, f.config, directory).reserve('script-r0', 50, hash(legacyTextSpec));
  writeJson(path.join(directory, 'operations', 'script-r0.json'), { id: 'script-r0', fingerprint: hash(legacyTextSpec),
    status: 'succeeded', spec: legacyTextSpec,
    result: { id: 'legacy-response', choices: [{ finish_reason: 'stop', message: { content: '{"title":"旧脚本","shots":[]}' } }] } });
  // Old records are readable, and a legacy synchronous operation never routes anywhere.
  const legacyOps = new Operations(path.join(directory, 'operations'), { request: () => { throw new Error('NO_ROUTE_EXPECTED'); } },
    new Budget(f.root, f.config, directory), () => {}, 0, 0);
  const cached = await legacyOps.execute('script-r0', legacyTextSpec, async () => { throw new Error('SHOULD_NOT_RESUBMIT'); });
  assert.equal(cached.id, 'legacy-response');
  // An async legacy operation cannot be "restored" from a synchronous response: explicit refusal, kept.
  const videoRecord = readJson(videoOp);
  assert.throws(() => legacyOps.adoptResponse('video-shot01-r0',
    { operationId: 'video-shot01-r0', fingerprint: 'wrong-fingerprint', result: { request_id: 'x' } }, 'legacy evidence'),
    /RESPONSE_EVIDENCE_REQUIRED/);
  assert.throws(() => legacyOps.adoptResponse('video-shot01-r0',
    { operationId: 'video-shot01-r0', fingerprint: videoRecord.fingerprint, result: { request_id: 'x' } }, 'legacy evidence'),
    /RESPONSE_CANNOT_BE_ADOPTED/);
  assert.equal(fileHash(videoOp), videoOpBefore);
  // Re-run past characters, script and audio: legacy data is used and nothing is resent.
  const beforeRerun = requests();
  await assert.rejects(runProduction(context, { client: f.client, log: () => {}, until: 'video' }),
    /OPERATION_REQUIRES_RECONCILIATION:video-shot01-r0/);
  const after = readJson(stateFile);
  assert.equal(after.briefSource.role, 'external-source');
  assert.equal(after.brief.generatedBy, undefined);
  assert.equal(after.brief.storySummary, '历史简报');
  assert.equal(after.script.title, f.script.title);
  assert.ok(after.assets.shot01.first);
  const rerun = f.client.log.slice(beforeRerun);
  assert.equal(rerun.length, 0); // nothing at all was re-sent: no brief, no review, no media, no legacy route
  assert.equal(after.scriptReview.verdict, 'pass'); // the review record is restored from its cached operation
  assert.equal(after.scriptReview.scriptHash, hash(after.script));
  assert.equal(beforeRerun > 0, true);
  assert.equal(fileHash(videoOp), videoOpBefore);
  assert.equal(readJson(videoOp).status, 'submitting');
});
