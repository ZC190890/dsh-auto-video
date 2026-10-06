// The fine-grained creative chain behind the NORMAL production entry. A task that explicitly declares
// `creative: true` runs this chain, and every boundary either stops cleanly (recoverable, no repeated
// planning) or stops with a recorded blocker. It never falls back into the legacy script/speech stages.
const fs = require('node:fs');
const path = require('node:path');
const { hash, fileHash, writeJson } = require('../services/aliyun/io');
const { staleSettingShots } = require('../services/aliyun/creative');
const { authorCreative, finalCompositionPlan, planStoryboard, requireAcceptedAudio, audioLines } = require('./creative');
const { EXECUTION, currentHumanToneDecision, currentToneReview, toneReviewBinding, toneReviewStage } =
  require('./tone-review');

// Acting notes are instructions for the voice, never text to read out.
function performanceInstruction(line) {
  const performance = line.performance || {}, parts = [];
  if (performance.tone) parts.push('语气：' + performance.tone);
  if (performance.pauses?.length) parts.push('停顿：' + performance.pauses.join('、'));
  if (performance.breath) parts.push('呼吸：' + performance.breath);
  if (performance.silence?.length) parts.push('留白：' + performance.silence.join('、'));
  if (line.notSpoken?.length) parts.push('以下只是表演说明，不要读出来：' + line.notSpoken.join('、'));
  return parts.length ? parts.join('；') : null;
}

function records(state) {
  state.creative ||= { version: 1 };
  state.creative.audio ||= {};
  return state.creative.audio;
}

function pause(state, code, detail) {
  state.creativeStage ||= {};
  state.creativeStage.pause = { code, detail, stage: state.stage, at: new Date().toISOString() };
  delete state.creativeStage.resumedAt;
  return state;
}

// One planning pass over the creative package. Finished pieces are persisted with their digest, so a
// resumed run reuses them and does not repeat a planning request.
async function authorStage(context, state, { models, log, save }) {
  state.creative ||= { version: 1 };
  await authorCreative(context, { models, state, log });
  state.stage = 'creative';
  state.creative.authoredAt = new Date().toISOString();
  delete state.creativeStage?.pause;
  // A running-time risk that rests on ESTIMATES is reported as a risk, never as a decision: no word is deleted,
  // reworded or sped up here, and the real judgement waits until the audio was measured.
  const risks = (state.creative.durationLedger?.conflicts || []).filter(conflict => !conflict.gating);
  if (risks.length) log('时长风险（估计，不作为判定或删改依据）：' + risks.map(conflict => conflict.note).join('；'));
  writeJson(path.join(context.directory, 'creative', 'creative-package.json'), state.creative);
  save();
  return state.creative;
}

// Speech is organised per PERFORMANCE PRODUCT from the voice plan (one line may contain several sentences,
// pauses and a slow build). Nothing here forces one file per sentence.
async function speechStage(context, state, { media, speechModels, operation, log, save }) {
  const creative = state.creative, audio = records(state);
  const model = speechModels.config.models.speech;
  const supportsInstruction = model === 'qwen-audio-3.0-tts-plus';
  const pendingEmotion = [];
  for (const line of audioLines(creative)) {
    if (audio[line.id]?.file && Number.isFinite(audio[line.id].duration)) continue; // resume: never resend
    const manifestCharacter = (context.production.characters || []).find(c => c.id === line.speaker) || null;
    state.characters ||= {};
    const stored = state.characters[line.speaker] || (state.characters[line.speaker] = {});
    if (!stored.voice) {
      // Voice enrollment is the existing adapter capability; the sample comes from the manifest, because the
      // creative chain uses the user's material instead of the legacy character registry.
      if (!manifestCharacter?.voiceSample) throw new Error('CREATIVE_VOICE_SAMPLE_MISSING:' + line.speaker);
      const sample = media.normalizeAudio(manifestCharacter.voiceSample,
        path.join(context.directory, 'creative', 'voices', line.speaker + '.wav'));
      stored.voice = await speechModels.voice(operation('voice-' + line.speaker), sample);
      writeJson(path.join(context.directory, 'creative', 'voices', line.speaker + '.json'), stored);
      save();
    }
    const voice = stored.voice;
    const instruction = performanceInstruction(line);
    const op = operation('speech-' + line.id);
    const raw = await speechModels.speech(op, line.text, voice,
      path.join(context.directory, 'audio', op + '.wav'), { instruction, rate: 1 });
    // The take is kept as recorded (no padding) because the film's running time must equal the accepted
    // audio; a padded copy is produced separately for driving a shot.
    const file = media.normalizeAudio(raw, path.join(context.directory, 'audio', operation('creative-' + line.id) + '.wav'), 0);
    const driving = media.normalizeAudio(raw, path.join(context.directory, 'audio', operation('driving-' + line.id) + '.wav'), 2);
    const duration = media.audio(file).duration;
    audio[line.id] = { operation: op, model, voice, instruction, file, driving, raw, hash: fileHash(file), duration,
      measuredBy: 'ffprobe@generation', characters: [...line.text].length,
      // The plan's own estimate travels WITH the take: once the file exists the measured duration is what counts,
      // and the estimate is kept only as the record of what was assumed before it.
      estimate: line.durationEstimate || null,
      notSpoken: line.notSpoken || [], performance: line.performance || null,
      // Tone is only an INSTRUCTION to the generator at this point. Nothing here claims the produced audio was
      // judged: the automatic tone check is not implemented, so acceptance (a human listen) is the only gate.
      toneReview: { status: 'pending-review', protocol: 'creative-tone-review',
        note: 'delivery 只证明把表演意图传给了生成模型，不代表生成结果已合规；随后由自动语气判断按本段台词与表演安排逐项审核，通过后仍需人工试听接受',
        requires: '自动语气判断（tone-review-*）与人工试听接受（accept-creative-audio）' },
      emotionHandling: !line.performance?.tone ? 'plan-has-no-tone'
        : instruction ? 'instruction-sent'
          : supportsInstruction ? 'instruction-missing-but-explained' : 'model-has-no-instruction-parameter',
      reviewStatus: 'awaiting-user-acceptance', at: new Date().toISOString() };
    if (line.performance?.tone && !supportsInstruction) pendingEmotion.push(line.id);
    log('配音产物已生成：' + line.id + '（' + line.speaker + '，' + duration.toFixed(2) + ' 秒）');
    save();

  }
  state.stage = 'audio';
  save();
  return { pendingEmotion };
}

// The automatic tone review is a GATE, not a formality, and it is never quietly overridden:
//   - a review taken for different audio, different words or different goals is stale (only a new review helps);
//   - an unusable file stays unusable, whatever the operator says about the tone;
//   - an execution problem left NO conclusion, so there is nothing to accept or overrule yet;
//   - a real conclusion of fail / undetermined / unsupported may only be passed by an EXPLICIT decision that records
//     its reason, and the model's own verdict stays in the record beside it;
//   - a decision the operator ALREADY took for this exact input stands: the same reason is not asked for a second
//     time and the record is not rewritten with a new timestamp, while changed audio, changed words or changed goals
//     make that decision stale like every other conclusion.
function toneGate(context, creative, lineId, { overrideReason = null, method = 'operator' } = {}) {
  const stored = creative.toneReviews?.[lineId] || null;
  if (!stored) throw new Error('CREATIVE_TONE_REVIEW_REQUIRED:' + lineId +
    '：该表演段还没有自动语气判断，先运行 run --until audio（或 node index.js tone-review）再接受，不把未判断当成通过');
  if (stored.binding !== toneReviewBinding(context, creative, lineId))
    throw new Error('CREATIVE_TONE_REVIEW_STALE:' + lineId +
      '：审核绑定已过期（音频、台词或表演目标已变化），必须重做语气判断；人工语气确认不能绕过');
  const status = stored.execution?.status;
  if (status === EXECUTION.BLOCKED_TECHNICAL)
    throw new Error('CREATIVE_TONE_AUDIO_INVALID:' + lineId + '：' + stored.execution.detail +
      '；技术无效的音频不能靠人工语气确认通过');
  if (status !== EXECUTION.COMPLETED)
    throw new Error('CREATIVE_TONE_REVIEW_NO_CONCLUSION:' + lineId + ':' + status +
      '：未得到模型结论（' + (stored.execution?.note || '') + '），不得当成通过；先按执行状态核实或改变输入，再重新判断');
  if (stored.verdict === 'pass')
    return { lineId, decision: 'pass', modelVerdict: 'pass', execution: status, model: stored.model,
      operation: stored.operation, binding: stored.binding, override: null };
  // The operator overruled this very input once, with a reason, and the record still binds the current take, words and
  // goals (the checks above did not fire). The run continues on that standing decision: no second reason is demanded
  // for the same input, and nothing is rewritten — the preserved model verdict is reported as it is.
  const standing = currentHumanToneDecision(context, creative, lineId);
  if (standing)
    return { lineId, decision: 'accepted-despite-review', modelVerdict: stored.verdict, execution: status,
      model: stored.model, operation: stored.operation, binding: stored.binding,
      problems: stored.problems || [], suggestions: stored.suggestions || [], override: standing, recorded: true };
  const decision = { lineId, decision: 'accepted-despite-review', modelVerdict: stored.verdict, execution: status,
    model: stored.model, operation: stored.operation, binding: stored.binding,
    problems: stored.problems || [], suggestions: stored.suggestions || [] };
  if (!overrideReason)
    throw new Error('CREATIVE_TONE_REVIEW_NOT_PASSED:' + lineId + ':' + stored.verdict +
      '：自动语气判断未通过，普通接受命令不能覆盖；确已人工复核并要继续时，须显式记录理由（--tone-override <理由>）');
  return { ...decision, override: { by: method === 'fixture' ? 'offline-fixture' : 'operator', reason: overrideReason,
    at: new Date().toISOString(), preservedModelVerdict: stored.verdict,
    note: '人工复核后的显式决定：模型结论原样保留在记录里，不因为接受而改变' } };
}

// Acceptance binds the voice plan, the audio content, the MEASURED duration and the method. A bare
// `accepted: true` is impossible by construction, and the fixture method only exists for offline fixtures.
function recordAcceptance(context, state, entries, { method = 'operator', media, offlineFixture = false,
  toneOverride = null } = {}) {
  const isolation = { offlineFixture };
  const creative = state.creative;
  if (!creative?.voicePlan) throw new Error('ACCEPTANCE_REQUIRES_VOICE_PLAN');
  if (method === 'fixture' && !(isolation.offlineFixture === true && context.production.creativeFixture === true))
    throw new Error('FIXTURE_ACCEPTANCE_NOT_ALLOWED: 模拟接受只能用于显式声明 creativeFixture 的离线夹具');
  const lines = audioLines(creative), audio = records(state);
  for (const entry of entries) {
    const line = lines.find(item => item.id === entry.lineId);
    if (!line) throw new Error('ACCEPTANCE_UNKNOWN_LINE:' + entry.lineId);
    if (!audio[entry.lineId]?.file) throw new Error('ACCEPTANCE_REQUIRES_GENERATED_AUDIO:' + entry.lineId);
    if (fileHash(audio[entry.lineId].file) !== fileHash(entry.file)) throw new Error('ACCEPTANCE_FILE_MISMATCH:' + entry.lineId);
    media.audio(entry.file);
    audio[entry.lineId] = { ...audio[entry.lineId], file: entry.file, hash: fileHash(entry.file),
      duration: media.audio(entry.file).duration, measuredBy: 'ffprobe@acceptance', reviewStatus: 'accepted',
      // The acceptance records WHERE the duration comes from. Whatever the plan estimated before is kept beside
      // it and never replaces the measurement.
      measurement: { basis: 'measured', measuredBy: 'ffprobe@acceptance' },
      estimate: audio[entry.lineId].estimate || null };
  }
  const unaccepted = lines.filter(line => !audio[line.id]?.file || !Number.isFinite(audio[line.id].duration));
  if (unaccepted.length) throw new Error('ACCEPTANCE_INCOMPLETE:' + unaccepted.map(line => line.id).join(','));
  // The automatic tone judgement of EVERY accepted performance segment is checked here, BEFORE anything is written:
  // the acceptance covers all lines, so a line whose audio changed cannot ride along on the operator's confirmation
  // of a different line. Only the lines the operator listed may be passed with an explicit reason.
  const listed = new Set(entries.map(entry => entry.lineId));
  const toneGates = audioLines(creative).map(line => toneGate(context, creative, line.id,
    { overrideReason: listed.has(line.id) ? toneOverride : null, method }));
  for (const gate of toneGates) {
    // A decision that was already recorded for this input is NOT written again: its original reason and timestamp
    // stay exactly as the operator left them, so an idempotent re-acceptance cannot rewrite history.
    if (!gate.override || gate.recorded) continue;
    const record = creative.toneReviews?.[gate.lineId];
    if (record) creative.toneReviews[gate.lineId] = { ...record, reviewStatus: 'overridden-by-user',
      humanDecision: gate.override };
  }
  creative.acceptance = { status: 'accepted', method, at: new Date().toISOString(),
    // The duration basis of this acceptance: every line's running time is a local measurement of the accepted
    // file, and the plan's earlier estimates are recorded separately as what they were.
    durationBasis: { basis: 'measured', measuredBy: 'ffprobe@acceptance',
      estimated: lines.filter(line => audio[line.id]?.estimate).map(line => ({ id: line.id,
        estimatedSeconds: audio[line.id].estimate.seconds, measuredSeconds: audio[line.id].duration })) },
    plan: { digest: creative.digests?.voicePlan || null, version: creative.voicePlan.version ?? null },
    binding: hash(lines.map(line => ({ id: line.id, text: line.text,
      file: audio[line.id]?.file ? fileHash(audio[line.id].file) : null }))),
    measured: Object.fromEntries(lines.map(line => [line.id, audio[line.id].duration])), measuredBy: 'ffprobe',
    toneReview: method === 'fixture' ? { status: 'simulated', note: '夹具的模拟接受，不代表任何试听或语气结论' }
      : { status: 'human-accepted', note: '接受来自人工试听；自动语气判断只作依据，不代替试听', lines: toneGates },
    note: method === 'fixture' ? '离线夹具的模拟接受，不代表真实试听' : null };
  delete state.creativeStage?.pause;
  return creative.acceptance;
}

function audioBinding(creative) {
  const audio = creative.audio || {};
  return hash(audioLines(creative).map(line => ({ id: line.id, text: line.text,
    file: audio[line.id]?.file ? fileHash(audio[line.id].file) : null })));
}

// The controlled-update state a board enters once a setting it was written against has been replaced. The run stops
// on this decision instead of generating frames from a spliced description, and the way forward is an explicit,
// recorded re-plan (never an automatic repair).
function settingStalePause(board) {
  const stale = staleSettingShots(board);
  if (!stale.length) return null;
  return { code: 'CREATIVE_STORYBOARD_SETTING_CHANGED', shots: stale,
    detail: '以下镜头的逐帧文字与可见环境是按已被修订的设定写的：' +
      stale.map(item => item.id + '（' + item.kind + '：' + item.target + '）').join('、') +
      '；不得与新设定拼接生成。确认后用受控重新规划：node index.js revise-creative <清单> ' +
      '{"kind":"storyboard","decision":"replan"} <原因>，再由 run 重新安排分镜（已接受的配音与实测时长不变，' +
      '旧分镜与旧产物留在历史与磁盘上）' };
}
// The chain, boundary by boundary. Each `until` value stops the run at its own stage and returns the state,
// so the next run resumes there; a stage that is not wired yet stops with a recorded blocker instead of
// entering the legacy generation path.
async function runCreativeStage(context, state, deps) {
  const { until, log, media, models, speechModels, attempts, operation, save } = deps;
  await authorStage(context, state, { models, log, save });
  log('创作产物已就绪（需求约束包/导演脚本/人物与场景设定集/配音计划）；本轮未生成任何配音或媒体');
  if (until === 'creative') return state;
  const { pendingEmotion } = await speechStage(context, state, { media, speechModels, operation, log, save });
  if (pendingEmotion.length) {
    pause(state, 'CREATIVE_EMOTION_UNSUPPORTED',
      '当前语音模型 ' + speechModels.config.models.speech + ' 没有语气指令能力，以下配音产物未把语气写进请求：' + pendingEmotion.join('、') + '；请改用支持的模型或明确说明后继续');
    save();
    return state;
  }
  // The automatic tone review of every recorded PERFORMANCE SEGMENT runs before the acceptance gate: the local
  // technical check and the model judgement come first, and a failure, an unclear hearing, a missing ability or an
  // execution problem stops the automatic advance with its evidence (per line, never per camera shot).
  const tone = await toneReviewStage(context, state, { models, media, log, save });
  if (tone.blocked) {
    save();
    log('自动语气判断没有通过：' + tone.blocked.lineId + '（' +
      (tone.blocked.verdict || tone.blocked.execution.status) + '）流程停在这里，未进入接受与分镜');
    return state;
  }
  if (until === 'audio') return state;
  // Acceptance gate. Not accepted, stale binding or a missing measured duration stops the run HERE, with
  // zero storyboard requests.
  try {
    requireAcceptedAudio(state);
  } catch (error) {
    // The old storyboard belonged to the previous audio: it is dropped here so it cannot be reused.
    if (state.creative.storyboard) {
      state.creative.invalidated = { code: 'CREATIVE_AUDIO_CHANGED', previous: state.creative.storyboard.audioBinding,
        current: audioBinding(state.creative), at: new Date().toISOString() };
      delete state.creative.storyboard;
      delete state.creative.timeline;
    }
    pause(state, 'CREATIVE_AUDIO_NOT_ACCEPTED', error.message + '；本轮未发起任何分镜请求');
    save();
    log('配音尚未被接受或验收绑定已变化，流程停在这里：' + error.message);
    return state;
  }
  const accepted = requireAcceptedAudio(state);
  // An older creative package was written before the per-frame structure existed. It is never patched silently:
  // the run stops and asks for a controlled re-plan (or an explicit revision), and no history is rewritten.
  const staleShot = state.creative.storyboard?.shots?.find(shot => !Array.isArray(shot.first?.extraCast) ||
    !Array.isArray(shot.first?.visibleEnvironment) || !shot.first.visibleEnvironment.length);
  if (staleShot) throw new Error('CREATIVE_STORYBOARD_NEEDS_REPLAN:' + staleShot.id +
    ': 既有分镜缺少本次的结构（每帧 visibleEnvironment 与 extraCast），请受控重新规划（revise-script 后重跑，或经确认后删除该创作产物再规划）；不会自动补字段，也不改写历史记录');
  // A setting that was revised after this board was written leaves frame text that describes the OLD setting (its
  // per-frame state and visible environment are part of that text). The affected shots are marked by the controlled
  // revision, and the run stops HERE: the new setting is never pasted onto the old description. Re-authoring those
  // frames is the controlled storyboard re-plan, never an automatic repair.
  const staleSettings = settingStalePause(state.creative.storyboard);
  if (staleSettings) {
    pause(state, staleSettings.code, staleSettings.detail);
    save();
    log('分镜逐帧文字所属设定已被修订，流程停在受控更新状态（未发起任何帧或视频请求）');
    return state;
  }
  // A storyboard that still matches the accepted audio is reused, so a resumed run never re-submits it. When
  // the audio or the voice plan changed, the old storyboard and timeline are dropped before planning again.
  if (state.creative.storyboard && state.creative.storyboard.audioBinding !== accepted.binding) {
    state.creative.invalidated = { code: 'CREATIVE_AUDIO_CHANGED', previous: state.creative.storyboard.audioBinding,
      current: accepted.binding, at: new Date().toISOString() };
    delete state.creative.storyboard;
    delete state.creative.timeline;
    save();
    log('已接受的配音或配音计划发生变化：旧分镜与时间线已失效，需重新安排');
  }
  log('配音已被接受（' + state.creative.acceptance.method + '），实测时长 ' + Object.keys(accepted.measured).length + ' 段');
  if (!state.creative.storyboard) {
    await planStoryboard(context, { models, state, log });
    state.stage = 'storyboard';
    save();
  }
  if (until === 'storyboard') return state;
  // Frames run through the injected stage (defined in production.js, where the binding/check/rework helpers
  // live), so the same operations, round ledger and protections apply to the creative chain.
  if (typeof deps.framesStage !== 'function') {
    pause(state, 'CREATIVE_FRAMES_UNAVAILABLE', '创作帧阶段未注入；本轮未发起任何图片或视频请求');
    save();
    return state;
  }
  await deps.framesStage(context, state, deps);
  if (state.assets && Object.values(state.assets).some(asset => asset.referencePause))
    return state;
  if (until === 'frames') return state;
  // A shot whose video plan could not be executed stopped the stage before the first submission; the blockers
  // are recorded per shot and the run ends here without a second, invented reason. Each shot's video otherwise
  // comes from its own plan, decided (with its local driving audio) before the first video submission.
  if (typeof deps.videoStage !== 'function') {
    pause(state, 'CREATIVE_VIDEO_UNAVAILABLE', '创作视频阶段未注入；本轮未发起任何视频请求，也不回落旧生成路径');
    save();
    return state;
  }
  await deps.videoStage(context, state, deps);
  if (state.assets && Object.values(state.assets).some(asset => asset.videoPause))
    return state;
  if (until === 'video') return state;
  return finalStage(context, state, deps);
}

// The last boundary of the creative chain: the film is assembled locally, from what this chain already
// produced (the accepted audio bed, the storyboard timeline, the subtitles and the shot videos that passed
// their own check). There is no fallback path here. A blocked plan stops the run with zero FFmpeg calls and
// no output file, and a film whose input is provably unchanged is reused instead of being encoded again.
function finalStage(context, state, deps) {
  const { media, log = () => {}, save } = deps;
  const plan = finalCompositionPlan(context, state, { media });
  state.creative.compositions ||= [];
  const previous = state.creative.composition || null;
  const directory = path.join(context.root, 'output', context.production.id,
    ...(state.editRevision ? ['revision-' + state.editRevision] : []));
  const output = path.join(directory, 'final.mp4');
  if (plan.blockers.length) {
    state.creative.finalBlockers = plan.blockers;
    // THIS input has no film. When the film the task currently points at is the very path this input would have
    // written, that pointer is cleared with an explanation instead of letting the older film pass as the result of
    // the new input. The file itself and its composition record are left untouched: no history is rewritten, and
    // no encode, no output and no fallback to the legacy assembly path happen here.
    let stale = '';
    if (state.output === output || previous?.output === output) {
      if (state.output) delete state.output;
      if (state.acceptance) delete state.acceptance;
      stale = '；指向旧成片的 output/acceptance 已清除（旧文件没有被覆盖，它属于上一次输入，仍留在磁盘上）';
    }
    pause(state, 'CREATIVE_FINAL_BLOCKED',
      '成片合成被阻断，本轮未调用 FFmpeg、未写入 output、未回落旧合成路径：' + plan.blockers.join('；') + stale);
    save();
    log('成片合成被阻断：' + plan.blockers.join('；') + stale);
    return state;
  }
  delete state.creative.finalBlockers;
  // The same input produces the same film: when the recorded composition is this exact input AND the file is
  // still the one that was written (same hash), nothing is re-encoded and no FFmpeg call is made at all.
  if (previous?.inputDigest === plan.inputDigest && previous.output === output &&
    fs.existsSync(output) && fileHash(output) === previous.hash) {
    state.creative.composition = { ...previous, lastReusedAt: new Date().toISOString(), reuses: (previous.reuses || 0) + 1 };
    state.timed = plan.timed;
    state.output = output;
    state.stage = 'final';
    state.acceptance = 'awaiting_user_playback';
    delete state.creativeStage?.pause;
    save();
    log('输入与上次成片完全一致：直接复用 ' + output + '（未重新编码）；仍需用户播放验收，不自动接受');
    return state;
  }
  fs.mkdirSync(directory, { recursive: true });
  // A different film already sitting at this path is a version of its own: it is preserved under its own
  // input digest instead of being overwritten, so no earlier film is silently lost.
  let preserved = null;
  if (previous?.hash && fs.existsSync(output) && fileHash(output) === previous.hash) {
    preserved = 'final-' + String(previous.inputDigest).slice(0, 8) + '.mp4';
    fs.copyFileSync(output, path.join(directory, preserved));
    log('旧成片已保留为独立版本：' + preserved);
  }
  const assembled = media.assemble(plan.timed, plan.assets, directory, { preview: plan.composition.preview });
  const info = media.video(output, plan.timed.totalDuration, true);
  const record = { at: new Date().toISOString(), inputDigest: plan.inputDigest, output, file: assembled,
    hash: fileHash(output), duration: info.duration, width: info.width, height: info.height, audio: info.audio,
    totalDuration: plan.timed.totalDuration, subtitles: plan.subtitles, audioBed: plan.audioBed,
    ending: plan.timed.ending || null, composition: plan.composition,
    shots: plan.shots.map(shot => ({ id: shot.id, start: shot.start, end: shot.end, duration: shot.duration,
      video: shot.video, videoHash: shot.videoHash, planDigest: shot.planDigest, checkDigest: shot.checkDigest })),
    previous: previous ? { inputDigest: previous.inputDigest, output: previous.output, hash: previous.hash, preserved } : null,
    pendingUserPlayback: true, reuses: 0 };
  if (previous) state.creative.compositions.push(previous);
  state.creative.composition = record;
  state.timed = plan.timed;
  state.output = output;
  state.stage = 'final';
  state.acceptance = 'awaiting_user_playback';
  delete state.creativeStage?.pause;
  save();
  log('成片已合成：' + output + '（' + info.duration + ' 秒；对白来自已接受的配音，经音频床一次性混音，字幕 ' +
    plan.subtitles.length + ' 条）；等待用户播放验收口型、音色与动作，不自动接受');
  return state;
}
module.exports = { runCreativeStage, authorStage, speechStage, finalStage, recordAcceptance, performanceInstruction, audioBinding, settingStalePause, toneGate };
