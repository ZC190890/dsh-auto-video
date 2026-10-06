const fs = require('node:fs');
const path = require('node:path');
const { fileHash, hash, safeId, withLock, writeJson } = require('../services/aliyun/io');
const { Media } = require('../services/aliyun/media');
const { Models } = require('../services/aliyun/models');
const { UnitAttempts } = require('../services/aliyun/units');
const { Budget, authorization } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { audioLines } = require('./creative');

// The automatic TONE review of the fine creative chain. It answers ONE question: does this recorded performance
// of THIS performance segment meet the goals the director script set for it? It is not a picture check, it is not
// a voice-similarity check and it is not the user's acceptance.
//
// Three things are kept apart on purpose:
//   1) what the model really heard (a transcription plus what it could not make out),
//   2) how the audible performance relates to the stated goals (five criteria, each with its own evidence),
//   3) the business verdict, which is DERIVED locally from those criteria — a model cannot hand itself a "pass"
//      by writing a summary score, and "有感情" never becomes "符合导演要求".
// A transport failure, an unresolved submission or an unparseable answer is an EXECUTION status; it is never
// recorded as one of the model's verdicts.
//
// The review runs per PERFORMANCE SEGMENT (a voice line), never per camera shot: one take that crosses several
// cuts is reviewed once, and it is never re-generated because of a review.
const TONE_PROTOCOL = 'creative-tone-review';
const CRITERIA = ['completeness', 'emotionDirection', 'emotionChange', 'pacing', 'audibility'];
const CRITERION_LABELS = { completeness: '台词完整性', emotionDirection: '情绪方向', emotionChange: '情绪变化',
  pacing: '节奏停顿', audibility: '可听性与表演干扰' };
const STATUSES = ['satisfied', 'violated', 'unclear', 'unsupported'];
// What the criteria mean. Each one is judged against the stated goals only; nothing here defines a fixed number of
// seconds for a pause, a fixed speed, or a single "激昂程度" that could stand in for a judgement.
const CRITERION_STANDARDS = {
  completeness: '是否念到全部台词的逐字内容：漏词、添词、重复、明显错读，或把表演说明念了出来。同音字、标点差异与识别不确定不算漏词或错读。',
  emotionDirection: '语气与情绪方向是否符合本段意图，有无相反表现（例如该克制却喊出来）或明显过度。',
  emotionChange: '本段要求的递进、转折与收束是否在听感上体现出来（例如低声阅读→稍停→逐渐坚定）。',
  pacing: '节奏与停顿是否自然、是否符合语义与表演安排，有无为了赶时长而明显挤压。不要按固定秒数判定。',
  audibility: '可听性与表演干扰：明显断裂、机械重复、不自然呼吸、忽大忽小、底噪或吞字等影响使用的问题。' };
// What the model is free to do inside the goal, so a legitimate performance is never marked down for it.
const FREE_CHOICES = ['音色细节与共鸣位置', '未写明的微停顿与换气位置', '自然范围内的语速波动', '句内标点处的自然短暂停顿'];
const NO_AUTHORITY = '你没有修改状态、批准、计费或重试的权限：只输出JSON内容，不得声称已批准、已通过或已修复，不得输出金额。';
// The execution states. None of them is a model verdict, and none of them silently becomes one.
const EXECUTION = { COMPLETED: 'completed', BLOCKED_TECHNICAL: 'blocked-technical', REQUEST_FAILED: 'request-failed',
  PROTOCOL_ERROR: 'protocol-error', UNRESOLVED_SUBMISSION: 'unresolved-submission', ATTEMPTS_EXHAUSTED: 'attempts-exhausted' };

function toneReviewModelTag(model) { return String(model).replace(/[^a-zA-Z0-9]/g, ''); }
function toneReviewBase(model, lineId) { return 'tone-review-' + toneReviewModelTag(model) + '-' + lineId; }
function protocolVersionOf(context) { return context.config.audioReview?.toneProtocolVersion; }
function promptVersionOf(context) { return context.config.audioReview?.tonePromptVersion; }
function reservationOf(context) {
  const block = context.config.audioReview || {};
  return Number.isSafeInteger(block.toneReservationCents) && block.toneReservationCents > 0
    ? block.toneReservationCents : block.reservationCents;
}
// The performance segment a line belongs to, taken from the CURRENT director script. The review is judged against
// these goals, so they are part of the binding: changing them makes the old conclusion invalid.
function segmentOf(creative, lineId) {
  for (const segment of creative?.directorScript?.segments || [])
    for (const spoken of segment.spoken || [])
      if (spoken.id === lineId) return { segment, spoken };
  return { segment: null, spoken: null };
}
function toneReviewBasis(creative, lineId) {
  const line = (creative?.voicePlan?.lines || []).find(item => item.id === lineId) || null;
  const take = creative?.audio?.[lineId] || null;
  const { segment } = segmentOf(creative, lineId);
  return {
    line: line ? { id: line.id, speaker: line.speaker, kind: line.kind, text: line.text,
      performance: line.performance || null, notSpoken: line.notSpoken || [] } : null,
    segment: segment ? { id: segment.id, purpose: segment.purpose, covers: segment.covers,
      beats: segment.beats, entry: segment.entry, performance: segment.performance,
      space: segment.space, props: segment.props, silence: segment.silence || [],
      endState: segment.endState, nextHandoff: segment.nextHandoff } : null,
    audio: take?.file && fs.existsSync(take.file) ? { file: take.file, hash: fileHash(take.file) } : null };
}
// What a conclusion is bound to: the audio CONTENT, the exact words, the performance goals and their context, the
// review protocol version and the model that really answered. Nothing here is an operation name or a revision
// number, so renaming an operation or bumping a revision cannot make the same input look like a new review.
function toneReviewBinding(context, creative, lineId) {
  return hash({ protocol: TONE_PROTOCOL, protocolVersion: protocolVersionOf(context),
    promptVersion: promptVersionOf(context), model: context.config.audioReview?.model || null,
    basis: toneReviewBasis(creative, lineId) });
}
// The five conclusions, the required goals and the parts that are free. The expected words ARE given (a review of
// completeness is impossible without them), and the instruction says plainly that they must not be copied back as
// the transcription; the record keeps that limitation instead of pretending it was proven.
function toneReviewPrompt(context, creative, lineId) {
  const line = (creative.voicePlan?.lines || []).find(item => item.id === lineId);
  const { segment } = segmentOf(creative, lineId);
  const required = {
    '逐字台词（必须完整念出，不得念表演说明）': line.text,
    ...(line.notSpoken?.length ? { '以下只是表演说明，不要读出来': line.notSpoken } : {}),
    ...(line.performance?.tone ? { '语气方向': line.performance.tone } : {}),
    ...(line.performance?.pauses?.length ? { '要求的停顿（按语义与表演，不按固定秒数）': line.performance.pauses } : {}),
    ...(line.performance?.breath ? { '要求的呼吸': line.performance.breath } : {}),
    ...(line.performance?.silence?.length ? { '要求的留白': line.performance.silence } : {}),
    ...(segment?.purpose ? { '本段叙事目标': segment.purpose } : {}),
    ...(segment?.beats ? { '本段因果（起因-行动-反应-结果）': segment.beats } : {}),
    ...(segment?.entry ? { '本段进入状态与动机': segment.entry } : {}),
    ...(segment?.performance ? { '本段表演安排（语气/停顿/呼吸/视线/表情/姿态）': segment.performance } : {}),
    ...(segment?.silence?.length ? { '本段留白': segment.silence } : {}),
    ...(segment?.endState ? { '本段结束状态': segment.endState } : {}) };
  const shape = '{' + '"lineId":"' + lineId + '",' +
    '"heard":{"transcript":"你实际听到的逐字内容","uncertainWords":["听不清或同音难辨的字"]},' +
    '"criteria":{"completeness":{"status":"satisfied或violated或unclear或unsupported","observed":"实际听到的","basis":"判断依据"},' +
    '"emotionDirection":{"status":"同前","observed":"","basis":"","span":"问题所在的台词片段或表演阶段"},' +
    '"emotionChange":{"status":"同前","observed":"","basis":"","span":""},' +
    '"pacing":{"status":"同前","observed":"","basis":"","span":""},' +
    '"audibility":{"status":"同前","observed":"","basis":""}},' +
    '"problems":[{"criterion":"completeness或emotionDirection或emotionChange或pacing或audibility",' +
    '"span":"具体台词片段或表演阶段（没有可靠定位就不要写时间戳）","observed":"实际听到的","required":"违反的要求原文","basis":"依据"}],' +
    '"suggestions":["具体可执行的修改建议"],"limits":["只凭音频看不出的方面"]}';
  return '你是本片的配音表演审核模型。审核对象是下面这一段实际生成的配音（见附件音频），不是文字稿。' + NO_AUTHORITY +
    '先独立听写：heard.transcript 只写你真正听到的字，不要照抄给出的台词当作听辨结果；听不清或同音难辨的字写入 ' +
    'heard.uncertainWords 并把相关判断记为 unclear，不要猜。同音字、标点差异与识别不确定不等于漏词或错读。' +
    '不得用“有感情/激昂”这类笼统评价、统一语速或综合评分代替逐项判断；五项必须分别给出结论与依据，不要输出总分。' +
    '只凭音频无法判断的方面（眼神、抬头、服饰动作、画面口型等）不要作为结论，写入 limits。' +
    '没有可靠定位能力就不要输出精确时间戳，用台词片段或表演阶段说明位置。' +
    '判断标准：' + JSON.stringify(CRITERION_STANDARDS) + '。' +
    '必须满足的要求与允许自由发挥的部分（自由发挥不得被当成问题）：' +
    JSON.stringify({ 必须满足: required, 允许自由发挥: FREE_CHOICES }) + '。' +
    '本段编号 ' + lineId + '，说话人 ' + line.speaker + '，类型 ' + line.kind + '。' +
    '仅输出JSON：' + shape + '。要求：每项 status 只能取 satisfied、violated、unclear、unsupported；' +
    '任何 violated 必须有对应的 problems 条目（写清 criterion、位置 span、实际听到的 observed、违反的要求 required 与依据 basis）；' +
    '证据不足写 unclear 并说明缺什么；本模型或本配置无法完成该项分析时写 unsupported 并说明原因（不要编造内容冒充判断）。';
}
// The business verdict comes from the five conclusions, never from a summary the model writes: one violated
// criterion is a failure, an unsupported criterion means the ability is missing, and an unclear criterion means the
// evidence is not there. `pass` therefore means "every criterion was really satisfied", nothing weaker.
function toneVerdict(criteria) {
  const values = CRITERIA.map(name => criteria?.[name]?.status);
  if (values.includes('violated')) return 'fail';
  if (values.includes('unsupported')) return 'unsupported';
  if (values.includes('unclear')) return 'undetermined';
  return 'pass';
}
function reportMissingCriteria(report) {
  return CRITERIA.filter(name => !STATUSES.includes(report.criteria?.[name]?.status));
}
// A failure must be explainable: every violated criterion needs its own problem entry with observed + required +
// basis. A "fail" without evidence is refused as a protocol error instead of being recorded as a judgement.
function toneEvidenceProblems(report) {
  const missing = [];
  for (const name of CRITERIA) {
    if (report.criteria?.[name]?.status !== 'violated') continue;
    const problems = (report.problems || []).filter(problem => problem.criterion === name);
    if (!problems.some(problem => problem.observed && problem.basis) || !problems.some(problem => problem.required))
      missing.push(name);
  }
  return missing;
}
// A conclusion must carry the evidence it was drawn from, whichever way it went. The protocol already asks for
// `observed` (what was really heard) and `basis` (what that observation rests on) on EVERY criterion, so this check
// is the protocol being enforced rather than an extra demand:
//   - `basis` is required for every status: a conclusion nobody can trace back to a reason is not a judgement;
//   - `observed` is required for the two statuses that make a factual claim about the hearing (satisfied and
//     violated) — "符合要求" written without anything heard is exactly the silent pass this review must not record,
//     and a violation without anything heard is equally unverifiable;
//   - `unclear` and `unsupported` may leave `observed` empty (there may be nothing to report), but they must still
//     say why in `basis`.
function reportMissingBasis(report) {
  return CRITERIA.filter(name => {
    const entry = report.criteria?.[name];
    // An entirely absent criterion is reportMissingCriteria's case, not this one.
    if (!entry) return false;
    if (!String(entry.basis || '').trim()) return true;
    if (entry.status === 'unclear' || entry.status === 'unsupported') return false;
    return !String(entry.observed || '').trim();
  });
}
// A conclusion may not contradict its own hearing. When the same answer declares a word impossible to make out
// (heard.uncertainWords, and that word is NOT in its own transcript) and then uses that word as the evidence of a
// violation, the failure rests on something the model itself said it could not hear — the protocol tells it to record
// those as unclear and not to guess, so this is a protocol error rather than a judgement: it is never recorded as a
// fail and never becomes a reason to re-record. The quoted requirement (problems[].required) is deliberately NOT
// searched: it repeats the expected words by definition, so matching there would prove nothing. Nothing is compared
// against a fixed expected string either, and a criterion that is satisfied, unclear or unsupported is untouched:
// a plainly spoken, even segment stays legitimate.
function toneEvidenceContradiction(report) {
  const heard = report.heard || {};
  const transcript = String(heard.transcript || '');
  const unhearable = (heard.uncertainWords || []).map(word => String(word).trim())
    .filter(word => word && !transcript.includes(word));
  if (!unhearable.length) return null;
  const found = [];
  for (const name of CRITERIA) {
    if (report.criteria?.[name]?.status !== 'violated') continue;
    const evidence = (report.problems || []).filter(problem => problem.criterion === name)
      .map(problem => [problem.span, problem.observed, problem.basis].filter(Boolean).join(' ')).join(' ');
    const word = evidence ? unhearable.find(item => evidence.includes(item)) : null;
    if (word) found.push({ criterion: name, word });
  }
  return found.length ? found : null;
}
// A transport/execution failure is classified, never dressed up as a model conclusion.
function classifyToneError(error) {
  const message = String(error?.message || error);
  if (/SUBMISSION_UNCERTAIN|OPERATION_REQUIRES_RECONCILIATION|SUBMISSION_CLAIM_HELD|BUSY_OR_STALE_LOCK/.test(message))
    return { status: EXECUTION.UNRESOLVED_SUBMISSION, resend: 'forbidden',
      note: '已有提交痕迹或占用：不得换号重发，先按原操作号核实' };
  if (/CHECK_ATTEMPTS_EXHAUSTED/.test(message))
    return { status: EXECUTION.ATTEMPTS_EXHAUSTED, resend: 'forbidden',
      note: '同一有效输入已用完首次请求与受控重试上限，需人工决定是否改变输入' };
  if (/TONE_REVIEW_INVALID_JSON|TONE_REVIEW_SHAPE_INVALID/.test(message))
    return { status: EXECUTION.PROTOCOL_ERROR, resend: 'same-input-is-reused',
      note: '回答无法按协议解析：结论不作数，也未记成模型判断' };
  if (/ONLINE_DISABLED|API_AUTHORIZATION/.test(message))
    return { status: EXECUTION.REQUEST_FAILED, resend: 'after-authorization', note: '未获授权，请求未发出' };
  return { status: EXECUTION.REQUEST_FAILED, resend: 'bounded-by-check-budget', note: '请求失败，未得到可用结论' };
}
// The local technical check runs BEFORE any model call: an unusable file is never sent for a listening judgement,
// and it can never be accepted afterwards by confirming the tone by hand.
function technicalCheck(media, file) {
  try {
    const report = media.audio(file);
    if (!Number.isFinite(report?.duration) || report.duration <= 0) throw new Error('AUDIO_DURATION_INVALID');
    return { ok: true, detail: { duration: report.duration, sampleRate: report.sampleRate, channels: report.channels,
      rmsDb: report.quality?.rmsDb ?? null, peak: report.quality?.peak ?? null,
      clippedFraction: report.quality?.clippedFraction ?? null, warnings: report.quality?.warnings || [] } };
  } catch (error) {
    return { ok: false, blocked: 'TONE_REVIEW_AUDIO_INVALID:' + String(error?.message || error),
      detail: { basis: '本地解码测量：无法读取或不满足基本技术条件，未向模型发送该音频' } };
  }
}
function toneRecordPath(context, lineId) { return path.join(context.directory, 'tone-review', lineId + '.json'); }
// The review that is CURRENT for this exact input. Anything bound to different audio, different words or different
// goals is stale and must be taken again; the superseded record is preserved as history when it is replaced.
function currentToneReview(context, creative, lineId) {
  const record = creative.toneReviews?.[lineId];
  if (!record?.binding) return null;
  return record.binding === toneReviewBinding(context, creative, lineId) ? record : null;
}
// Whether this input may be sent again. A conclusion that exists for the same input is reused (zero requests); an
// unresolved submission is never re-sent; a local failure or an unparseable answer may be tried again, and the
// shared check ledger still caps how often the same effective input can be paid for.
function toneReviewRetryable(context, creative, lineId) {
  const record = currentToneReview(context, creative, lineId);
  if (!record) return true;
  if ([EXECUTION.COMPLETED, EXECUTION.BLOCKED_TECHNICAL, EXECUTION.UNRESOLVED_SUBMISSION]
    .includes(record.execution?.status)) return false;
  return true;
}
// A human decision that is CURRENT for this exact input. The operator overruled a model conclusion once, with a
// reason, and that decision stands: every later run of this same input honours it (the run continues past the
// segment without asking for the reason again and without paying for a review the operator has already decided on),
// while a changed take, changed words or changed goals make it stale like any other conclusion — a new input needs a
// new review and a new decision. Without a reason nothing is overruled, so a half-written override never lets a
// segment through.
function currentHumanToneDecision(context, creative, lineId) {
  const record = currentToneReview(context, creative, lineId);
  if (!record || record.execution?.status !== EXECUTION.COMPLETED ||
      !['fail', 'undetermined', 'unsupported'].includes(record.verdict) ||
      record.reviewStatus !== 'overridden-by-user') return null;
  const reason = String(record.humanDecision?.reason || '').trim();
  if (!reason) return null;
  return record.humanDecision;
}
// ONE performance segment, reviewed once. The technical check runs locally first; a conclusion for this exact
// input (or one that must not be re-sent) is reused instead of being paid for again.
async function analyzeLineTone(context, { creative, lineId, models, media, log = () => {} }) {
  safeId(lineId);
  const line = (creative.voicePlan?.lines || []).find(item => item.id === lineId);
  if (!line) throw new Error('TONE_REVIEW_UNKNOWN_LINE:' + lineId);
  const take = creative.audio?.[lineId];
  if (!take?.file || !fs.existsSync(take.file)) throw new Error('TONE_REVIEW_AUDIO_MISSING:' + lineId);
  const model = context.config.audioReview?.model;
  const base = toneReviewBase(model, lineId);
  const binding = toneReviewBinding(context, creative, lineId);
  // The operation number is derived from WHAT is reviewed (the binding), never from a counter: the same input always
  // lands on the same record (reuse, never a second payment), a genuinely different input gets its own record, and no
  // revision number or rename can manufacture a fresh review budget for the same input. The shared check ledger still
  // caps how often one effective input can be paid for.
  const operation = base + '-' + binding.slice(0, 12);
  const previous = creative.toneReviews?.[lineId] || null;
  const technical = technicalCheck(media, take.file);
  if (technical.ok && !toneReviewRetryable(context, creative, lineId))
    return { ...currentToneReview(context, creative, lineId), reused: true };
  const finish = record => {
    creative.toneReviews ||= {};
    if (previous && previous.binding !== binding)
      (creative.toneReviewHistory ||= []).push({ lineId, at: new Date().toISOString(),
        reason: '输入已变化：旧语气结论不再适用于本次音频、台词或表演目标', review: previous });
    creative.toneReviews[lineId] = record;
    // The take carries its own review state, so the acceptance gate sees what the automatic judgement said without
    // reading a second structure.
    creative.audio[lineId] = { ...take, toneReview: { protocol: TONE_PROTOCOL,
      protocolVersion: protocolVersionOf(context), promptVersion: promptVersionOf(context), model, operation,
      status: record.verdict || null, execution: record.execution.status, binding, at: record.at,
      requires: record.execution.status === EXECUTION.COMPLETED
        ? '人工试听确认（accept-creative-audio）；模型结论不代替用户验收'
        : '按执行状态处理：未决提交先核实，未得到结论不得当成通过' } };
    writeJson(toneRecordPath(context, lineId), record);
    return record;
  };
  const header = { lineId, operation, model, protocol: TONE_PROTOCOL, protocolVersion: protocolVersionOf(context),
    promptVersion: promptVersionOf(context), binding, at: new Date().toISOString(),
    objective: toneReviewBasis(creative, lineId),
    input: { file: take.file, hash: fileHash(take.file), source: 'generated-take',
      instruction: take.instruction || null, performance: line.performance || null,
      speaker: line.speaker, kind: line.kind } };
  const noConclusion = (extra, execution, limits, notProven) => finish({ ...header, ...extra,
    verdict: null, criteria: null, problems: [], suggestions: [], usage: null, execution, limits,
    reviewStatus: 'no-conclusion', notProven });
  if (!technical.ok) {
    log('语气审核前技术检查未通过：' + lineId);
    return finish({ ...header, technical: technical.detail, verdict: null, criteria: null, problems: [],
      suggestions: [], usage: null, limits: ['未做模型听感判断：音频未通过本地技术检查'],
      execution: { status: EXECUTION.BLOCKED_TECHNICAL, request: null, detail: technical.blocked },
      reviewStatus: 'not-reviewed', notProven: ['音频未通过本地技术检查，未提交任何分析请求'] });
  }
  let answer;
  try {
    answer = await models.audioToneReview(operation, { lineId, audio: take.file, audioHash: fileHash(take.file),
      expectedTextHash: hash(line.text), basisDigest: binding, prompt: toneReviewPrompt(context, creative, lineId),
      reservationCents: reservationOf(context) });
  } catch (error) {
    const classified = classifyToneError(error);
    log('语气审核未得到结论：' + lineId + '（' + classified.status + '）');
    return noConclusion({ technical: technical.detail },
      { status: classified.status, request: operation, resend: classified.resend,
        error: { code: String(error?.message || error).slice(0, 300) }, note: classified.note },
      ['本次未得到模型结论'], ['执行状态不是模型结论，不得当作通过或失败']);
  }
  const report = answer.report;
  const missing = reportMissingCriteria(report);
  if (missing.length)
    return noConclusion({ technical: technical.detail, heard: report.heard || null, criteria: report.criteria || null,
      problems: report.problems || [], suggestions: report.suggestions || [], limits: report.limits || [],
      usage: answer.usage || null },
    { status: EXECUTION.PROTOCOL_ERROR, request: operation, resend: 'same-input-is-reused',
      error: { code: 'TONE_REVIEW_MISSING_CRITERIA', detail: missing.join(',') },
      note: '五项结论不完整：不作数，也不当成模型判断' },
    report.limits || [], ['缺少 ' + missing.join('、') + ' 的结论，未形成判断']);
  const unjustified = toneEvidenceProblems(report);
  if (unjustified.length)
    return noConclusion({ technical: technical.detail, heard: report.heard || null, criteria: report.criteria,
      problems: report.problems || [], suggestions: report.suggestions || [], limits: report.limits || [],
      usage: answer.usage || null },
    { status: EXECUTION.PROTOCOL_ERROR, request: operation, resend: 'same-input-is-reused',
      error: { code: 'TONE_REVIEW_EVIDENCE_MISSING', detail: unjustified.join(',') },
      note: '判为不通过的项缺少具体问题与依据：不记成模型结论' },
    report.limits || [], ['以下项缺少可说明的问题与依据：' + unjustified.join('、')]);
  // A status without its own evidence is not a conclusion at all, in either direction: a pass drawn from nothing
  // heard and a fail drawn from nothing heard are equally unverifiable, so both are reported as protocol errors
  // instead of being recorded. Nothing here compares the answer against a fixed expected string. The refused
  // statuses are deliberately NOT copied into the record (a no-conclusion record carries no criteria): the raw answer
  // stays recoverable from the operation record, where it cannot be mistaken for a judgement.
  const baseless = reportMissingBasis(report);
  if (baseless.length)
    return noConclusion({ technical: technical.detail, heard: report.heard || null },
    { status: EXECUTION.PROTOCOL_ERROR, request: operation, resend: 'same-input-is-reused',
      error: { code: 'TONE_REVIEW_BASIS_MISSING', detail: baseless.join(',') },
      note: '结论项缺少实际听感（observed）或依据（basis）：不作数，也不当成模型判断' },
    [...(report.limits || []), '以下项写出了结论却没有实际听感与依据，未作数：' + baseless.join('、')],
    ['执行状态不是模型结论：既不是通过也不是失败，也不据此要求重录']);
  // The answer may not fail a word on the strength of its own admission that the word could not be made out.
  const contradicted = toneEvidenceContradiction(report);
  if (contradicted)
    return noConclusion({ technical: technical.detail, heard: report.heard || null },
    { status: EXECUTION.PROTOCOL_ERROR, request: operation, resend: 'same-input-is-reused',
      error: { code: 'TONE_REVIEW_EVIDENCE_CONTRADICTION',
        detail: contradicted.map(item => item.criterion + '=' + item.word).join(',') },
      note: '判为不通过的依据来自本答复自己列为听不清的词：不作数，也不据此要求重录' },
    [...(report.limits || []), '结论与听感自相矛盾，未作数：' +
      contradicted.map(item => item.criterion + '（' + item.word + '）').join('、')],
    ['执行状态不是模型结论：既不是通过也不是失败，也不据此要求重录']);
  const verdict = toneVerdict(report.criteria);
  log('语气审核完成：' + lineId + '（' + verdict + '）');
  return finish({ ...header, technical: technical.detail, heard: report.heard, criteria: report.criteria,
    problems: report.problems || [], suggestions: report.suggestions || [], limits: report.limits || [],
    verdict, usage: answer.usage || null, execution: { status: EXECUTION.COMPLETED, request: operation },
    reviewStatus: 'awaiting-user-acceptance',
    basisNote: '判断只依据音频：眼神、抬头、服饰动作与画面口型不在本结论范围内',
    notProven: ['逐字听辨无法证明完全不受给出的台词影响；文字正确性仍需人工按实听复核'] });
}
// One pause code per state, so a caller can tell "the model said no" apart from "there is no conclusion yet" and
// from "the audio itself could not be used". Automatic advance stops in every one of these cases.
function tonePause(record) {
  const status = record.execution?.status;
  if (status === EXECUTION.BLOCKED_TECHNICAL)
    return { code: 'CREATIVE_TONE_AUDIO_INVALID', detail: record.execution.detail };
  if (status === EXECUTION.UNRESOLVED_SUBMISSION)
    return { code: 'CREATIVE_TONE_REVIEW_UNRESOLVED', detail: record.execution.note };
  if (status === EXECUTION.ATTEMPTS_EXHAUSTED)
    return { code: 'CREATIVE_TONE_REVIEW_ATTEMPTS_EXHAUSTED', detail: record.execution.note };
  if (status === EXECUTION.PROTOCOL_ERROR)
    return { code: 'CREATIVE_TONE_REVIEW_PROTOCOL_ERROR', detail: JSON.stringify(record.execution.error) };
  if (status === EXECUTION.REQUEST_FAILED)
    return { code: 'CREATIVE_TONE_REVIEW_REQUEST_FAILED', detail: JSON.stringify(record.execution.error) };
  if (record.verdict === 'unsupported')
    return { code: 'CREATIVE_TONE_REVIEW_UNSUPPORTED', detail: '模型或配置无法完成部分判断，未自动重配' };
  if (record.verdict === 'undetermined')
    return { code: 'CREATIVE_TONE_REVIEW_UNDETERMINED', detail: '证据不足或听辨不清，未自动重配' };
  return { code: 'CREATIVE_TONE_REVIEW_FAILED', detail: (record.problems || [])
    .map(problem => (CRITERION_LABELS[problem.criterion] || problem.criterion) + '：' + (problem.observed || ''))
    .join('；') };
}
function pauseTone(state, record) {
  const { code, detail } = tonePause(record);
  state.creativeStage ||= {};
  state.creativeStage.pause = { code, detail, stage: state.stage, lineId: record.lineId,
    execution: record.execution?.status || null, verdict: record.verdict || null,
    suggestions: record.suggestions || [], at: new Date().toISOString() };
  delete state.creativeStage.resumedAt;
  return state.creativeStage.pause;
}
function toneSummary(context, reviews, requests, humanDecisions = {}) {
  const decidedLines = Object.keys(humanDecisions).sort();
  return { model: context.config.audioReview?.model, protocol: TONE_PROTOCOL,
    protocolVersion: protocolVersionOf(context), promptVersion: promptVersionOf(context),
    lines: reviews.map(record => record.lineId), requests,
    verdicts: Object.fromEntries(reviews.map(record => [record.lineId, record.verdict || null])),
    execution: Object.fromEntries(reviews.map(record => [record.lineId, record.execution?.status || null])),
    // A human decision is not a model verdict. It is named here, on its own, so a reader of the summary can see
    // which segments went on because the operator decided them — and that the model's conclusion is still what it
    // was, not silently rewritten into a pass.
    humanDecisions,
    humanDecisionLines: decidedLines,
    humanDecisionNote: decidedLines.length
      ? '这些段落按人工语气决定继续：模型结论未被改写，也未被当成通过' : null,
    at: new Date().toISOString(),
    limitation: '辅助模型听感判断，不是用户验收；只看音频，不能证明眼神/服饰动作/画面口型；不构成配音合格' };
}
// The automatic stage: local technical check → model review → STOP whenever the conclusion is not a pass. It runs
// for every line that HAS audio, which is why a resumed run whose audio already exists still reviews it: the
// generation skip must never turn into a review skip.
async function toneReviewStage(context, state, { models, media, log = () => {}, save = () => {} }) {
  const creative = state.creative;
  if (!creative?.voicePlan) throw new Error('TONE_REVIEW_REQUIRES_VOICE_PLAN');
  const targets = audioLines(creative).filter(line => creative.audio?.[line.id]?.file);
  if (!targets.length) return { reviewed: [], requests: 0, blocked: null };
  const reviews = [];
  const human = {};
  let requests = 0, blocked = null;
  for (const line of targets) {
    // A human decision recorded for this same input stands here exactly as it does at the acceptance gate: the run
    // continues past this segment, the model's own conclusion stays where it is, and no request is sent to
    // "confirm" a decision the operator has already taken (which would also be a second payment for it).
    const current = currentToneReview(context, creative, line.id);
    const reuse = technicalCheck(media, creative.audio[line.id].file).ok && current &&
      !toneReviewRetryable(context, creative, line.id);
    const record = reuse ? { ...current, reused: true }
      : await analyzeLineTone(context, { creative, lineId: line.id, models, media, log });
    // A fresh technical failure supersedes the earlier decision before it can permit continuation.
    const decision = record.execution?.status === EXECUTION.COMPLETED
      ? currentHumanToneDecision(context, creative, line.id) : null;
    if (decision) human[line.id] = decision;
    if (!record.reused) requests += 1;
    reviews.push(record);
    // A pass keeps flowing; anything else (a failure, an unclear hearing, a missing ability, or an execution
    // problem) stops the automatic advance and keeps the evidence with its suggestions. A segment the operator has
    // already decided is not a blocker any more — it is reported as decided, not as passed.
    if (!blocked && !decision && !(record.execution?.status === EXECUTION.COMPLETED && record.verdict === 'pass'))
      blocked = record;
  }
  creative.toneReviewSummary = toneSummary(context, reviews, requests, human);
  if (blocked) pauseTone(state, blocked);
  else {
    // Nothing blocks this run. A TONE pause may still be on record from an earlier run, and it is lifted here, once,
    // with the reason it no longer holds. Only two reasons are accepted, and each is stated as itself:
    //   - the operator took a standing decision for that very line (the acceptance flow clears the pause when it
    //     records the decision, so this also covers a state that still carries both);
    //   - that line now has a passing conclusion of its own (its audio or its words changed and it was reviewed again).
    // The model's conclusion is untouched, the old pause stays readable in `resumedBy`, no review is re-sent, and a
    // pause that still holds is left exactly where it is.
    const pause = state.creativeStage?.pause;
    const decision = pause ? human[pause.lineId] || null : null;
    const current = pause ? reviews.find(record => record.lineId === pause.lineId) || null : null;
    const passed = current?.execution?.status === EXECUTION.COMPLETED && current.verdict === 'pass';
    if (pause && String(pause.code || '').startsWith('CREATIVE_TONE_') && (decision || passed)) {
      state.creativeStage.resumedAt = new Date().toISOString();
      state.creativeStage.resumedBy = { lineId: pause.lineId, code: pause.code, verdict: pause.verdict || null,
        execution: pause.execution || null, humanDecision: decision || null, currentVerdict: current?.verdict || null,
        note: decision ? '人工语气决定已记录，本轮继续；模型结论原样保留，未重发审核请求'
          : '该暂停不再成立：这一段在本轮已有通过的结论（输入变化后重新判断），本轮继续；旧暂停原样保留在此' };
      delete state.creativeStage.pause;
    }
  }
  save();
  return { reviewed: reviews, requests, blocked, human };
}
// The manual entry (node index.js tone-review <清单> [lineId...]): authorization, the shared operations layer, the
// shared check budget and the same "never resend an unresolved submission" rule. It cannot introduce a review state
// the automatic stage could not produce, and it never writes an acceptance.
async function runToneReviews(context, lineIds = [], { client: injectedClient, log = console.log } = {}) {
  // Load after module initialization: production -> creative-stage -> tone-review is otherwise cyclic.
  const { loadState, saveState, providerClient } = require('./production');
  const requested = (lineIds || []).map(id => safeId(id));
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    const creative = state.creative;
    if (!creative?.voicePlan) throw new Error('TONE_REVIEW_REQUIRES_VOICE_PLAN');
    authorization(context.root, context.config, context.production.id); // before credentials or any request
    const known = audioLines(creative).map(line => line.id);
    for (const id of requested) if (!known.includes(id)) throw new Error('TONE_REVIEW_UNKNOWN_LINE:' + id);
    const media = new Media(context.root, context.project);
    const budget = new Budget(context.root, context.config, context.directory);
    const client = providerClient(context.root, injectedClient);
    const attempts = new UnitAttempts(context.directory);
    const ops = new Operations(path.join(context.directory, 'operations'), client, budget, log,
      context.config.pollIntervalSeconds, context.config.pollTimeoutSeconds, attempts);
    const models = new Models(context.config, ops, media, path.join(context.directory, 'vision-cache'));
    const targets = (requested.length ? requested : known).filter(id => creative.audio?.[id]?.file);
    const reviews = [];
    const human = {};
    for (const id of targets) {
      // The manual entry reports a standing human decision as such, exactly like the automatic stage does: it never
      // turns it into a pass, and it never re-sends a review this same input already has.
      const record = await analyzeLineTone(context, { creative, lineId: id, models, media, log });
      const decision = record.execution?.status === EXECUTION.COMPLETED
        ? currentHumanToneDecision(context, creative, id) : null;
      if (decision) human[id] = decision;
      reviews.push(record);
    }
    const sent = reviews.filter(record => !record.reused).length;
    creative.toneReviewSummary = toneSummary(context, reviews, sent, human);
    saveState(context, state);
    return { model: context.config.audioReview?.model, protocol: TONE_PROTOCOL,
      lines: reviews.map(record => record.lineId), requests: sent, humanDecisions: human,
      verdicts: Object.fromEntries(reviews.map(record => [record.lineId, record.verdict || null])),
      execution: Object.fromEntries(reviews.map(record => [record.lineId, record.execution.status])) };
  });
}
module.exports = { CRITERIA, CRITERION_LABELS, CRITERION_STANDARDS, EXECUTION, FREE_CHOICES, STATUSES, TONE_PROTOCOL,
  analyzeLineTone, classifyToneError, currentHumanToneDecision, currentToneReview, pauseTone, reportMissingBasis,
  reportMissingCriteria, runToneReviews, segmentOf, technicalCheck, toneEvidenceContradiction, toneEvidenceProblems,
  tonePause, toneRecordPath, toneReviewBase, toneReviewBasis, toneReviewBinding, toneReviewModelTag, toneReviewPrompt,
  toneReviewRetryable, toneReviewStage, toneSummary, toneVerdict };
