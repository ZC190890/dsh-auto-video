const fs = require('node:fs');
const path = require('node:path');
const { readCache, hash, writeJson, withLock, safeId, fileHash } = require('../services/aliyun/io');
const { Media } = require('../services/aliyun/media');
const { Models } = require('../services/aliyun/models');
const { UnitAttempts } = require('../services/aliyun/units');
const { Budget, authorization } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { audioAcceptanceBinding } = require('./operations-map');
const { loadState, saveState, providerClient } = require('./production');

// Audio understanding via the documented Qwen-Omni model. One request per shot: the earlier single
// concatenated request left the model guessing segment boundaries and mis-assigning lines, so this
// module never concatenates and never lets the model decide where a shot starts or ends.
// Split deliberately: text correctness, technical quality, emotion and voice similarity are stored
// separately, and an auxiliary model opinion is never recorded as user acceptance.
function audioReviewModelTag(model) { return String(model).replace(/[^a-zA-Z0-9]/g, ''); }
function audioReviewBase(model, shotId) { return 'audio-review-' + audioReviewModelTag(model) + '-' + shotId; }
function normalizeText(value) { return String(value).replace(/[\s\p{P}]/gu, ''); }

function reviewPrompt(shotId) {
  return '请只根据这一段中文古装人物配音独立判断，不要猜测，不要改成常见名言，也不要参考任何剧本或台词列表。' +
    '仅输出JSON：{"shotId":"' + shotId + '","transcript":"实际听到的逐字文本",' +
    '"delivery":"实际听到的语气与音色描述","expressiveness":"flat或moderate或strong或uncertain",' +
    '"issues":[],"uncertainWords":[]}。' +
    '要求：不确定的同音字写入uncertainWords；完全听不清或无声时在issues写明，不要编造内容；' +
    '平读就写flat，不要根据人物身份推断情绪；只描述真实听感，不评价是否符合剧本。';
}

async function analyzeShotAudio(context, { shotId, models, media, state, log = () => {} }) {
  const shot = state.timed?.shots?.find(s => s.id === shotId);
  if (!shot) throw new Error('SHOT_NOT_FOUND:' + shotId);
  if (!shot.text) throw new Error('SHOT_HAS_NO_SPEECH:' + shotId);
  const asset = state.assets?.[shotId] || {};
  const audio = asset.speechRaw || asset.audio;
  if (!audio || !fs.existsSync(audio)) throw new Error('AUDIO_REVIEW_SOURCE_MISSING:' + shotId);
  const model = context.config.audioReview?.model;
  const base = audioReviewBase(model, shotId);
  const operation = base + '-r' + (state.revisions?.[base] || 0);
  const technical = media.audio(audio);
  const { report, usage } = await models.audioReview(operation, { shotId, shotTextHash: hash(shot.text), audio,
    prompt: reviewPrompt(shotId), reservationCents: context.config.audioReview?.reservationCents });
  const normalizedExpected = normalizeText(shot.text), normalizedActual = normalizeText(report.transcript);
  const record = {
    shotId, operation, model,
    promptVersion: context.config.audioReview.promptVersion,
    input: { file: audio, hash: fileHash(audio), source: asset.speechRaw ? 'speechRaw' : 'drivingAudio' },
    textCheck: { expected: shot.text, transcript: report.transcript, normalizedMatch: normalizedExpected === normalizedActual,
      note: '同音字与ASR差异不等于读音错误；文字正确性必须人工按实听复核' },
    technical: { duration: technical.duration, sampleRate: technical.sampleRate, channels: technical.channels,
      rmsDb: technical.quality.rmsDb, peak: technical.quality.peak, clippedFraction: technical.quality.clippedFraction,
      warnings: technical.quality.warnings, basis: '本地解码测量，不含表演判断' },
    performance: { expressiveness: report.expressiveness, delivery: report.delivery,
      basis: '辅助模型听感描述，不是用户验收，也不证明情绪达标' },
    voiceSimilarity: { assessed: false,
      reason: '未向该模型提供参考音频；即使提供也只能是辅助意见，不能当音色相似度验收' },
    issues: report.issues, uncertainWords: report.uncertainWords, usage: usage || null,
    reviewStatus: 'awaiting-user-acceptance', analyzedAt: new Date().toISOString()
  };
  state.audioReviews ||= {};
  state.audioReviews[shotId] = record;
  writeJson(path.join(context.directory, 'audio-review', shotId + '.json'), record);
  log('音频分析完成：' + shotId + '（' + report.expressiveness + '，技术项本地测量）');
  return record;
}

async function runAudioReviews(context, shotIds = [], { client: injectedClient, log = console.log } = {}) {
  const requested = (shotIds || []).map(id => safeId(id));
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    const shots = state.timed?.shots || [];
    if (!shots.length) throw new Error('TIMELINE_REQUIRED');
    const targets = requested.length ? requested : shots.filter(s => s.text).map(s => s.id);
    if (!targets.length) throw new Error('NO_SPEECH_SHOTS');
    for (const id of targets) {
      if (!shots.some(s => s.id === id)) throw new Error('SHOT_NOT_FOUND:' + id);
      if (!shots.find(s => s.id === id).text) throw new Error('SHOT_HAS_NO_SPEECH:' + id);
    }
    authorization(context.root, context.config, context.production.id); // before credentials or any request
    const media = new Media(context.root, context.project);
    const budget = new Budget(context.root, context.config, context.directory);
    const client = providerClient(context.root, injectedClient);
    const ops = new Operations(path.join(context.directory, 'operations'), client, budget, log,
      context.config.pollIntervalSeconds, context.config.pollTimeoutSeconds, new UnitAttempts(context.directory));
    const models = new Models(context.config, ops, media, path.join(context.directory, 'vision-cache'));
    const reviews = [];
    for (const shotId of targets) reviews.push(await analyzeShotAudio(context, { shotId, models, media, state, log }));
    state.audioReviewSummary = { model: context.config.audioReview?.model, promptVersion: context.config.audioReview?.promptVersion,
      shots: targets, requests: targets.length, at: new Date().toISOString(),
      limitation: '辅助模型分析，不能替代用户试听；不构成配音表演合格' };
    saveState(context, state);
    return { model: state.audioReviewSummary.model, shots: targets, requests: targets.length,
      reviews: reviews.map(r => ({ shotId: r.shotId, expressiveness: r.performance.expressiveness,
        normalizedMatch: r.textCheck.normalizedMatch, issues: r.issues.length })) };
  });
}

// The user decides (the model may advise but can never approve); a rejection stores the concrete
// problem and the rework direction and deliberately disables automatic retry, and any non-accepted
// state keeps blocking the video stage.
// The acceptance is bound to the audio actually in state (digest per shot + speech revision + script
// digest), so a later change cannot leave an old "accepted" verdict standing.
async function recordAudioDecision(context, decision, note) {
  if (!['accepted', 'rejected'].includes(decision)) throw new Error('AUDIO_DECISION_REQUIRED: accepted 或 rejected');
  if (typeof note !== 'string' || !note.trim() || note.length > 500) throw new Error('AUDIO_DECISION_NOTE_REQUIRED');
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    if (!state.timed) throw new Error('TIMELINE_REQUIRED');
    const model = state.speechProfile?.models?.speech || context.config.models.speech;
    state.audioReview = { status: decision, note: note.trim(), model, binding: audioAcceptanceBinding(state), at: new Date().toISOString(),
      ...(decision === 'rejected' ? { rework: note.trim(), reworkScope: 'speech', autoRetry: 'disabled' } : {}) };
    for (const record of Object.values(state.audioReviews || {})) record.reviewStatus = decision === 'accepted' ? 'accepted-by-user' : 'rejected-by-user';
    saveState(context, state);
    return { status: decision, model, blocksVideo: decision !== 'accepted',
      autoRetry: decision === 'rejected' ? 'disabled' : null, boundTo: state.audioReview.binding };
  });
}

function operationRecord(context, operation) {
  return readCache(path.join(context.directory, 'operations', operation + '.json'));
}

module.exports = { analyzeShotAudio, audioAcceptanceBinding, audioReviewBase, audioReviewModelTag, normalizeText,
  operationRecord, recordAudioDecision, reviewPrompt, runAudioReviews };
