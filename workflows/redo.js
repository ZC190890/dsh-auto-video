const fs = require('node:fs');
const path = require('node:path');
const { readJson, safeId, withLock } = require('../services/aliyun/io');
const { loadState, saveState } = require('./production');
const { Budget } = require('../services/aliyun/budget');
const { UnitAttempts, unitForOperation } = require('../services/aliyun/units');

async function redo(context, shotId, scope, reason) {
  safeId(shotId);
  if (!['speech', 'frames', 'video'].includes(scope) || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('REDO_SCOPE_AND_REASON_REQUIRED');
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context), shot = state.script?.shots.find(s => s.id === shotId);
    if (!shot) throw new Error('SHOT_NOT_FOUND');
    if (scope === 'speech' && !['dialogue','narration'].includes(shot.type)) throw new Error('SHOT_HAS_NO_SPEECH');
    const groups = {
      speech: ['speech', 'video', 'video-check'],
      frames: ['first', ...(shot.needsLastFrame ? ['last'] : []), 'frame-check', 'video', 'video-check'],
      video: ['video', 'video-check']
    };
    const bases = groups[scope].map(prefix => prefix + '-' + shotId);
    const entries = new Map(new Budget(context.root, context.config, context.directory).report().entries.map(e => [e.id, e]));
    const found = [];
    for (const base of bases) {
      const revision = state.revisions?.[base] || 0, id = base + '-r' + revision;
      const file = path.join(context.directory, 'operations', id + '.json');
      if (!fs.existsSync(file)) {
        if (entries.has(id)) throw new Error('RESERVED_OPERATION_RECORD_MISSING:' + id);
        continue;
      }
      const op = readJson(file);
      const terminalFailure = op.status === 'failed' && !!op.taskId &&
        ['FAILED', 'CANCELED'].includes(op.result?.output?.task_status);
      if (op.id !== id || (op.status !== 'succeeded' && !terminalFailure)) throw new Error('REDO_BLOCKED_UNRESOLVED_OPERATION:' + id);
      if (!entries.has(id)) throw new Error('REDO_LEDGER_ENTRY_MISSING:' + id);
      // The attempt limit now lives in the per-unit round ledger (first generation + at most 3 reworks).
      const rounds = new UnitAttempts(context.directory).status(unitForOperation(id) || id);
      if (rounds.exhausted)
        throw new Error('REDO_ATTEMPTS_EXHAUSTED:' + id + '：单元 ' + rounds.unit + ' 已用完首次生成与 3 次返工，需人工核对，不自动重置');
      if (!rounds.hasRoundsLeft)
        throw new Error('REDO_ATTEMPTS_EXHAUSTED:' + id + '：单元 ' + rounds.unit + ' 已用完首次生成与 3 次返工，不能再新增生成（已有结果的查询/下载/审核/验收不受影响）');
      if (rounds.needsAudit)
        throw new Error('REDO_ATTEMPTS_EXHAUSTED:' + id + '：单元 ' + rounds.unit + ' 的历史次数无法判定（' + rounds.needsAudit + '），需先核对');
      found.push({ base, id, revision });
    }
    if (!found.some(item => item.base === bases[0])) throw new Error('REDO_TARGET_NOT_ATTEMPTED');
    const oldAssets = structuredClone(state.assets[shotId] || {});
    state.history ||= [];
    state.history.push({ kind: 'redo', shotId, scope, reason, at: new Date().toISOString(),
      previousOperations: found.map(item => item.id), assets: oldAssets, preview: state.preview || null,
      output: state.output || null, timeline: state.timed || null,
      localVideoEdits: state.localVideoEdits ? structuredClone(state.localVideoEdits) : null });
    state.revisions ||= {};
    for (const item of found) state.revisions[item.base] = item.revision + 1;
    const a = state.assets[shotId] ||= {};
    for (const key of ['video', 'videoInfo', 'videoReview']) delete a[key];
    // A regenerated clip invalidates any local edit that was recorded against the previous one.
    if (state.localVideoEdits?.[shotId]) {
      delete state.localVideoEdits[shotId];
      if (!Object.keys(state.localVideoEdits).length) delete state.localVideoEdits;
    }
    if (scope === 'frames') {
      for (const key of ['first', 'last', 'frameReview']) delete a[key];
      state.revisions['first-ready-' + shotId] = state.revisions['first-' + shotId];
      state.revisions['last-ready-' + shotId] = state.revisions['last-' + shotId] || 0;
    }
    if (scope === 'speech') {
      for (const key of ['audio', 'audioHash', 'speechRaw']) delete a[key];
      state.revisions['driving-' + shotId] = state.revisions['speech-' + shotId];
      delete state.timed;
      // Regenerated speech invalidates the previous acceptance and its analysis records.
      state.audioReview = { status: 'pending', note: '语音已准备重做（redo speech），需重新试听', at: new Date().toISOString() };
      if (state.audioRecords) delete state.audioRecords[shotId];
      if (state.audioReviews) delete state.audioReviews[shotId];
    }
    const invalidApprovals = ['video-' + shotId, ...(scope === 'frames' ? ['frames-' + shotId] : [])];
    for (const key of invalidApprovals) delete state.approvals[key];
    if (state.pendingReview && invalidApprovals.includes(state.pendingReview.key)) delete state.pendingReview;
    state.editRevision = (state.editRevision || 0) + 1;
    delete state.output; delete state.acceptance; delete state.lastError; delete state.costForecast;
    if (scope !== 'video') delete state.preview;
    state.stage = scope === 'speech' ? 'script' : scope === 'frames' ? 'audio' : 'frames';
    saveState(context, state);
    return { shotId, scope, revision: state.editRevision, newOperations: found.map(item => item.base + '-r' + (item.revision + 1)) };
  });
}
module.exports = { redo };
