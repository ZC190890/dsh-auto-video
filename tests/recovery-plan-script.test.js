const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, hash } = require('../services/aliyun/io');
const { UnitAttempts, GENERATIONS_PER_UNIT, unitForOperation } = require('../services/aliyun/units');
const { recoverScriptPlan } = require('../workflows/recover-script');
const ROOT = path.resolve(__dirname, '..');
const REAL_OPERATION = path.join(ROOT, 'jobs', 'aliyun', 'second-film', 'operations', 'plan-script.json');

// The real second-film plan-script failure is reproduced here from an isolated copy of its own records.
// The original job directory is only READ (its bytes must stay identical); every write happens in a temp
// copy, and no provider request can happen because the recovery entry has no client at all.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'recover-'));
  const directory = path.join(root, 'jobs', 'aliyun', 'second-film');
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  fs.copyFileSync(REAL_OPERATION, path.join(directory, 'operations', 'plan-script.json'));
  writeJson(path.join(directory, 'operations', 'plan-brief.json'), { id: 'plan-brief', fingerprint: 'b',
    status: 'succeeded', spec: {}, result: { choices: [{ finish_reason: 'stop', message: { content: '{"storySummary":"s"}' } }] } });
  writeJson(path.join(directory, 'state.json'), { stage: 'script', brief: { storySummary: 's', shotGuidance: 'g' } });
  writeJson(path.join(directory, 'unit-attempts.json'), { version: 1, checks: {}, units: { script: {
    generations: 1, reworks: 0, consumed: { 'plan-script': { at: '2026-09-21T22:26:53.761Z', status: 'uncertain' } },
    pending: null, exhausted: null, limitReached: null, lastOperation: 'plan-script', lastStatus: 'uncertain' } } });
  const evidence = path.join(root, 'input', 'second-film', 'plan-script-provider-evidence.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'input', 'second-film', 'plan-script-provider-evidence.json'), evidence);
  const config = readJson(path.join(ROOT, 'config/aliyun.json'));
  return { root, directory, config,
    context: { root, directory, config, production: { id: 'second-film', description: '一计害三贤', style: '国风插画',
      targetDurationSeconds: 43, maxDurationSeconds: 45, narrator: 'jiang_wei', ending: null, requiredQuotes: [],
      maxAttemptsPerAsset: 2, characters: [] } },
    evidenceFile: path.relative(root, evidence).replace(/\\/g, '/') };
}

test('the second-film script failure has an auditable recovery entry that leaves the original untouched', async () => {
  const f = fixture();
  const originalFile = path.join(f.directory, 'operations', 'plan-script.json');
  const before = fs.readFileSync(originalFile);
  const realBefore = hash(fs.readFileSync(REAL_OPERATION));
  const result = await recoverScriptPlan(f.context, { evidenceFile: f.evidenceFile, decision: 'regenerate',
    reason: '按供应商记录核实：已有用量但未取得可用正文，需受控重新生成' });
  assert.equal(result.idempotent, false);
  assert.equal(result.completed, true);
  const recovery = result.recovery;
  assert.equal(recovery.original.id, 'plan-script');
  assert.equal(recovery.original.status, 'uncertain');
  assert.equal(recovery.original.recordUntouched, true);
  assert.equal(recovery.originalResultRecoverable, false);
  assert.match(recovery.originalResultReason, /1 个 token/);
  assert.equal(recovery.evidence.requestId, 'd800a709-89e0-98eb-8661-f2ca96851a13');
  assert.equal(recovery.evidence.usage.textTokens, 1);
  assert.equal(recovery.retryOperation, 'plan-script-retry-1');
  assert.equal(recovery.roundAccounting.generationsBefore, 1);
  assert.equal(recovery.roundAccounting.retryCountsAs, '一次返工');
  assert.equal(recovery.billing.actualCents, null, '无账单不虚构金额，未知不是 0');
  assert.equal(recovery.networkRequests, 0);
  assert.equal(fs.readFileSync(originalFile).equals(before), true, '原记录不得删除或改写');
  assert.equal(hash(fs.readFileSync(REAL_OPERATION)), realBefore, '真实 second-film 记录字节不变');
  const state = readJson(path.join(f.directory, 'state.json'));
  assert.equal(state.scriptPlanRecovery.retryOperation, 'plan-script-retry-1');
  assert.equal(state.brief.storySummary, 's', '已成功的制作简报保持原样，不重做');
  assert.equal(fs.existsSync(path.join(f.directory, 'operations', 'plan-brief.json')), true);
  assert.equal(unitForOperation('plan-script-retry-1'), 'script', '重试仍属脚本单元');
  const attempts = new UnitAttempts(f.directory);
  const reserved = await attempts.reserve('script', 'plan-script-retry-1');
  assert.equal(reserved.attempt, 2, '重试消耗一次返工机会，不重置为首次');
  const committed = await attempts.commit('script', 'plan-script-retry-1', 'succeeded');
  assert.equal(committed.generations, 2);
  assert.equal(committed.reworks, 1);
  assert.equal(committed.exhausted, null);
  assert.equal(attempts.status('script').remainingReworks, 2);
});

test('one evidence document and one decision create at most one retry, and every refusal is explicit', async () => {
  const f = fixture();
  const { listDecisions } = require('../workflows/recover-script');
  const options = { evidenceFile: f.evidenceFile, decision: 'regenerate', reason: 'r' };
  const first = await recoverScriptPlan(f.context, options);
  const second = await recoverScriptPlan(f.context, options);
  assert.equal(second.idempotent, true);
  assert.equal(second.recovery.retryOperation, first.recovery.retryOperation);
  assert.equal(listDecisions(f.context).length, 1, '同一证据同一决策不产生第二个重试');
  assert.equal(second.recovery.evidenceHash, first.recovery.evidenceHash);
  await assert.rejects(recoverScriptPlan(f.context, { evidenceFile: f.evidenceFile, decision: 'regenerate' }),
    /RECOVERY_REASON_REQUIRED/);
  await assert.rejects(recoverScriptPlan(f.context, { ...options, decision: 'reuse' }), /RECOVERY_DECISION_UNSUPPORTED/);
  await assert.rejects(recoverScriptPlan(f.context, { ...options, evidenceFile: 'input/second-film/missing.json' }),
    /RECOVERY_EVIDENCE_FILE_MISSING/);
  writeJson(path.join(f.root, 'input', 'second-film', 'partial.json'), { provider: 'aliyun' });
  await assert.rejects(recoverScriptPlan(f.context, { ...options, evidenceFile: 'input/second-film/partial.json' }),
    /RECOVERY_EVIDENCE_INCOMPLETE/);
  const g = fixture();
  const record = readJson(path.join(g.directory, 'operations', 'plan-script.json'));
  record.status = 'succeeded';
  writeJson(path.join(g.directory, 'operations', 'plan-script.json'), record);
  await assert.rejects(recoverScriptPlan(g.context, { evidenceFile: g.evidenceFile, decision: 'regenerate', reason: 'r' }),
    /RECOVERY_NOT_UNCERTAIN/);
  const h = fixture();
  const ledger = readJson(path.join(h.directory, 'unit-attempts.json'));
  ledger.units.script.generations = GENERATIONS_PER_UNIT;
  writeJson(path.join(h.directory, 'unit-attempts.json'), ledger);
  await assert.rejects(recoverScriptPlan(h.context, { evidenceFile: h.evidenceFile, decision: 'regenerate', reason: 'r' }),
    /RECOVERY_NO_ROUNDS_LEFT/);
  assert.equal(fs.existsSync(path.join(h.directory, 'recovery')), false, '被拒绝的登记不得留下决策文件');
});

test('the planning flow picks up the registered retry operation, and only then', async () => {
  const f = fixture();
  await recoverScriptPlan(f.context, { evidenceFile: f.evidenceFile, decision: 'regenerate', reason: 'r' });
  const { generateScript } = require('../workflows/planner');
  const calls = [];
  const models = { plan: async (id, spec) => { calls.push({ id, spec }); return { json: { title: 't', shots: [] }, usage: null }; } };
  const state = readJson(path.join(f.directory, 'state.json'));
  await generateScript(f.context, { models, state }).catch(() => {});
  assert.equal(calls[0].id, 'plan-script-retry-1');
  assert.equal(calls[0].spec.purpose, 'script');
  const plain = { ...state };
  delete plain.scriptPlanRecovery;
  await generateScript(f.context, { models, state: plain }).catch(() => {});
  assert.equal(calls[1].id, 'plan-script', '没有恢复决策时仍使用原操作号');
});

