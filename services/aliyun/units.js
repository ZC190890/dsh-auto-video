const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, withLock } = require('./io');

// One production unit is the smallest thing that can be regenerated on its own: the whole script, one
// character portrait, or one shot's speech / first frame / last frame / video. The first generation is
// not a rework; after that a unit may be reworked at most three times, so four generations in total.
// The count is bound to the production task plus the unit plus the generation stage, so a new operation
// id, a new revision, a new rework job id, a model switch, a changed prompt or a restart cannot reset it.
const REWORK_LIMIT = 3;
const GENERATIONS_PER_UNIT = 1 + REWORK_LIMIT;
// Checks, analyses, reviews and rework advice are NOT generation units: they have their own budget of one
// first request plus at most three controlled retries for the same logical unit and effective input, and
// they never consume a round of video/image/speech generation.
const CHECK_LIMIT = 3;
const ATTEMPTED = ['submitting', 'submitted', 'succeeded', 'failed', 'uncertain', 'unknown'];
const UNRESOLVED = ['submitting', 'submitted', 'uncertain'];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Logical check units bound every paid inspection/planning path. Ids may carry a revision or a content
// digest, but the budget stays on the logical purpose so a rewritten prompt version, a random suffix or a
// micro-edited input cannot manufacture unlimited new review units.
function checkUnitForOperation(id) {
  const base = String(id).replace(/-r\d+$/, '');
  if (/^plan-(script|script-review|brief)(-[0-9a-f]{8,})?$/.test(base)) return base.replace(/-[0-9a-f]{8,}$/, '');
  if (/^plan-material-/.test(base)) return base.replace(/-[0-9a-f]{8,}$/, '');
  // The storyboard plan carries a content digest instead of a name: the whole board of one production is ONE logical
  // planning purpose, so the budget stays on the purpose and the digest (which moves whenever the planned input
  // moves) keeps a genuinely new plan from being starved by the retries of the superseded one. Without this the
  // request had no check budget at all: an unbounded, unbilled-in-the-ledger paid planning call.
  if (/^plan-storyboard(-[0-9a-f]{12,})?$/.test(base)) return 'plan-storyboard';
  const retry = /^(plan-script|plan-revision)-retry(-\d+)?$/.exec(base);
  if (retry) return 'plan-' + (retry[1] === 'plan-script' ? 'script' : 'revision') + '-retry';
  const match = /^(inspect|front-check|frame-check|video-check|adjacent-check|audio-review|tone-review|plan-rework|plan-rework-instruction|plan-revision)-(.+)$/.exec(base);
  if (!match) return null;
  return match[1] + '-' + match[2].replace(/-[0-9a-f]{12,}$/, '');
}

// Operation id -> unit id. Checks, analyses and reviews never produce a reworkable artefact, so they are
// not units and never consume a round; only generation operations are counted.
function unitForOperation(id) {
  const base = String(id).replace(/-r\d+$/, '');
  if (base === 'plan-script' || base === 'plan-revision' || /^plan-(script|revision)-retry(-\d+)?$/.test(base)) return 'script';
  const match = /^(first|last|speech|video|voice|front)-(.+)$/.exec(base);
  if (!match) return null;
  if (base.startsWith('video-check-') || base.startsWith('front-check-')) return null;
  return match[1] + '-' + match[2];
}
// The base names a unit owns inside the operations directory (used to rebuild a legacy baseline).
function basesForUnit(unit) {
  if (unit === 'script') return ['plan-script', 'plan-revision'];
  if (unit.startsWith('front-')) return [unit, 'front-check-' + unit.slice('front-'.length)];
  return [unit];
}

class UnitAttempts {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'unit-attempts.json');
    this.lock = this.file + '.lock';
    this.operations = path.join(directory, 'operations');
  }
  read() {
    const value = fs.existsSync(this.file) ? readJson(this.file) : { version: 1, units: {} };
    if (value.version !== 1 || typeof value.units !== 'object' || value.units === null) throw new Error('INVALID_UNIT_LEDGER');
    return value;
  }
  unit(ledger, unit) {
    return ledger.units[unit] ||= { generations: 0, reworks: 0, consumed: {}, pending: null, exhausted: null,
      limitReached: null, lastOperation: null, lastStatus: null, needsAudit: null, updatedAt: null };
  }
  // An operation is accounted for when this ledger counted it already or when its round was migrated
  // from the authoritative records: either way it must never be counted a second time.
  accounted(rec, operation) {
    return !!rec.consumed?.[operation] || (rec.migratedOperations || []).includes(operation);
  }
  // Reconcile a pending round that was never settled (a crash between the reserve and the verdict):
  // an attempt that reached the provider keeps its round, one that never left this machine is released.
  reconcile(rec) {
    const pending = rec.pending;
    if (!pending) return null;
    const recordFile = path.join(this.operations, pending.operation + '.json');
    const claimed = fs.existsSync(path.join(this.operations, pending.operation + '.submit.lock'));
    let record = null;
    if (fs.existsSync(recordFile)) { try { record = readJson(recordFile); } catch { record = null; } }
    if (claimed || UNRESOLVED.includes(record?.status))
      return { verdict: 'in-flight', pending, attempted: ATTEMPTED.includes(record?.status), status: record?.status || null };
    if (ATTEMPTED.includes(record?.status)) return { verdict: 'attempted', pending, status: record.status };
    return { verdict: 'never-submitted', pending };
  }
  exhaustedError(rec, unit) {
    return new Error('UNIT_REWORK_LIMIT_REACHED:' + unit + ':' + rec.generations +
      '：首次生成不计返工，之后最多 3 次返工；该单元已用完 4 轮生成，需人工核对' +
      (rec.exhausted?.reason ? '（' + rec.exhausted.reason + '）' : '') +
      '；不自动重置额度，也不通过新操作号、改模型或换任务绕过');
  }
  // Running out of rounds is not the same as failing. The 4th result stays usable — it can be queried,
  // downloaded, reviewed, accepted and carried downstream — and only a further NEW generation is refused.
  limitError(rec, unit) {
    return new Error('UNIT_NO_GENERATION_ROUNDS_LEFT:' + unit + ':' + rec.generations +
      '：已用完首次生成与最多 3 次返工，不能再新增生成；已有结果的查询、下载、审核、验收与下游不受影响' +
      (rec.limitReached?.reason ? '（' + rec.limitReached.reason + '）' : '') + '；不自动重置额度');
  }
  // The generations a unit already used, rebuilt only from records that can be verified: every
  // authoritative operation record that shows an attempt. Ambiguity is reported instead of assumed.
  baseline(unit) {
    let generations = 0;
    const operations = [];
    const names = fs.existsSync(this.operations) ? fs.readdirSync(this.operations) : [];
    for (const base of basesForUnit(unit)) {
      const pattern = new RegExp('^' + escape(base) + '(-r\\d+)?\\.json$');
      for (const name of names) {
        if (!pattern.test(name)) continue;
        const id = name.slice(0, -'.json'.length);
        let record;
        try { record = readJson(path.join(this.operations, name)); }
        catch { return { generations: null, operations: [], audit: 'OPERATION_RECORD_CORRUPT:' + id }; }
        if (record?.id !== id) return { generations: null, operations: [], audit: 'OPERATION_RECORD_MISMATCH:' + id };
        if (ATTEMPTED.includes(record.status)) { generations += 1; operations.push(id); }
      }
    }
    // A reservation without its authoritative record is exactly the case that must not be guessed.
    const ledgerFile = path.join(this.directory, 'api-ledger.json');
    if (fs.existsSync(ledgerFile)) {
      const ledger = readJson(ledgerFile);
      for (const entry of ledger.entries || []) {
        const owned = basesForUnit(unit).some(base => new RegExp('^' + escape(base) + '(-r\\d+)?$').test(entry.id));
        if (owned && !fs.existsSync(path.join(this.operations, entry.id + '.json')))
          return { generations: null, operations: [], audit: 'RESERVED_OPERATION_RECORD_MISSING:' + entry.id };
      }
    }
    return { generations, operations, audit: null };
  }
  async reserve(unit, operation, { reason = null } = {}) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const rec = this.unit(ledger, unit);
      if (rec.exhausted) throw this.exhaustedError(rec, unit);
      // Reusing or resuming an operation that is already counted is never a new round, so an existing 4th
      // result stays reachable even after the rounds are used up.
      if (this.accounted(rec, operation)) { writeJson(this.file, ledger); return { already: true, generations: rec.generations }; }
      // Out of rounds but not paused: refuse only a genuinely new generation, with the accurate reason.
      if (rec.generations >= GENERATIONS_PER_UNIT) throw this.limitError(rec, unit);
      if (rec.needsAudit)
        throw new Error('UNIT_ATTEMPTS_NEED_AUDIT:' + unit + ':' + rec.needsAudit + '：历史次数无法从可核实记录判定，请先核对，不默认按 0 计');
      if (!rec.consumed || !Object.keys(rec.consumed).length) {
        const base = this.baseline(unit);
        if (base.audit) {
          rec.needsAudit = base.audit; rec.updatedAt = new Date().toISOString(); writeJson(this.file, ledger);
          throw new Error('UNIT_ATTEMPTS_NEED_AUDIT:' + unit + ':' + base.audit + '：历史次数无法从可核实记录判定，请先核对，不默认按 0 计');
        }
        if (base.generations > 0) {
          rec.generations = base.generations; rec.reworks = Math.max(0, base.generations - 1);
          rec.migratedFrom = 'operation-records'; rec.migratedOperations = base.operations;
        }
      }
      if (this.accounted(rec, operation)) { writeJson(this.file, ledger); return { already: true, generations: rec.generations }; }
      const pending = this.reconcile(rec);
      // A round that already reached the provider keeps its round, counted once and only once: an
      // operation already counted (or migrated from the records) is never counted a second time.
      const accountedFor = settledOperation => this.accounted(rec, settledOperation);
      if (pending?.attempted) {
        const settledOperation = pending.pending.operation;
        if (!accountedFor(settledOperation)) {
          rec.generations += 1; rec.reworks = Math.max(0, rec.generations - 1);
          rec.consumed ||= {};
          rec.consumed[settledOperation] = { at: new Date().toISOString(), status: pending.status, recovered: true };
        }
        rec.lastOperation = settledOperation; rec.lastStatus = pending.status; rec.pending = null;
      }
      if (pending?.verdict === 'in-flight') {
        rec.updatedAt = new Date().toISOString();
        // Retrying that very operation is the resume of its own round: neither a new round nor a conflict.
        if (pending.pending.operation === operation) {
          writeJson(this.file, ledger);
          return { already: true, generations: rec.generations };
        }
        // A different operation id while the previous round is unresolved is exactly the "resend under
        // another name" this rule forbids: it is refused until the original request is reconciled.
        writeJson(this.file, ledger);
        throw new Error('UNIT_ROUND_IN_FLIGHT:' + unit + ':' + pending.pending.operation +
          '：该单元有一轮生成尚未结算，先核实原请求，不重复占用额度也不换操作号重发');
      }
      if (pending?.verdict === 'attempted') {
        rec.generations += 1; rec.reworks = Math.max(0, rec.generations - 1);
        rec.consumed ||= {};
        rec.consumed[pending.pending.operation] = { at: new Date().toISOString(), status: pending.status, recovered: true };
        rec.lastOperation = pending.pending.operation; rec.lastStatus = pending.status;
      }
      rec.pending = null;
      if (rec.generations >= GENERATIONS_PER_UNIT) {
        rec.limitReached = { at: new Date().toISOString(), generations: rec.generations,
          reason: '已用完首次生成与 3 次返工（仅禁止新增生成，已有结果仍可查询/下载/审核/验收）' };
        rec.updatedAt = new Date().toISOString(); writeJson(this.file, ledger);
        throw this.limitError(rec, unit);
      }
      rec.pending = { operation, at: new Date().toISOString(), reason, attempt: rec.generations + 1 };
      rec.updatedAt = new Date().toISOString();
      writeJson(this.file, ledger);
      return { generations: rec.generations, attempt: rec.pending.attempt, reworks: rec.reworks };
    });
  }
  async commit(unit, operation, status) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const rec = this.unit(ledger, unit);
      if (this.accounted(rec, operation)) {
        // Re-executing the newest operation of a finished round refreshes its observed status (for example
        // "submitted" -> "succeeded" after a query) without counting another round.
        if (rec.lastOperation === operation) { rec.lastStatus = status; rec.updatedAt = new Date().toISOString(); }
        rec.pending = null; writeJson(this.file, ledger); return rec;
      }
      if (rec.pending?.operation !== operation) { writeJson(this.file, ledger); return rec; }
      rec.generations += 1;
      rec.reworks = Math.max(0, rec.generations - 1);
      rec.consumed ||= {};
      rec.consumed[operation] = { at: new Date().toISOString(), status };
      rec.pending = null; rec.lastOperation = operation; rec.lastStatus = status; rec.updatedAt = new Date().toISOString();
      // The 4th generation is recorded as "no rounds left", never as a failure: a succeeded 4th round must
      // keep flowing to querying, review, acceptance and downstream.
      if (rec.generations >= GENERATIONS_PER_UNIT)
        rec.limitReached = { at: new Date().toISOString(), generations: rec.generations,
          reason: '已用完首次生成与 3 次返工（仅禁止新增生成，已有结果仍可查询/下载/审核/验收）' };
      writeJson(this.file, ledger);
      return rec;
    });
  }
  // Called after a failed call: an attempt that reached the provider keeps its round (an uncertain
  // submission is never refunded), an attempt that never left this machine releases it.
  async settleAfterError(unit, operation) {
    const recordFile = path.join(this.operations, operation + '.json');
    let status = 'new';
    if (fs.existsSync(recordFile)) { try { status = readJson(recordFile).status || 'new'; } catch { status = 'uncertain'; } }
    if (ATTEMPTED.includes(status)) return this.commit(unit, operation, status);
    return this.release(unit, operation);
  }
  async release(unit, operation) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const rec = this.unit(ledger, unit);
      if (rec.pending?.operation === operation) { rec.pending = null; rec.updatedAt = new Date().toISOString(); }
      writeJson(this.file, ledger);
      return rec;
    });
  }
  // A failed check or a user rejection at the end of the available rounds is what "paused" means, and it is
  // the only state that stops the flow. Merely having no rounds left pauses nothing.
  async markExhausted(unit, reason) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const rec = this.unit(ledger, unit);
      if (rec.generations >= GENERATIONS_PER_UNIT) {
        rec.limitReached ||= { at: new Date().toISOString(), generations: rec.generations,
          reason: '已用完首次生成与 3 次返工（仅禁止新增生成，已有结果仍可查询/下载/审核/验收）' };
        rec.exhausted = { at: new Date().toISOString(), generations: rec.generations, reason: String(reason || '').slice(0, 300) };
      }
      writeJson(this.file, ledger);
      return rec;
    });
  }
  status(unit) {
    const rec = this.read().units[unit];
    if (!rec) return { unit, generations: 0, reworks: 0, remainingReworks: REWORK_LIMIT, exhausted: null,
      limitReached: null, hasRoundsLeft: true };
    return { unit, generations: rec.generations, reworks: rec.reworks,
      remainingReworks: Math.max(0, GENERATIONS_PER_UNIT - rec.generations), exhausted: rec.exhausted || null,
      limitReached: rec.limitReached || null, hasRoundsLeft: rec.generations < GENERATIONS_PER_UNIT,
      pending: rec.pending || null, needsAudit: rec.needsAudit || null,
      lastOperation: rec.lastOperation || null, lastStatus: rec.lastStatus || null };
  }
  // ---- Check / analysis / review budget ---------------------------------------------------------------
  // Persisted, concurrency-safe and separate from generation rounds: an identical effective input reuses the
  // stored successful record instead of paying again, and a failure is counted but never auto-retried, so no
  // unbounded resend loop can hide behind "retries still available".
  checkKey(checkUnit, bind, digest) { return checkUnit + '@' + (bind || 'na') + '@' + digest; }
  checkRecord(ledger, key) {
    ledger.checks ||= {};
    return ledger.checks[key] ||= { attempts: 0, consumed: {}, pending: null, lastOperation: null,
      lastStatus: null, exhausted: null, updatedAt: null };
  }
  checkStatus(checkUnit, bind, digest) {
    const rec = this.read().checks?.[this.checkKey(checkUnit, bind, digest)];
    if (!rec) return { checkUnit, attempts: 0, remaining: 1 + CHECK_LIMIT, exhausted: null };
    return { checkUnit, attempts: rec.attempts, remaining: Math.max(0, 1 + CHECK_LIMIT - rec.attempts),
      exhausted: rec.exhausted || null, lastOperation: rec.lastOperation || null, lastStatus: rec.lastStatus || null };
  }
  checkSummary() {
    return Object.entries(this.read().checks || {}).map(([key, rec]) => ({ key, attempts: rec.attempts,
      remaining: Math.max(0, 1 + CHECK_LIMIT - rec.attempts), exhausted: rec.exhausted || null,
      lastOperation: rec.lastOperation || null }));
  }
  async reserveCheck(checkUnit, bind, digest, operation, { reason = null } = {}) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const key = this.checkKey(checkUnit, bind, digest), rec = this.checkRecord(ledger, key);
      if (rec.consumed[operation]) { writeJson(this.file, ledger); return { already: true, attempts: rec.attempts }; }
      // A resumed reservation of the same request must not spend a second attempt before it is committed.
      if (rec.pending?.operation === operation) { writeJson(this.file, ledger); return { already: true, attempts: rec.attempts }; }
      if (rec.exhausted || rec.attempts >= 1 + CHECK_LIMIT) {
        rec.exhausted ||= { at: new Date().toISOString(), attempts: rec.attempts, reason: String(reason || '检查/分析请求').slice(0, 200) };
        rec.updatedAt = new Date().toISOString(); writeJson(this.file, ledger);
        throw new Error('CHECK_ATTEMPTS_EXHAUSTED:' + checkUnit + '：同一有效输入已用完首次请求与最多 ' + CHECK_LIMIT +
          ' 次受控重试，不再自动重发，需人工决定是否更换输入');
      }
      rec.attempts += 1; rec.pending = { operation, at: new Date().toISOString(), reason };
      rec.updatedAt = new Date().toISOString(); writeJson(this.file, ledger);
      return { attempts: rec.attempts, remaining: 1 + CHECK_LIMIT - rec.attempts };
    });
  }
  async commitCheck(checkUnit, bind, digest, operation, status) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const rec = this.checkRecord(ledger, this.checkKey(checkUnit, bind, digest));
      if (!rec.consumed[operation]) rec.consumed[operation] = { at: new Date().toISOString(), status };
      rec.pending = null; rec.lastOperation = operation; rec.lastStatus = status; rec.updatedAt = new Date().toISOString();
      writeJson(this.file, ledger);
      return rec;
    });
  }
  async releaseCheck(checkUnit, bind, digest, operation) {
    return withLock(this.lock, async () => {
      const ledger = this.read();
      const rec = this.checkRecord(ledger, this.checkKey(checkUnit, bind, digest));
      if (rec.pending?.operation === operation && !rec.consumed[operation]) rec.attempts = Math.max(0, rec.attempts - 1);
      rec.pending = null; rec.updatedAt = new Date().toISOString();
      writeJson(this.file, ledger);
      return rec;
    });
  }
  // A check that never left this machine gives its attempt back; one that reached the provider keeps it.
  async settleCheckAfterError(checkUnit, bind, digest, operation) {
    const recordFile = path.join(this.operations, operation + '.json');
    let status = 'new';
    if (fs.existsSync(recordFile)) { try { status = readJson(recordFile).status || 'new'; } catch { status = 'uncertain'; } }
    if (ATTEMPTED.includes(status)) return this.commitCheck(checkUnit, bind, digest, operation, status);
    return this.releaseCheck(checkUnit, bind, digest, operation);
  }
  summary() { return Object.keys(this.read().units).sort().map(unit => this.status(unit)); }
}
module.exports = { CHECK_LIMIT, GENERATIONS_PER_UNIT, REWORK_LIMIT, UnitAttempts, basesForUnit, checkUnitForOperation, unitForOperation };
