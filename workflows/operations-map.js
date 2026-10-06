const fs = require('node:fs');
const path = require('node:path');
const { readJson, hash } = require('../services/aliyun/io');
const { Budget } = require('../services/aliyun/budget');
const { UnitAttempts, unitForOperation } = require('../services/aliyun/units');

// One authoritative mapping from a shot + scope to the operations it affects. revise.js, redo.js and
// rework.js all use this so the three paths cannot drift apart again.
const SPEECH_PREFIXES = ['speech', 'video', 'video-check'];
function framesPrefixes(shot) { return ['first', ...(shot.needsLastFrame ? ['last'] : []), 'frame-check', 'video', 'video-check']; }
const VIDEO_PREFIXES = ['video', 'video-check'];

function scopeOperations(shot, scope) {
  if (!shot) throw new Error('SHOT_NOT_FOUND');
  if (scope === 'speech') return SPEECH_PREFIXES.map(prefix => prefix + '-' + shot.id);
  if (scope === 'frames') return framesPrefixes(shot).map(prefix => prefix + '-' + shot.id);
  if (scope === 'video') return VIDEO_PREFIXES.map(prefix => prefix + '-' + shot.id);
  throw new Error('INVALID_SCOPE:' + scope);
}
// Which invalidation groups a script edit touches, for a shot that existed before and/or after.
// Which script field belongs to which invalidation group, so a patch cannot silently widen the scope.
// The action contract belongs to the frames group: changing what a first/last frame must show means the
// frames, their checks, the video and its check all have to be made again under the new goal.
const FRAME_FIELDS = ['type', 'scene', 'endScene', 'needsLastFrame', 'action', 'characters', 'lastFrameDirection',
  'startState', 'endState', 'primaryAction', 'beats', 'cut', 'handoff'];

const VIDEO_ONLY_FIELDS = ['videoScene', 'videoAction'];
function scriptChangeScopes(oldShot, currentShot) {
  const speech = !oldShot || !currentShot || oldShot.type !== currentShot.type ||
    oldShot.text !== currentShot.text || oldShot.speaker !== currentShot.speaker;
  const frames = !oldShot || !currentShot || FRAME_FIELDS.some(key => hash(oldShot[key] ?? null) !== hash(currentShot[key] ?? null));
  const videoOnly = !frames && (!oldShot || !currentShot || VIDEO_ONLY_FIELDS.some(key => hash(oldShot[key] ?? null) !== hash(currentShot[key] ?? null)));
  return { speech, frames, videoOnly };
}
// The performance parameters that actually reach a speech request, plus the ones applied locally.
function effectiveDelivery(state, shotId, config, patch = null) {
  const model = state.speechProfile?.models?.speech || config.models?.speech || null;
  const delivery = state.speechProfile?.delivery?.[shotId] || {};
  const from = source => ({
    instruction: typeof source?.instruction === 'string' && source.instruction.trim() ? source.instruction.trim() : null,
    rate: Number.isFinite(source?.rate) ? source.rate : 1,
    hotFix: !!source?.hotFix
  });
  const current = from(delivery);
  const merged = patch ? { ...current, ...from({ ...delivery, ...patch }) } : current;
  return { model, ...merged };
}
// The parameters that actually reached the last speech request. Only `modelParams` records those; the
// older mixed `performance` block keeps the LOCAL post-processing speed under `rate`, so it can never be
// compared against a model rate and is reported as unverifiable instead of being treated as equal.
function recordedDelivery(record) {
  if (!record) return null;
  if (record.modelParams && typeof record.modelParams === 'object') {
    const source = record.modelParams;
    return { verified: true,
      model: typeof source.model === 'string' && source.model ? source.model : (record.model || null),
      instruction: typeof source.instruction === 'string' && source.instruction.trim() ? source.instruction.trim() : null,
      rate: Number.isFinite(source.rate) ? source.rate : 1,
      hotFix: source.hotFix === true || source.hotFix === 'sent' };
  }
  return { verified: false, model: record.model || null,
    instruction: typeof record.performance?.instruction === 'string' && record.performance.instruction.trim()
      ? record.performance.instruction.trim() : null,
    rate: null, hotFix: null };
}
// The comparison only uses what the record can prove. A record without model parameters is treated as
// changed, so an unknown model rate is never silently assumed to be the same, and the reason is returned
// to the caller and stored with the revision.
function deliveryChange(state, shotId, config, patch = null) {
  const before = recordedDelivery(state.audioRecords?.[shotId]);
  const after = effectiveDelivery(state, shotId, config, patch);
  if (!before) return { changed: false, reason: 'NO_AUDIO_RECORD', before: null, after };
  if (!before.verified)
    return { changed: true, before, after,
      reason: hash(before.instruction) === hash(after.instruction) ? 'LEGACY_RECORD_WITHOUT_MODEL_PARAMS' : 'MODEL_PARAMS_CHANGED' };
  const same = ['model', 'instruction', 'rate', 'hotFix'].every(key => hash(before[key]) === hash(after[key]));
  return { changed: !same, reason: same ? 'UNCHANGED' : 'MODEL_PARAMS_CHANGED', before, after };
}
function speechDeliveryChanged(state, shotId, config, patch = null) {
  return deliveryChange(state, shotId, config, patch).changed;
}
// The digest an audio acceptance is bound to: the audio actually in state, the speech revision and the
// script digest. A later change makes the binding differ, so a stale "accepted" cannot stand.
function audioAcceptanceBinding(state) {
  const shots = {};
  for (const [id, asset] of Object.entries(state.assets || {})) {
    const shot = state.timed?.shots?.find(s => s.id === id);
    if (!shot?.text) continue;
    shots[id] = { audioHash: asset.audioHash || null, speechRevision: state.revisions?.['speech-' + id] || 0,
      textHash: hash(shot.text), duration: shot.duration };
  }
  return { scriptHash: state.script ? hash(state.script) : null, shots };
}

const DEFAULT_CODES = { recordMissing: 'RESERVED_OPERATION_RECORD_MISSING', blocked: 'REVISION_BLOCKED_UNRESOLVED_OPERATION',
  ledger: 'REVISION_LEDGER_ENTRY_MISSING', exhausted: 'REVISION_ATTEMPTS_EXHAUSTED', corrupt: 'OPERATION_RECORD_CORRUPT' };

// One preflight for every invalidation path (revise, redo, rework): unresolved work blocks, the ledger
// must match the operation records, a damaged authoritative record is never treated as "absent", and the
// per-asset attempt limit is honoured. Nothing is persisted by this function.
function preflight(context, state, operations, codes = {}) {
  const code = { ...DEFAULT_CODES, ...codes };
  const entries = new Map(new Budget(context.root, context.config, context.directory).report().entries.map(e => [e.id, e]));
  const advance = [];
  for (const base of operations) {
    const revision = state.revisions?.[base] || 0, id = base + '-r' + revision;
    const file = path.join(context.directory, 'operations', id + '.json');
    if (!fs.existsSync(file)) {
      if (entries.has(id)) throw new Error(code.recordMissing + ':' + id + '：账本已有预留但权威操作记录缺失，不得视为未执行');
      continue;
    }
    let op;
    try { op = readJson(file); }
    catch { throw new Error(code.corrupt + ':' + id + '：权威操作记录损坏，需人工核对，不自动重发'); }
    const failed = op.status === 'failed' && op.taskId && ['FAILED', 'CANCELED'].includes(op.result?.output?.task_status);
    if (op.id !== id || (op.status !== 'succeeded' && !failed)) throw new Error(code.blocked + ':' + id + ':' + op.status);
    if (!entries.has(id)) throw new Error(code.ledger + ':' + id);
    // The authoritative limit is the per-unit round ledger: first generation plus at most 3 reworks.
    const unit = unitForOperation(id);
    const rounds = unit ? new UnitAttempts(context.directory).status(unit) : null;
    if (rounds?.exhausted)
      throw new Error(code.exhausted + ':' + id + '：单元 ' + unit + ' 已用完首次生成与 3 次返工（' +
        (rounds.exhausted.reason || '') + '），需人工核对，不自动重置');
    // Out of rounds but not paused: only the new generation is refused, reading existing results is not.
    if (rounds && !rounds.hasRoundsLeft)
      throw new Error(code.exhausted + ':' + id + '：单元 ' + unit + ' 已用完首次生成与 3 次返工，不能再新增生成' +
        '（已有结果的查询、下载、审核、验收与下游不受影响），不自动重置');
    if (rounds?.needsAudit)
      throw new Error(code.exhausted + ':' + id + '：单元 ' + unit + ' 的历史次数无法从可核实记录判定（' + rounds.needsAudit + '），需先核对');
    advance.push({ base, revision: revision + 1, id });
  }
  return advance;
}
module.exports = { DEFAULT_CODES, FRAME_FIELDS, VIDEO_ONLY_FIELDS, audioAcceptanceBinding, deliveryChange,
  effectiveDelivery, framesPrefixes, preflight, recordedDelivery, scopeOperations, scriptChangeScopes, speechDeliveryChanged };
