const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readCache, readJson, writeJson, fileHash, redact } = require('./io');
const ORIGIN = 'https://dashscope.aliyuncs.com';
class ProviderError extends Error {
  constructor(status, result = {}) {
    super('API_ERROR:' + status + ':' + redact(result.code || result.error?.code || 'UNKNOWN') + ':' + redact(result.message || result.error?.message || '').slice(0, 400));
    this.status = status; this.code = redact(result.code || result.error?.code || 'UNKNOWN');
    this.requestId = redact(result.request_id || '').slice(0, 100);
  }
}
// Streaming responses keep bounded, survivable evidence: a long thinking phase, a late answer, a broken
// stream or a missing stop marker never turn partial text into a usable result, and the request id,
// usage, finish reason and interruption time stay available for the operator.
function streamEvidence(response, snapshot, reason) {
  return { at: new Date().toISOString(), reason, httpStatus: response.status,
    providerRequestId: redact(response.headers?.get?.('x-request-id') || '') || null,
    responseId: snapshot.id || null, finishReason: snapshot.finishReason || null, done: !!snapshot.done,
    contentChars: (snapshot.text || '').length, contentPreview: redact(snapshot.text || '').slice(0, 200),
    reasoningChars: snapshot.reasoningChars || 0, chunks: snapshot.chunks || 0, usage: snapshot.usage || null,
    elapsedMs: Date.now() - (snapshot.startedAt || Date.now()),
    note: '部分正文只作诊断证据，绝不作为脚本、审核或任何有效结果使用；未记录思考正文与素材Base64' };
}
function attachEvidence(error, response, snapshot, reason, diagnostics) {
  const evidence = streamEvidence(response, snapshot, reason);
  if (diagnostics) { try { writeJson(diagnostics, evidence); } catch { /* diagnostics are best effort */ } }
  error.evidence = evidence;
  return error;
}
async function collectTextStream(response, { idleMs = 60000, diagnostics = null } = {}) {
  let buffer = '', text = '', finishReason = null, id = null, usage = null, done = false, bytes = 0;
  let reasoningChars = 0, chunks = 0;
  const snapshot = () => ({ id, text, finishReason, done, usage, reasoningChars, chunks, startedAt });
  const startedAt = Date.now();
  const decoder = new TextDecoder();
  const event = block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { done = true; return; }
    const part = JSON.parse(data);
    if (part.error || part.code) throw new ProviderError(response.status, part);
    id ||= part.id;
    if (part.usage) usage = part.usage;
    const choice = part.choices?.[0];
    // Only the answer text is kept; the thinking text is counted, never stored.
    if (typeof choice?.delta?.reasoning_content === 'string') reasoningChars += choice.delta.reasoning_content.length;
    if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };
  // Accepts anything async-iterable (a ReadableStream, an async generator or an array), so no caller is
  // forced into one body shape.
  const iterator = typeof response.body?.[Symbol.asyncIterator] === 'function' ? response.body[Symbol.asyncIterator]() : null;
  if (!iterator) throw attachEvidence(new Error('STREAM_BODY_NOT_READABLE'), response, snapshot(), 'stream-body-not-readable', diagnostics);
  const readOnce = () => {
    const next = iterator.next();
    if (!Number.isFinite(idleMs) || idleMs <= 0) return next;
    let timer;
    const idle = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('STREAM_IDLE_TIMEOUT'), { idle: true })), idleMs);
    });
    return Promise.race([next, idle]).finally(() => clearTimeout(timer));
  };
  while (true) {
    let step;
    try { step = await readOnce(); }
    catch (error) {
      // The cleanup must not be awaited: cancelling a stream that still has a pending read can never settle,
      // and a hung cleanup would hide the real failure.
      try { const closing = iterator.return?.(); if (closing?.catch) closing.catch(() => {}); } catch { /* already gone */ }
      try { const cancelling = response.body?.cancel?.(); if (cancelling?.catch) cancelling.catch(() => {}); } catch { /* already gone */ }
      throw attachEvidence(error.message === 'STREAM_IDLE_TIMEOUT' ? new Error('STREAM_IDLE_TIMEOUT') : error,
        response, snapshot(), error.idle ? 'stream-idle-timeout' : 'stream-read-failure', diagnostics);
    }
    if (step.done) break;
    bytes += step.value.length;
    if (bytes > 2 * 1024 * 1024) throw attachEvidence(new Error('STREAM_RESPONSE_TOO_LARGE'), response, snapshot(), 'stream-too-large', diagnostics);
    chunks += 1;
    buffer += decoder.decode(step.value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop();
    try { events.forEach(event); }
    catch (error) { throw attachEvidence(error, response, snapshot(), 'stream-event-failure', diagnostics); }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { try { event(buffer); } catch (error) { throw attachEvidence(error, response, snapshot(), 'stream-event-failure', diagnostics); } }
  if (!done || finishReason !== 'stop' || !text)
    throw attachEvidence(new Error(!done ? 'STREAM_RESPONSE_INCOMPLETE' : finishReason !== 'stop' ? 'STREAM_FINISH_NOT_STOP' : 'STREAM_RESPONSE_EMPTY'),
      response, snapshot(), !done ? 'stream-interrupted' : 'finish-not-stop', diagnostics);
  return { id, choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: text } }], usage };
}
class AliyunClient {
  constructor({ apiKey, fetchImpl = fetch, uploadDirectory }) {
    if (!apiKey) throw new Error('DASHSCOPE_API_KEY_MISSING');
    this.apiKey = apiKey; this.fetch = fetchImpl; this.uploadDirectory = uploadDirectory;
  }
  async request(endpoint, body, { method = 'POST', async = false, timeoutMs = 180000, streamIdleMs = 60000, diagnostics = null } = {}) {
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) throw new Error('INVALID_API_PATH');
    let response;
    try {
      response = await this.fetch(ORIGIN + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json',
          'X-DashScope-OssResourceResolve': 'enable', ...(async ? { 'X-DashScope-Async': 'enable' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      // A total-timeout or transport failure is ambiguous about whether the provider started working, so
      // the evidence is attached and the caller keeps the attempt instead of retrying it blindly.
      const evidence = { at: new Date().toISOString(), reason: 'request-not-completed', endpoint,
        timeoutMs, errorName: redact(error.name || ''), message: redact(error.message || '').slice(0, 200),
        note: '未取得完整响应；是否已产生用量需按操作号核对' };
      if (diagnostics) { try { writeJson(diagnostics, evidence); } catch { /* best effort */ } }
      const failure = new Error(error.name === 'TimeoutError' ? 'REQUEST_TIMEOUT:' + timeoutMs + 'ms' : 'REQUEST_FAILED:' + redact(error.message || 'unknown'));
      failure.evidence = evidence; throw failure;
    }
    if (response.ok && body?.stream === true && response.headers.get('content-type')?.includes('text/event-stream'))
      return collectTextStream(response, { idleMs: streamIdleMs, diagnostics });
    let result;
    try { result = await response.json(); } catch { throw new ProviderError(response.status, { code: 'INVALID_RESPONSE' }); }
    if (!response.ok || result.code || result.error) throw new ProviderError(response.status, result);
    return result;
  }
  async task(taskId) {
    if (!/^[\w-]{1,120}$/.test(taskId)) throw new Error('INVALID_PROVIDER_TASK_ID');
    return this.request('/api/v1/tasks/' + encodeURIComponent(taskId), undefined, { method: 'GET' });
  }
  async upload(model, file) {
    const digest = fileHash(file), name = digest.slice(0, 24) + path.extname(file);
    const cache = path.join(this.uploadDirectory, model + '-' + digest + '.json');
    if (fs.existsSync(cache)) {
      const saved = readCache(cache);
      if (Date.parse(saved?.expiresAt) > Date.now() + 3600000) return saved.url;
    }
    const result = await this.request('/api/v1/uploads?action=getPolicy&model=' + encodeURIComponent(model), undefined, { method: 'GET' });
    const p = result.data;
    if (!p || !p.upload_dir || !p.upload_host) throw new Error('INVALID_UPLOAD_POLICY');
    const host = new URL(p.upload_host);
    if (host.protocol !== 'https:' || !host.hostname.endsWith('.aliyuncs.com')) throw new Error('UNTRUSTED_UPLOAD_HOST');
    const key = p.upload_dir + '/' + name, form = new FormData();
    for (const [k, v] of Object.entries({ OSSAccessKeyId: p.oss_access_key_id, Signature: p.signature, policy: p.policy,
      'x-oss-object-acl': p.x_oss_object_acl, 'x-oss-forbid-overwrite': p.x_oss_forbid_overwrite, key, success_action_status: '200' })) {
      if (v === undefined) throw new Error('INVALID_UPLOAD_POLICY');
      form.append(k, String(v));
    }
    form.append('file', new Blob([fs.readFileSync(file)]), name);
    const response = await this.fetch(host.href, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('UPLOAD_FAILED:' + response.status);
    const url = 'oss://' + key;
    writeJson(cache, { url, expiresAt: new Date(Date.now() + 47 * 3600000).toISOString() });
    return url;
  }
  async download(url, file) {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' && !parsed.port && (parsed.hostname.endsWith('.aliyuncs.com') || parsed.hostname.endsWith('.alicdn.com'))) parsed.protocol = 'https:';
    if (parsed.protocol !== 'https:' || !(parsed.hostname.endsWith('.aliyuncs.com') || parsed.hostname.endsWith('.alicdn.com'))) throw new Error('UNTRUSTED_RESULT_URL');
    const response = await this.fetch(parsed.href, { redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error('DOWNLOAD_FAILED:' + response.status);
    const maxBytes = 300 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('DOWNLOAD_TOO_LARGE');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp', handle = fs.openSync(temporary, 'wx');
    try {
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error('DOWNLOAD_TOO_LARGE');
        fs.writeFileSync(handle, chunk);
      }
      if (!bytes) throw new Error('EMPTY_DOWNLOAD');
      fs.closeSync(handle); fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.closeSync(handle); } catch {}
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }
}
function dataUri(file) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }[path.extname(file).toLowerCase()];
  if (!mime || fs.statSync(file).size > 10 * 1024 * 1024) throw new Error('UNSUPPORTED_INLINE_MEDIA');
  return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
}
module.exports = { AliyunClient, ProviderError, dataUri, collectTextStream };
