#!/usr/bin/env node
// Offline handoff self-check: syntax of every tracked source file, model/online contract, budget
// contract and the absence of the removed Kling provider. Never contacts a provider.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
// archive/ and backups/ are excluded by path segment: they hold historical evidence and are never
// scanned. The test runs before descending, so nothing inside them is even read.
const SKIP = /(?:^|[\\/])(?:node_modules|\.git|backups|archive|\.wrapup-tmp|jobs|output)(?:[\\/]|$)/;

function walk(root, directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name), relative = path.relative(root, full);
    if (SKIP.test(relative)) continue;
    if (entry.isDirectory()) found.push(...walk(root, full));
    else if (/\.(js|cjs)$/.test(entry.name)) found.push(relative);
  }
  return found;
}
function readJson(root, file) { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '')); }

// The checks run against an injectable root, so the exclusion rules can be verified on an isolated
// fixture instead of the real archive/backups directories.
function checkRepo(root = ROOT) {
const files = walk(root, root).sort();
const failures = [];
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe', windowsHide: true }); }
  catch { failures.push('SYNTAX:' + file); }
}
// Historical documents may still describe the removed provider; code and config may not.
// This checker names the removed provider itself, so it is excluded from its own scan.
const SELF = path.relative(root, __filename);
const residue = files.filter(file => file !== SELF && /kling|可灵/i.test(fs.readFileSync(path.join(root, file), 'utf8')));
if (residue.length) failures.push('REMOVED_PROVIDER_RESIDUE:' + residue.join(','));
// Every local require must resolve: this catches wiring left behind by a removal.
for (const file of files) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of text.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
    const target = path.resolve(path.dirname(path.join(root, file)), match[2]);
    if (![target, target + '.js', target + '.cjs', path.join(target, 'index.js')].some(candidate => fs.existsSync(candidate)))
      failures.push('UNRESOLVED_REQUIRE:' + file + ' -> ' + match[2]);
  }
}
const config = readJson(root, 'config/aliyun.json'), project = readJson(root, 'config/project.json');
if (config.planner?.model !== 'qwen3.8-omni-flash') failures.push('PLANNER_MODEL_MUST_BE_QWEN_OMNI');
if (config.audioReview?.model !== 'qwen3.8-omni-flash') failures.push('AUDIO_REVIEW_MODEL_MUST_BE_QWEN_OMNI');
if (config.onlineEnabled !== false) failures.push('ONLINE_ENABLED_MUST_BE_FALSE');
if (project.execution) failures.push('LEGACY_PAID_SWITCH_PRESENT');
if (project.budget.target !== 50 || project.budget.hardLimit !== 70 || project.budget.currency !== 'CNY') failures.push('BUDGET_CONTRACT_CHANGED');
// Runtime files must not depend on a former assistant and must have no second text provider: a failed
// model call is surfaced with its evidence instead of being routed somewhere else. Documents keep
// their history, so only runtime paths are scanned here.
const RUNTIME = /^(?:index\.js|services[\\/]|workflows[\\/]|config[\\/])/;
const runtimeFiles = files.filter(file => RUNTIME.test(file));
const formerAssistant = runtimeFiles.filter(file => /codex/i.test(fs.readFileSync(path.join(root, file), 'utf8')));
if (formerAssistant.length) failures.push('FORMER_ASSISTANT_DEPENDENCY_IN_RUNTIME:' + formerAssistant.join(','));
const secondProvider = runtimeFiles.filter(file =>
  /require\([^)]*deepseek|DEEPSEEK_API_KEY|api\.deepseek\.com/i.test(fs.readFileSync(path.join(root, file), 'utf8')));
if (secondProvider.length) failures.push('SECOND_TEXT_PROVIDER_IN_RUNTIME:' + secondProvider.join(','));
const next = fs.readFileSync(path.join(root, 'docs/NEXT_SESSION.md'), 'utf8').trim();
if ([...next].length > 300) failures.push('NEXT_SESSION_TOO_LONG:' + [...next].length);
return { checkedFiles: files.length, plannerModel: config.planner?.model, audioReviewModel: config.audioReview?.model,
  onlineEnabled: config.onlineEnabled, legacyPaidSwitchPresent: !!project.execution, nextSessionCharacters: [...next].length, failures };
}
if (require.main === module) {
  const result = checkRepo();
  console.log(JSON.stringify(result, null, 2));
  if (result.failures.length) process.exitCode = 1;
}
module.exports = { SKIP, checkRepo, walk };
