const fs = require('node:fs');
const path = require('node:path');
const { readJson, hash, withLock } = require('../services/aliyun/io');
const { validateScript } = require('../services/aliyun/schema');
const { loadState, saveState } = require('./production');
const { deliveryChange, preflight, scriptChangeScopes } = require('./operations-map');

// A local revision never submits requests and never removes historical reservations. The invalidation
// scope is computed jointly from the script fields and from the performance parameters that actually
// reach a speech request, so a changed instruction, rate, voice sample or model invalidates speech just
// like changed words do. A speech-profile patch is applied only after every precheck has passed.
async function reviseScript(context, replacement, reason, { speechProfilePatch = null } = {}) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('REVISION_REASON_REQUIRED');
  const next = validateScript(structuredClone(replacement), context.production);
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    if (!state.script) throw new Error('SCRIPT_REQUIRED');
    const patch = speechProfilePatch && typeof speechProfilePatch === 'object' ? speechProfilePatch : null;
    if (patch && (!patch.shotId || typeof patch.instruction !== 'string' || !patch.instruction.trim() ||
        (patch.rate !== undefined && (!Number.isFinite(patch.rate) || patch.rate < 0.5 || patch.rate > 2))))
      throw new Error('INVALID_SPEECH_PROFILE_PATCH');
    const oldShots = new Map(state.script.shots.map(s => [s.id, s]));
    const nextShots = new Map(next.shots.map(s => [s.id, s]));
    const changes = [];
    for (const id of new Set([...oldShots.keys(), ...nextShots.keys()])) {
      const old = oldShots.get(id), current = nextShots.get(id);
      const unchangedScript = old && current && hash(old) === hash(current);
      const patchHere = patch && patch.shotId === id && current?.text
        ? { instruction: patch.instruction.trim(), ...(patch.rate !== undefined ? { rate: patch.rate } : {}) } : null;
      // Effective model parameters are compared even when the script text is identical, using only the
      // parameters the record can prove (a legacy record without modelParams counts as changed).
      const change = patchHere ? deliveryChange(state, id, context.config, patchHere) : null;
      const deliveryChanged = !!change?.changed;
      if (unchangedScript && !deliveryChanged) continue;
      const scopes = scriptChangeScopes(old, current);
      const speech = scopes.speech || deliveryChanged;
      const frames = scopes.frames;
      changes.push({ id, speech, frames, deliveryChanged, deliveryReason: change?.reason || null,
        prefixGroups: [...(speech ? ['speech'] : []), ...(frames ? ['first', 'last', 'frame-check'] : []), 'video', 'video-check'] });
    }
    if (!changes.length) throw new Error('SCRIPT_UNCHANGED');
    const operations = [];
    for (const c of changes) for (const prefix of c.prefixGroups) operations.push(prefix + '-' + c.id);
    // Check every affected request before mutating anything (state, profile, revisions).
    const advance = preflight(context, state, operations);
    state.history ||= [];
    // The superseded performance parameters, audio pointers and acceptance records are preserved here.
    state.history.push({ kind: 'script-revision', at: new Date().toISOString(), reason, script: state.script,
      assets: structuredClone(state.assets), timeline: state.timed || null, output: state.output || null,
      preview: state.preview || null, previousOperations: advance.map(x => x.id),
      localVideoEdits: state.localVideoEdits ? structuredClone(state.localVideoEdits) : null,
      speechProfile: state.speechProfile ? structuredClone(state.speechProfile) : null,
      audioReview: state.audioReview ? structuredClone(state.audioReview) : null,
      audioRecords: state.audioRecords ? structuredClone(state.audioRecords) : null,
      audioReviews: state.audioReviews ? structuredClone(state.audioReviews) : null,
      deliveryChanges: changes.filter(c => c.deliveryChanged).map(c => c.id),
      deliveryChangeReasons: Object.fromEntries(changes.filter(c => c.deliveryChanged).map(c => [c.id, c.deliveryReason])) });
    // Everything above was checked first; only now are the script, the profile patch and the revisions
    // persisted together, so a refusal can never leave a half-applied performance change.
    if (patch) {
      state.speechProfile ||= { models: { speech: context.config.models.speech, voiceEnrollment: 'voice-enrollment' }, delivery: {} };
      state.speechProfile.delivery ||= {};
      state.speechProfile.delivery[patch.shotId] = { ...(state.speechProfile.delivery[patch.shotId] || {}),
        instruction: patch.instruction.trim(), ...(patch.rate !== undefined ? { rate: patch.rate } : {}) };
    }
    state.revisions ||= {};
    for (const a of advance) state.revisions[a.base] = a.revision;
    for (const c of changes) {
      if (!nextShots.has(c.id)) { delete state.assets[c.id]; }
      else {
        const a = state.assets[c.id] ||= {};
        for (const k of ['video','videoInfo','videoReview']) delete a[k];
        if (c.speech) {
          for (const k of ['audio','audioHash','speechRaw']) delete a[k];
          state.revisions['driving-' + c.id] = state.revisions['speech-' + c.id] || 0;
          // Changed speech parameters invalidate the previous acceptance and its per-shot analysis; the
          // pointers are replaced (the values themselves stay in history above).
          state.audioReview = { status: 'pending', model: state.speechProfile?.models?.speech || context.config.models?.speech || null,
            note: c.deliveryChanged
              ? '模型表演参数已改变或无法核实（' + c.deliveryReason + '），需重新生成并试听'
              : '脚本修订改变了本镜台词，需重新生成并试听',
            invalidatedShot: c.id, at: new Date().toISOString() };
          if (state.audioRecords) delete state.audioRecords[c.id];
          if (state.audioReviews) delete state.audioReviews[c.id];
        }
        if (c.frames) {
          for (const k of ['first','last','frameReview']) delete a[k];
          state.revisions['first-ready-' + c.id] = state.revisions['first-' + c.id] || 0;
          state.revisions['last-ready-' + c.id] = state.revisions['last-' + c.id] || 0;
        }
      }
      // A changed shot loses its clip, so a local edit recorded against that clip cannot survive.
      if (state.localVideoEdits?.[c.id]) {
        delete state.localVideoEdits[c.id];
        if (!Object.keys(state.localVideoEdits).length) delete state.localVideoEdits;
      }
      for (const key of ['frames-' + c.id, 'video-' + c.id]) {
        delete state.approvals[key];
        if (state.pendingReview?.key === key) delete state.pendingReview;
      }
    }
    state.script = next; state.editRevision = (state.editRevision || 0) + 1; state.stage = 'script';
    for (const k of ['timed','preview','output','acceptance','lastError','costForecast']) delete state[k];
    saveState(context, state);
    return { revision: state.editRevision, affectedShots: changes.map(c => c.id),
      deliveryChanges: changes.filter(c => c.deliveryChanged).map(c => c.id),
      deliveryChangeReasons: Object.fromEntries(changes.filter(c => c.deliveryChanged).map(c => [c.id, c.deliveryReason])),
      networkRequests: 0 };
  });
}
module.exports = { reviseScript };
