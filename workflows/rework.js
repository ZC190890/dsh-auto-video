const path = require('node:path');
const { hash, safeId, withLock } = require('../services/aliyun/io');
const { Media } = require('../services/aliyun/media');
const { Budget, authorization } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { Models } = require('../services/aliyun/models');
const { UnitAttempts } = require('../services/aliyun/units');
const { loadState, saveState, providerClient } = require('./production');
const { planReworkInstruction, reviewScript } = require('./planner');
const { preflight, scopeOperations } = require('./operations-map');
const { reviseScript } = require('./revise');
const { redo } = require('./redo');

// Closes the rework loop as a resumable, persisted flow. Stages: instruction → apply → review → done,
// with 'blocked-uncertain' when a provider submission cannot be reconciled. Every stage is written to
// state before the next one starts, so an interrupted run continues instead of rebuilding requests.
const REWORK_CODES = { recordMissing: 'REWORK_RESERVED_OPERATION_RECORD_MISSING',
  blocked: 'REWORK_BLOCKED_UNRESOLVED_OPERATION', ledger: 'REWORK_LEDGER_ENTRY_MISSING',
  exhausted: 'REWORK_ATTEMPTS_EXHAUSTED', corrupt: 'REWORK_OPERATION_RECORD_CORRUPT' };
// Which script field belongs to which invalidation group, so a patch cannot silently widen the scope.
const PATCH_GROUPS = { videoScene: 'video', videoAction: 'video', scene: 'frames', action: 'frames',
  endScene: 'frames', lastFrameDirection: 'frames', text: 'speech', emotion: 'speech' };
const SCOPES = ['speech', 'frames', 'video'];

function reworkScope(target) {
  const match = /^(frames|video|speech)-(.+)$/.exec(String(target));
  if (!match) throw new Error('REWORK_TARGET_REQUIRED: 需要 frames-<镜头ID>、video-<镜头ID> 或 speech-<镜头ID>');
  return { scope: match[1], shotId: match[2] };
}
function shotOf(state, shotId) {
  return (state.script?.shots || []).find(s => s.id === shotId) || (state.timed?.shots || []).find(s => s.id === shotId) || null;
}
function affectedOperations(context, state, scope, shot) { return scopeOperations(shot, scope); }
function preflightRework(context, state, operations) { return preflight(context, state, operations, REWORK_CODES); }
// Target + known downstream are checked before anything is spent.
function reworkGuard(context, state, target) {
  const { scope, shotId } = reworkScope(target);
  const shot = shotOf(state, shotId);
  if (!shot) throw new Error('SHOT_NOT_FOUND:' + shotId);
  return preflightRework(context, state, affectedOperations(context, state, scope, shot));
}
function modelsFor(context, injectedClient, log) {
  const { root, config, directory } = context;
  const budget = new Budget(root, config, directory);
  const ops = new Operations(path.join(directory, 'operations'), providerClient(root, injectedClient), budget, log,
    config.pollIntervalSeconds, config.pollTimeoutSeconds, new UnitAttempts(directory));
  return new Models(config, ops, new Media(root, context.project), path.join(directory, 'vision-cache'));
}
async function lockAnd(context, work) { return withLock(path.join(context.root, 'jobs', 'aliyun', 'run.lock'), work); }
async function readJob(context, jobId) {
  return lockAnd(context, async () => loadState(context).rework?.[jobId] || null);
}
// The groups a model instruction would touch, used to refuse a silent scope expansion.
function instructionGroups(instruction) {
  const groups = new Set(['video']);
  for (const field of Object.keys(instruction.patch)) { const group = PATCH_GROUPS[field]; if (group) groups.add(group); }
  if (instruction.speechInstruction) groups.add('speech');
  if (instruction.scope && SCOPES.includes(instruction.scope)) groups.add(instruction.scope);
  return [...groups];
}

async function applyRework(context, target, reason, { client: injectedClient, log = console.log } = {}) {
  safeId(target);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('REWORK_CONFIRMATION_REQUIRED');
  const { scope, shotId } = reworkScope(target);
  authorization(context.root, context.config, context.production.id);
  // Stage 0: resume an open job, report a finished one, or open a new job after the full preflight.
  const opened = await lockAnd(context, async () => {
    const state = loadState(context);
    state.rework ||= {};
    const open = Object.values(state.rework).find(job => job.target === target && job.stage !== 'done');
    if (open) return { jobId: open.jobId, resumed: true, job: open };
    const done = Object.values(state.rework).find(job => job.target === target && job.stage === 'done' && job.applied);
    if (done) return { jobId: done.jobId, completed: true, job: done };
    const shot = shotOf(state, shotId);
    if (!shot) throw new Error('SHOT_NOT_FOUND:' + shotId);
    const checked = affectedOperations(context, state, scope, shot);
    preflightRework(context, state, checked);
    const jobId = 'rework-' + (Object.keys(state.rework).length + 1) + '-' + target;
    const job = { jobId, target, scope, shotId, reason: reason.trim(), stage: 'instruction',
      inputDigest: hash({ script: hash(state.script), profile: state.speechProfile || null, shotId }),
      checkedOperations: checked, createdAt: new Date().toISOString() };
    state.rework[jobId] = job;
    saveState(context, state);
    return { jobId, resumed: false, job };
  });
  if (opened.completed) return { target, jobId: opened.jobId, alreadyApplied: true, review: opened.job.review || null,
    nextStep: '该返工已完成：重复执行不会再次返工，也不会新增预留或请求' };
  let job = opened.job;

  // Stage 1: the model instruction. The network call is deliberately outside the lock; the persisted job
  // record is what makes the flow recoverable, not the lock.
  if (job.stage === 'instruction') {
    const prepared = await lockAnd(context, async () => {
      const state = loadState(context);
      const current = state.rework[opened.jobId];
      if (current.instruction) return { stored: true };
      if (hash({ script: hash(state.script), profile: state.speechProfile || null, shotId }) !== current.inputDigest)
        throw new Error('REWORK_STALE_INPUT:' + current.jobId + '：脚本或表演参数已被其它操作改动，需重新发起返工');
      return { stored: false, models: modelsFor(context, injectedClient, log), state,
        scriptAt: hash(state.script), profileAt: hash(state.speechProfile || null) };
    });
    if (!prepared.stored) {
      const instruction = await planReworkInstruction(context, { models: prepared.models, state: prepared.state,
        target, operationId: 'plan-rework-instruction-' + opened.jobId, log });
      await lockAnd(context, async () => {
        const state = loadState(context);
        const current = state.rework[opened.jobId];
        if (current.instruction) return;
        current.instruction = instruction; current.stage = 'apply'; current.instructedAt = new Date().toISOString();
        // The script and performance parameters the instruction was written against. The apply stage
        // compares them again, so a revision made while the model answered is never silently overwritten.
        current.scriptAtInstruction = prepared.scriptAt; current.profileAtInstruction = prepared.profileAt;
        saveState(context, state);
      });
    }
    job = await readJob(context, opened.jobId);
  }
  return continueRework(context, { opened, job, target, reason, scope, shotId, injectedClient, log });
}

// Stages 2 and 3 are shared by the first call and by a resumed call, so an interrupted rework continues
// exactly where it stopped.
async function continueRework(context, { opened, job, target, reason, scope, shotId, injectedClient, log }) {
  // The instruction is part of the caller's contract: the model's decision stays visible after a resume.
  const exposedInstruction = () => {
    const stored = job?.instruction;
    return stored ? { shotId: stored.shotId, scope: stored.scope, patch: Object.keys(stored.patch),
      rationale: stored.rationale, speechInstruction: stored.speechInstruction, basedOn: stored.basedOn } : null;
  };
  if (job.stage === 'apply') {
    const outcome = await lockAnd(context, async () => {
      const state = loadState(context);
      const current = state.rework[opened.jobId];
      if (current.applied) return { already: true };
      const instruction = current.instruction;
      const shot = shotOf(state, instruction.shotId);
      if (!shot) throw new Error('SHOT_NOT_FOUND:' + instruction.shotId);
      const note = '模型返工指令（' + target + '）：' + instruction.rationale.slice(0, 120) +
        '；用户确认：' + String(reason).trim().slice(0, 200);
      const inputChanged = () => !!current.scriptAtInstruction && (hash(state.script) !== current.scriptAtInstruction ||
        hash(state.speechProfile || null) !== current.profileAtInstruction);
      const staleInput = () => new Error('REWORK_STALE_INPUT:' + current.jobId +
        '：指令生成后脚本或表演参数已被其它操作改动，旧指令不会覆盖新状态，需核实后重新发起返工');
      // Recovery: an earlier run records its intent (and may have applied it) before it stops. The change
      // it makes writes this job's exact note into history, so "this rework already applied" is provable
      // and stays distinguishable from "another operation changed the state".
      if (current.applying) {
        // Recovery is bound to content, never to the human-readable note alone: the same note could come
        // from another rework of the same target or from a manual revision with the same wording. The
        // decision therefore also requires the one revision step the intent expected, the intended change
        // itself, and the recorded history entry as corroboration for a human reader.
        const intent = current.applying;
        const singleStep = (state.editRevision || 0) === intent.expectedRevision + 1;
        const scriptChanged = hash(state.script) !== intent.beforeScriptHash ||
          hash(state.speechProfile || null) !== intent.beforeProfileHash;
        const patchedOk = Object.entries(intent.patchedValues || {}).every(([field, value]) => shot[field] === value);
        const revisionsOk = Object.entries(intent.beforeRevisions || {})
          .every(([base, before]) => (state.revisions?.[base] || 0) > before);
        const corroborated = (state.history || []).some(entry => entry.reason === intent.note &&
          ['script-revision', 'redo'].includes(entry.kind));
        const landed = singleStep && corroborated &&
          (intent.mode === 'redo' ? revisionsOk : scriptChanged && patchedOk);
        if (landed) return { recovered: true,
          applied: { ...intent.planned, revision: state.editRevision, recovered: true,
            recoveredAt: new Date().toISOString() } };
        if (inputChanged()) throw staleInput();          // never applied, and someone else moved the state
        delete current.applying; saveState(context, state);   // never applied, nothing else changed: retry
      }
      if (inputChanged()) throw staleInput();
      // Refuse a silent scope expansion: every group the instruction touches must already be checked.
      const expanded = [];
      for (const group of instructionGroups(instruction))
        for (const operation of affectedOperations(context, state, group, shot))
          if (!current.checkedOperations.includes(operation) && !expanded.includes(operation)) expanded.push(operation);
      if (expanded.length) throw new Error('REWORK_SCOPE_EXPANSION_REQUIRES_USER:' + expanded.join(',') +
        '：模型指令扩大了失效范围，需用户明确同意后才能继续');
      const hasPatch = Object.keys(instruction.patch).length > 0;
      const speechModel = state.speechProfile?.models?.speech || context.config.models.speech;
      const canInstruct = speechModel === 'qwen-audio-3.0-tts-plus';
      const profilePatch = instruction.speechInstruction && canInstruct
        ? { shotId: instruction.shotId, instruction: instruction.speechInstruction } : null;
      if (!hasPatch && !instruction.speechInstruction) {
        // The durable intent is written before the change; redo persists the change itself. A crash in
        // between is recovered from the intent plus the history entry, never by re-applying blindly.
        const redoScope = SCOPES.includes(instruction.scope) ? instruction.scope : 'video';
        current.applying = { at: new Date().toISOString(), mode: 'redo', note,
          expectedRevision: state.editRevision || 0, beforeScriptHash: hash(state.script),
          beforeProfileHash: hash(state.speechProfile || null),
          beforeRevisions: Object.fromEntries(affectedOperations(context, state, redoScope, shot)
            .map(base => [base, state.revisions?.[base] || 0])),
          planned: { mode: 'redo', shotId: instruction.shotId, scope: redoScope } };
        saveState(context, state);
        const redone = await redo(context, instruction.shotId, redoScope, note);
        return { applied: { mode: 'redo', redone } };
      }
      if (!hasPatch && !profilePatch)
        return { notApplied: { model: speechModel, reason: '当前语音模型没有情绪/表演指令参数，返工指令未进入请求' } };
      current.applying = { at: new Date().toISOString(), mode: 'revise', note,
        expectedRevision: state.editRevision || 0, beforeScriptHash: hash(state.script),
        beforeProfileHash: hash(state.speechProfile || null), patchedValues: { ...instruction.patch },
        planned: { mode: 'revise', shotId: instruction.shotId, patch: Object.keys(instruction.patch),
          profilePatched: !!profilePatch } };
      saveState(context, state);
      const next = structuredClone(state.script);
      Object.assign(next.shots.find(s => s.id === instruction.shotId), instruction.patch);
      const revision = await reviseScript(context, next, note, profilePatch ? { speechProfilePatch: profilePatch } : {});
      return { applied: { mode: 'revise', revision, profilePatched: !!profilePatch, patch: Object.keys(instruction.patch) } };
    });
    if (outcome.notApplied) {
      await lockAnd(context, async () => {
        const state = loadState(context);
        const current = state.rework[opened.jobId];
        current.stage = 'done'; current.notApplied = outcome.notApplied; current.finishedAt = new Date().toISOString();
        state.reworkSpeechNote = { target, ...outcome.notApplied, at: new Date().toISOString() };
        saveState(context, state);
      });
      return { target, jobId: opened.jobId, applied: false, instruction: exposedInstruction(), notApplied: outcome.notApplied,
        nextStep: '返工未应用：该指令需要的表演参数当前模型不支持；未生成媒体、未新增预留；需先切换语音模型或改为脚本修订' };
    }
    if (!outcome.already) {
      await lockAnd(context, async () => {
        const state = loadState(context);
        const current = state.rework[opened.jobId];
        current.applied = outcome.applied; current.stage = 'review'; current.appliedAt = new Date().toISOString();
        // The intent is consumed by this commit: the change and the "applied" mark end up in state together.
        delete current.applying;
        if (outcome.recovered) current.recovered = { at: current.appliedAt, mode: outcome.applied.mode };
        saveState(context, state);
      });
    }
    job = await readJob(context, opened.jobId);
  }
  if (job.stage === 'review') {
    try {
      const review = await lockAnd(context, async () => {
        const state = loadState(context);
        const current = state.rework[opened.jobId];
        // Another run may have finished this job while this one waited: reuse its review instead of paying
        // for a second submission and appending a second applied record.
        if (current.stage === 'done') return { ...(current.review || {}), reused: true };
        const result = await reviewScript(context, { models: modelsFor(context, injectedClient, log), state, log });
        state.scriptReview = result;
        current.review = { verdict: result.verdict, estimatedDurationSeconds: result.estimatedDurationSeconds,
          reviewInputDigest: result.reviewInputDigest, scriptHash: result.scriptHash };
        current.stage = 'done'; current.finishedAt = new Date().toISOString();
        state.reworkApplied ||= [];
        state.reworkApplied.push({ target, jobId: opened.jobId, reason: String(reason).trim(), instruction: current.instruction,
          applied: current.applied, review: current.review, at: new Date().toISOString() });
        saveState(context, state);
        return result;
      });
      return { target, jobId: opened.jobId, applied: true, appliedTo: job.applied, instruction: exposedInstruction(),
        review: { verdict: review.verdict, estimatedDurationSeconds: review.estimatedDurationSeconds, reused: !!review.reused },
        nextStep: '未生成任何媒体：run 会要求先 approve script，再按既有闸门与预算生成受影响素材' };
    } catch (error) {
      if (!/UNCERTAIN|RECONCILIATION|TASK_PENDING/.test(error.message)) throw error;
      await lockAnd(context, async () => {
        const state = loadState(context);
        const current = state.rework[opened.jobId];
        current.stage = 'review';
        current.blocked = { reason: error.message, at: new Date().toISOString(),
          note: '保持原审核操作号，不重发；核实原提交后再执行同一命令继续' };
        saveState(context, state);
      });
      throw new Error('REWORK_REVIEW_BLOCKED_UNCERTAIN:' + opened.jobId + ': ' + error.message +
        '；指令与脚本修改已保留，待核实原提交后再执行同一命令继续');
    }
  }
  return { target, jobId: opened.jobId, stage: job.stage, instruction: exposedInstruction(),
    nextStep: '任务处于可恢复阶段：重新执行同一命令继续，不会重复请求或重复修改' };
}

module.exports = { REWORK_CODES, affectedOperations, applyRework, continueRework, reworkGuard, reworkScope };
