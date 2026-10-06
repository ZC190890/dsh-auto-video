const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { Models } = require('../services/aliyun/models');
const { AliyunClient } = require('../services/aliyun/client');
const { UnitAttempts, CHECK_LIMIT, checkUnitForOperation, unitForOperation } = require('../services/aliyun/units');
const { readJson, writeJson, hash } = require('../services/aliyun/io');
const ROOT = path.resolve(__dirname, '..');

// Checks, analyses, reviews and rework advice are paid requests but not generations. They must reuse a
// successful result for the same effective input, carry their own bounded budget (first request plus at
// most three controlled retries), never consume a generation round and never auto-resend.
function fixture() {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'check-'));
  const config = { ...readJson(path.join(ROOT, 'config/aliyun.json')), onlineEnabled: true, authorizationFile: 'auth.json' };
  writeJson(path.join(root, 'config/aliyun.json'), config);
  writeJson(path.join(root, 'auth.json'), { enabled: true, productionId: 'check-film', providers: ['aliyun'],
    region: 'cn-beijing', expiresAt: new Date(Date.now() + 86400000).toISOString(), approvedBudgetCny: 50 });
  const directory = path.join(root, 'jobs', 'aliyun', 'check-film');
  fs.mkdirSync(path.join(directory, 'operations'), { recursive: true });
  const ref = path.join(root, 'ref.png'); fs.writeFileSync(ref, 'reference-image');
  const client = chatClient();
  const budget = new Budget(root, config, directory);
  const attempts = new UnitAttempts(directory);
  const ops = new Operations(path.join(directory, 'operations'), client, budget, () => {}, 0, 0, attempts);
  const media = { visionImage: file => file, image: file => ({ hash: hash(file), width: 1, height: 1 }),
    audio: () => ({ duration: 1 }), normalizeAudio: source => source, command: () => {} };
  const models = new Models(config, ops, media, path.join(directory, 'vision-cache'));
  return { root, directory, config, client, budget, attempts, ops, models, ref,
    out: name => path.join(directory, 'out', name) };
}
function chatClient() {
  const state = { posts: [], bodies: [], options: [], failNext: 0 };
  return { state,
    request: async (endpoint, body, options) => {
      state.posts.push(endpoint); state.bodies.push(body); state.options.push(options || {});
      if (state.failNext > 0) { state.failNext -= 1; throw new Error('network down'); }
      return { id: 'resp-1', choices: [{ finish_reason: 'stop', message: { content: '{"pass":true,"issues":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
    task: async () => { throw new Error('NO_TASK_EXPECTED'); },
    download: async () => { throw new Error('NO_DOWNLOAD_EXPECTED'); } };
}

test('a paid check reuses its result and is capped at one request plus three retries per effective input', async () => {
  const f = fixture();
  const first = await f.models.json('frame-check-shot01-r0', 'p', [f.ref]);
  assert.equal(first.pass, true);
  const reused = await f.models.json('frame-check-shot01-r0', 'p', [f.ref]);
  assert.equal(reused.pass, true);
  assert.equal(f.client.state.posts.length, 1, '同一有效输入必须复用成功结果，不重复付费');
  for (const id of ['frame-check-shot01-r1', 'frame-check-shot01-r2', 'frame-check-shot01-r3'])
    await f.models.json(id, 'p', [f.ref]);
  assert.equal(f.client.state.posts.length, 1 + CHECK_LIMIT);
  await assert.rejects(f.models.json('frame-check-shot01-r4', 'p', [f.ref]), /CHECK_ATTEMPTS_EXHAUSTED/);
  assert.equal(f.client.state.posts.length, 1 + CHECK_LIMIT, '上限之后不得再发请求');
  assert.deepEqual(f.attempts.summary(), [], '检查不占用生成单元');
  assert.equal(f.attempts.status('last-shot01').generations, 0);
  const budgets = f.attempts.checkSummary();
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0].attempts, 1 + CHECK_LIMIT);
  assert.ok(budgets[0].key.startsWith('frame-check-shot01'));
  assert.equal(budgets[0].exhausted.attempts, 1 + CHECK_LIMIT);
  await f.models.json('frame-check-shot01-r5', 'different prompt', [f.ref]);
  assert.equal(f.client.state.posts.length, 2 + CHECK_LIMIT, '新输入可以触发新审核单元');
  const before = f.attempts.checkStatus('frame-check-shot01', 'vision', 'digest-x').attempts;
  await f.attempts.reserveCheck('frame-check-shot01', 'vision', 'digest-x', 'frame-check-shot01-r0');
  await f.attempts.reserveCheck('frame-check-shot01', 'vision', 'digest-x', 'frame-check-shot01-r0');
  assert.equal(f.attempts.checkStatus('frame-check-shot01', 'vision', 'digest-x').attempts, before + 1,
    '恢复同一请求不得重复扣次数');
});

test('every paid inspection and planning entry has one logical check unit, and local work has none', () => {
  assert.equal(checkUnitForOperation('inspect-jiang_wei'), 'inspect-jiang_wei');
  assert.equal(checkUnitForOperation('front-check-jiang_wei-r1'), 'front-check-jiang_wei');
  assert.equal(checkUnitForOperation('frame-check-shot01-r2'), 'frame-check-shot01');
  assert.equal(checkUnitForOperation('video-check-shot01-r3'), 'video-check-shot01');
  assert.equal(checkUnitForOperation('plan-material-jiang_wei'), 'plan-material-jiang_wei');
  assert.equal(checkUnitForOperation('plan-brief'), 'plan-brief');
  assert.equal(checkUnitForOperation('plan-script-review-0f1e2d3c4b5a'), 'plan-script-review');
  assert.equal(checkUnitForOperation('audio-review-qwen38-shot01-r1'), 'audio-review-qwen38-shot01');
  assert.equal(checkUnitForOperation('plan-rework-shot01-r3'), 'plan-rework-shot01');
  assert.equal(checkUnitForOperation('plan-rework-instruction-frames-shot01-r2'), 'plan-rework-instruction-frames-shot01');
  assert.equal(checkUnitForOperation('plan-script-retry-1'), 'plan-script-retry');
  // The storyboard plan carries a content digest instead of a name: the whole board of one production is ONE logical
  // planning purpose, so it is one bounded unit of paid inspection rather than an entry with no budget at all.
  assert.equal(checkUnitForOperation('plan-storyboard'), 'plan-storyboard');
  assert.equal(checkUnitForOperation('plan-storyboard-0f1e2d3c4b5a'), 'plan-storyboard');
  assert.equal(unitForOperation('plan-storyboard-0f1e2d3c4b5a'), null, '规划不是可重做的生成单元');
  assert.equal(checkUnitForOperation('local-edit-shot01'), null);
  assert.equal(checkUnitForOperation('final-export'), null);
});

test('a failed check keeps its attempt, is never auto-resent, and the record explains why', async () => {
  const f = fixture();
  f.client.state.failNext = 1;
  await assert.rejects(f.models.json('video-check-shot01-r0', 'p', [f.ref]), /SUBMISSION_UNCERTAIN/);
  assert.equal(f.client.state.posts.length, 1);
  const budget = f.attempts.checkSummary()[0];
  assert.equal(budget.attempts, 1, '失败的检查保留已用次数');
  assert.equal(budget.exhausted, null, '一次失败不等于超限');
  assert.equal(readJson(path.join(f.directory, 'operations', 'video-check-shot01-r0.json')).status, 'uncertain');
  await assert.rejects(f.models.json('video-check-shot01-r0', 'p', [f.ref]), /OPERATION_REQUIRES_RECONCILIATION/);
  assert.equal(f.client.state.posts.length, 1, '不确定提交不得自动重发，也不得当作重试授权');
  assert.equal(f.attempts.checkSummary()[0].attempts, 1);
});

const encoder = new TextEncoder();
function sse(chunks, { status = 200, requestId = 'req-stream-1', close = true } = {}) {
  const body = new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    if (close) controller.close();
  } });
  return { ok: status < 400, status,
    headers: { get: name => name === 'content-type' ? 'text/event-stream' : name === 'x-request-id' ? requestId : null },
    body };
}
const chatChunk = (delta, extra = {}) => 'data: ' + JSON.stringify({ id: 'resp-9', choices: [{ index: 0, delta, finish_reason: null }], usage: null }) + '\n\n';
function streamClient(response) {
  return new AliyunClient({ apiKey: 'test-key', fetchImpl: async () => response });
}
function diagnosticsPath(name) {
  fs.mkdirSync(path.join(ROOT, '.wrapup-tmp'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, '.wrapup-tmp', 'stream-'));
  return path.join(root, name);
}

test('long thinking with a late answer completes, and the thinking text is never stored as the answer', async () => {
  const diagnostics = diagnosticsPath('plan.json');
  const client = streamClient(sse([
    chatChunk({ reasoning_content: 'THINKING-ONLY-MARKER'.repeat(50) }),
    chatChunk({ reasoning_content: 'THINKING-ONLY-MARKER' }),
    chatChunk({ content: '{"title":"late"}' }),
    'data: ' + JSON.stringify({ id: 'resp-9', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4066, completion_tokens: 30 } }) + '\n\n',
    'data: [DONE]\n\n'
  ]));
  const result = await client.request('/compatible-mode/v1/chat/completions', { stream: true, model: 'qwen3.8-omni-flash' },
    { timeoutMs: 1000, streamIdleMs: 500, diagnostics });
  assert.equal(result.choices[0].message.content, '{"title":"late"}');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 4066, completion_tokens: 30 });
  assert.equal(fs.existsSync(diagnostics), false, '成功时无需诊断文件');
});

test('a stream that stops before the end marker fails with evidence and never returns partial text', async () => {
  const diagnostics = diagnosticsPath('interrupted.json');
  const client = streamClient(sse([
    chatChunk({ reasoning_content: 'THINKING-ONLY-MARKER'.repeat(50) }),
    chatChunk({ content: '{"title":"partial' })
  ]));
  await assert.rejects(client.request('/compatible-mode/v1/chat/completions', { stream: true }, { timeoutMs: 1000, streamIdleMs: 500, diagnostics }),
    /STREAM_RESPONSE_INCOMPLETE/);
  const saved = readJson(diagnostics);
  assert.equal(saved.reason, 'stream-interrupted');
  assert.equal(saved.responseId, 'resp-9');
  assert.equal(saved.providerRequestId, 'req-stream-1');
  assert.ok(saved.contentChars > 0, '已收到的正文长度必须留档');
  assert.equal(Number.isFinite(saved.elapsedMs), true);
  assert.equal(JSON.stringify(saved).includes('THINKING-ONLY-MARKER'), false, '不得记录思考正文');
});

test('a truncated finish reason, an idle stream and a total timeout are all failures with evidence', async () => {
  const truncated = streamClient(sse([
    chatChunk({ content: 'x' }),
    'data: ' + JSON.stringify({ id: 'resp-9', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: null }) + '\n\n',
    'data: [DONE]\n\n'
  ]));
  await assert.rejects(truncated.request('/compatible-mode/v1/chat/completions', { stream: true }, { timeoutMs: 1000, streamIdleMs: 500 }),
    /STREAM_FINISH_NOT_STOP/);
  const idle = streamClient(sse([chatChunk({ reasoning_content: 'still thinking' })], { close: false }));
  await assert.rejects(idle.request('/compatible-mode/v1/chat/completions', { stream: true }, { timeoutMs: 5000, streamIdleMs: 30 }),
    /STREAM_IDLE_TIMEOUT/);
  const timeoutEvidence = diagnosticsPath('timeout.json');
  const timingOut = new AliyunClient({ apiKey: 'test-key', fetchImpl: async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } });
  let failure = null;
  try { await timingOut.request('/compatible-mode/v1/chat/completions', { stream: true }, { timeoutMs: 240000, diagnostics: timeoutEvidence }); }
  catch (error) { failure = error; }
  assert.match(failure.message, /REQUEST_TIMEOUT:240000ms/);
  assert.equal(failure.evidence.timeoutMs, 240000);
  assert.equal(readJson(timeoutEvidence).reason, 'request-not-completed');
});

test('the planning request bounds thinking and carries its own total and idle deadlines', async () => {
  const f = fixture();
  const { json } = await f.models.plan('plan-brief', { purpose: 'production-brief', prompt: 'p', reservationCents: 20 });
  assert.equal(json.pass, true);
  const body = f.client.state.bodies[0], options = f.client.state.options[0];
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.enable_thinking, false, '规划请求必须关闭思考（官方 OpenAI 兼容开关）');
  assert.equal(body.max_tokens, f.config.planner.thinking.maxTokens);
  assert.equal(body.reasoning_effort, undefined, '取值未核实的参数不得发送');
  assert.equal(options.timeoutMs, f.config.planner.thinking.timeoutSeconds * 1000);
  assert.equal(options.streamIdleMs, f.config.planner.thinking.streamIdleSeconds * 1000);
  assert.ok(options.diagnostics.includes('diagnostics'), '诊断写入本地忽略目录');
  assert.equal(options.timeoutMs !== 120000 && options.timeoutMs !== 180000, true, '规划时限与上传/下载分开');
  assert.equal(f.attempts.status('script').generations, 0, '规划请求不消耗生成轮次');
  assert.equal(f.attempts.checkSummary().length, 1, '规划请求走独立于生成轮次的检查上限');
});



