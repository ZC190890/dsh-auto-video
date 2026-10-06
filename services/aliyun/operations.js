const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, hash, safeId, redact, claimFile, inspectClaim } = require('./io');
const { unitForOperation, checkUnitForOperation } = require('./units');
// The run lock serializes writes. Persist intent BEFORE sending; never retry an ambiguous POST.
// Every submission also takes an atomic per-operation claim, so the same operation can only be posted
// once even if two processes (or two CLI calls) reach this point at the same time.
class Operations {
  constructor(directory, client, budget, log = () => {}, pollSeconds = 15, pollTimeout = 600, attempts = null) {
    this.directory = directory; this.client = client; this.budget = budget; this.log = log;
    this.pollSeconds = pollSeconds; this.pollTimeout = pollTimeout; this.attempts = attempts;
  }
  async execute(id, spec, buildBody) {
    safeId(id);
    const file = path.join(this.directory, id + '.json'), fingerprint = hash(spec);
    // The claim is taken first, so an in-flight round is always observable while its unit round is open.
    const release = claimFile(path.join(this.directory, id + '.submit.lock'));
    const unit = unitForOperation(id);
    // Checks, analyses, reviews and rework advice are not generation units; they run on their own persisted
    // budget (first request plus at most three controlled retries for the same effective input). A stored
    // successful record for the very same input is reused instead of being paid for again, so a re-run or a
    // resume never opens a new paid review unit, and a failure is never auto-resend.
    const checkUnit = unit ? null : checkUnitForOperation(id);
    const checkBind = checkUnit ? (spec.purpose || spec.kind || null) : null;
    const checkDigest = spec.checkBudgetKey || fingerprint;
    const reusable = checkUnit ? this.cachedSucceeded(file, fingerprint) : false;
    if (this.attempts && checkUnit && !reusable)
      await this.attempts.reserveCheck(checkUnit, checkBind, checkDigest, id, { reason: spec.purpose || spec.kind || null });
    // Every generation entry point goes through here, so the per-unit round is claimed once, before the
    // request exists, and it is committed only when the authoritative record shows the attempt.
    if (this.attempts && unit) await this.attempts.reserve(unit, id, { reason: spec.purpose || spec.kind || null });
    try {
      const result = await this.submitClaimed(id, file, fingerprint, spec, buildBody);
      const settled = fs.existsSync(file) ? readJson(file).status : 'succeeded';
      if (this.attempts && unit) await this.attempts.commit(unit, id, settled);
      if (this.attempts && checkUnit && !reusable) await this.attempts.commitCheck(checkUnit, checkBind, checkDigest, id, settled);
      return result;
    } catch (error) {
      if (this.attempts && unit) {
        try { await this.attempts.settleAfterError(unit, id); }
        catch (bookkeeping) { this.log('轮次结算失败（操作记录仍为准）：' + id + '：' + redact(bookkeeping.message)); }
      }
      if (this.attempts && checkUnit && !reusable) {
        try { await this.attempts.settleCheckAfterError(checkUnit, checkBind, checkDigest, id); }
        catch (bookkeeping) { this.log('检查额度结算失败（操作记录仍为准）：' + id + '：' + redact(bookkeeping.message)); }
      }
      throw error;
    } finally { release(); }
  }
  // Identical effective input already produced a result: reuse it, never pay twice for the same request.
  cachedSucceeded(file, fingerprint) {
    if (!fs.existsSync(file)) return false;
    try { const state = readJson(file); return state.status === 'succeeded' && state.fingerprint === fingerprint; }
    catch { return false; }
  }
  async submitClaimed(id, file, fingerprint, spec, buildBody) {
    let state = fs.existsSync(file) ? readJson(file) : { id, fingerprint, status: 'new' };
    if (state.fingerprint !== fingerprint) throw new Error('OPERATION_INPUT_CHANGED:' + id);
    if (state.status === 'succeeded') {
      await this.budget.completed(id, state.result.usage); return state.result;
    }
    if (['submitting', 'uncertain', 'failed', 'unknown'].includes(state.status)) throw new Error('OPERATION_REQUIRES_RECONCILIATION:' + id + ':' + state.status);
    if (state.status === 'new') {
      await this.budget.reserve(id, spec.cents, fingerprint);
      const body = await buildBody();
      state = { ...state, status: 'submitting', spec, attemptedAt: new Date().toISOString() };
      writeJson(file, state); this.log('提交 ' + id);
      let result;
      // Separate budgets per purpose: a planning stream gets its own total and idle limits, on top of the
      // transport timeouts used by uploads and downloads. Diagnostics (request id, usage, partial length,
      // interruption time) go to the local job directory; no key, no reasoning text, no material Base64.
      const diagnostics = path.resolve(this.directory, '..', 'diagnostics', id + '-' + Date.now() + '.json');
      try {
        result = await this.client.request(spec.endpoint, body, { async: spec.async === true,
          timeoutMs: spec.timeoutMs, streamIdleMs: spec.streamIdleMs, diagnostics });
      } catch (error) {
        state.status = 'uncertain';
        state.error = { message: redact(error.message), status: error.status || null, requestId: error.requestId || null,
          evidence: error.evidence || null };
        writeJson(file, state); throw new Error('SUBMISSION_UNCERTAIN:' + id + ': 已保留记录，禁止自动重发');
      }
      state.result = result;
      if (spec.async) {
        state.taskId = result.output?.task_id;
        if (typeof state.taskId !== 'string' || !state.taskId) {
          state.status = 'uncertain'; writeJson(file, state); throw new Error('TASK_ID_MISSING:' + id);
        }
        state.status = 'submitted';
      } else state.status = 'succeeded';
      writeJson(file, state);
    }
    if (state.status === 'submitted') {
      const deadline = Date.now() + this.pollTimeout * 1000;
      do {
        const result = await this.client.task(state.taskId), status = result.output?.task_status;
        state.result = result;
        if (status === 'SUCCEEDED') state.status = 'succeeded';
        else if (['FAILED', 'CANCELED', 'UNKNOWN'].includes(status)) state.status = status === 'UNKNOWN' ? 'unknown' : 'failed';
        else if (!['PENDING', 'RUNNING'].includes(status)) throw new Error('UNRECOGNIZED_TASK_STATUS:' + id);
        writeJson(file, state);
        if (state.status === 'succeeded') break;
        if (state.status !== 'submitted') throw new Error('PROVIDER_TASK_' + state.status.toUpperCase() + ':' + id);
        if (Date.now() >= deadline) throw new Error('TASK_PENDING:' + id + ': 重新 run 会查询原任务');
        this.log('等待 ' + id + '：' + status);
        await new Promise(resolve => setTimeout(resolve, this.pollSeconds * 1000));
      } while (true);
    }
    await this.budget.completed(id, state.result.usage); return state.result;
  }
  // Clearing a submission claim is a user decision that needs evidence, a verifiable owner and an
  // operation record that shows no submission. A claim whose owner still runs (or whose state cannot be
  // verified) is refused, so a release can never open the door to a second submission.
  releaseStaleClaim(id, evidence) {
    safeId(id);
    if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 500) throw new Error('CLAIM_RELEASE_EVIDENCE_REQUIRED');
    const claim = path.join(this.directory, id + '.submit.lock');
    const held = inspectClaim(claim);
    if (!held) throw new Error('NO_SUBMISSION_CLAIM:' + id);
    if (held.unreadable || !held.token || held.pid === null)
      throw new Error('CLAIM_OWNER_UNVERIFIABLE:' + id + '：占用未记录可核实的持有者，拒绝清除，需人工核对 ' + claim);
    if (held.alive !== false)
      throw new Error('CLAIM_OWNER_STILL_RUNNING:' + id + '：占用进程 ' + held.pid +
        ' 仍在运行或状态无法核实，不得清除占用；先确认该进程已退出');
    const file = path.join(this.directory, id + '.json');
    const state = fs.existsSync(file) ? readJson(file) : null;
    // A submitted asynchronous task is already out of our hands: releasing its claim only re-enables
    // QUERYING the original task (its id, fingerprint, status and reservation are untouched), never a
    // second generation. Anything without a task id still needs reconciliation first.
    const queryable = !!state && state.status === 'submitted' && typeof state.taskId === 'string' && !!state.taskId;
    if (state && !['new', 'succeeded'].includes(state.status) && !queryable)
      throw new Error('CLAIM_RELEASE_REQUIRES_RECONCILIATION:' + id + ':' + state.status +
        '：已有提交痕迹，不得清除占用或重发；先按原操作号核实并 adopt-response/adopt-task');
    // Atomic: the verified claim is renamed away, so a claim created meanwhile is never removed here.
    const parked = claim + '.released-' + held.token;
    fs.renameSync(claim, parked);
    fs.unlinkSync(parked);
    const audit = path.join(this.directory, id + '.claim-release.json');
    const record = { at: new Date().toISOString(), evidence: evidence.trim(), ownerPid: held.pid,
      operationStatus: state ? state.status : 'missing', taskId: queryable ? state.taskId : null,
      note: queryable
        ? '已提交的异步任务：释放占用后只允许继续查询原 taskId，绝不重新提交生成'
        : '清除占用不等于确认未提交：若操作记录缺失，必须先向供应商核实无该请求再重新执行' };
    const log = fs.existsSync(audit) ? readJson(audit) : { id, releases: [] };
    log.releases.push(record); writeJson(audit, log);
    return record;
  }
  async refresh(id) {
    safeId(id);
    const file = path.join(this.directory, id + '.json'), state = readJson(file);
    if (state.status !== 'succeeded' || !state.spec?.async || !state.taskId) throw new Error('RESULT_RECOVERY_REQUIRED:' + id);
    const result = await this.client.task(state.taskId);
    if (result.output?.task_status !== 'SUCCEEDED' || (result.output.task_id && result.output.task_id !== state.taskId)) throw new Error('RESULT_REFRESH_UNAVAILABLE:' + id);
    state.result = result; state.refreshedAt = new Date().toISOString();
    writeJson(file, state);
    return result;
  }
  adoptResponse(id, recovered, evidence) {
    safeId(id);
    const file = path.join(this.directory, id + '.json'), state = readJson(file);
    if (!evidence?.trim() || !recovered || recovered.operationId !== id || recovered.fingerprint !== state.fingerprint) throw new Error('RESPONSE_EVIDENCE_REQUIRED');
    if (!['submitting', 'uncertain', 'succeeded'].includes(state.status) || state.spec?.async === true) throw new Error('RESPONSE_CANNOT_BE_ADOPTED');
    const result = recovered.result;
    if (!result || result.error || result.code || !(result.request_id || result.id)) throw new Error('INVALID_RECOVERED_RESPONSE');
    const spec = state.spec;
    if (spec.kind === 'text' || spec.kind === 'vision' || spec.kind === 'planner') {
      if (result.choices?.[0]?.finish_reason !== 'stop' || typeof result.choices[0].message?.content !== 'string') throw new Error('INVALID_RECOVERED_RESPONSE');
    } else if (spec.targetModel) {
      const voice = spec.model === 'voice-enrollment' ? result.output?.voice_id : result.output?.voice;
      if (typeof voice !== 'string' || !voice) throw new Error('INVALID_RECOVERED_RESPONSE');
    } else if (spec.voice) {
      if (typeof result.output?.audio?.url !== 'string') throw new Error('INVALID_RECOVERED_RESPONSE');
    } else throw new Error('UNSUPPORTED_RECOVERED_RESPONSE');
    state.recoveries ||= [];
    state.recoveries.push({ at: new Date().toISOString(), evidence, previousResult: state.result || null, previousStatus: state.status });
    state.result = result; state.status = 'succeeded';
    writeJson(file, state);
  }
  adoptTask(id, taskId, evidence) {
    safeId(id);
    if (!/^[\w-]{1,120}$/.test(taskId) || !evidence?.trim()) throw new Error('TASK_EVIDENCE_REQUIRED');
    const file = path.join(this.directory, id + '.json'), state = readJson(file);
    if (!['submitting', 'uncertain'].includes(state.status) || state.spec.async !== true) throw new Error('TASK_CANNOT_BE_ADOPTED');
    state.taskId = taskId; state.status = 'submitted'; state.reconciliation = evidence; writeJson(file, state);
  }
}
module.exports = { Operations };
