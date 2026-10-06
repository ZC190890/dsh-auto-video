const path = require('node:path');
const { hash, withLock } = require('../services/aliyun/io');
const { characterBible, directorScript, durationLedger, invalidations, sceneBible, staleSettingShots, voicePlan } = require('../services/aliyun/creative');
const { creativeAuthority, recordCreativeAuthority } = require('./creative');
const { preflight } = require('./operations-map');
const { loadState, saveState } = require('./production');

// A controlled revision is the ONLY path that may widen a production on purpose. It validates the new value
// with the SAME validators the authoring path uses, computes the dependency scope from the current storyboard,
// preflights every affected operation (unresolved work, the round ledger, damaged records) and only then
// persists the new setting, the invalidations and the new revision numbers together.
//
// Two things are deliberately kept apart:
//   1) a revision the user asked for through this command, and
//   2) a package that was edited by hand: that one is not accepted here as an authorisation, so it is refused
//      with CREATIVE_REVISION_UNKNOWN_BASIS and keeps the existing input-change protections intact.
// Running the same revision twice changes nothing (idempotent): no version is advanced twice and no unit round
// is consumed twice.
const KINDS = ['scene', 'equipment', 'costume', 'dialogue', 'audio', 'storyboard', 'adjacent'];
const OPERATION_PREFIXES = { full: ['first', 'last', 'frame-check', 'video', 'video-check'],
  checks: ['frame-check', 'video-check'] };
const ASSET_FIELDS = { full: ['first', 'last', 'frameReview', 'video', 'videoInfo', 'videoReview', 'referencePlan',
  'referencePause', 'videoPause', 'qualityPause', 'adjacentReview', 'drivingAudio'],
  checks: ['frameReview', 'videoReview', 'referencePlan', 'adjacentReview'] };

function sanitizeRequest(request) { return JSON.parse(JSON.stringify(request)); }
function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('CREATIVE_REVISION_SHAPE');
  if (!KINDS.includes(request.kind)) throw new Error('CREATIVE_REVISION_KIND:' + request.kind);
  return request.kind;
}
// The candidate package is built with the authoring validators, so a revision cannot smuggle in a value the
// authoring path would have refused.
function applyRequest(context, candidate, request) {
  const characterIds = (context.production.characters || []).map(item => item.id);
  if (request.kind === 'scene') {
    const stored = candidate.scenes.entries.find(entry => entry.id === request.target);
    if (!stored) throw new Error('CREATIVE_REVISION_SCENE_UNKNOWN:' + request.target);
    if (!request.scene || typeof request.scene !== 'object') throw new Error('CREATIVE_REVISION_SCENE_REQUIRED');
    const entries = candidate.scenes.entries.map(entry => entry.id === request.target
      ? { ...request.scene, id: request.target } : entry);
    const validated = sceneBible({ entries }, { production: context.production, requirements: candidate.requirements });
    const next = validated.entries.find(entry => entry.id === request.target);
    candidate.scenes = { ...candidate.scenes, version: validated.version, entries: validated.entries };
    return { changed: hash(stored) !== hash(next), change: { kind: 'scene', sceneId: request.target,
      field: request.field || 'setting', note: request.note || null } };
  }
  if (request.kind === 'equipment' || request.kind === 'costume') {
    const stored = candidate.characters.entries.find(entry => entry.id === request.target);
    if (!stored) throw new Error('CREATIVE_REVISION_CHARACTER_UNKNOWN:' + request.target);
    if (!request.character || typeof request.character !== 'object') throw new Error('CREATIVE_REVISION_CHARACTER_REQUIRED');
    const entries = candidate.characters.entries.map(entry => entry.id === request.target
      ? { ...request.character, id: request.target } : entry);
    const validated = characterBible({ entries }, { production: context.production });
    const next = validated.entries.find(entry => entry.id === request.target);
    candidate.characters = { ...candidate.characters, version: validated.version, entries: validated.entries };
    return { changed: hash(stored) !== hash(next),
      change: { kind: 'equipment', characterId: request.target, field: request.field || 'any',
        crowd: request.crowd === true, note: request.note || null } };
  }
  // Re-authoring the board is its own controlled revision, and it has exactly one legitimate cause: shots whose
  // frame text was written for a setting that has since been replaced. It is refused as a general-purpose
  // re-plan, so it can never be used to paper over a change nobody authorised.
  if (request.kind === 'storyboard') {
    const board = candidate.storyboard;
    if (!board) throw new Error('CREATIVE_REVISION_REQUIRES_STORYBOARD');
    if (request.decision !== 'replan') throw new Error('CREATIVE_REVISION_DECISION_REQUIRED:分镜重规划必须显式写 decision=replan');
    const stale = staleSettingShots(board);
    if (!stale.length) throw new Error('CREATIVE_REVISION_STORYBOARD_NOT_STALE:' +
      '当前分镜没有被取代的设定文字，无需重规划；本入口不接受其它用途的重新规划');
    return { changed: true, change: { kind: 'storyboard', decision: 'replan', shots: stale.map(item => item.id),
      superseded: stale, note: request.note || null } };
  }
  return applyWordsRequest(context, candidate, request, characterIds);
}
// The two changes that move WORDS (and therefore the audio and the storyboard bound to that audio).
// A tone review is bound to the audio it actually heard, so replacing that audio retires the review with it.
// The retired record is kept as history instead of being deleted silently.
function supersedeToneReviews(candidate, lineIds, reason) {
  if (!candidate.toneReviews) return;
  for (const id of lineIds) {
    if (!candidate.toneReviews[id]) continue;
    (candidate.toneReviewHistory ||= []).push({ lineId: id, at: new Date().toISOString(), reason,
      review: candidate.toneReviews[id] });
    delete candidate.toneReviews[id];
  }
}
function applyWordsRequest(context, candidate, request, characterIds) {
  if (request.kind === 'dialogue') {
    const replacement = new Map((request.lines || []).map(line => [line.id, line]));
    if (!replacement.size) throw new Error('CREATIVE_REVISION_LINES_REQUIRED');
    for (const id of replacement.keys())
      if (!candidate.voicePlan.lines.some(line => line.id === id)) throw new Error('CREATIVE_REVISION_LINE_UNKNOWN:' + id);
    // The words live in two places (the director's spoken lines and the voice plan) and the validator insists
    // that they are identical, so a revision moves both or neither. A must-keep line whose text the user
    // specified is refused by the director validator instead of being reworded here.
    const director = structuredClone(candidate.directorScript);
    for (const segment of director.segments)
      for (const spoken of segment.spoken) if (replacement.has(spoken.id)) spoken.text = replacement.get(spoken.id).text;
    const validatedDirector = directorScript(director, { requirements: candidate.requirements, characterIds });
    const lines = candidate.voicePlan.lines.map(line => replacement.has(line.id)
      ? { ...line, text: replacement.get(line.id).text,
        ...(replacement.get(line.id).performance ? { performance: replacement.get(line.id).performance } : {}),
        ...(replacement.get(line.id).durationEstimate !== undefined
          ? { durationEstimate: replacement.get(line.id).durationEstimate } : {}) }
      : line);
    const validatedPlan = voicePlan({ lines }, { director: validatedDirector, characterIds, requirements: candidate.requirements });
    const changed = hash(validatedDirector) !== hash(candidate.directorScript) || hash(validatedPlan) !== hash(candidate.voicePlan);
    candidate.directorScript = validatedDirector;
    candidate.voicePlan = validatedPlan;
    // Changed words make the accepted take, its acceptance and the storyboard built on that acceptance stale.
    // They remain in history and the run stops at the ordinary acceptance gate until the new take is accepted.
    candidate.audio = { ...(candidate.audio || {}) };
    for (const id of replacement.keys()) delete candidate.audio[id];
    // The automatic tone review belonged to the take that just disappeared: it is kept as history and taken
    // again for the new take instead of being carried over to audio it never heard.
    supersedeToneReviews(candidate, replacement.keys(), '台词已受控修订：旧配音与旧语气结论一并作废');
    delete candidate.acceptance;
    delete candidate.storyboard;
    delete candidate.timeline;
    return { changed, change: { kind: 'dialogue', lineIds: [...replacement.keys()], note: request.note || null } };
  }
  if (request.kind === 'audio') {
    const lineIds = (request.lineIds?.length ? request.lineIds : [request.target]).filter(Boolean);
    if (!lineIds.length) throw new Error('CREATIVE_REVISION_LINES_REQUIRED');
    for (const id of lineIds)
      if (!candidate.voicePlan.lines.some(line => line.id === id)) throw new Error('CREATIVE_REVISION_LINE_UNKNOWN:' + id);
    const reRecord = request.decision !== 'invalidate';
    const changed = reRecord ? lineIds.some(id => !!candidate.audio?.[id]) : !!candidate.acceptance;
    if (reRecord) {
      for (const id of lineIds) delete candidate.audio[id];
      supersedeToneReviews(candidate, lineIds, '该句配音已按受控修订重录：旧语气结论一并作废');
    }
    // Either way the acceptance belonged to the old take, and the storyboard belonged to that acceptance.
    delete candidate.acceptance;
    delete candidate.storyboard;
    delete candidate.timeline;
    return { changed, change: { kind: 'audio', lineIds, decision: reRecord ? 're-record' : 'invalidate',
      note: request.note || null } };
  }
  // Adjacency: only the pair's own conclusion is invalidated — neither shot is rebuilt merely for being next
  // to a changed one.
  const board = candidate.storyboard;
  const from = request.from || request.pair?.from || null;
  const to = request.to || request.pair?.to || request.target;
  if (!board) throw new Error('CREATIVE_REVISION_REQUIRES_STORYBOARD');
  if (!from || !to || !board.shots.some(shot => shot.id === from) || !board.shots.some(shot => shot.id === to))
    throw new Error('CREATIVE_REVISION_PAIR_UNKNOWN:' + String(from) + '->' + String(to));
  return { changed: true, change: { kind: 'adjacent', pair: { from, to }, note: request.note || null } };
}
// The operations a revision must preflight before anything is written. Full rework moves frames, video and
// their checks; a neighbour or a pair only loses checks, so its own material is not rebuilt.
function revisionOperations(scope) {
  const bases = [];
  const add = base => { if (!bases.includes(base)) bases.push(base); };
  // A revision that really re-records a line moves that line's SPEECH unit too: the new take must not land on the
  // old operation number (it would either be reused as the old take or refused as OPERATION_INPUT_CHANGED).
  if (scope.detail?.basis?.reRecord === true)
    for (const id of scope.detail.basis.lineIds || []) add('speech-' + id);
  for (const id of scope.shots) for (const prefix of OPERATION_PREFIXES.full) add(prefix + '-' + id);
  for (const id of scope.checks) for (const prefix of OPERATION_PREFIXES.checks) add(prefix + '-' + id);
  for (const pair of scope.adjacentPairs) add('adjacent-check-' + pair.to);
  return bases;
}
// Everything a revision changes is written in ONE step, and only after every check above passed: the setting,
// the affected products, the film pointers, the revision numbers, the history entry and the new authority
// record. An interruption therefore cannot leave a half-applied revision behind, and the history, the ledger
// and the material of untouched shots are never rewritten.
function applyCreativeRevision(context, state, candidate, applied, scope, advance) {
  const creative = state.creative, kind = applied.change.kind;
  const boardBefore = creative.storyboard || null;
  if (kind === 'scene') creative.scenes = candidate.scenes;
  else if (kind === 'equipment') creative.characters = candidate.characters;
  else if (kind === 'dialogue') {
    creative.directorScript = candidate.directorScript; creative.voicePlan = candidate.voicePlan;
    // The cleaned audio map is applied HERE. Only the lines whose words changed lost their take in the
    // candidate, so a changed line can never keep using the audio of the words it no longer says, while every
    // untouched line keeps its own recorded and accepted take.
    creative.audio = candidate.audio;
    if (candidate.toneReviews) creative.toneReviews = candidate.toneReviews;
    if (candidate.toneReviewHistory) creative.toneReviewHistory = candidate.toneReviewHistory;
  } else if (kind === 'audio') {
    creative.audio = candidate.audio;
    if (candidate.toneReviews) creative.toneReviews = candidate.toneReviews;
    if (candidate.toneReviewHistory) creative.toneReviewHistory = candidate.toneReviewHistory;
  } else if (kind === 'storyboard') {
    // The board is re-authored in the next run from the CURRENT settings: nothing of the superseded wording is
    // carried over, and the reason it was needed stays recorded beside the products it did not touch.
    creative.storyboardReplan = { at: new Date().toISOString(), reason: applied.change.note || null,
      shots: applied.change.shots, superseded: applied.change.superseded || [],
      previousBinding: boardBefore?.audioBinding || null,
      previousShots: (boardBefore?.shots || []).length,
      next: '下一轮 run 由分镜阶段按当前设定重新规划（逐帧文字与动作提示词重写）；已接受的配音与实测时长不变' };
    delete creative.storyboard;
    delete creative.timeline;
  }
  if (kind === 'dialogue' || kind === 'audio') {
    // The acceptance, the storyboard and the timeline belonged to the previous words or take. They stay in the
    // history entry; the run stops at the ordinary acceptance gate until a new take is accepted.
    delete creative.acceptance;
    delete creative.storyboard;
    delete creative.timeline;
  }
  // A revised setting cannot be pasted onto frame text that was written for the old one. The affected shots are
  // marked here, at the ONE place a setting may change, and the run stops on that mark until the board is
  // re-authored through the controlled re-plan. The old wording is preserved, never rewritten in place.
  if (['scene', 'equipment', 'costume'].includes(kind) && creative.storyboard) {
    const marker = { at: new Date().toISOString(), kind,
      target: applied.change.sceneId || applied.change.characterId || null, field: applied.change.field || null,
      crowd: applied.change.crowd === true, reason: applied.change.note || null,
      requires: 'controlled-storyboard-replan',
      note: '本镜逐帧状态与可见环境是按修订前的设定写的：不得与新设定拼接生成，需受控重新规划分镜' };
    for (const id of scope.shots) {
      const shot = creative.storyboard.shots.find(item => item.id === id);
      if (shot) shot.settingsStale = { ...marker, writtenFor: shot.settings || null };
    }
  }
  for (const id of scope.shots) {
    const asset = state.assets?.[id];
    if (asset) for (const key of ASSET_FIELDS.full) delete asset[key];
    if (creative.frames) delete creative.frames[id];
    if (creative.videos) delete creative.videos[id];
    if (creative.actions) delete creative.actions[id];
  }
  // A neighbour keeps its own frames and video: only what was derived from the changed shot is dropped, so the
  // next run decides with a fresh check instead of rebuilding the neighbour unconditionally.
  for (const id of scope.checks) {
    if (scope.shots.includes(id)) continue;
    const asset = state.assets?.[id];
    if (asset) for (const key of ASSET_FIELDS.checks) delete asset[key];
  }
  for (const pair of scope.adjacentPairs) {
    if (state.adjacencyReviews) delete state.adjacencyReviews[pair.to];
    for (const id of [pair.from, pair.to]) {
      const asset = state.assets?.[id];
      if (asset) delete asset.adjacentReview;
    }
  }
  state.revisions ||= {};
  for (const item of advance) state.revisions[item.base] = item.revision;
  // A change that reaches the picture or the sound also invalidates the FILM of the previous input: the old
  // film stays on disk as its own version, the pointer and the playback acceptance of that film are cleared,
  // and the composition record is kept as history instead of being overwritten.
  if (scope.composition) {
    if (creative.composition) { (creative.compositions ||= []).push(creative.composition); delete creative.composition; }
    for (const key of ['timed', 'output', 'preview', 'finalBlockers', 'acceptance']) delete state[key];
  }
  creative.durationLedger = durationLedger(creative, { maxSeconds: context.production.maxDurationSeconds,
    targetSeconds: context.production.targetDurationSeconds });
  return creative;
}
async function reviseCreative(context, request, reason) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('REVISION_REASON_REQUIRED');
  validateRequest(request);
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    const creative = state.creative;
    if (!creative?.voicePlan) throw new Error('CREATIVE_REVISION_REQUIRES_CREATIVE');
    // 1) What this revision is based on. A package edited outside the controlled paths is refused here instead
    //    of being certified by this command: a direct edit is not an authorisation.
    const authority = creativeAuthority(creative);
    if (authority.reason === 'changed-outside-a-controlled-entry')
      throw new Error('CREATIVE_REVISION_UNKNOWN_BASIS:当前创作产物与上次登记的摘要不一致（可能被直接修改）；' +
        '请先核实或用受控流程重新规划，不把直接修改当成授权修订');
    // 2) The same request twice is the same revision: nothing is advanced a second time.
    const requestDigest = hash({ kind: request.kind, request: sanitizeRequest(request) });
    const appliedBefore = (creative.revisions || []).find(entry => entry.requestDigest === requestDigest);
    if (appliedBefore)
      throw new Error('CREATIVE_REVISION_ALREADY_APPLIED:' + appliedBefore.revision + ':同一修订已经执行过，不重复推进版本号');
    // 3) The new value, validated by the validators the authoring path uses.
    const candidate = structuredClone(creative);
    const applied = applyRequest(context, candidate, request);
    if (!applied.changed) throw new Error('CREATIVE_REVISION_UNCHANGED:本次修订没有改变任何内容，不推进版本号');
    // 4) The scope, computed from the CURRENT board for every hit shot (all runs, not one contiguous block).
    const scope = invalidations(applied.change, candidate, creative.storyboard || null);
    // 5) Every affected operation is checked before anything is written: unresolved work blocks, the
    //    authoritative ledger must match, a damaged record is never treated as absent, and an exhausted unit
    //    stops the revision instead of being reset by it.
    const advance = preflight(context, state, revisionOperations(scope),
      { recordMissing: 'CREATIVE_REVISION_RESERVED_OPERATION_MISSING', blocked: 'CREATIVE_REVISION_BLOCKED_UNRESOLVED_OPERATION',
        ledger: 'CREATIVE_REVISION_LEDGER_ENTRY_MISSING', exhausted: 'CREATIVE_REVISION_ATTEMPTS_EXHAUSTED',
        corrupt: 'CREATIVE_REVISION_RECORD_CORRUPT' });
    // 6) History first: the superseded package, products and film pointers are preserved, never rewritten.
    const scopeRecord = { shots: scope.shots, prompts: scope.prompts, checks: scope.checks,
      neighbourOnly: scope.detail.neighbourOnly, adjacentPairs: scope.adjacentPairs, composition: scope.composition,
      acceptance: scope.acceptance, reasons: scope.reasons, basis: scope.detail.basis };
    state.history ||= [];
    state.history.push({ kind: 'creative-revision', at: new Date().toISOString(), reason, request: sanitizeRequest(request),
      change: applied.change, scope: scopeRecord, authority: authority.recorded || null,
      creative: structuredClone(creative), assets: structuredClone(state.assets || {}), timeline: state.timed || null,
      output: state.output || null, preview: state.preview || null, acceptance: state.acceptance || null });
    applyCreativeRevision(context, state, candidate, applied, scope, advance);
    state.editRevision = (state.editRevision || 0) + 1;
    creative.revisions ||= [];
    creative.revisions.push({ at: new Date().toISOString(), revision: state.editRevision, kind: applied.change.kind,
      target: request.target || null, reason, requestDigest, change: applied.change, scope: scopeRecord });
    recordCreativeAuthority(creative, { by: 'controlled-revision', reason });
    saveState(context, state);
    return { revision: state.editRevision, kind: applied.change.kind, target: request.target || null, authorized: true,
      affectedShots: scope.shots, promptsInvalidated: scope.prompts, checksInvalidated: scope.checks,
      neighbourOnly: scope.detail.neighbourOnly, adjacentPairs: scope.adjacentPairs,
      compositionInvalidated: scope.composition,
      acceptanceInvalidated: scope.acceptance || ['dialogue', 'audio'].includes(applied.change.kind),
      // Which takes this revision really replaced (only those lines), and which of them must be recorded again
      // under a new operation number instead of landing on the old one.
      audioInvalidated: ['dialogue', 'audio'].includes(applied.change.kind) ? (applied.change.lineIds || []) : [],
      speechReRecorded: scope.detail?.basis?.reRecord === true ? (scope.detail.basis.lineIds || []) : [],
      // A revised setting leaves frame text that was written for the old one: those shots are named here and must
      // go through the controlled storyboard re-plan before anything is generated from them again.
      settingsSupersededShots: ['scene', 'equipment', 'costume'].includes(applied.change.kind) ? scope.shots : [],
      storyboardReplanRequired: ['scene', 'equipment', 'costume', 'storyboard'].includes(applied.change.kind),
      revisions: Object.fromEntries(advance.map(item => [item.base, item.revision])),
      reasons: scope.reasons, networkRequests: 0 };
  });
}
module.exports = { KINDS, applyCreativeRevision, applyRequest, applyWordsRequest, reviseCreative, revisionOperations, validateRequest };
