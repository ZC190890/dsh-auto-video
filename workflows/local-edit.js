const fs = require('node:fs');
const path = require('node:path');
const { Media } = require('../services/aliyun/media');
const { fileHash, safeId, withLock, writeJson } = require('../services/aliyun/io');

// Local repair of a single shot: no network, no ledger entry, no new provider attempt. The edit is
// stored in state.localVideoEdits so that a later `run` re-applies it instead of discarding it.
// production.js requires this module, so its state helpers are required lazily to avoid a cycle.
const stateHelpers = () => require('./production');

const LOCAL_EDIT_FLAGS = ['from', 'to', 'duration', 'reason'];

function parseLocalEditArgs(args) {
  if (!Array.isArray(args) || !args.length) throw new Error('LOCAL_EDIT_SHOT_AND_OPTIONS_REQUIRED');
  const [shotId, ...flags] = args;
  if (flags.length !== LOCAL_EDIT_FLAGS.length * 2) throw new Error('LOCAL_EDIT_SHOT_AND_OPTIONS_REQUIRED: 需要 --from --to --duration --reason');
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    const name = String(flags[i]).replace(/^--/, '');
    if (!LOCAL_EDIT_FLAGS.includes(name) || Object.prototype.hasOwnProperty.call(options, name)) throw new Error('LOCAL_EDIT_OPTION_INVALID: ' + flags[i]);
    options[name] = flags[i + 1];
  }
  if (LOCAL_EDIT_FLAGS.some(name => options[name] === undefined)) throw new Error('LOCAL_EDIT_SHOT_AND_OPTIONS_REQUIRED');
  return { shotId, options };
}

function planLocalEdit(state, shotId, { from, to, duration, reason }) {
  const shot = state.timed?.shots?.find(s => s.id === shotId);
  if (!shot) throw new Error('SHOT_NOT_FOUND');
  const sourceStart = Number(from), sourceEnd = Number(to), targetDuration = Number(duration);
  for (const [flag, value] of [['--from', sourceStart], ['--to', sourceEnd], ['--duration', targetDuration]]) {
    if (!Number.isFinite(value)) throw new Error('LOCAL_EDIT_NUMBER_REQUIRED: ' + flag);
  }
  if (sourceStart < 0) throw new Error('LOCAL_EDIT_RANGE_INVALID');
  if (sourceEnd - sourceStart < 0.2) throw new Error('LOCAL_EDIT_RANGE_TOO_SHORT');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('LOCAL_EDIT_REASON_REQUIRED');
  // Assembly sets -t to the timeline duration and rejects a shorter clip, so never shorten a slot.
  if (targetDuration + 1e-6 < shot.duration) throw new Error('LOCAL_EDIT_TOO_SHORT_FOR_SHOT: 目标时长不得短于时间线 ' + shot.duration + ' 秒');
  return { sourceStart, sourceEnd, targetDuration, reason: reason.trim() };
}

function applyLocalEdits(media, state, assets, editDirectory, log = () => {}) {
  const next = structuredClone(assets), applied = {};
  for (const [shotId, edit] of Object.entries(state.localVideoEdits || {})) {
    if (!state.timed?.shots?.some(s => s.id === shotId)) throw new Error('LOCAL_EDIT_SHOT_MISSING: ' + shotId);
    if (!next[shotId]) throw new Error('LOCAL_EDIT_ASSETS_MISSING: ' + shotId);
    if (edit.edited && fs.existsSync(edit.edited) && edit.editedHash === fileHash(edit.edited)) {
      next[shotId].video = edit.edited;
      applied[shotId] = { ...edit, reused: true };
      continue;
    }
    const source = edit.source || assets[shotId]?.video;
    if (!source || !fs.existsSync(source)) throw new Error('LOCAL_EDIT_SOURCE_MISSING: ' + shotId + ': 需保留原视频，不会重新联网生成');
    if (edit.sourceHash && edit.sourceHash !== fileHash(source)) throw new Error('LOCAL_EDIT_SOURCE_CHANGED: ' + shotId);
    const destination = path.join(editDirectory, shotId + '-local-edit.mp4');
    next[shotId].video = media.localEdit(source, destination, edit);
    applied[shotId] = { ...edit, edited: next[shotId].video, editedHash: fileHash(next[shotId].video), reused: false };
    log('本地剪辑重建：' + shotId + ' -> ' + next[shotId].video);
  }
  return { assets: next, applied };
}

async function recordLocalEdit(context, shotId, options) {
  safeId(shotId);
  const { loadState, saveState } = stateHelpers();
  return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), async () => {
    const state = loadState(context);
    if (state.pendingReview) throw new Error('LOCAL_EDIT_BLOCKED_PENDING_REVIEW: ' + state.pendingReview.key);
    if (!['video', 'final'].includes(state.stage)) throw new Error('LOCAL_EDIT_REQUIRES_VIDEO_STAGE');
    const plan = planLocalEdit(state, shotId, options);
    const media = new Media(context.root, context.project);
    const source = state.assets?.[shotId]?.video;
    if (!source || !fs.existsSync(source)) throw new Error('LOCAL_EDIT_SOURCE_MISSING: ' + shotId + ': 需保留原视频，不会重新联网生成');
    const edited = path.join(context.directory, 'video-local', shotId + '-local-edit.mp4');
    media.localEdit(source, edited, plan);
    state.localVideoEdits ||= {};
    state.localVideoEdits[shotId] = { source, sourceHash: fileHash(source), edited, editedHash: fileHash(edited),
      sourceStart: plan.sourceStart, sourceEnd: plan.sourceEnd, targetDuration: plan.targetDuration,
      reason: plan.reason, recordedAt: new Date().toISOString() };
    // A previous export is kept as its own revision; the new export always writes a fresh one.
    const exported = state.stage === 'final';
    if (exported) state.editRevision = (state.editRevision || 0) + 1;
    const local = applyLocalEdits(media, state, state.assets, path.join(context.directory, 'video-local'));
    state.localVideoEdits = { ...state.localVideoEdits, ...local.applied };
    const directory = path.join(context.root, 'output', context.production.id, ...(state.editRevision ? ['revision-' + state.editRevision] : []));
    state.output = media.assemble(state.timed, local.assets, directory);
    writeJson(path.join(directory, 'local-edit-record.json'), state.localVideoEdits);
    state.stage = 'final';
    state.acceptance = 'awaiting_user_playback';
    delete state.lastError;
    saveState(context, state);
    return { shotId, output: state.output, revision: state.editRevision || 0, edit: state.localVideoEdits[shotId],
      previousExportKept: exported, networkRequests: 0 };
  });
}

module.exports = { applyLocalEdits, parseLocalEditArgs, planLocalEdit, recordLocalEdit, LOCAL_EDIT_FLAGS };


