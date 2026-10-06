const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function readCache(file) {
  try { return readJson(file); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function hash(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}
function fileHash(file) { return hash(fs.readFileSync(file)); }
function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('INVALID_ID');
  return value;
}
// The run lock is exclusive across processes (an atomic 'wx' create). It is also re-entrant inside the
// same call chain, so a workflow may call another workflow that locks the same file without deadlocking;
// a *concurrent* sibling call from outside the chain still hits the file and is refused, so no two tasks
// in one process can act as if they each held the lock.
const { AsyncLocalStorage } = require('node:async_hooks');
const lockContext = new AsyncLocalStorage();
async function withLock(file, work) {
  const key = path.resolve(file);
  const inherited = lockContext.getStore();
  if (inherited?.has(key)) {
    const nested = new Map(inherited);
    nested.set(key, inherited.get(key) + 1);
    return lockContext.run(nested, work);
  }
  fs.mkdirSync(path.dirname(key), { recursive: true });
  let handle;
  try { handle = fs.openSync(key, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('BUSY_OR_STALE_LOCK: 先确认原进程已退出，再使用 unlock 命令');
    throw error;
  }
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  const store = new Map(inherited || []);
  store.set(key, 1);
  try { return await lockContext.run(store, work); } finally { fs.closeSync(handle); fs.unlinkSync(key); }
}
// An operation may only be submitted once. The claim is created atomically, so a second process (or a
// second task) refuses instead of posting the same request again. The claim records the owning pid and a
// unique token, so a release can only ever remove the claim that this exact holder created.
const SUBMISSION_CLAIM_HELD = 'SUBMISSION_CLAIM_HELD';
// true = the process exists, false = provably gone, null = could not be verified (never treat as gone).
function ownerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}
function inspectClaim(file) {
  if (!fs.existsSync(file)) return null;
  let record;
  try { record = readJson(file); } catch { return { token: null, pid: null, alive: null, unreadable: true }; }
  return { token: typeof record?.token === 'string' && record.token ? record.token : null,
    pid: Number.isSafeInteger(record?.pid) ? record.pid : null, alive: ownerAlive(record?.pid), unreadable: false };
}
function claimFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let handle;
  try { handle = fs.openSync(file, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(SUBMISSION_CLAIM_HELD + ': ' + path.basename(file) +
      '：该操作的提交占用仍被持有，不重复提交；确需清理时先核实再用 unlock <production.json> <操作ID> <核实说明>');
    throw error;
  }
  const token = crypto.randomUUID();
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
  return () => {
    try { fs.closeSync(handle); } catch { /* already closed */ }
    // Remove only our own claim: a claim created after ours must never be deleted by this call.
    try {
      if (inspectClaim(file)?.token !== token) return;
      const parked = file + '.released-' + token;
      fs.renameSync(file, parked);
      fs.unlinkSync(parked);
    } catch { /* already released by hand, or the file changed */ }
  };
}
function unlock(file) {
  if (!fs.existsSync(file)) return;
  const lock = readJson(file);
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error('INVALID_LOCK');
  try { process.kill(lock.pid, 0); } catch (error) {
    if (error.code !== 'ESRCH') throw new Error('LOCK_OWNER_NOT_VERIFIABLY_DEAD');
    fs.unlinkSync(file);
    return;
  }
  throw new Error('LOCK_OWNER_STILL_RUNNING');
}
function redact(value) {
  return String(value).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[\w-]+/g, '[REDACTED]')
    .replace(/data:[^\s"']+/g, '[MEDIA]')
    .replace(/https?:\/\/[^\s"']+/g, '[URL]');
}
module.exports = { readCache, readJson, writeJson, hash, fileHash, safeId, withLock, unlock, redact, claimFile,
  inspectClaim, ownerAlive, SUBMISSION_CLAIM_HELD };
