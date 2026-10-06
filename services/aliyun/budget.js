const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, withLock } = require('./io');
// Reservations are conservative estimates, never claims of actual charges.
function estimateCents(kind, model, units = 1, refs = 0, resolution = '1080P') {
  if (!Number.isSafeInteger(units) || units <= 0 || !Number.isSafeInteger(refs) || refs < 0 || refs > 3) throw new Error('INVALID_BUDGET_UNITS');
  if (kind === 'vision' && model === 'qwen-vl-plus') return 20;
  if (kind === 'image' && ['qwen-image-3.0', 'qwen-image-3.0-pro'].includes(model)) return units * (model.endsWith('-pro') ? 50 : 18) + refs * 2;
  // Officially free creation; reserve one cent conservatively until reconciliation.
  if (kind === 'voice' && ['qwen-voice-enrollment','voice-enrollment'].includes(model)) return units;
  if (kind === 'speech' && model === 'qwen-audio-3.0-tts-plus') return Math.max(1, Math.ceil(units * 140 / 10000));
  if (kind === 'speech' && model === 'qwen3-tts-vc-2026-01-22') return Math.max(1, Math.ceil(units * 80 / 10000));
  if (kind === 'video' && ['720P', '1080P'].includes(resolution)) {
    if (model === 'wan2.7-i2v') return units * (resolution === '1080P' ? 100 : 60);
    if (model === 'wan2.2-kf2v-flash') return units * (resolution === '1080P' ? 48 : 20);
  }
  // The price of this model/kind is not verified: the call is still allowed and the cost is recorded as
  // unknown. A missing price is never treated as zero and never blocks the production flow.
  return null;
}
function authorization(root, config, productionId) {
  if (config.onlineEnabled !== true) throw new Error('ONLINE_DISABLED: 实际API调用前需明确授权预算');
  const file = path.resolve(root, config.authorizationFile);
  if (!fs.existsSync(file)) throw new Error('API_AUTHORIZATION_MISSING');
  const a = readJson(file);
  // One precise reason per failure so an expired window is never confused with a disabled or
  // mismatched authorization; the accepted set is unchanged from the previous combined check.
  if (a.enabled !== true) throw new Error('API_AUTHORIZATION_DISABLED');
  if (productionId && a.productionId !== productionId) throw new Error('API_AUTHORIZATION_PRODUCTION_MISMATCH');
  if (!Array.isArray(a.providers) || !a.providers.includes('aliyun')) throw new Error('API_AUTHORIZATION_PROVIDERS_INVALID');
  if (a.region !== 'cn-beijing' || config.region !== a.region) throw new Error('API_AUTHORIZATION_REGION_MISMATCH');
  if (!Number.isFinite(Date.parse(a.expiresAt))) throw new Error('API_AUTHORIZATION_EXPIRY_INVALID');
  if (Date.parse(a.expiresAt) <= Date.now()) throw new Error('API_AUTHORIZATION_EXPIRED: ' + a.expiresAt + '；需另行明确授权并续期');
  // The approved amount is kept as historical information only: it no longer limits execution, so a
  // missing or small value cannot block a run. Malformed values are still rejected.
  if (a.approvedBudgetCny !== undefined && a.approvedBudgetCny !== null &&
      (!Number.isFinite(a.approvedBudgetCny) || a.approvedBudgetCny < 0 ||
       Math.abs(a.approvedBudgetCny * 100 - Math.round(a.approvedBudgetCny * 100)) > 1e-7))
    throw new Error('API_AUTHORIZATION_BUDGET_INVALID');
  return a.approvedBudgetCny === undefined || a.approvedBudgetCny === null ? null : Math.round(a.approvedBudgetCny * 100);
}
function loadLedger(file) {
  const value = fs.existsSync(file) ? readJson(file) : { version: 1, entries: [] };
  if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('INVALID_LEDGER');
  const ids = new Set();
  for (const e of value.entries) {
    const reservedOk = e.reservedCents === null || (Number.isSafeInteger(e.reservedCents) && e.reservedCents >= 0);
    if (ids.has(e.id) || !reservedOk ||
        (e.actualCents !== null && (!Number.isSafeInteger(e.actualCents) || e.actualCents < 0))) throw new Error('INVALID_LEDGER_ENTRY');
    ids.add(e.id);
  }
  return value;
}
// Only known amounts add up; an unknown price is reported as unknown and is never counted as zero.
function total(ledger) { return ledger.entries.reduce((sum, e) => sum + (e.actualCents ?? e.reservedCents ?? 0), 0); }
function unknownCount(ledger) { return ledger.entries.filter(e => e.actualCents === null && e.reservedCents === null).length; }
class Budget {
  constructor(root, config, directory) { this.root = root; this.config = config; this.file = path.join(directory, 'api-ledger.json'); this.productionId = path.basename(directory); }
  async reserve(id, cents, fingerprint) {
    // The network authorization is still required; the amount is recorded, never used to block.
    authorization(this.root, this.config, this.productionId);
    if (cents !== null && (!Number.isSafeInteger(cents) || cents < 0)) throw new Error('INVALID_RESERVATION');
    return withLock(this.file + '.lock', async () => {
      const ledger = loadLedger(this.file);
      const old = ledger.entries.find(e => e.id === id);
      if (old) {
        if (old.reservedCents !== cents || old.fingerprint !== fingerprint) throw new Error('RESERVATION_CONFLICT');
        return old;
      }
      const entry = { id, fingerprint, reservedCents: cents, actualCents: null, status: 'reserved',
        costStatus: cents === null ? 'unknown-price-awaiting-bill' : 'reserved-conservative-estimate',
        estimateIsNotActualCharge: true, createdAt: new Date().toISOString() };
      ledger.entries.push(entry); writeJson(this.file, ledger); return entry;
    });
  }
  async completed(id, usage) {
    return withLock(this.file + '.lock', async () => {
      const ledger = loadLedger(this.file), entry = ledger.entries.find(e => e.id === id);
      if (!entry) throw new Error('RESERVATION_MISSING');
      entry.status = entry.actualCents === null ? 'awaiting_bill' : 'settled';
      entry.usage = usage || null; writeJson(this.file, ledger);
    });
  }
  async settle(id, actualCents, evidence) {
    if (!Number.isSafeInteger(actualCents) || actualCents < 0 || !evidence?.trim()) throw new Error('BILL_EVIDENCE_REQUIRED');
    return withLock(this.file + '.lock', async () => {
      const ledger = loadLedger(this.file), entry = ledger.entries.find(e => e.id === id);
      if (!entry) throw new Error('RESERVATION_MISSING');
      if (entry.actualCents !== null && (entry.actualCents !== actualCents || entry.evidence !== evidence)) throw new Error('SETTLEMENT_CONFLICT');
      entry.actualCents = actualCents; entry.evidence = evidence; entry.status = 'settled'; writeJson(this.file, ledger);
    });
  }
  // Reporting only: a plan may exceed any historical amount. It never blocks and never opens a request.
  checkPlan(plan) {
    if (!Array.isArray(plan)) throw new Error("INVALID_BUDGET_PLAN");
    const ledger = loadLedger(this.file), existing = new Map(ledger.entries.map(e => [e.id, e]));
    const ids = new Set(); let additionalCents = 0, unknownItems = 0;
    for (const item of plan) {
      if (!item || typeof item.id !== "string" || ids.has(item.id) ||
          (item.cents !== null && (!Number.isSafeInteger(item.cents) || item.cents < 0))) throw new Error("INVALID_BUDGET_PLAN");
      ids.add(item.id);
      const old = existing.get(item.id);
      if (old && old.reservedCents !== item.cents) throw new Error("PLAN_RESERVATION_CONFLICT:" + item.id);
      if (!old) { if (item.cents === null) unknownItems += 1; else additionalCents += item.cents; }
    }
    return { additionalCents, unknownItems, committedCents: total(ledger), unknownEntries: unknownCount(ledger),
      projectedCents: total(ledger) + additionalCents,
      historicalApprovedCents: authorization(this.root, this.config, this.productionId), blocking: false,
      note: '仅作预测与记录：费用不再限制制作，未知价格不计入合计也不当作 0' };
  }
  checkAvailable(cents) {
    if (cents !== null && (!Number.isSafeInteger(cents) || cents < 0)) throw new Error("INVALID_BUDGET_UNITS");
    const ledger = loadLedger(this.file), committed = total(ledger);
    const approved = authorization(this.root, this.config, this.productionId);
    return { committedCents: committed, additionalCents: cents, projectedCents: committed + (cents || 0),
      historicalApprovedCents: approved, overHistoricalAmount: approved === null ? null : committed + (cents || 0) > approved,
      blocking: false, note: '历史金额仅作参考，不再阻止制作；真实费用以账单为准' };
  }
  report() {
    const ledger = loadLedger(this.file);
    return { ...ledger, committedCents: total(ledger), unknownEntries: unknownCount(ledger),
      actualCostKnown: ledger.entries.every(e => e.actualCents !== null),
      note: 'reservedCents 是保守预留或 null（价格未知），不等于实扣；actualCents 未结算时为 null' };
  }
}
module.exports = { Budget, estimateCents, authorization, total, unknownCount };
