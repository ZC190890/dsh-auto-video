const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, hash, withLock, redact } = require('../services/aliyun/io');
const { UnitAttempts } = require('../services/aliyun/units');

// Controlled recovery for an ambiguous planning submission (second-film / plan-script / 2026-09-22).
//
// Locking: this entry takes exactly the same exclusive state lock as run / redo / revise-script /
// audio-review / local-edit / settle — jobs/aliyun/run.lock — so it can never read a stale state and write
// it back over a concurrent production update. There is deliberately no second private lock: a leftover
// private lock could not be cleared by the `unlock` command, and a single lock keeps the lock order trivial
// (run.lock first and only, then state and decision files) with no deadlock window. A concurrent run or a
// second registration is refused explicitly by withLock (BUSY_OR_STALE_LOCK); nothing waits or auto-retries.
//
// Registration is a recoverable two-phase process whose completion means "decision and production state
// agree", never merely "a decision file exists":
//   1. write the decision file with application.status = 'registered'
//   2. write state.json (read-modify-write inside the lock, every other field preserved)
//   3. re-write the same decision file with application.status = 'applied'
// Re-running after any interruption reuses the registered retryOperation, completes only the missing step
// and never creates a second retry or consumes another round. Conflicts (a newer decision, a different
// applied decision, a changed original fingerprint or status, another production) are refused without
// overwriting or rolling anything back. Nothing here contacts a provider.
const EVIDENCE_KEYS = ['provider', 'operationId', 'requestId', 'httpStatus', 'usage', 'elapsedSeconds', 'verdict'];
const DECISIONS = ['regenerate'];
const ORIGINAL_ID = 'plan-script';

function runLockFile(context) { return path.join(context.root, 'jobs', 'aliyun', 'run.lock'); }
function stateFileOf(context) { return path.join(context.directory, 'state.json'); }
function decisionsDirectory(context) { return path.join(context.directory, 'recovery'); }
function readDecisions(context) {
  const directory = decisionsDirectory(context);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^plan-script-recovery-\d+\.json$/.test(name))
    .map(name => {
      let value;
      try { value = readJson(path.join(directory, name)); }
      catch { throw new Error('RECOVERY_DECISION_RECORD_CORRUPT:' + name); }
      if (value?.kind !== 'plan-script-recovery' || !Number.isSafeInteger(value.sequence))
        throw new Error('RECOVERY_DECISION_RECORD_CORRUPT:' + name);
      return { ...value, file: name };
    })
    .sort((a, b) => a.sequence - b.sequence || String(a.createdAt).localeCompare(String(b.createdAt)));
}
function readState(context) {
  const file = stateFileOf(context);
  return fs.existsSync(file) ? readJson(file) : {};
}
function loadEvidence(context, evidenceFile) {
  if (typeof evidenceFile !== 'string' || !evidenceFile.trim()) throw new Error('RECOVERY_EVIDENCE_FILE_REQUIRED');
  const target = path.resolve(context.root, evidenceFile);
  if (!fs.existsSync(target)) throw new Error('RECOVERY_EVIDENCE_FILE_MISSING:' + evidenceFile);
  const evidence = readJson(target);
  for (const key of EVIDENCE_KEYS)
    if (evidence[key] === undefined || evidence[key] === null) throw new Error('RECOVERY_EVIDENCE_INCOMPLETE:' + key);
  if (evidence.verdict !== 'usage-recorded-no-usable-body')
    throw new Error('RECOVERY_EVIDENCE_VERDICT_INVALID:' + evidence.verdict);
  if (evidence.operationId !== ORIGINAL_ID) throw new Error('RECOVERY_EVIDENCE_OPERATION_MISMATCH:' + evidence.operationId);
  return { file: path.relative(context.root, target).replace(/\\/g, '/'), evidence };
}
// The original record, its ownership and its live state are re-verified before anything is completed, so a
// finished retry, an adopted result or a swapped record can never be completed blindly.
function verifyOriginal(context, recovery) {
  const file = path.join(context.directory, 'operations', ORIGINAL_ID + '.json');
  if (!fs.existsSync(file)) throw new Error('RECOVERY_ORIGINAL_RECORD_MISSING:' + ORIGINAL_ID);
  const original = readJson(file);
  if (original.id !== ORIGINAL_ID) throw new Error('RECOVERY_ORIGINAL_RECORD_MISMATCH:' + (original.id || '?'));
  if (original.fingerprint !== recovery.original.fingerprint)
    throw new Error('RECOVERY_ORIGINAL_FINGERPRINT_CHANGED:' + ORIGINAL_ID + '：原操作输入指纹已变化，拒绝覆盖或回退');
  if (original.status !== 'uncertain')
    throw new Error('RECOVERY_ORIGINAL_STATE_CHANGED:' + ORIGINAL_ID + ':' + original.status + '：原操作已不再是待核实状态，需人工核对');
  if (original.spec?.kind !== 'planner' || original.spec?.purpose !== 'script')
    throw new Error('RECOVERY_ORIGINAL_NOT_OWNED:' + ORIGINAL_ID + '：原操作不是本片脚本规划请求，拒绝登记');
  const retryFile = path.join(context.directory, 'operations', recovery.retryOperation + '.json');
  if (fs.existsSync(retryFile)) {
    const retry = readJson(retryFile);
    if (retry.id !== recovery.retryOperation || retry.spec?.purpose !== 'script')
      throw new Error('RECOVERY_RETRY_OPERATION_CONFLICT:' + recovery.retryOperation + '：该重试操作号已被其它请求占用');
  }
  return original;
}
function stateAppliedFrom(state, recovery, productionId) {
  const applied = state?.scriptPlanRecovery;
  return !!applied && applied.evidenceHash === recovery.evidenceHash &&
    applied.retryOperation === recovery.retryOperation && applied.productionId === productionId;
}
// Read-modify-write of the shared state happens inside the run lock, so no field written by another entry
// point can be lost and no newer decision can be overwritten.
function applyState(context, recovery, productionId) {
  const state = readState(context);
  state.version ||= 1;
  state.productionId ||= productionId;
  const previous = state.scriptPlanRecovery;
  if (previous && previous.retryOperation !== recovery.retryOperation) {
    // Moving forward to a newer decision keeps the replaced one as history: nothing is silently lost and
    // an older decision can never roll this back.
    state.scriptPlanRecoveryHistory ||= [];
    state.scriptPlanRecoveryHistory.push({ replacedAt: new Date().toISOString(), by: recovery.file, previous });
  }
  state.scriptPlanRecovery = { at: recovery.createdAt, productionId, original: ORIGINAL_ID,
    sequence: recovery.sequence, decisionFile: recovery.file, retryOperation: recovery.retryOperation,
    decision: recovery.decision, evidenceFile: recovery.evidence.file, evidenceHash: recovery.evidenceHash,
    reason: recovery.reason, originalFingerprint: recovery.original.fingerprint,
    note: '受控重试：原尝试计入首次生成，本次消耗一次返工机会；已成功的素材分析与制作简报不重做' };
  writeJson(stateFileOf(context), state);
  return state;
}
function markApplied(context, recovery) {
  const updated = { ...recovery, application: { status: 'applied', stateFile: 'state.json',
    productionId: recovery.application.productionId, registeredAt: recovery.application.registeredAt,
    appliedAt: new Date().toISOString() } };
  delete updated.file;
  writeJson(path.join(decisionsDirectory(context), recovery.file), updated);
  return { ...updated, file: recovery.file };
}
// The registration itself. Argument-only validation happens before the lock; everything that reads or
// writes shared state happens inside it.
async function recoverScriptPlan(context, { evidenceFile = null, decision = 'regenerate', reason } = {}) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('RECOVERY_REASON_REQUIRED: 必须写明恢复理由');
  if (!DECISIONS.includes(decision)) throw new Error('RECOVERY_DECISION_UNSUPPORTED:' + decision);
  const productionId = context.production?.id;
  if (typeof productionId !== 'string' || !productionId) throw new Error('RECOVERY_PRODUCTION_REQUIRED');
  return withLock(runLockFile(context), async () => {
    const { file: evidenceRelative, evidence } = loadEvidence(context, evidenceFile);
    const evidenceHash = hash(evidence);
    const decisions = readDecisions(context);
    const registered = decisions.find(item => item.evidenceHash === evidenceHash && item.decision === decision);
    if (registered)
      return completeRegistration(context, { registered, productionId, evidenceFile: evidenceRelative,
        alreadyRegistered: true });
    const attempts = new UnitAttempts(context.directory);
    const rounds = attempts.status('script');
    if (!rounds.hasRoundsLeft)
      throw new Error('RECOVERY_NO_ROUNDS_LEFT:script:' + rounds.generations +
        '：脚本单元已用完首次生成与 3 次返工，不能自动重置为首次，需人工决定');
    const originalFile = path.join(context.directory, 'operations', ORIGINAL_ID + '.json');
    if (!fs.existsSync(originalFile)) throw new Error('RECOVERY_ORIGINAL_RECORD_MISSING:' + ORIGINAL_ID);
    const original = readJson(originalFile);
    if (original.id !== ORIGINAL_ID || original.status !== 'uncertain')
      throw new Error('RECOVERY_NOT_UNCERTAIN:' + (original.id || '?') + ':' + (original.status || '?') +
        '：只有待核实（uncertain）的原操作才需要恢复入口');
    const state = readState(context);
    if (state.productionId && state.productionId !== productionId)
      throw new Error('RECOVERY_PRODUCTION_MISMATCH:' + state.productionId + '≠' + productionId + '：作业目录不属于该制作清单');
    const retryOperation = 'plan-script-retry-' + (decisions.filter(item => item.retryOperation).length + 1);
    if (decisions.some(item => item.retryOperation === retryOperation))
      throw new Error('RECOVERY_RETRY_OPERATION_CONFLICT:' + retryOperation + '：该重试操作号已被另一决策登记');
    const sequence = decisions.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
    const recovery = { kind: 'plan-script-recovery', createdAt: new Date().toISOString(), sequence, productionId,
      original: { id: ORIGINAL_ID, status: original.status, fingerprint: original.fingerprint,
        attemptedAt: original.attemptedAt || null, requestId: original.error?.requestId || null,
        error: original.error?.message ? redact(original.error.message) : null, recordUntouched: true },
      evidence: { file: evidenceRelative, provider: evidence.provider, requestId: evidence.requestId,
        httpStatus: evidence.httpStatus, submittedAtLocal: evidence.submittedAtLocal || null, usage: evidence.usage,
        elapsedSeconds: evidence.elapsedSeconds, verdict: evidence.verdict },
      originalResultRecoverable: false,
      originalResultReason: '正文仅 ' + Number(evidence.usage?.textTokens || 0) + ' 个 token，不构成可用脚本；不伪造可恢复脚本',
      decision, reason: reason.trim().slice(0, 400), retryOperation, unit: 'script',
      roundAccounting: { originalCountsAs: '首次生成（已产生用量，不退还、不重置）', retryCountsAs: '一次返工',
        generationsBefore: rounds.generations, remainingReworksBefore: rounds.remainingReworks },
      billing: { actualCents: null, note: '无账单不虚构金额；未知不是 0；本入口不联网' },
      evidenceHash, networkRequests: 0,
      application: { status: 'registered', stateFile: 'state.json', productionId,
        registeredAt: new Date().toISOString(), appliedAt: null } };
    const file = 'plan-script-recovery-' + sequence + '.json';
    writeJson(path.join(decisionsDirectory(context), file), recovery);   // step 1: durable intent
    return completeRegistration(context, { registered: { ...recovery, file }, productionId, evidenceFile: evidenceRelative });
  });
}
// Completion is idempotent and resumable: an existing decision keeps its retryOperation, the state is only
// written after the original, the ownership and the absence of conflicts have been re-verified, and
// "completed" means the decision and the production state agree.
function completeRegistration(context, { registered, productionId, evidenceFile, alreadyRegistered = false }) {
  const state = readState(context);
  if (stateAppliedFrom(state, registered, productionId)) {
    // Steps 2/3 already happened (or the marker was lost): never create a second retry, never consume
    // another round, only repair the application marker.
    const recovery = registered.application?.status === 'applied' && registered.application?.appliedAt
      ? registered : markApplied(context, registered);
    return { idempotent: true, completed: true, resumed: false, retryOperation: registered.retryOperation,
      application: recovery.application, recovery, evidenceFile,
      note: '决策与制作状态一致：原记录未动，重试操作号不变，不重复计数' };
  }
  const newer = readDecisions(context).filter(item => item.sequence > registered.sequence);
  if (newer.length)
    throw new Error('RECOVERY_SUPERSEDED_BY_NEWER_DECISION:' + registered.retryOperation +
      '：已存在更新的恢复决策（' + newer.map(item => item.file).join('、') + '），拒绝用旧决策覆盖或回退');
  const current = state?.scriptPlanRecovery;
  if (current && !(current.evidenceHash === registered.evidenceHash && current.retryOperation === registered.retryOperation)) {
    // The state already carries an applied decision: moving forward to a strictly newer decision is allowed
    // (the replaced one is kept as history), rolling back to an older one is refused.
    const applied = readDecisions(context).find(item => item.retryOperation === current.retryOperation);
    const appliedSequence = applied?.sequence ?? (Number.isSafeInteger(current.sequence) ? current.sequence : 0);
    if (!(registered.sequence > appliedSequence))
      throw new Error('RECOVERY_STATE_CONFLICT:' + (current.retryOperation || '?') +
        '：制作状态已有另一条恢复决策，拒绝覆盖或回退');
  }
  if (state?.productionId && state.productionId !== productionId)
    throw new Error('RECOVERY_PRODUCTION_MISMATCH:' + state.productionId + '≠' + productionId + '：作业目录不属于该制作清单');
  verifyOriginal(context, registered);
  applyState(context, registered, productionId);      // step 2: the production state
  const recovery = markApplied(context, registered);  // step 3: the durable completion marker
  return { idempotent: false, completed: true, resumed: alreadyRegistered, retryOperation: registered.retryOperation,
    application: recovery.application, recovery, evidenceFile,
    note: '登记完成：决策与制作状态一致，未新建重试号、未重复消耗轮次、未联网' };
}
// The planning flow reads this so the retry runs under its own operation number while the unit stays
// "script". The field only exists once a registration completed, so the flow can never pick up a
// half-written decision.
function scriptPlanOperationId(state) {
  const retry = state?.scriptPlanRecovery?.retryOperation;
  return typeof retry === 'string' && retry ? retry : 'plan-script';
}
module.exports = { DECISIONS, EVIDENCE_KEYS, completeRegistration, listDecisions: readDecisions,
  recoverScriptPlan, runLockFile, scriptPlanOperationId };



