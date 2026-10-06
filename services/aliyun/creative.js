const fs = require('node:fs');
const { fileHash, hash, safeId } = require('./io');

// The creative package is the authored part of a production: what the user requires, the director script,
// the character and scene bibles, the voice plan and (only after the audio is accepted) the final
// storyboard. This module owns the STRUCTURE and the deterministic rules; the planner model authors the
// words. Nothing here invents content: a missing field is an explicit failure, never a default.
const CREATIVE_VERSION = 1;
const MUST_KINDS = ['line', 'character', 'event', 'action', 'ending'];
const SPEAK_KINDS = ['dialogue', 'narration', 'inner'];
// Where a statement comes from. `fixture` is part of the vocabulary on purpose instead of being folded into
// `creative`: an offline fixture is neither the user's material nor a real fact, so it stays visible as
// itself and can never become a real task's default appearance.
const SOURCES = ['user', 'reference', 'verified', 'creative', 'fixture'];
// What has actually been confirmed about a statement. This is a SEPARATE axis from the source: a reference
// file proves that a material was handed over, not that its content was looked at, and a user-supplied
// material does not mean that every detail inside it has been confirmed.
const CLAIM_STATUSES = ['provided', 'analyzed', 'unverified', 'creative'];
// The evidence kinds a LOCAL check can insist on before a statement may call itself verified. A model cannot
// simply declare that something has been verified.
const VERIFICATION_KINDS = ['manifest-declaration', 'user-confirmation', 'local-measurement'];
// How a朗读 duration may be estimated before any audio exists, and what a recorded conflict may rest on.
const ESTIMATE_METHODS = ['character-rate', 'reading-aloud-rate', 'model-reading'];
const CONFLICT_BASES = ['measured', 'user-decision', 'hard-limit', 'estimate', 'unknown'];
const COVERAGE = ['fit', 'extra', 'trim', 'direct'];
// Cutting semantics. A cut is never judged by comparing free wording: each kind says what may change.
// continuous = the same action carries on; reframe = same place, different camera or framing;
// time = an allowed jump in time (needs a reason); scene = the place changes.
const TRANSITIONS = ['continuous', 'reframe', 'time', 'scene'];
// Markers that suggest one frame description holds several moments. Deterministic, and only used together
// with the structured single-moment rules below; the model still owns the semantic judgement.
const MULTI_MOMENT_MARKERS = ['然后', '接着', '随后', '最后', '继而', '随即'];

function fail(code, detail) { throw new Error(code + (detail ? ':' + detail : '')); }
function text(value, code, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code);
  return value.trim();
}
function optionalText(value, code, max = 2000) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, code, max);
}
function list(value, code, { min = 0, max = 40 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some(item => typeof item !== 'string' || !item.trim()))
    fail(code);
  return value.map(item => item.trim());
}
function objects(value, code, { min = 0, max = 60 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some(item => !item || typeof item !== 'object' || Array.isArray(item)))
    fail(code);
  return value;
}
function idList(value, code, { min = 0, max = 12 } = {}) {
  const ids = list(value, code, { min, max });
  for (const id of ids) safeId(id);
  if (new Set(ids).size !== ids.length) fail(code + '_DUPLICATE');
  return ids;
}
function seconds(value, code, { min = 0, max = 600 } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) fail(code);
  return Number(value);
}
// ---------------------------------------------------------------- provenance
// Every statement that reaches a prompt carries two separate things: WHERE it came from (user / reference /
// verified / creative / fixture) and WHAT has actually been confirmed about it (provided / analyzed /
// unverified / creative). They are checked here, before any prompt is assembled, so a claim that a local
// check cannot support never travels as if it had been established.
function citationIds(references) {
  return (references || []).map(item => (typeof item === 'string' ? item : item?.id ?? item?.ref ?? '')).filter(Boolean);
}
// The manifest fields of one registered character that a `verified` claim may cite: what the manifest really
// declares is the only local evidence available for an appearance detail.
function manifestCitations(production, characterId) {
  const character = (production?.characters || []).find(item => item.id === characterId) || null;
  if (!character) return [];
  const out = Object.entries(character)
    .filter(([key, value]) => !['id', 'name'].includes(key) && value !== null && value !== undefined && value !== '')
    .map(([key]) => characterId + '.' + key);
  // A declared coverage entry is the manifest's own statement about what a material has been confirmed to
  // cover, so it is citable evidence as well.
  for (const key of Object.keys(character.referenceCoverage || {})) out.push(characterId + '.referenceCoverage.' + key);
  return out;
}
function sourceLabel(claim) {
  const refs = claim?.refs?.length ? '（素材：' + claim.refs.join('、') + '）' : '';
  if (!claim || claim.sourceAssumed) return '来源未声明（按创作补充处理，不得当成用户指定或历史事实）';
  if (claim.source === 'user') return '用户指定（用户提供的素材不等于其中每个细节都已确认）';
  if (claim.source === 'reference') return '参考素材' + refs + '（关联素材；' + (claim.status === 'analyzed'
    ? '已分析：' + (claim.analyzedRefs || []).join('、') : '其中的内容未逐项确认，只作保守保留') + '）';
  if (claim.source === 'verified') return '已核实（依据：' + (claim.verifiedBy
    ? claim.verifiedBy.kind + ':' + claim.verifiedBy.ref + '，' + claim.verifiedBy.detail : '未记录依据') + '）';
  if (claim.source === 'fixture') return '离线夹具（不代表用户素材，也不代表真实事实，不得用作真实任务默认值）';
  return '创作补充（为叙事与画面提出，不是用户指定，也不是历史事实）';
}
function provenanceClaim(entry, { code, where = '', allowFixture = false, references = null, refs = null,
  refCode = null, refsRequired = false } = {}) {
  const suffix = where ? ':' + where : '';
  const raw = entry?.source === undefined || entry?.source === null || entry?.source === '' ? null : entry.source;
  if (raw !== null && !SOURCES.includes(raw)) fail(code + '_SOURCE' + suffix, String(raw));
  const source = raw === null ? 'creative' : raw;
  const status = CLAIM_STATUSES.includes(entry?.status) ? entry.status : 'unverified';
  const material = refs || list(entry?.refs || [], (refCode || code + '_REFS') + suffix, { max: 6 });
  const analyzedRefs = list(entry?.analyzedRefs || [], code + '_ANALYZED_REFS' + suffix, { max: 6 });
  if (source === 'fixture' && !allowFixture) fail(code + '_FIXTURE_IN_REAL_TASK' + suffix,
    '夹具设定只能用于显式声明 creativeFixture 的离线任务，不得当作真实任务的默认外观');
  if (source === 'reference' && refsRequired && !material.length) fail(code + '_REFERENCE_WITHOUT_MATERIAL' + suffix);
  // A reference file proves a material exists. Claiming that it was analysed needs the named material the
  // analysis actually covered, so "有参考文件" can never be written up as "已确认".
  if (status === 'analyzed') {
    if (source !== 'reference') fail(code + '_ANALYZED_WITHOUT_REFERENCE' + suffix, source);
    if (!analyzedRefs.length) fail(code + '_ANALYZED_UNPROVEN' + suffix, '有参考文件不等于看过图片；请列出实际分析过的素材，或把状态改为未分析');
    for (const ref of analyzedRefs) if (!material.includes(ref)) fail(code + '_ANALYZED_UNKNOWN_REF' + suffix, ref);
  } else if (analyzedRefs.length) fail(code + '_ANALYZED_REFS_CONTRADICT_STATUS' + suffix, status);
  let verifiedBy = null;
  if (source === 'verified') {
    const evidence = entry?.verifiedBy;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !VERIFICATION_KINDS.includes(evidence.kind))
      fail(code + '_VERIFIED_UNSUPPORTED' + suffix, 'verified 必须有本地可核对的依据，不能由模型自行宣称');
    const detail = text(evidence.detail, code + '_VERIFIED_DETAIL' + suffix, 400);
    if (evidence.kind === 'local-measurement') {
      if (typeof evidence.ref !== 'string' || !evidence.ref.trim() || !fs.existsSync(evidence.ref))
        fail(code + '_VERIFIED_LOCAL_EVIDENCE_MISSING' + suffix, String(evidence.ref));
    } else if (!citationIds(references).includes(evidence.ref))
      fail(code + '_VERIFIED_UNDECLARED' + suffix, String(evidence.ref));
    verifiedBy = { kind: evidence.kind, ref: text(evidence.ref, code + '_VERIFIED_REF' + suffix, 300), detail };
  }
  return { source, sourceAssumed: raw === null, status, refs: material, analyzedRefs, verifiedBy };
}
// ---------------------------------------------------------------- duration basis
// A hard limit, an estimate and a measurement are three different things and never stand in for each other:
// only a hard limit may stop a plan, only a measurement may approve one, and an estimate may do neither. An
// estimate therefore carries its own basis and its own uncertainty instead of looking like a fact.
function durationEstimate(value, code) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(code + '_SHAPE');
  if (!ESTIMATE_METHODS.includes(value.method)) fail(code + '_METHOD', String(value.method));
  return { method: value.method, seconds: planSeconds(value.seconds, code + '_SECONDS', { min: 0.1, max: 600 }),
    uncertaintySeconds: planSeconds(value.uncertaintySeconds, code + '_UNCERTAINTY', { min: 0, max: 600 }),
    rate: Number.isFinite(value.rate) ? planSeconds(value.rate, code + '_RATE', { min: 0.5, max: 30 }) : null,
    characters: Number.isInteger(value.characters) && value.characters > 0 ? value.characters : null,
    basis: text(value.basis, code + '_BASIS', 400), measured: false,
    note: '估计值：只用于提前发现风险，不作为删词、改词、加速、冲突判定或验收的依据' };
}
// The three-class ledger of one production's running time. `gating` says whether an entry may stop the flow: a
// MEASUREMENT beyond the hard limit does and then waits for an explicit decision; an estimate never does.
function durationLedger(creative, { maxSeconds = null, targetSeconds = null } = {}) {
  const lines = (creative?.voicePlan?.lines || []).map(line => {
    const record = creative?.audio?.[line.id] || null;
    const estimate = line.durationEstimate || record?.estimate || null;
    if (record && Number.isFinite(record.duration) && record.duration > 0)
      return { id: line.id, basis: 'measured', seconds: Number(record.duration), measuredBy: record.measuredBy || null,
        estimateSeconds: estimate?.seconds ?? null, estimateUncertaintySeconds: estimate?.uncertaintySeconds ?? null };
    if (estimate) return { id: line.id, basis: 'estimated', seconds: estimate.seconds, measuredBy: null,
      method: estimate.method || null, estimateSeconds: estimate.seconds,
      estimateUncertaintySeconds: estimate.uncertaintySeconds ?? null, basisNote: estimate.basis || null };
    return { id: line.id, basis: 'unknown', seconds: null, measuredBy: null };
  });
  const measured = lines.filter(line => line.basis === 'measured');
  const estimated = lines.filter(line => line.basis === 'estimated');
  const measuredSeconds = measured.reduce((sum, line) => sum + line.seconds, 0);
  const estimatedSeconds = estimated.reduce((sum, line) => sum + line.seconds, 0);
  const uncertaintySeconds = estimated.reduce((sum, line) => sum + (line.estimateUncertaintySeconds || 0), 0);
  const conflicts = [];
  if (Number.isFinite(maxSeconds) && measured.length && measuredSeconds > maxSeconds + 0.01)
    conflicts.push({ kind: 'measured-over-hard-limit', status: 'open', gating: true, basis: 'measured',
      measuredSeconds: Number(measuredSeconds.toFixed(3)), maxSeconds,
      options: ['按硬性片长删减或改写（需用户明确决定）', '经用户明确同意提高硬性上限', '把台词拆到更多镜头并重新验收'],
      note: '实测总时长超过硬性上限：冲突只记录并等待明确处理，不自动删词、改词或加速', at: new Date().toISOString() });
  else if (Number.isFinite(maxSeconds) && estimated.length && estimatedSeconds - uncertaintySeconds > maxSeconds + 0.01)
    conflicts.push({ kind: 'estimate-over-hard-limit', status: 'open', gating: false, basis: 'estimate',
      estimatedSeconds: Number(estimatedSeconds.toFixed(3)), uncertaintySeconds: Number(uncertaintySeconds.toFixed(3)),
      maxSeconds, options: ['先完成配音并实测后再判断', '经用户明确同意调整硬性上限'],
      note: '估计值超出硬性上限：估计不足以判定台词必然冲突，本轮不删词、不改词、不加速，等实测与明确处理',
      at: new Date().toISOString() });
  return { basis: !lines.length ? 'unknown' : (measured.length === lines.length ? 'measured' : (estimated.length ? 'estimated' : 'unknown')),
    hard: Number.isFinite(maxSeconds) ? { maxSeconds, targetSeconds: Number.isFinite(targetSeconds) ? targetSeconds : null } : null,
    lines, measured: { ids: measured.map(line => line.id), seconds: Number(measuredSeconds.toFixed(3)) },
    estimated: { ids: estimated.map(line => line.id), seconds: Number(estimatedSeconds.toFixed(3)),
      uncertaintySeconds: Number(uncertaintySeconds.toFixed(3)) },
    unknown: lines.filter(line => line.basis === 'unknown').map(line => line.id), conflicts };
}
// ---------------------------------------------------------------- requirements
// What the user requires, what may be extended, what is unknown and what conflicts. A conflict is never
// resolved silently: it stays listed with its options until a human decides.
function requirementBrief(value, production = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('REQUIREMENTS_SHAPE');
  // A fixture requirement may only exist on a task that declares itself an offline fixture: a fixture must
  // never become the default constraint set of a real production.
  const allowFixture = production?.creativeFixture === true;
  const mustKeep = objects(value.mustKeep, 'REQUIREMENTS_MUST_KEEP', { min: 1, max: 60 }).map(entry => {
    safeId(entry.id);
    if (!MUST_KINDS.includes(entry.kind)) fail('REQUIREMENTS_MUST_KIND:' + entry.id);
    if (!SOURCES.includes(entry.source)) fail('REQUIREMENTS_SOURCE:' + entry.id);
    // The same provenance rule as every other claim: "verified" needs evidence a local check can read, and a
    // source may not be left implicit where the difference matters.
    const claim = provenanceClaim(entry, { code: 'REQUIREMENTS_MUST', where: entry.id, allowFixture,
      refCode: 'REQUIREMENTS_MUST_SOURCE',
      references: (production?.requiredQuotes || []).map((quote, index) => 'requiredQuotes.' + index) });
    return { id: entry.id, kind: entry.kind, text: text(entry.text, 'REQUIREMENTS_MUST_TEXT:' + entry.id, 1200),
      ...claim, note: optionalText(entry.note, 'REQUIREMENTS_MUST_NOTE:' + entry.id, 400) };
  });
  const ids = mustKeep.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) fail('REQUIREMENTS_MUST_DUPLICATE');
  const brief = { version: CREATIVE_VERSION, mustKeep,
    style: text(value.style, 'REQUIREMENTS_STYLE', 600),
    aspect: text(value.aspect || '16:9', 'REQUIREMENTS_ASPECT', 12),
    targetSeconds: seconds(value.targetSeconds, 'REQUIREMENTS_TARGET_SECONDS', { min: 2, max: 600 }),
    maxSeconds: seconds(value.maxSeconds, 'REQUIREMENTS_MAX_SECONDS', { min: 2, max: 600 }),
    prohibitions: list(value.prohibitions || [], 'REQUIREMENTS_PROHIBITIONS'),
    expandable: objects(value.expandable || [], 'REQUIREMENTS_EXPANDABLE', { max: 30 }).map(entry =>
      ({ area: text(entry.area, 'REQUIREMENTS_EXPAND_AREA', 160), serves: text(entry.serves, 'REQUIREMENTS_EXPAND_SERVES', 200) })),
    unknowns: list(value.unknowns || [], 'REQUIREMENTS_UNKNOWNS', { max: 30 }),
    conflicts: objects(value.conflicts || [], 'REQUIREMENTS_CONFLICTS', { max: 20 }).map(entry => ({
      issue: text(entry.issue, 'REQUIREMENTS_CONFLICT_ISSUE', 600),
      options: list(entry.options, 'REQUIREMENTS_CONFLICT_OPTIONS', { min: 1, max: 6 }),
      status: ['open', 'resolved'].includes(entry.status) ? entry.status : 'open',
      resolution: optionalText(entry.resolution, 'REQUIREMENTS_CONFLICT_RESOLUTION', 400),
      // What the conflict itself rests on. A conflict judged from an estimate is recorded as such instead of
      // being presented as an established fact.
      basis: entry.basis && typeof entry.basis === 'object' && !Array.isArray(entry.basis)
        ? { kind: CONFLICT_BASES.includes(entry.basis.kind) ? entry.basis.kind : 'unknown',
          detail: optionalText(entry.basis.detail, 'REQUIREMENTS_CONFLICT_BASIS_DETAIL', 400) }
        : { kind: 'unknown', detail: null } })) };
  if (brief.targetSeconds > brief.maxSeconds) fail('REQUIREMENTS_TARGET_OVER_MAX');
  if (production && production.maxDurationSeconds && brief.maxSeconds > production.maxDurationSeconds) fail('REQUIREMENTS_MAX_OVER_PRODUCTION');
  for (const conflict of brief.conflicts) {
    if (conflict.status === 'resolved' && !conflict.resolution) fail('REQUIREMENTS_CONFLICT_UNEXPLAINED:' + conflict.issue);
    // A conflict may only be closed on something that was actually established. An estimate or a word count is
    // not a decision, so it can never delete, reword, speed up or shrink a line.
    if (conflict.status === 'resolved' && ['estimate', 'unknown'].includes(conflict.basis.kind))
      fail('REQUIREMENTS_CONFLICT_BASIS_NOT_DECISIVE:' + conflict.issue, conflict.basis.kind +
        '：估计或未记录的时长不足以判定冲突必然成立，必须保留为待处理，等实测或用户明确决定');
    if (conflict.status === 'resolved' && !conflict.basis.detail) fail('REQUIREMENTS_CONFLICT_BASIS_UNDETAILED:' + conflict.issue);
  }
  return brief;
}// ---------------------------------------------------------------- director script
function performanceFields(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return { tone: text(value.tone, code + '_TONE', 400), pauses: list(value.pauses || [], code + '_PAUSES', { max: 12 }),
    breath: text(value.breath, code + '_BREATH', 400), gaze: text(value.gaze, code + '_GAZE', 400),
    expression: text(value.expression, code + '_EXPRESSION', 400), posture: text(value.posture, code + '_POSTURE', 400) };
}
function directorScript(value, { requirements = null, characterIds = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DIRECTOR_SHAPE');
  const segments = objects(value.segments, 'DIRECTOR_SEGMENTS', { min: 1, max: 40 }).map(entry => {
    safeId(entry.id);
    const beats = entry.beats;
    if (!beats || typeof beats !== 'object' || Array.isArray(beats)) fail('DIRECTOR_BEATS:' + entry.id);
    const spoken = objects(entry.spoken || [], 'DIRECTOR_SPOKEN:' + entry.id, { max: 20 }).map(line => {
      safeId(line.id);
      if (!SPEAK_KINDS.includes(line.kind)) fail('DIRECTOR_SPOKEN_KIND:' + line.id);
      if (characterIds && !characterIds.includes(line.speaker)) fail('DIRECTOR_SPOKEN_SPEAKER:' + line.id);
      return { id: line.id, speaker: text(line.speaker, 'DIRECTOR_SPOKEN_SPEAKER_TEXT:' + line.id, 60), kind: line.kind,
        text: text(line.text, 'DIRECTOR_SPOKEN_TEXT:' + line.id, 600),
        covers: idList(line.covers || [], 'DIRECTOR_SPOKEN_COVERS:' + line.id) };
    });
    const speakIds = spoken.map(line => line.id);
    if (new Set(speakIds).size !== speakIds.length) fail('DIRECTOR_SPOKEN_DUPLICATE:' + entry.id);
    return { id: entry.id, purpose: text(entry.purpose, 'DIRECTOR_PURPOSE:' + entry.id, 800),
      covers: idList(entry.covers || [], 'DIRECTOR_COVERS:' + entry.id),
      characters: idList(entry.characters || [], 'DIRECTOR_CHARACTERS:' + entry.id),
      entry: { state: text(entry.entry?.state, 'DIRECTOR_ENTRY:' + entry.id, 600),
        motivation: text(entry.entry?.motivation, 'DIRECTOR_MOTIVATION:' + entry.id, 600) },
      beats: { cause: text(beats.cause, 'DIRECTOR_CAUSE:' + entry.id, 800), action: text(beats.action, 'DIRECTOR_ACTION:' + entry.id, 800),
        reaction: text(beats.reaction, 'DIRECTOR_REACTION:' + entry.id, 800), result: text(beats.result, 'DIRECTOR_RESULT:' + entry.id, 800) },
      performance: performanceFields(entry.performance, 'DIRECTOR_PERFORMANCE:' + entry.id),
      space: text(entry.space, 'DIRECTOR_SPACE:' + entry.id, 600), props: list(entry.props || [], 'DIRECTOR_PROPS:' + entry.id, { max: 20 }),
      spoken, ambience: list(entry.ambience || [], 'DIRECTOR_AMBIENCE:' + entry.id, { max: 20 }),
      silence: list(entry.silence || [], 'DIRECTOR_SILENCE:' + entry.id, { max: 20 }),
      shotIntent: text(entry.shotIntent, 'DIRECTOR_SHOT_INTENT:' + entry.id, 800),
      endState: text(entry.endState, 'DIRECTOR_END_STATE:' + entry.id, 600),
      nextHandoff: text(entry.nextHandoff, 'DIRECTOR_HANDOFF:' + entry.id, 600),
      creative: list(entry.creative || [], 'DIRECTOR_CREATIVE:' + entry.id, { max: 20 }),
      unknown: list(entry.unknown || [], 'DIRECTOR_UNKNOWN:' + entry.id, { max: 20 }) };
  });
  const ids = segments.map(segment => segment.id);
  if (new Set(ids).size !== ids.length) fail('DIRECTOR_SEGMENT_DUPLICATE');
  if (requirements) {
    const covered = new Set(segments.flatMap(segment => segment.covers));
    const missing = requirements.mustKeep.filter(entry => !covered.has(entry.id)).map(entry => entry.id);
    if (missing.length) fail('DIRECTOR_MUST_KEEP_UNCOVERED', missing.join(','));
    const spokenTexts = new Set(segments.flatMap(segment => segment.spoken.map(line => line.text)));
    const dropped = requirements.mustKeep.filter(entry => entry.kind === 'line' && !spokenTexts.has(entry.text)).map(entry => entry.id);
    if (dropped.length) fail('DIRECTOR_MUST_KEEP_LINE_MISSING', dropped.join(','));
  }
  return { version: CREATIVE_VERSION, title: text(value.title, 'DIRECTOR_TITLE', 120),
    theme: text(value.theme, 'DIRECTOR_THEME', 800), segments };
}// ---------------------------------------------------------------- bibles
// What a reference image actually shows, what is unknown, and where the statement comes from. Frame prompts
// are assembled from these entries instead of writing "see the reference image".
function characterBible(value, { production = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BIBLE_CHARACTER_SHAPE');
  const allowFixture = production?.creativeFixture === true;
  const entries = objects(value.entries, 'BIBLE_CHARACTER_ENTRIES', { min: 1, max: 20 }).map(entry => {
    safeId(entry.id);
    const confirmed = entry.confirmed;
    if (!confirmed || typeof confirmed !== 'object' || Array.isArray(confirmed)) fail('BIBLE_CHARACTER_CONFIRMED:' + entry.id);
    const confirmedText = {};
    for (const key of ['face', 'hair', 'costume', 'accessories', 'weapon', 'palette', 'materials'])
      confirmedText[key] = text(confirmed[key], 'BIBLE_CHARACTER_' + key.toUpperCase() + ':' + entry.id, 800);
    const refs = list(entry.refs || [], 'BIBLE_CHARACTER_REFS:' + entry.id, { min: 1, max: 6 });
    // The claim behind every appearance detail is validated here, with the same rule used everywhere else: a
    // reference that was never analysed stays "未逐项确认", a fixture cannot pass for the user's material, and
    // "verified" must cite the manifest field (or local file) it was actually checked against.
    const claim = provenanceClaim(entry, { code: 'BIBLE_CHARACTER', where: entry.id, allowFixture, refs,
      references: [...manifestCitations(production, entry.id),
        ...(production?.requiredQuotes || []).map((quote, index) => 'requiredQuotes.' + index)] });
    return { id: entry.id, version: Number.isInteger(entry.version) && entry.version > 0 ? entry.version : 1,
      name: text(entry.name, 'BIBLE_CHARACTER_NAME:' + entry.id, 60), refs,
      confirmed: confirmedText, weaponSide: optionalText(entry.weaponSide, 'BIBLE_CHARACTER_WEAPON_SIDE:' + entry.id, 200),
      unknown: list(entry.unknown || [], 'BIBLE_CHARACTER_UNKNOWN:' + entry.id, { max: 20 }), ...claim };
  });
  const ids = entries.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) fail('BIBLE_CHARACTER_DUPLICATE');
  if (production) {
    const missing = production.characters.map(c => c.id).filter(id => !ids.includes(id));
    if (missing.length) fail('BIBLE_CHARACTER_MISSING', missing.join(','));
    const extra = ids.filter(id => !production.characters.some(c => c.id === id));
    if (extra.length) fail('BIBLE_CHARACTER_UNREGISTERED', extra.join(','));
  }
  return { version: CREATIVE_VERSION, entries };
}
function sceneBible(value, { production = null, requirements = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BIBLE_SCENE_SHAPE');
  const allowFixture = production?.creativeFixture === true;
  // What a scene claim may cite as local evidence: the user's must-keep items (a user confirmation) and the
  // quotes the manifest really carries.
  const citations = [...(requirements?.mustKeep || []).map(entry => entry.id),
    ...(production?.requiredQuotes || []).map((quote, index) => 'requiredQuotes.' + index)];
  const entries = objects(value.entries, 'BIBLE_SCENE_ENTRIES', { min: 1, max: 20 }).map(entry => {
    safeId(entry.id);
    const light = entry.light, directions = entry.directions;
    if (!light || typeof light !== 'object') fail('BIBLE_SCENE_LIGHT:' + entry.id);
    if (!directions || typeof directions !== 'object') fail('BIBLE_SCENE_DIRECTIONS:' + entry.id);
    const refs = list(entry.refs || [], 'BIBLE_SCENE_REFS:' + entry.id, { max: 6 });
    const claim = provenanceClaim(entry, { code: 'BIBLE_SCENE', where: entry.id, allowFixture, refs,
      references: citations, refsRequired: true });
    return { id: entry.id, version: Number.isInteger(entry.version) && entry.version > 0 ? entry.version : 1,
      name: text(entry.name, 'BIBLE_SCENE_NAME:' + entry.id, 60),
      scale: text(entry.scale, 'BIBLE_SCENE_SCALE:' + entry.id, 400),
      directions: { north: text(directions.north, 'BIBLE_SCENE_NORTH:' + entry.id, 300),
        entrance: text(directions.entrance, 'BIBLE_SCENE_ENTRANCE:' + entry.id, 300),
        roads: list(directions.roads || [], 'BIBLE_SCENE_ROADS:' + entry.id, { min: 1, max: 10 }) },
      structures: list(entry.structures, 'BIBLE_SCENE_STRUCTURES:' + entry.id, { min: 1, max: 20 }),
      materials: list(entry.materials, 'BIBLE_SCENE_MATERIALS:' + entry.id, { min: 1, max: 20 }),
      wear: list(entry.wear || [], 'BIBLE_SCENE_WEAR:' + entry.id, { max: 20 }),
      props: list(entry.props || [], 'BIBLE_SCENE_PROPS:' + entry.id, { max: 20 }),
      light: { position: text(light.position, 'BIBLE_SCENE_LIGHT_POSITION:' + entry.id, 300),
        direction: text(light.direction, 'BIBLE_SCENE_LIGHT_DIRECTION:' + entry.id, 300),
        warmth: text(light.warmth, 'BIBLE_SCENE_LIGHT_WARMTH:' + entry.id, 200),
        coverage: text(light.coverage, 'BIBLE_SCENE_LIGHT_COVERAGE:' + entry.id, 300) },
      weather: text(entry.weather, 'BIBLE_SCENE_WEATHER:' + entry.id, 300),
      wind: optionalText(entry.wind, 'BIBLE_SCENE_WIND:' + entry.id, 300),
      people: list(entry.people || [], 'BIBLE_SCENE_PEOPLE:' + entry.id, { max: 20 }),
      boundary: list(entry.boundary, 'BIBLE_SCENE_BOUNDARY:' + entry.id, { min: 1, max: 10 }),
      fixed: list(entry.fixed, 'BIBLE_SCENE_FIXED:' + entry.id, { min: 1, max: 20 }),
      variable: list(entry.variable || [], 'BIBLE_SCENE_VARIABLE:' + entry.id, { max: 20 }), ...claim };
  });
  const ids = entries.map(entry => entry.id);
  if (new Set(ids).size !== ids.length) fail('BIBLE_SCENE_DUPLICATE');
  return { version: CREATIVE_VERSION, entries };
}function voicePlan(value, { director = null, characterIds = null, requirements = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VOICE_PLAN_SHAPE');
  const lines = objects(value.lines, 'VOICE_PLAN_LINES', { min: 1, max: 80 }).map(entry => {
    safeId(entry.id);
    if (!SPEAK_KINDS.includes(entry.kind)) fail('VOICE_PLAN_KIND:' + entry.id);
    if (characterIds && !characterIds.includes(entry.speaker)) fail('VOICE_PLAN_SPEAKER:' + entry.id);
    const performance = entry.performance;
    if (!performance || typeof performance !== 'object') fail('VOICE_PLAN_PERFORMANCE:' + entry.id);
    return { id: entry.id, speaker: text(entry.speaker, 'VOICE_PLAN_SPEAKER_TEXT:' + entry.id, 60), kind: entry.kind,
      text: text(entry.text, 'VOICE_PLAN_TEXT:' + entry.id, 600),
      performance: { tone: text(performance.tone, 'VOICE_PLAN_TONE:' + entry.id, 400),
        pauses: list(performance.pauses || [], 'VOICE_PLAN_PAUSES:' + entry.id, { max: 12 }),
        breath: text(performance.breath, 'VOICE_PLAN_BREATH:' + entry.id, 400),
        silence: list(performance.silence || [], 'VOICE_PLAN_SILENCE:' + entry.id, { max: 12 }) },
      // Before any audio exists a line's running time can only be ESTIMATED, so the estimate says so, records
      // its method and its uncertainty, and is never allowed to stand in for a measurement.
      durationEstimate: durationEstimate(entry.durationEstimate, 'VOICE_PLAN_ESTIMATE:' + entry.id),
      notSpoken: list(entry.notSpoken || [], 'VOICE_PLAN_NOT_SPOKEN:' + entry.id, { max: 20 }) };
  });
  const ids = lines.map(line => line.id);
  if (new Set(ids).size !== ids.length) fail('VOICE_PLAN_DUPLICATE');
  if (director) {
    const spoken = director.segments.flatMap(segment => segment.spoken);
    const expected = new Set(spoken.map(line => line.id));
    const missing = [...expected].filter(id => !ids.includes(id));
    const extra = ids.filter(id => !expected.has(id));
    if (missing.length) fail('VOICE_PLAN_MISSING_LINES', missing.join(','));
    if (extra.length) fail('VOICE_PLAN_UNKNOWN_LINES', extra.join(','));
    for (const line of spoken) {
      const planned = lines.find(entry => entry.id === line.id);
      // Verbatim: the text that is spoken is exactly the text that was authored, character by character.
      if (planned.text !== line.text || planned.speaker !== line.speaker || planned.kind !== line.kind)
        fail('VOICE_PLAN_TEXT_CHANGED:' + line.id);
    }
  }
  if (requirements) {
    const planned = new Set(lines.map(line => line.text));
    const dropped = requirements.mustKeep.filter(entry => entry.kind === 'line' && !planned.has(entry.text)).map(entry => entry.id);
    if (dropped.length) fail('VOICE_PLAN_MUST_KEEP_MISSING', dropped.join(','));
  }
  return { version: CREATIVE_VERSION, lines };
}// ---------------------------------------------------------------- storyboard
// The final storyboard exists only after the audio is accepted: every shot maps explicit SOURCE ranges of
// accepted audio to explicit FILM ranges, so one line may cross several shots and one shot may hold several
// fragments. Nothing here estimates durations; it compares them and refuses contradictions.
const CHARACTER_FIELDS = ['position', 'facing', 'posture', 'hands', 'gaze', 'occlusion', 'costume'];
// Everyone recognisable in the frame gets his own entry, his own stable label and his own state. A shared
// costume is declared once and then expanded per person; it is never used to merge people into one line.
const FRAME_PERSON_FIELDS = ['position', 'facing', 'posture', 'hands', 'gaze', 'action'];
const ORDINALS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];
function ordinal(index) { return ORDINALS[index] || '(' + (index + 1) + ')'; }
function framePerson(person, shotId, kind) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) fail('STORYBOARD_FRAME_PERSON_SHAPE:' + shotId + ':' + kind);
  // The id is the person's identity: it must exist and be unique inside the frame, so the same person can be
  // followed from the first frame to the last one even if the order changes. label and group are display only.
  const id = safeId(person.id);
  const label = text(person.label, 'STORYBOARD_FRAME_PERSON_LABEL:' + shotId + ':' + kind, 80);
  const described = { id, label, group: optionalText(person.group, 'STORYBOARD_FRAME_PERSON_GROUP:' + shotId + ':' + kind, 80),
    costume: optionalText(person.costume, 'STORYBOARD_FRAME_PERSON_COSTUME:' + shotId + ':' + kind, 500) };
  for (const field of FRAME_PERSON_FIELDS)
    described[field] = text(person[field], 'STORYBOARD_FRAME_PERSON_' + field.toUpperCase() + ':' + shotId + ':' + kind + ':' + label, 500);
  described.props = list(person.props || [], 'STORYBOARD_FRAME_PERSON_PROPS:' + shotId + ':' + kind + ':' + label, { max: 10 });
  described.visible = text(person.visible, 'STORYBOARD_FRAME_PERSON_VISIBLE:' + shotId + ':' + kind + ':' + label, 300);
  return described;
}
function sceneHeader(sceneId, scenes) {
  const entry = (scenes?.entries || []).find(item => item.id === sceneId) || null;
  if (!entry) fail('FRAME_SCENE_UNKNOWN:' + sceneId);
  return '场景「' + entry.name + '」版本 v' + (entry.version ?? 1) + '（设定来源：' + sourceLabel(entry) + '）';
}
// The per-frame state of a named cast member. Fixed appearance stays in the bible; position, facing, posture,
// hands, gaze, occlusion and costume are per frame, so a later frame never re-uses an earlier pose.
function frameCastState(entryState, shotId, kind) {
  if (!entryState || typeof entryState !== 'object' || Array.isArray(entryState)) fail('STORYBOARD_FRAME_CAST_STATE_SHAPE:' + shotId + ':' + kind);
  const id = safeId(entryState.id);
  const described = { id };
  for (const field of CHARACTER_FIELDS)
    described[field] = text(entryState[field], 'STORYBOARD_FRAME_CAST_STATE_' + field.toUpperCase() + ':' + shotId + ':' + kind + ':' + id, 500);
  described.props = list(entryState.props || [], 'STORYBOARD_FRAME_CAST_STATE_PROPS:' + shotId + ':' + kind + ':' + id, { max: 10 });
  return described;
}
function sceneLight(sceneId, scenes, override = null) {
  if (override) return '光照与天气：' + override;
  const entry = (scenes?.entries || []).find(item => item.id === sceneId) || null;
  if (!entry) fail('FRAME_SCENE_UNKNOWN:' + sceneId);
  return '光照与天气：光源 ' + entry.light.position + '，方向 ' + entry.light.direction + '，色温 ' + entry.light.warmth +
    '，覆盖 ' + entry.light.coverage + '；天气 ' + entry.weather + (entry.wind ? '，风 ' + entry.wind : '');
}
function extraPersonLine(person, index, crowdCostume) {
  // Shared costume and individual additions are MERGED, never used to hide one behind the other, and the
  // shared costume never implies shared weapons.
  const costume = person.costume ? (crowdCostume ? crowdCostume + '；个体补充：' + person.costume : person.costume) : crowdCostume;
  if (!costume) fail('FRAME_EXTRA_CAST_COSTUME_MISSING:' + person.label);
  return ordinal(index) + ' ' + person.label + '（' + (person.group ? person.group + '，' : '') + '身份 ' + person.id + '）：位置：' + person.position +
    '；朝向：' + person.facing + '；姿态：' + person.posture + '；手部与持物：' + person.hands +
    (person.props.length ? '（' + person.props.join('、') + '）' : '') + '；视线与表情：' + person.gaze +
    '；静止状态：' + person.action + '；可见范围与遮挡：' + person.visible + '；服饰装备：' + costume +
    '。共用服饰只共用衣着装备，不含武器；本帧手中的武器与道具只以上面的手部与持物为准。';
}
// Reference inheritance is stated in four parts instead of one blanket sentence: what is inherited, what this
// shot may change, what may be left out, and what stays unknown or conflicting.
function referenceRules(shot, bible) {
  const inherit = shot.characters.map(cast => {
    const entry = (bible?.entries || []).find(item => item.id === cast.id) || null;
    const must = entry ? [entry.confirmed.face, entry.confirmed.hair, entry.confirmed.costume, entry.confirmed.accessories,
      entry.confirmed.weapon, entry.confirmed.palette, entry.confirmed.materials].filter(Boolean).join('、') : '设定集给出的外观';
    return (entry?.name || cast.id) + '：' + must + (entry?.weaponSide ? '；' + entry.weaponSide : '');
  });
  const unknown = shot.characters.flatMap(cast => ((bible?.entries || []).find(item => item.id === cast.id)?.unknown || [])
    .map(item => cast.id + '：' + item));
  return '参考图继承规则：必须继承——身份与已记录外观（' + inherit.join('；') +
    '）；随本镜变化——姿态、表情、机位与动作状态以本帧描述与动作提示词为准；可以不采用——参考图中的背景与非必要物件' +
    '（本帧背景以上面的可见环境为准）；未知或冲突——' + (unknown.length ? unknown.join('、') + '，保持未知并保留来源，不得写成已知事实'
      : '本帧没有记录未确认项') + '。人物已有立绘：直接复用用户提供的参考素材，不新增立绘生成，也不把夹具外观当作真实任务默认值。';
}
function storyboardShot(entry, state) {
  const { durations, lineById, characters, scenes, sceneVersion, allowedVendorSeconds } = state;
  safeId(entry.id);
  const vendor = entry.vendor;
  if (!vendor || typeof vendor !== 'object') fail('STORYBOARD_VENDOR:' + entry.id);
  if (!COVERAGE.includes(vendor.coverage)) fail('STORYBOARD_VENDOR_COVERAGE:' + entry.id);
  const modelSeconds = seconds(vendor.modelSeconds, 'STORYBOARD_VENDOR_SECONDS:' + entry.id, { min: 1, max: 30 });
  if (allowedVendorSeconds && !allowedVendorSeconds.includes(modelSeconds)) fail('STORYBOARD_VENDOR_UNSUPPORTED:' + entry.id + ':' + modelSeconds);
  const action = entry.action;
  if (!action || typeof action !== 'object') fail('STORYBOARD_ACTION:' + entry.id);
  const phases = list(action.phases, 'STORYBOARD_ACTION_PHASES:' + entry.id, { min: 1, max: 6 });
  const speed = action.speed === undefined ? 1 : Number(action.speed);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 2) fail('STORYBOARD_ACTION_SPEED:' + entry.id);
  const frame = (kind) => {
    const source = entry[kind];
    if (!source || typeof source !== 'object') fail('STORYBOARD_FRAME:' + entry.id + ':' + kind);
    const moment = text(source.moment, 'STORYBOARD_FRAME_MOMENT:' + entry.id + ':' + kind, 800);
    const composition = text(source.composition, 'STORYBOARD_FRAME_COMPOSITION:' + entry.id + ':' + kind, 1200);
    // One picture, one moment: a frame that contains the whole ordered action (with or without separators)
    // is refused, while naming a single phase is fine.
    const combined = moment + composition;
    const positions = phases.map(phase => combined.indexOf(phase));
    if (phases.length > 1 && positions.every(index => index >= 0) && positions.every((index, i) => i === 0 || index > positions[i - 1]))
      fail('STORYBOARD_FRAME_CONTAINS_ACTION_SEQUENCE:' + entry.id + ':' + kind);
    for (const marker of MULTI_MOMENT_MARKERS)
      if (moment.includes(marker) || composition.includes(marker)) fail('STORYBOARD_FRAME_MULTIPLE_MOMENTS:' + entry.id + ':' + kind);
    return { moment, composition, bans: list(source.bans || [], 'STORYBOARD_FRAME_BANS:' + entry.id + ':' + kind, { max: 10 }),
      visibleEnvironment: list(source.visibleEnvironment || [], 'STORYBOARD_FRAME_VISIBLE_ENVIRONMENT:' + entry.id + ':' + kind, { max: 24 }),
      visibleEnvironment: list(source.visibleEnvironment, 'STORYBOARD_FRAME_VISIBLE_ENVIRONMENT:' + entry.id + ':' + kind, { min: 1, max: 24 }),
      offscreen: list(source.offscreen || [], 'STORYBOARD_FRAME_OFFSCREEN:' + entry.id + ':' + kind, { max: 24 }),
      crowdCostume: optionalText(source.crowdCostume, 'STORYBOARD_FRAME_CROWD_COSTUME:' + entry.id + ':' + kind, 500),
      light: optionalText(source.light, 'STORYBOARD_FRAME_LIGHT:' + entry.id + ':' + kind, 600),
      castState: objects(source.castState || [], 'STORYBOARD_FRAME_CAST_STATE:' + entry.id + ':' + kind, { max: 12 })
        .map(entryState => frameCastState(entryState, entry.id, kind)),
      creativeAdditions: list(source.creativeAdditions || [], 'STORYBOARD_FRAME_CREATIVE_ADDITIONS:' + entry.id + ':' + kind, { max: 12 }),
      extraCast: objects(source.extraCast || [], 'STORYBOARD_FRAME_EXTRA_CAST:' + entry.id + ':' + kind, { max: 30 })
        .map(person => framePerson(person, entry.id, kind)) };
  };
  const first = frame('first'), last = frame('last');
  // Two people may not share one identity inside a frame: that would make the first-to-last correspondence
  // meaningless even if their labels differ.
  for (const [kind, frameValue] of [['first', first], ['last', last]]) {
    const intraIds = frameValue.extraCast.map(person => person.id);
    if (new Set(intraIds).size !== intraIds.length) fail('STORYBOARD_FRAME_PERSON_ID_DUPLICATE:' + entry.id + ':' + kind);
  }
  // A frame pair may legitimately show no named character (an environment shot): staying in the story space is
  // not the same as being visible in this frame. An empty cast must be explained, never silent.
  const casts = objects(entry.characters, 'STORYBOARD_CHARACTERS:' + entry.id, { min: 0, max: 12 }).map(cast => {
    safeId(cast.id);
    if (characters && !characters.entries.some(item => item.id === cast.id)) fail('STORYBOARD_CAST_UNKNOWN:' + entry.id + ':' + cast.id);
    const described = {};
    for (const field of CHARACTER_FIELDS) described[field] = text(cast[field], 'STORYBOARD_CAST_' + field.toUpperCase() + ':' + entry.id + ':' + cast.id, 500);
    return { id: cast.id, ...described, props: list(cast.props || [], 'STORYBOARD_CAST_PROPS:' + entry.id + ':' + cast.id, { max: 10 }) };
  });
  const castIds = casts.map(cast => cast.id);
  if (new Set(castIds).size !== castIds.length) fail('STORYBOARD_CAST_DUPLICATE:' + entry.id);
  // Every setting this shot's text can refer to: the named cast, the per-frame cast state of both frames and the
  // extra people that only appear inside a frame description.
  const castEntry = id => (characters?.entries || []).find(item => item.id === id) || null;
  const referencedIds = [...new Set([...castIds, ...[first, last]
    .flatMap(frameValue => [...frameValue.castState, ...frameValue.extraCast].map(person => person.id))])];
  const sceneEntry = (scenes?.entries || []).find(item => item.id === entry.scene?.id) || null;
  const scene = entry.scene;
  const castNote = optionalText(entry.castNote, 'STORYBOARD_CAST_NOTE:' + entry.id, 400);
  if (!casts.length && !castNote) fail('STORYBOARD_CAST_EMPTY_UNEXPLAINED:' + entry.id);
  if (castNote) text(castNote, 'STORYBOARD_CAST_NOTE:' + entry.id, 400);
  if (!scene || typeof scene !== 'object') fail('STORYBOARD_SCENE:' + entry.id);
  if (scenes && !scenes.entries.some(item => item.id === scene.id)) fail('STORYBOARD_SCENE_UNKNOWN:' + entry.id + ':' + scene.id);
  if (sceneVersion !== null && sceneVersion !== undefined && scene.version !== sceneVersion) fail('STORYBOARD_SCENE_VERSION:' + entry.id);
  const segments = objects(entry.segments || [], 'STORYBOARD_SEGMENTS:' + entry.id, { max: 12 }).map(fragment => {
    if (!lineById.has(fragment.lineId)) fail('STORYBOARD_SEGMENT_UNKNOWN:' + entry.id + ':' + fragment.lineId);
    const measured = seconds(durations[fragment.lineId], 'STORYBOARD_DURATION_MISSING:' + fragment.lineId, { min: 0.05, max: 600 });
    const sourceStart = seconds(fragment.sourceStart, 'STORYBOARD_SOURCE_START:' + entry.id + ':' + fragment.lineId, { min: 0, max: measured });
    const sourceEnd = seconds(fragment.sourceEnd, 'STORYBOARD_SOURCE_END:' + entry.id + ':' + fragment.lineId, { min: 0.05, max: measured });
    if (sourceEnd - sourceStart < 0.05) fail('STORYBOARD_SOURCE_RANGE:' + entry.id + ':' + fragment.lineId);
    return { lineId: fragment.lineId, sourceStart, sourceEnd };
  });
  const byLine = new Map();
  for (const fragment of segments) {
    const previous = byLine.get(fragment.lineId);
    if (previous && fragment.sourceStart < previous.sourceEnd - 0.001) fail('STORYBOARD_SEGMENT_OVERLAP:' + entry.id + ':' + fragment.lineId);
    byLine.set(fragment.lineId, fragment);
  }
  const start = seconds(entry.start, 'STORYBOARD_START:' + entry.id, { min: 0, max: 600 });
  const end = seconds(entry.end, 'STORYBOARD_END:' + entry.id, { min: 0.2, max: 600 });
  const filmSeconds = end - start;
  if (filmSeconds <= 0) fail('STORYBOARD_END_BEFORE_START:' + entry.id);
  const drivingLine = optionalText(entry.drivingLine, 'STORYBOARD_DRIVING_LINE:' + entry.id, 60);
  if (drivingLine && !segments.some(fragment => fragment.lineId === drivingLine)) fail('STORYBOARD_DRIVING_LINE_UNMAPPED:' + entry.id + ':' + drivingLine);  const sourceSeconds = segments.reduce((sum, fragment) => sum + (fragment.sourceEnd - fragment.sourceStart), 0);
  // A film duration that differs from the audio it carries is only allowed when the change is declared.
  // A shot with no audio at all is a deliberate silence and needs no pace declaration.
  if (segments.length && Math.abs(filmSeconds - sourceSeconds) > 0.05 && speed === 1) fail('STORYBOARD_PACE_UNDECLARED:' + entry.id);
  if (modelSeconds > filmSeconds + 0.05 && vendor.coverage !== 'trim') fail('STORYBOARD_VENDOR_COVERAGE:' + entry.id + ':TRIM');
  if (modelSeconds < filmSeconds - 0.05 && vendor.coverage !== 'extra') fail('STORYBOARD_VENDOR_COVERAGE:' + entry.id + ':EXTRA');
  if (['extra', 'trim'].includes(vendor.coverage)) text(vendor.note, 'STORYBOARD_VENDOR_NOTE:' + entry.id, 400);
  return { id: entry.id, purpose: text(entry.purpose, 'STORYBOARD_PURPOSE:' + entry.id, 800),
    covers: idList(entry.covers || [], 'STORYBOARD_COVERS:' + entry.id), segments, start, end, filmSeconds, drivingLine,
    vendor: { modelSeconds, coverage: vendor.coverage, note: optionalText(vendor.note, 'STORYBOARD_VENDOR_NOTE:' + entry.id, 400) },
    characters: casts, castNote: castNote || null, scene: { id: scene.id, version: scene.version },
    startState: text(entry.startState, 'STORYBOARD_START_STATE:' + entry.id, 600),
    endState: text(entry.endState, 'STORYBOARD_END_STATE:' + entry.id, 600),
    camera: text(entry.camera, 'STORYBOARD_CAMERA:' + entry.id, 600),
    transition: TRANSITIONS.includes(entry.transition) ? entry.transition : fail('STORYBOARD_TRANSITION:' + entry.id),
    timeJump: entry.transition === 'time' ? text(entry.timeJump, 'STORYBOARD_TIME_JUMP_REASON:' + entry.id, 400)
      : optionalText(entry.timeJump, 'STORYBOARD_TIME_JUMP_REASON:' + entry.id, 400),
    first, last,
    action: { phases, speed, secondary: list(action.secondary || [], 'STORYBOARD_ACTION_SECONDARY:' + entry.id, { max: 12 }),
      settle: text(action.settle, 'STORYBOARD_ACTION_SETTLE:' + entry.id, 400),
      continuity: list(action.continuity || [], 'STORYBOARD_ACTION_CONTINUITY:' + entry.id, { max: 12 }),
      paceNote: optionalText(action.paceNote, 'STORYBOARD_ACTION_PACE_NOTE:' + entry.id, 400) },
    // The settings this shot is actually built from, with id, version and source. A controlled revision can
    // therefore name exactly which setting version a shot used instead of "the prompt changed".
    settings: { scene: { id: scene.id, version: scene.version,
      source: (scenes?.entries || []).find(item => item.id === scene.id)?.source ?? null,
      status: (scenes?.entries || []).find(item => item.id === scene.id)?.status ?? null },
      characters: casts.map(cast => {
        const bibleEntry = (characters?.entries || []).find(item => item.id === cast.id) || null;
        return { id: cast.id, version: bibleEntry?.version ?? 1, source: bibleEntry?.source ?? null,
          status: bibleEntry?.status ?? null };
      }),
      // The CONTENT of every setting this shot's own text refers to (the scene, the named cast and the people
      // that only appear in a frame description). Versions alone cannot prove that a setting is the same one:
      // a replaced setting keeps this digest apart from the text that was written for the old one, so the
      // assembled request refuses instead of pasting a new setting onto a stale description.
      sceneDigest: hash(sceneEntry),
      castDigests: Object.fromEntries(referencedIds.map(id => [id, hash(castEntry(id))])) } };
}
function storyboard(value, options = {}) {
  const { durations = {}, acceptedBinding = null, lines = [], characters = null, scenes = null,
    sceneVersion = null, allowedVendorSeconds = null, maxSeconds = null, requirements = null, durationSource = null } = options;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('STORYBOARD_SHAPE');
  if (!lines.length) fail('STORYBOARD_AUDIO_REQUIRED');
  // The storyboard is planned on MEASURED audio only. A source record that is not a measurement (an estimate,
  // or an unrecorded number) is refused here instead of being used as if the audio had been accepted.
  if (durationSource) {
    if (durationSource.basis !== 'measured' || !durationSource.measuredBy)
      fail('STORYBOARD_DURATION_NOT_MEASURED', String(durationSource.basis));
    const missing = lines.filter(line => !durationSource.lines || !Number.isFinite(durationSource.lines[line.id])).map(line => line.id);
    if (missing.length) fail('STORYBOARD_DURATION_SOURCE_INCOMPLETE', missing.join(','));
    for (const line of lines) {
      const measured = Number(durationSource.lines[line.id]);
      if (!Number.isFinite(durations[line.id]) || Math.abs(measured - durations[line.id]) > 0.001)
        fail('STORYBOARD_DURATION_SOURCE_MISMATCH:' + line.id);
    }
  }
  if (acceptedBinding && value.audioBinding !== acceptedBinding) fail('STORYBOARD_AUDIO_BINDING_MISMATCH');
  const lineById = new Map(lines.map(line => [line.id, line]));
  const unused = objects(value.unusedAudio || [], 'STORYBOARD_UNUSED_AUDIO', { max: 20 }).map(entry => {
    if (!lineById.has(entry.id)) fail('STORYBOARD_UNUSED_UNKNOWN:' + entry.id);
    return { id: entry.id, reason: text(entry.reason, 'STORYBOARD_UNUSED_REASON:' + entry.id, 300) };
  });
  const state = { durations, lineById, characters, scenes, sceneVersion, allowedVendorSeconds };
  const shots = objects(value.shots, 'STORYBOARD_SHOTS', { min: 1, max: 40 }).map(entry => storyboardShot(entry, state));
  const ids = shots.map(shot => shot.id);
  if (new Set(ids).size !== ids.length) fail('STORYBOARD_SHOT_DUPLICATE');  // Film time is one continuous track starting at zero: no gaps and no overlaps.
  let cursor = 0;
  for (const shot of shots) {
    if (Math.abs(shot.start - cursor) > 0.02) fail('STORYBOARD_TIMELINE_GAP:' + shot.id + ':' + shot.start + '!=' + cursor);
    cursor = shot.end;
  }
  if (maxSeconds && cursor > maxSeconds + 0.01) fail('STORYBOARD_TOO_LONG:' + cursor);
  // Every accepted line is used exactly once, end to end, unless it is explicitly listed as unused.
  const unusedIds = new Set(unused.map(entry => entry.id));
  for (const line of lines) {
    if (unusedIds.has(line.id)) continue;
    const fragments = shots.flatMap(shot => shot.segments.map(fragment => ({ ...fragment, shot: shot.id })))
      .filter(fragment => fragment.lineId === line.id).sort((left, right) => left.sourceStart - right.sourceStart);
    if (!fragments.length) fail('STORYBOARD_AUDIO_UNMAPPED:' + line.id);
    const measured = durations[line.id];
    if (Math.abs(fragments[0].sourceStart) > 0.02) fail('STORYBOARD_AUDIO_HEAD_TRUNCATED:' + line.id);
    if (Math.abs(fragments[fragments.length - 1].sourceEnd - measured) > 0.02) fail('STORYBOARD_AUDIO_TAIL_TRUNCATED:' + line.id);
    for (let index = 1; index < fragments.length; index++)
      if (Math.abs(fragments[index].sourceStart - fragments[index - 1].sourceEnd) > 0.02) fail('STORYBOARD_AUDIO_GAP:' + line.id);
  }
  // Cutting semantics: the words of start/endState may differ between framings, so they are never compared.
  // What IS compared is the structured state that a cut may not change without an explanation.
  for (let index = 1; index < shots.length; index++) {
    const previous = shots[index - 1], shot = shots[index];
    const explained = shot.action.continuity.length > 0;
    if (shot.transition === 'scene') {
      if (shot.scene.id === previous.scene.id) fail('STORYBOARD_HANDOFF_MISMATCH:' + shot.id + ':SCENE_UNCHANGED');
      continue;
    }
    if (shot.scene.id !== previous.scene.id) fail('STORYBOARD_HANDOFF_MISMATCH:' + shot.id + ':SCENE_CHANGED');
    if (!explained) fail('STORYBOARD_HANDOFF_MISMATCH:' + shot.id + ':CONTINUITY_UNEXPLAINED');
    const before = new Map(previous.characters.map(cast => [cast.id, cast]));
    const now = new Map(shot.characters.map(cast => [cast.id, cast]));
    if (shot.transition === 'continuous') {
      // The same action carries on: the same people, the same held objects, no unexplained change.
      if (before.size !== now.size || [...before.keys()].some(id => !now.has(id)))
        fail('STORYBOARD_HANDOFF_MISMATCH:' + shot.id + ':CAST_CHANGED');
      for (const [id, cast] of now) {
        const earlier = before.get(id);
        if (JSON.stringify([...earlier.props].sort()) !== JSON.stringify([...cast.props].sort()))
          fail('STORYBOARD_HANDOFF_MISMATCH:' + shot.id + ':PROPS_CHANGED:' + id);
      }
    } else {
      // A different camera may show a different part of the same place; a person or object may only disappear
      // when this shot says so, and never silently.
      for (const id of before.keys()) if (!now.has(id) && !explained) fail('STORYBOARD_HANDOFF_MISMATCH:' + shot.id + ':CAST_DROPPED:' + id);
    }
  }
  if (requirements) {
    const covered = new Set(shots.flatMap(shot => shot.covers));
    const missing = requirements.mustKeep.filter(entry => !covered.has(entry.id)).map(entry => entry.id);
    if (missing.length) fail('STORYBOARD_MUST_KEEP_UNCOVERED', missing.join(','));
  }
  return { version: CREATIVE_VERSION, audioBinding: value.audioBinding || acceptedBinding, unusedAudio: unused,
    totalSeconds: cursor, shots: shots.map(shot => ({ ...shot, byLine: undefined })),
    // The provenance of the durations this board was planned on, kept with the board itself.
    durationBasis: durationSource ? { basis: durationSource.basis, measuredBy: durationSource.measuredBy,
      lines: Object.fromEntries(lines.map(line => [line.id, Number(durationSource.lines[line.id])])) } : null };
}// ---------------------------------------------------------------- timeline, audio bed, subtitles
// The film track comes from the storyboard. The dialogue track is mixed once onto it, so a line crossing a
// cut is neither repeated nor interrupted, and subtitles follow the audio timeline instead of restarting at
// every cut.
function storyboardTimeline(board, { durations = {}, audioFiles = {}, titles = {}, ending = null, durationSource = null } = {}) {
  const shots = board.shots.map(shot => {
    const spans = [];
    let film = shot.start;
    for (const fragment of shot.segments) {
      const span = (fragment.sourceEnd - fragment.sourceStart) / shot.action.speed;
      spans.push({ lineId: fragment.lineId, sourceStart: fragment.sourceStart, sourceEnd: fragment.sourceEnd,
        filmStart: Number(film.toFixed(3)), filmEnd: Number((film + span).toFixed(3)) });
      film += span;
    }
    // A shot with no audio is declared silence: it holds the picture for its whole film span.
    if (spans.length && Math.abs(film - shot.end) > 0.05) fail('STORYBOARD_TIMELINE_FILL:' + shot.id + ':' + film.toFixed(3) + '!=' + shot.end);
    return { id: shot.id, start: shot.start, end: shot.end, duration: Number((shot.end - shot.start).toFixed(3)),
      storyboard: true, audioSpans: spans, drivingLine: shot.drivingLine,
      drivingSpan: spans.find(span => span.lineId === shot.drivingLine) || null };
  });
  const audioBed = [];
  for (const shot of board.shots)
    for (const fragment of shot.segments) {
      const span = shots.find(item => item.id === shot.id).audioSpans
        .find(item => item.lineId === fragment.lineId && item.sourceStart === fragment.sourceStart);
      const existing = audioBed.find(entry => entry.lineId === fragment.lineId);
      if (existing) { existing.segments.push(span); continue; }
      audioBed.push({ lineId: fragment.lineId, file: audioFiles[fragment.lineId] || null,
        startSeconds: Number((span.filmStart - fragment.sourceStart).toFixed(3)), segments: [span] });
    }
  for (const entry of audioBed) {
    const measured = durations[entry.lineId];
    if (!Number.isFinite(measured) || measured <= 0) fail('STORYBOARD_DURATION_MISSING:' + entry.lineId);
    entry.durationSeconds = measured;
  }
  audioBed.sort((left, right) => left.startSeconds - right.startSeconds);
  const subtitles = audioBed.map(entry => ({ lineId: entry.lineId, text: titles[entry.lineId] || null,
    start: entry.startSeconds, end: Number((entry.startSeconds + entry.durationSeconds).toFixed(3)) }))
    .filter(entry => typeof entry.text === 'string' && entry.text.trim());
  const total = board.totalSeconds + (ending ? ending.cardSeconds + ending.blackSeconds : 0);
  return { shots, audioBed, subtitles, totalDuration: Number(total.toFixed(3)), contentSeconds: board.totalSeconds,
    // The provenance of the durations the bed was built from: a local measurement of the accepted files, never
    // an estimate and never an unrecorded number.
    durationBasis: durationSource ? { basis: durationSource.basis || 'measured', measuredBy: durationSource.measuredBy || null,
      lines: Object.fromEntries(audioBed.map(entry => [entry.lineId, entry.durationSeconds])) } : null };
}// ---------------------------------------------------------------- the actual requests
// These are the only places that build the text sent to the image/video models: the assembled request
// carries the confirmed bible entries and every visible person, never just "see the reference image".
// How the appearance recorded in a bible entry may be NAMED inside a request. The wording follows what was
// really established, so an unanalysed reference is never presented to the picture model as "已确认外观".
function appearanceLabel(entry) {
  if (entry.status === 'analyzed') return '已确认外观';
  if (entry.source === 'verified') return '已核对外观';
  if (entry.source === 'user') return '用户提供的外观';
  if (entry.source === 'fixture') return '离线夹具外观（不代表用户素材）';
  if (entry.source === 'reference') return '参考素材外观（未逐项确认）';
  return '创作设定的外观（不是用户指定）';
}
function castLine(cast, bible, { index = 0, crowdCostume = null } = {}) {
  const entry = bible?.entries.find(item => item.id === cast.id) || null;
  const appearance = entry ? appearanceLabel(entry) + '（' + [entry.confirmed.face, entry.confirmed.hair,
    entry.confirmed.costume, entry.confirmed.accessories, entry.confirmed.weapon, entry.confirmed.palette,
    entry.confirmed.materials].join('、') + '）' : '没有设定集条目，外观只按本帧文字描述';
  return ordinal(index) + ' ' + (entry?.name || cast.id) + '（' + cast.id + '）：' + appearance + (entry?.weaponSide ? '；持械：' + entry.weaponSide : '') +
    '；本帧位置：' + cast.position + '；朝向：' + cast.facing + '；姿态与重心：' + cast.posture +
    '；手部与持物：' + cast.hands + (cast.props.length ? '（' + cast.props.join('、') + '）' : '') +
    '；视线与表情：' + cast.gaze + '；遮挡与可见范围：' + cast.occlusion + '；服饰装备状态：' + (cast.costume || crowdCostume || fail('FRAME_CAST_COSTUME_MISSING:' + cast.id)) +
    (entry?.unknown?.length ? '；该角色未确认部分：' + entry.unknown.join('、') + '（不得写成已知事实）' : '') +
    // Where this appearance actually comes from. A claim's source is repeated in the request itself, so a
    // prompt can never present a creative addition or a fixture as the user's confirmed material.
    '；设定来源：' + (entry ? sourceLabel(entry) + '（设定集 v' + (entry.version ?? 1) + '）' : '没有设定集条目，外观只按本帧文字描述');
}
function sceneLine(sceneId, bible) {
  const entry = bible?.entries.find(item => item.id === sceneId);
  if (!entry) return '场景（无设定集条目）：' + sceneId;
  return '场景「' + entry.name + '」：空间尺度 ' + entry.scale + '；入口 ' + entry.directions.entrance + '；道路 ' + entry.directions.roads.join('、') +
    '；结构 ' + entry.structures.join('、') + '；材料 ' + entry.materials.join('、') +
    (entry.wear.length ? '；使用状态 ' + entry.wear.join('、') : '') + (entry.props.length ? '；陈设 ' + entry.props.join('、') : '') +
    '；光源 ' + entry.light.position + '，方向 ' + entry.light.direction + '，色温 ' + entry.light.warmth + '，覆盖 ' + entry.light.coverage +
    '；天气 ' + entry.weather + (entry.wind ? '，风 ' + entry.wind : '') + '；人群分布 ' + (entry.people.join('、') || '无') +
    '；边界 ' + entry.boundary.join('、') + '；固定内容 ' + entry.fixed.join('、') +
    (entry.variable.length ? '；允许变化 ' + entry.variable.join('、') : '');
}
// What this ONE frame can see is selected here: the internal scene record stays complete, but a close-up does
// not inherit the off-screen crowd, and unknown details of invisible parts are never pasted into the request.
function sceneVisible(sceneId, scenes, visiblePeople = []) {
  const entry = (scenes?.entries || []).find(item => item.id === sceneId) || null;
  if (!entry) fail('FRAME_SCENE_UNKNOWN:' + sceneId);
  const parts = ['结构 ' + entry.structures.join('、'), '材料 ' + entry.materials.join('、'),
    '使用状态 ' + entry.wear.join('、'), '陈设 ' + entry.props.join('、'),
    '光源 ' + entry.light.position + '，方向 ' + entry.light.direction + '，色温 ' + entry.light.warmth + '，覆盖 ' + entry.light.coverage,
    '天气 ' + entry.weather + (entry.wind ? '，风 ' + entry.wind : ''), '边界 ' + entry.boundary.join('、')];
  if (visiblePeople.length) parts.push('本帧可见的人群分布 ' + visiblePeople.join('、'));
  else parts.push('本帧没有可见的其他人群；营地守卫、巡逻队与远处人员一律不入画');
  return '场景「' + entry.name + '」版本 v' + (entry.version ?? 1) + '（设定来源：' + sourceLabel(entry) + '）：' + parts.join('；');
}
function frameRequest(shot, { characters = null, scenes = null, kind, style = '', aspect = '16:9', references = null } = {}) {
  const frame = kind === 'last' ? shot.last : shot.first;
  if (!frame) fail('FRAME_REQUEST_KIND:' + kind);
  const visibleEnvironment = frame.visibleEnvironment || [], offscreen = frame.offscreen || [];
  // A frame declares what it shows. There is no automatic fallback: a missing or empty visible environment is a
  // structure error that needs controlled re-planning, so nothing is guessed into the request.
  if (!visibleEnvironment.length) fail('FRAME_VISIBLE_ENVIRONMENT_MISSING:' + shot.id + ':' + kind);
  // This frame's text was written FOR the setting versions the shot recorded, and the digest proves it is still
  // the same content. If a setting was replaced since (a controlled revision marks the shot, and any other
  // change shows up in the digest), the request is refused here instead of pasting the new setting onto a
  // description of the old one. Re-authoring those frames is a controlled re-plan, never a silent splice.
  if (shot.settingsStale)
    fail('FRAME_SETTING_SUPERSEDED:' + shot.id + ':' + String(shot.settingsStale.target) + '：本镜的逐帧文字是按旧设定写的' +
      '（' + (shot.settingsStale.reason || '设定已受控修订') + '），不得与新设定拼接生成；这些镜头需受控重新规划分镜');
  const sceneEntry = (scenes?.entries || []).find(item => item.id === shot.scene.id) || null;
  if (shot.settings?.sceneDigest && shot.settings.sceneDigest !== hash(sceneEntry))
    fail('FRAME_SETTING_SUPERSEDED:' + shot.id + ':scene:' + shot.scene.id +
      '：场景设定的内容与撰写本镜文字时不一致（旧描述不得留用，直接拼接会生成自相矛盾的帧）；需受控重新规划分镜');
  const castEntry = id => (characters?.entries || []).find(item => item.id === id) || null;
  for (const [id, digest] of Object.entries(shot.settings?.castDigests || {}))
    if (digest !== hash(castEntry(id)))
      fail('FRAME_SETTING_SUPERSEDED:' + shot.id + ':cast:' + id +
        '：该人物/装备设定的内容与撰写本镜文字时不一致（逐帧状态与服饰不得据此留用）；需受控重新规划分镜');
  const parts = [style, '横屏' + aspect + '。' + sceneHeader(shot.scene.id, scenes) + '。' + sceneLight(shot.scene.id, scenes, frame.light),
    '本帧可见的环境：' + visibleEnvironment.join('；'),
    '构图与景别：' + frame.composition,
    '该帧的唯一静止时刻：' + frame.moment,
    '本帧入画人物（逐人独立描述；共用外观也要在各人身上展开，不得合并省略）：'];
  const crowdCostume = frame.crowdCostume || null;
  shot.characters.forEach((cast, index) => parts.push(castLine({ ...cast, ...(frame.castState || []).find(state => state.id === cast.id) || {} }, characters, { index, crowdCostume })));
  (frame.extraCast || []).forEach((person, index) => parts.push(extraPersonLine(person, shot.characters.length + index, crowdCostume)));
  if (crowdCostume) parts.push('共用群演服饰（已在上面对应人物身上展开）：' + crowdCostume);
  // The settings this frame's prompt really uses, named by id, version and source. A later revision can then
  // say exactly what it invalidates, and the assembled request stays traceable to the material it came from.
  const castSetting = cast => {
    const entry = (characters?.entries || []).find(item => item.id === cast.id) || null;
    return cast.id + '（人物设定 v' + (entry?.version ?? 1) + '，' + (entry ? sourceLabel(entry) : '没有设定集条目') + '）';
  };
  parts.push('本帧设定依据（ID/版本/来源）：' + [shot.scene.id + '（场景设定 v' + (sceneEntry?.version ?? 1) + '，' +
    (sceneEntry ? sourceLabel(sceneEntry) : '没有场景设定条目') + '）', ...shot.characters.map(castSetting)].join('；'));
  if (frame.creativeAdditions?.length) parts.push('创作补充（本片新增、参考图中没有的物件与安排）：' + frame.creativeAdditions.join('、'));
  // The plan states who is in frame and who is explicitly not. It is data, never a hard-coded name list.
  if (shot.castNote) parts.push('本镜人物范围说明：' + shot.castNote);
  if (offscreen.length) parts.push('画外影响（不在画内，只影响光照或声音，不要画成画内物件）：' + offscreen.join('；'));
  parts.push('与相邻画面的连接：' + shot.startState + ' 到 ' + shot.endState + '（切镜关系 ' + shot.transition + '）');
  parts.push(referenceRules(shot, characters));
  // Each attached reference states what it is DECLARED to cover, using the same words recorded in the plan: a
  // material whose coverage was never declared is never presented as if some requirement had been verified by it.
  if (references?.length) parts.push('参考图对应：' + references.map((reference, index) =>
    '图' + (index + 1) + '=' + (reference.role || reference.id || '参考素材') +
    (reference.purpose ? '（用途：' + reference.purpose + '）' : '')).join('；') +
    '；按上面的继承规则使用这些参考。' + (references.some(item => item.coverage === 'unconfirmed')
      ? '其中覆盖范围未经确认的参考只作保守保留，不得据此声称身份、服饰或武器已由参考图保证。' : ''));
  else parts.push('本帧未附带参考图：外观只能依据上面的文字描述，不得声称已参考立绘。');
  if (frame.bans.length) parts.push('禁止：' + frame.bans.join('、'));
  parts.push('画面中不得出现文字、字幕、水印或拼图边框。');
  return parts.filter(Boolean).join('\n');
}
function actionRequest(shot) {
  const parts = ['动作分阶段：' + shot.action.phases.map((phase, index) => (index + 1) + '）' + phase).join('；'),
    '速度与节奏：' + (shot.action.speed === 1 ? '按实时速度，不加速不拉伸' : '变速 ' + shot.action.speed + '（' + (shot.action.paceNote || '已声明') + '）'),
    '收势：' + shot.action.settle,
    '与下一镜的连接：' + (shot.action.continuity.length ? shot.action.continuity.join('；') : shot.endState),
    '机位：' + shot.camera];
  if (shot.action.secondary.length) parts.push('次要运动：' + shot.action.secondary.join('、'));
  parts.push('必须保持的连续性：' + shot.startState + ' → ' + shot.endState);
  return parts.join('\n');
}// ---------------------------------------------------------------- the video execution plan
// A shot's video request is a DECISION, and the decision is taken before the first submission of the run: which
// adapter branch is used (first+last keyframes, or the first frame plus the driving audio for lip sync), the
// complete action prompt, the seconds the provider is asked for, how much of the returned clip the film uses,
// where the driving audio sits inside the shot, and what no check here can prove. The plan is plain data: the
// record and the request are built from the SAME object, so a claim and a request can not drift apart.
const VIDEO_PLAN_VERSION = 1;
// wan2.2-kf2v-flash generates exactly 5 seconds from a first and a last frame.
const VENDOR_KEYFRAME_SECONDS = 5;
// wan2.7-i2v drives a mouth from an audio track; its documented input window is 2-15 seconds.
const VENDOR_DRIVING_MIN_SECONDS = 2;
const VENDOR_DRIVING_MAX_SECONDS = 15;
const PLAN_TOLERANCE = 0.05;
const LIP_SYNC_DECLARATION = '口型：本镜人物只按输入音频说话，不加旁白、不念字幕，保持身份与服装一致，嘴部清晰可见；画面不得出现文字、字幕或水印。';
const CLOSED_MOUTH_DECLARATION = '口型：本镜没有口型驱动（说话由后期音轨提供），画中所有人物保持闭口，不出现说话口型；画面不得出现文字、字幕或水印。';
function videoPlanError(code, detail) {
  const error = new Error(code + '：' + detail);
  error.code = code; error.detail = detail;
  return error;
}
function planSeconds(value, code, detail) {
  if (!Number.isFinite(value) || value <= 0) throw videoPlanError(code, detail);
  return Number(value.toFixed(3));
}
// The digest covers exactly the semantics the request carries, so a changed branch, model, seconds, prompt,
// anchor frame or driving-audio position can never be answered by the record of an older request.
function videoPlanDigest(plan) {
  return hash({ version: VIDEO_PLAN_VERSION, shot: plan.shot.id, branch: plan.branch, model: plan.model.id,
    requestSeconds: plan.model.requestSeconds, filmSeconds: plan.duration.filmSeconds,
    usage: [plan.duration.usageStart, plan.duration.usageEnd], prompt: plan.prompt.text,
    keyframes: [plan.keyframes.first.hash, plan.keyframes.last.hash],
    driving: plan.drivingAudio ? { lineId: plan.drivingAudio.lineId, sourceHash: plan.drivingAudio.sourceHash,
      pieces: plan.drivingAudio.pieces.map(piece => [piece.sourceStart, piece.sourceEnd, piece.inShotStart]) } : null });
}
function videoExecutionPlan(shot, { timeline = null, frames = null, audio = null, models = null } = {}) {
  if (!timeline || !Array.isArray(timeline.shots) || !timeline.shots.length)
    throw videoPlanError('CREATIVE_VIDEO_PLAN_REQUIRES_TIMELINE', '缺少配音时间线（audioSpans 与成片时间）：没有它无法确定驱动音频在镜头内的位置，不为凑任务而生成');
  if (!frames?.first || !frames?.last)
    throw videoPlanError('CREATIVE_VIDEO_PLAN_REQUIRES_FRAMES', (shot?.id || '?') + '：本镜首帧或尾帧不完整，缺少锚点时不生成视频');
  const entry = timeline.shots.find(item => item.id === shot.id);
  if (!entry) throw videoPlanError('CREATIVE_VIDEO_PLAN_UNKNOWN_SHOT', String(shot.id) + '：时间线里没有这个镜头');
  const filmSeconds = planSeconds(entry.duration, 'CREATIVE_VIDEO_PLAN_TIMELINE_INVALID', shot.id + '：时间线里的镜头时长为 ' + entry.duration);
  if (Math.abs(filmSeconds - shot.filmSeconds) > 0.02)
    throw videoPlanError('CREATIVE_VIDEO_PLAN_TIMELINE_MISMATCH', shot.id + '：分镜声明 ' + shot.filmSeconds + ' 秒，时间线是 ' + filmSeconds + ' 秒，两者不一致时不能决定生成哪一段');
  const supplierSeconds = planSeconds(shot.vendor?.modelSeconds, 'CREATIVE_VIDEO_PLAN_SUPPLIER_SECONDS', shot.id + '：缺少供应商生成时长（vendor.modelSeconds）');
  const drivingLine = shot.drivingLine || null;
  const spans = entry.audioSpans.filter(span => span.lineId === drivingLine);
  const uncovered = entry.audioSpans.filter(span => span.lineId !== drivingLine);
  const branch = drivingLine ? 'driving-audio' : 'keyframes';
  const model = branch === 'driving-audio' ? models?.dialogueVideo : models?.actionVideo;
  if (typeof model !== 'string' || !model) throw videoPlanError('CREATIVE_VIDEO_PLAN_MODEL_MISSING',
    shot.id + '：配置里没有 ' + (branch === 'driving-audio' ? 'models.dialogueVideo' : 'models.actionVideo') + '，不能凭空生成视频请求');
  let pieces = [], lastInShotEnd = 0, lipSync = null, drivingAudio = null;
  if (branch === 'driving-audio') {
    // A shot whose slot is compressed by a declared speed change can not keep the mouth on the film's own
    // audio: the provider acts in real time while the film would play the take retimed. Neither stretching the
    // take nor speeding the provider up is invented here.
    if (shot.action.speed !== 1) throw videoPlanError('CREATIVE_VIDEO_PLAN_PACE_UNSUPPORTED',
      shot.id + '：本镜声明了口型驱动，同时把成片槽位按变速 ' + shot.action.speed + ' 压缩；供应商按实时生成的面部动作无法与成片音轨的口型对齐，本轮不自动变速或变调');
    if (!audio?.file || !Number.isFinite(audio.duration)) throw videoPlanError('CREATIVE_VIDEO_PLAN_DRIVING_AUDIO_MISSING',
      shot.id + '：口型驱动需要 ' + drivingLine + ' 的已接受配音与实测时长，当前缺失；禁止在无音频的情况下生成口型');
    if (!spans.length) throw videoPlanError('CREATIVE_VIDEO_PLAN_DRIVING_SPAN_MISSING', shot.id + '：时间线里找不到 ' + drivingLine + ' 在本镜的音频区间');
    if (supplierSeconds < VENDOR_DRIVING_MIN_SECONDS || supplierSeconds > VENDOR_DRIVING_MAX_SECONDS)
      throw videoPlanError('CREATIVE_VIDEO_PLAN_REQUEST_SECONDS', shot.id + '：口型驱动适配器的输入音频窗口是 ' +
        VENDOR_DRIVING_MIN_SECONDS + '-' + VENDOR_DRIVING_MAX_SECONDS + ' 秒，当前声明 ' + supplierSeconds + ' 秒');
    pieces = spans.map(span => {
      const inShotStart = Number((span.filmStart - entry.start).toFixed(3));
      if (inShotStart < -PLAN_TOLERANCE) throw videoPlanError('CREATIVE_VIDEO_PLAN_SPAN_OUTSIDE_SHOT',
        shot.id + '：' + span.lineId + ' 的 ' + span.filmStart + ' 秒落在镜头开始之前，本镜不重复播放它');
      const start = Math.max(0, inShotStart);
      return { lineId: span.lineId, sourceStart: Number(span.sourceStart.toFixed(3)), sourceEnd: Number(span.sourceEnd.toFixed(3)),
        filmStart: span.filmStart, filmEnd: span.filmEnd, inShotStart: start,
        inShotEnd: Number((start + (span.sourceEnd - span.sourceStart)).toFixed(3)) };
    });
    lastInShotEnd = Math.max(...pieces.map(piece => piece.inShotEnd));
    const lastSourceEnd = Math.max(...pieces.map(piece => piece.sourceEnd));
    if (lastSourceEnd > audio.duration + PLAN_TOLERANCE) throw videoPlanError('CREATIVE_VIDEO_PLAN_SOURCE_TOO_SHORT',
      shot.id + '：时间线用到源音频 ' + lastSourceEnd + ' 秒，而已接受的配音只有 ' + audio.duration + ' 秒');
    // Which shots the same line runs through: a narration crossing a cut keeps ONE position basis, so the
    // in-shot offset of every piece is the position the audio bed actually plays it at.
    const bedShots = timeline.shots.filter(item => item.audioSpans.some(span => span.lineId === drivingLine)).map(item => item.id);
    lipSync = { required: true, lineId: drivingLine, sourceFile: audio.file, sourceHash: fileHash(audio.file),
      sourceSeconds: Number(audio.duration.toFixed(3)), sourceRange: [Math.min(...pieces.map(piece => piece.sourceStart)), lastSourceEnd],
      inShot: [pieces[0].inShotStart, lastInShotEnd], rate: 1, sameAsAudioBed: true, crossesShots: bedShots.length > 1,
      bedShotIds: bedShots, positionBasis: '驱动音频只取本镜区间（源 ' + pieces[0].sourceStart + '–' + lastSourceEnd + ' 秒），按成片时间线里同一段音频的实际位置做镜头内偏置（本镜从 ' +
        pieces[0].inShotStart + ' 秒处开始），不重新配音、不拉伸、不变调；成片音轨仍是整句混音，所以驱动音频与观众听到的是同一段声音',
      checked: 'technical', notProven: ['口型与声音是否真的对上只能由人验收：本地只校验音频可解码、时长与位置，抽帧检查也不能证明口型'] };
    drivingAudio = { lineId: drivingLine, sourceFile: audio.file, sourceHash: fileHash(audio.file), minimumSeconds: VENDOR_DRIVING_MIN_SECONDS,
      pieces: pieces.map(piece => ({ lineId: piece.lineId, sourceStart: piece.sourceStart, sourceEnd: piece.sourceEnd,
        inShotStart: piece.inShotStart, inShotEnd: piece.inShotEnd, filmStart: piece.filmStart, filmEnd: piece.filmEnd })),
      inShotStart: pieces[0].inShotStart, inShotEnd: lastInShotEnd,
      padToSeconds: Number(Math.max(VENDOR_DRIVING_MIN_SECONDS, lastInShotEnd).toFixed(3)),
      note: '本地按镜头内偏移拼接源音频的同一区间（复制，不重采样），不足供应商下限用静音补齐' };
  } else {
    if (supplierSeconds !== VENDOR_KEYFRAME_SECONDS) throw videoPlanError('CREATIVE_VIDEO_PLAN_KEYFRAME_SECONDS',
      shot.id + '：本镜没有口型驱动，使用首尾帧适配器 ' + model + '，它只生成 ' + VENDOR_KEYFRAME_SECONDS +
      ' 秒且必须同时给出首帧与尾帧；当前声明 ' + supplierSeconds + ' 秒');
    lipSync = { required: false, reason: '分镜没有为本镜声明口型驱动（drivingLine 为空），画面人物保持闭口' };
  }
  // The film may only use as much picture as the provider was asked for. A slot longer than the request would
  // need local retiming or repeated frames, and neither is invented here.
  if (supplierSeconds + PLAN_TOLERANCE < filmSeconds) throw videoPlanError('CREATIVE_VIDEO_PLAN_SLOT_LONGER_THAN_REQUEST',
    shot.id + '：成片槽位 ' + filmSeconds + ' 秒比供应商生成时长 ' + supplierSeconds + ' 秒长（vendor.coverage=' +
    (shot.vendor?.coverage || 'null') + '）；本轮不自动提速、不补帧，请重新规划分镜或显式声明本地补足');
  if (drivingAudio && lastInShotEnd + PLAN_TOLERANCE > supplierSeconds) throw videoPlanError('CREATIVE_VIDEO_PLAN_REQUEST_TOO_SHORT',
    shot.id + '：驱动音频在本镜最晚到 ' + lastInShotEnd + ' 秒，供应商只生成 ' + supplierSeconds + ' 秒；不把口型拖到镜头之外');
  const plan = {
    version: VIDEO_PLAN_VERSION, shotId: shot.id, branch,
    shot: { id: shot.id, purpose: shot.purpose, scene: shot.scene, transition: shot.transition,
      characters: shot.characters.map(cast => cast.id), castNote: shot.castNote || null,
      start: entry.start, end: entry.end, filmSeconds, speed: shot.action.speed,
      startState: shot.startState, endState: shot.endState, camera: shot.camera },
    model: { id: model, branch, requestSeconds: supplierSeconds,
      role: branch === 'driving-audio' ? '口型驱动适配器（首帧+驱动音频→视频）' : '首尾帧适配器（首帧+尾帧→视频）' },
    keyframes: { first: { file: frames.first, hash: fileHash(frames.first) }, last: { file: frames.last, hash: fileHash(frames.last) },
      role: '首帧与尾帧都是锚点，生成请求必须同时给出' },
    duration: { supplierSeconds, requestSeconds: supplierSeconds, filmSeconds, usageStart: 0, usageEnd: filmSeconds,
      usageSeconds: filmSeconds, coverage: shot.vendor?.coverage || null, vendorNote: shot.vendor?.note || null,
      tailDiscardedSeconds: Number(Math.max(0, supplierSeconds - filmSeconds).toFixed(3)),
      basis: '向供应商要 ' + supplierSeconds + ' 秒，成片只取前 ' + filmSeconds + ' 秒，其余画面不进入成片、也不拼进下一镜' },
    prompt: { text: actionRequest(shot) + '\n' + (branch === 'driving-audio' ? LIP_SYNC_DECLARATION : CLOSED_MOUTH_DECLARATION),
      basis: '完整动作提示词（分阶段动作、速度、收势、与下一镜的连接、机位、次要运动、首尾状态）',
      parts: { phases: shot.action.phases, speed: shot.action.speed, paceNote: shot.action.paceNote || null,
        settle: shot.action.settle, continuity: shot.action.continuity, secondary: shot.action.secondary,
        camera: shot.camera, startState: shot.startState, endState: shot.endState } },
    lipSync, drivingAudio,
    // Audio that is heard in this shot but does not drive its mouth is recorded, not hidden: for a narration
    // shot this is exactly why the request asks for everyone to keep their mouth closed.
    uncoveredAudio: { spans: uncovered.map(span => ({ lineId: span.lineId, sourceStart: span.sourceStart,
      sourceEnd: span.sourceEnd, filmStart: span.filmStart, filmEnd: span.filmEnd })),
      note: uncovered.length ? '这些音频在本镜不驱动口型（' + (drivingLine ? '本镜只用 ' + drivingLine + ' 驱动口型' :
        '分镜未声明本镜需要口型驱动') + '）；画面按闭口要求生成，抽帧检查也不能证明口型或声音' : null } };
  plan.digest = videoPlanDigest(plan);
  return plan;
}// ---------------------------------------------------------------- script derivation and invalidation
// The storyboard is the source; the shot objects consumed by the existing generation/check/rework pipeline
// are derived from it, so downstream stages read the new structure instead of an old summary.
function scriptFromStoryboard(board, { title = '', characters = null, scenes = null, style = '', aspect = '16:9' } = {}) {
  const shots = board.shots.map(shot => {
    const driving = shot.segments.find(fragment => fragment.lineId === shot.drivingLine) || null;
    return { id: shot.id, type: 'action', characters: shot.characters.map(cast => cast.id), speaker: null, text: '', emotion: '',
      scene: frameRequest(shot, { characters, scenes, kind: 'first', style, aspect }),
      endScene: frameRequest(shot, { characters, scenes, kind: 'last', style, aspect }),
      action: actionRequest(shot), needsLastFrame: true, duration: shot.filmSeconds,
      startState: shot.startState, endState: shot.endState, primaryAction: shot.action.phases[0],
      beats: shot.action.phases.slice(0, 3), cut: shot.transition, handoff: shot.startState,
      // Storyboard-driven shots carry their own duration and their own driving audio slice.
      storyboard: true, videoModel: 'i2v',
      drivingAudio: driving ? { lineId: driving.lineId, sourceStart: driving.sourceStart, sourceEnd: driving.sourceEnd } : null };
  });
  return { title: title || 'storyboard', storyboardTimed: true, shots };
}
// Which shots still carry frame text that was written for a setting which has since been replaced. A run must
// stop on this list instead of generating frames from a spliced description.
function staleSettingShots(board) {
  return (board?.shots || []).filter(shot => shot.settingsStale).map(shot => ({ id: shot.id,
    kind: shot.settingsStale.kind || null, target: shot.settingsStale.target || null,
    field: shot.settingsStale.field || null, reason: shot.settingsStale.reason || null }));
}
// Which downstream artefacts a change invalidates. Only the affected shots are listed: a dialogue edit does
// not force the whole film to be re-generated, but a timing change must reach the shots that carry it.
function invalidations(changed, creative = {}, board = null) {
  const shots = board?.shots || [];
  const result = { voicePlan: false, storyboard: false, timeline: false, shots: [], prompts: [], checks: [],
    adjacentPairs: [], acceptance: false, composition: false, reasons: [],
    detail: { kind: changed.kind, direct: [], neighbours: [], neighbourOnly: [], frames: [], basis: {} } };
  const add = (list, id) => { if (id && !list.includes(id)) list.push(id); };
  const hit = (ids, reason) => { for (const id of ids) { add(result.shots, id); add(result.prompts, id); add(result.checks, id); } result.reasons.push(reason); };
  const indexOf = id => shots.findIndex(shot => shot.id === id);
  // Maximal contiguous runs of hit shots: a scene may return later in the film, and each run needs its own
  // boundary neighbours — assuming a single block would leave a stale prompt or check in place elsewhere.
  const runsOf = ids => {
    const indexes = [...new Set(ids.map(indexOf).filter(index => index >= 0))].sort((left, right) => left - right);
    const runs = [];
    for (const index of indexes) {
      const last = runs[runs.length - 1];
      if (last && index === last.end + 1) last.end = index; else runs.push({ start: index, end: index });
    }
    return runs;
  };
  const neighboursOf = ids => {
    const out = [];
    for (const run of runsOf(ids)) { add(out, shots[run.start - 1]?.id); add(out, shots[run.end + 1]?.id); }
    return out.filter(id => !ids.includes(id));
  };
  const neighbourOnly = ids => {
    const out = neighboursOf(ids);
    for (const id of out) { add(result.prompts, id); add(result.checks, id); }
    for (const id of out) if (!result.detail.neighbourOnly.includes(id)) result.detail.neighbourOnly.push(id);
    return out;
  };
  // Every adjacent pair that touches a changed shot: the continuity verdict was taken against the old content,
  // so the PAIR's conclusion is invalidated — without rebuilding the unchanged neighbour's own material.
  const pairsFor = ids => {
    const out = [];
    for (let index = 1; index < shots.length; index++) {
      const from = shots[index - 1].id, to = shots[index].id;
      if (ids.includes(from) || ids.includes(to))
        out.push({ from, to, reason: ids.includes(from) && ids.includes(to) ? '两镜都在本次变更范围内'
          : '相邻镜的一方已变更，衔接结论需要重做' });
    }
    return out;
  };
  const frameStatesOf = shot => [...(shot.first?.castState || []), ...(shot.last?.castState || []),
    ...(shot.first?.extraCast || []), ...(shot.last?.extraCast || [])];
  if (changed.kind === 'dialogue') {
    result.voicePlan = true; result.storyboard = true; result.timeline = true; result.acceptance = true;
    result.composition = true;
    const lineIds = changed.lineIds || [];
    const carrying = shots.filter(shot => shot.segments.some(fragment => lineIds.includes(fragment.lineId))).map(shot => shot.id);
    hit(carrying, '台词变更：配音计划、分镜、时间线与音频验收绑定失效');
    result.adjacentPairs = pairsFor(carrying);
    // The take of every changed line really has to be recorded again, so the speech unit moves with it.
    result.detail.basis = { lineIds, replanned: true, reRecord: true };
  } else if (changed.kind === 'audio') {
    result.storyboard = true; result.timeline = true; result.acceptance = true; result.composition = true;
    const lineIds = changed.lineIds || [];
    const carrying = shots.filter(shot => shot.segments.length).map(shot => shot.id);
    // A shot whose own DRIVING take changed must be made again; a shot that merely HEARS the audio keeps its
    // picture and loses only the checks that were taken against it.
    const driven = shots.filter(shot => shot.drivingLine && (!lineIds.length || lineIds.includes(shot.drivingLine))).map(shot => shot.id);
    const full = lineIds.length ? driven : carrying;
    hit(full, '接受音频变更：分镜、时间线、字幕与验收绑定失效；用该段音频驱动口型的镜头需重做');
    for (const id of carrying) if (!full.includes(id)) { add(result.prompts, id); add(result.checks, id); }
    const neighbours = neighbourOnly(carrying);
    result.detail.basis = { lineIds, carrying, driven, neighbours, reRecord: changed.decision !== 'invalidate' };
  } else if (changed.kind === 'scene') {
    const direct = shots.filter(shot => shot.scene.id === changed.sceneId).map(shot => shot.id);
    hit(direct, '场景设定变更：引用该场景的镜头、提示词、相关帧/视频检查与最终合成失效');
    result.composition = true;
    const neighbours = neighbourOnly(direct);
    result.adjacentPairs = pairsFor(direct);
    result.detail.basis = { sceneId: changed.sceneId, runs: runsOf(direct), neighbours };
  } else if (changed.kind === 'equipment' || changed.kind === 'costume') {
    const field = changed.field || 'any';
    const direct = [], frameHits = [];
    for (const shot of shots) {
      const named = shot.characters.some(item => item.id === changed.characterId);
      const frames = frameStatesOf(shot);
      const inFrame = frames.some(person => person.id === changed.characterId);
      const crowd = changed.crowd === true && !!(shot.first?.crowdCostume || shot.last?.crowdCostume);
      // Where the change really reaches: the named cast list is not enough, because a person can appear in the
      // frame's castState/extraCast without being part of shot.characters (and the other way round).
      const carried = changed.crowd === true ? crowd
        : field === 'weapon'
          ? frames.some(person => person.id === changed.characterId && ((person.props || []).length || person.hands))
            || shot.characters.some(item => item.id === changed.characterId && (item.props || []).length)
          : named || inFrame;
      if (carried) { add(direct, shot.id); frameHits.push({ shot: shot.id, named, frame: inFrame, crowd }); }
    }
    hit(direct, '服饰或装备设定变更：实际引用该设定的镜头、逐帧状态、提示词与检查失效');
    result.composition = true;
    result.adjacentPairs = pairsFor(direct);
    result.detail.basis = { characterId: changed.characterId, field, crowd: changed.crowd === true, frameHits };
  } else if (changed.kind === 'storyboard') {
    // The board itself is re-authored: its per-frame wording was written for a setting that has been replaced, so
    // every shot's text may change. That puts every shot's products and checks in scope, while the accepted audio
    // and its measured durations stay exactly as they are.
    const all = shots.map(shot => shot.id);
    hit(all, '分镜受控重规划：逐帧文字与动作提示词按新设定重写，相关帧/视频与检查失效；已接受的配音与实测时长不变');
    result.storyboard = true; result.timeline = true; result.composition = true;
    result.detail.basis = { reason: changed.reason || null, shots: all };
  } else if (changed.kind === 'adjacent') {
    const pair = changed.pair || {};
    if (!pair.from || !pair.to) fail('INVALIDATION_PAIR_REQUIRED');
    result.adjacentPairs = [{ from: pair.from, to: pair.to, reason: changed.reason || '相邻关系变更：该对衔接结论失效' }];
    add(result.checks, pair.to);
    // Only the pair's own conclusion is invalidated: neither shot is rebuilt merely for being adjacent.
    result.detail.basis = { pair: { from: pair.from, to: pair.to }, rework: 'none' };
    result.reasons.push(result.adjacentPairs[0].reason);
  } else fail('INVALIDATION_KIND:' + changed.kind);
  result.detail.direct = [...result.shots];
  result.detail.neighbours = neighboursOf(result.shots);
  result.detail.frames = result.shots.filter(id => !result.detail.neighbourOnly.includes(id));
  return result;
}
function creativeDigests(creative) {
  const parts = {};
  for (const key of ['requirements', 'directorScript', 'characters', 'scenes', 'voicePlan', 'storyboard'])
    parts[key] = creative?.[key] ? hash(creative[key]) : null;
  return parts;
}

module.exports = { CHARACTER_FIELDS, CLAIM_STATUSES, CONFLICT_BASES, COVERAGE, CREATIVE_VERSION, ESTIMATE_METHODS,
  MUST_KINDS, SOURCES, SPEAK_KINDS, VENDOR_DRIVING_MAX_SECONDS,
  VENDOR_DRIVING_MIN_SECONDS, VENDOR_KEYFRAME_SECONDS, VERIFICATION_KINDS, VIDEO_PLAN_VERSION, actionRequest, appearanceLabel, castLine, characterBible,
  creativeDigests, directorScript, durationEstimate, durationLedger, frameRequest, invalidations, manifestCitations,
  provenanceClaim, requirementBrief, sceneBible, sceneLine, sourceLabel,
  scriptFromStoryboard, staleSettingShots, storyboard, storyboardTimeline, videoExecutionPlan, videoPlanDigest, voicePlan };
