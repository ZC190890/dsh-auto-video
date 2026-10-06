const fs = require('node:fs');
const path = require('node:path');
const { loadContext, loadState, saveState, runProduction, planRevision, approve, doctor } = require('./workflows/production');
const { Media } = require('./services/aliyun/media');
const { Budget } = require('./services/aliyun/budget');
const { UnitAttempts } = require('./services/aliyun/units');
const { Operations } = require('./services/aliyun/operations');
const { readJson, writeJson, withLock, unlock, redact, safeId } = require('./services/aliyun/io');
const { redo } = require('./workflows/redo');
const { reviseScript } = require('./workflows/revise');
const { parseLocalEditArgs, recordLocalEdit } = require('./workflows/local-edit');
const { recordAudioDecision, runAudioReviews } = require('./workflows/audio-review');
const { applyRework } = require('./workflows/rework');
const { recoverScriptPlan } = require('./workflows/recover-script');
const { reviseCreative } = require('./workflows/creative-revise');
const ROOT = __dirname;
const HELP = [
  '武将视频制作（默认不联网、不付费）',
  'node index.js init                         创建输入模板，不覆盖已有文件',
  'node index.js doctor input/production.json  离线检查素材和配置',
  'node index.js run input/production.json [--until characters|creative|script|audio|storyboard|frames|video|final]',
  '        必须显式指定清单，例如 node index.js run input/second-film/production.json --until script',
  '        精细创作流程（清单里显式写 creative: true 的任务）走新链路：--until creative 只产出创作产物，--until audio 生成配音产物，--until storyboard 需要先接受配音',
  'node index.js accept-creative-audio input/production.json <lineId>=<音频文件> [更多...] [--method operator|fixture] [--tone-override <理由>]  接受新链路的配音产物，记录实测时长与绑定（fixture 仅限离线夹具）；自动语气判断未通过时普通接受会被拒绝，只有显式 --tone-override <理由> 才能继续并保留模型结论',
  'node index.js tone-review input/production.json [<表演段ID>...]  按表演段做自动语气判断（五项分别给结论；同输入复用、未决提交不重发；不代替人工试听接受）',
  'node index.js revise-creative <清单> <修订JSON> <原因>  受控修订创作设定并按依赖失效相关产物（场景/服饰装备/台词/配音/相邻），不联网、不重发请求',
  '        修订JSON 例：{"kind":"scene","target":"tent","scene":{...完整场景条目...}}；{"kind":"equipment","target":"jiang_wei","character":{...完整人物条目...},"field":"costume"}；',
  '        {"kind":"dialogue","target":"ln01","lines":[{"id":"ln01","text":"新台词"}]}；{"kind":"audio","target":"ln01","decision":"re-record"}；{"kind":"adjacent","from":"shot01","to":"shot02"}',
  'node index.js redo input/production.json <镜头ID> <speech|frames|video> <原因>  仅准备重做，不联网',
  'node index.js local-edit input/production.json <镜头ID> --from 0 --to 3 --duration 3.9 --reason <原因>  仅本地剪辑该镜头并重新导出，不联网',
  'node index.js audio-review input/production.json [<镜头ID>...]  按镜头做音频理解分析（不产生生成轮次，费用按账单核对）',
  'node index.js accept-audio input/production.json <accepted|rejected> <说明>  记录对配音的决定；未accepted则阻止视频阶段',
  'node index.js apply-rework input/production.json <frames|video|speech>-<镜头ID> <用户确认说明>  用户允许返工后，由模型把返工意见转成修订指令并经既有受控机制执行',
  'node index.js recover-script <清单> --evidence <证据JSON> --decision regenerate --reason <恢复理由>  登记受控恢复（不改原记录、不联网、幂等），重试计入一次返工',
  '        例如 node index.js recover-script input/second-film/production.json --evidence input/second-film/plan-script-provider-evidence.json --decision regenerate --reason "供应商记录已核实，原请求未取得可用正文"',
  'node index.js revise-script input/production.json <新脚本JSON> <原因>  校验并准备局部修订，不联网',
  'node index.js revise-script input/production.json --instructions <导演指令>  由规划模型产出修订稿再按上述规则失效',
  'node index.js status input/production.json',
  '次数规则：每个制作单元（整片脚本、各角色正脸、每镜配音/首帧/尾帧/视频等）首次生成不计返工，之后最多 3 次返工；',
  '          达到上限后该单元及其依赖阶段暂停，需人工核对，不自动重置；费用不再限制制作，只记录（价格未知记为未知）。',
  'node index.js approve input/production.json <待确认项>',
  'node index.js adopt-task input/production.json <操作ID> <供应商任务ID> <核实说明>',
  'node index.js adopt-response input/production.json <操作ID> <恢复JSON路径> <核实说明>',
  'node index.js settle input/production.json <操作ID> <实扣分> <账单证据>',
  'node index.js unlock [input/production.json] [<操作ID> <核实说明>] 清理已退出进程留下的运行锁与账本锁，并在核实确无提交后清除该操作的提交占用',
  'run默认关闭。启用需要另行明确预算，并填写input/api-authorization.json。',
  '首次运行前请填写故事、角色名称、立绘和语音路径；不要在聊天或日志中粘贴密钥。'
].join('\n');
// `root` is injectable so tests can drive this exact entry point against an isolated fixture.
async function main(args = process.argv.slice(2), { root = ROOT, client = null } = {}) {
  const [command, manifest, ...rest] = args;
  if (!command || command === 'help' || command === '--help') { console.log(HELP); return; }
  if (command === 'init') {
    fs.mkdirSync(path.join(root, 'input'), { recursive: true });
    for (const name of ['production.json', 'api-authorization.json']) {
      const target = path.join(root, 'input', name);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(root, 'examples', name), target);
    }
    console.log('输入模板已准备；尚未联网。'); return;
  }
  if (command === 'unlock') {
    const runLock = path.join(root, 'jobs', 'aliyun', 'run.lock');
    unlock(runLock);
    if (manifest) {
      const recovery = loadContext(root, manifest);
      await withLock(runLock, async () => {
        unlock(path.join(recovery.directory, 'api-ledger.json.lock'));
        // A leftover submission claim only disappears on explicit evidence that nothing was sent.
        if (rest.length === 2) new Operations(path.join(recovery.directory, 'operations')).releaseStaleClaim(rest[0], rest[1]);
      });
    }
    console.log('锁检查完成'); return;
  }
  if (!manifest) throw new Error('MANIFEST_REQUIRED');
  const ctx = loadContext(root, manifest);
  if (command === 'doctor') {
    const result = doctor(ctx); console.log(JSON.stringify(result, null, 2));
    if (result.issues.length) process.exitCode = 2; return;
  }
  if (command === 'status') {
    const s = loadState(ctx);
    const attempts = new UnitAttempts(ctx.directory);
    const rounds = attempts.summary();
    console.log(JSON.stringify({ stage: s.stage, pendingReview: s.pendingReview, lastError: s.lastError,
      output: s.output, acceptance: s.acceptance, localVideoEdits: Object.keys(s.localVideoEdits || {}),
      qualityDegradations: s.qualityDegradations || [], budget: new Budget(root, ctx.config, ctx.directory).report(),
      unitRounds: rounds,
      // Only a failed check or a rejection at the end of the rounds pauses the flow. A unit that merely used
      // its 4 rounds, whose 4th result is still on its way or waiting for review, is reported separately.
      pausedUnits: rounds.filter(r => r.exhausted).map(r => ({ unit: r.unit, generations: r.generations, reason: r.exhausted.reason || null })),
      unitsWithNoRoundsLeft: rounds.filter(r => !r.hasRoundsLeft && !r.exhausted)
        .map(r => ({ unit: r.unit, generations: r.generations, lastStatus: r.lastStatus || null, note: '不能再新增生成；查询、下载、审核、验收与下游可用' })),
      checkBudgets: attempts.checkSummary().filter(c => c.attempts > 0),
      roundsNeedingAudit: rounds.filter(r => r.needsAudit).map(r => r.unit) }, null, 2)); return;
  }
  if (command === 'run') {
    if (rest.length && (rest.length !== 2 || rest[0] !== '--until')) throw new Error('INVALID_ARGUMENTS');
    // `client` is only an injected provider adapter (external service), so an isolated test can drive this
    // exact entry point without any network access.
    await runProduction(ctx, { until: rest[1] || 'final', client: client || undefined }); return;
  }
  // Acceptance for the creative chain. The operator states which audio files are accepted; the plan digest,
  // the audio content, the MEASURED duration and the method are bound. `accepted: true` alone cannot exist.
  if (command === 'accept-creative-audio') {
    // Fixture acceptance needs a SECOND, run-context signal (not a manifest field) plus the environment marker,
    // so a real invocation cannot turn a simulated acceptance into a human one by editing one manifest flag.
    const options = { method: 'operator', offlineFixture: false, toneOverride: null }, entries = [];
    for (let index = 0; index < rest.length; index++) {
      if (rest[index] === '--method') { options.method = rest[++index]; continue; }
      if (rest[index] === '--tone-override') { options.toneOverride = String(rest[++index] ?? '').trim(); continue; }
      if (rest[index] === '--offline-fixture') { options.offlineFixture = process.env.CREATIVE_OFFLINE_FIXTURE === '1'; continue; }
      const split = String(rest[index]).indexOf('=');
      if (split < 1) throw new Error('INVALID_ARGUMENTS:' + rest[index]);
      entries.push({ lineId: String(rest[index]).slice(0, split), file: path.resolve(root, String(rest[index]).slice(split + 1)) });
    }
    // An unexplained override is refused here as well: the decision has to be written down to be a decision.
    if (options.toneOverride !== null && !options.toneOverride)
      throw new Error('TONE_OVERRIDE_REASON_REQUIRED: --tone-override 必须写明人工复核理由');
    if (!entries.length) throw new Error('AUDIO_FILES_REQUIRED: 例如 node index.js accept-creative-audio <清单> ln01=audio/ln01.wav');
    const { recordAcceptance } = require('./workflows/creative-stage');
    const state = loadState(ctx);
    const acceptance = recordAcceptance(ctx, state, entries, { method: options.method, media: new Media(root, ctx.project),
      offlineFixture: options.offlineFixture, toneOverride: options.toneOverride });
    saveState(ctx, state);
    console.log(JSON.stringify(acceptance, null, 2)); return;
  }
  // The automatic tone review of one performance segment, on demand. Same protocol, same operations layer, same
  // budget, same "never resend an unresolved submission" rule as the run: this command cannot invent a review.
  if (command === 'tone-review') {
    const { runToneReviews } = require('./workflows/tone-review');
    console.log(JSON.stringify(await runToneReviews(ctx, rest, { client: client || undefined }), null, 2)); return;
  }
  // A controlled revision of the creative package: the new value is validated by the same validators the
  // authoring path uses, the dependency scope is computed from the current storyboard and every affected
  // operation is preflighted before anything is written. No request is sent here.
  if (command === 'revise-creative') {
    if (rest.length !== 2) throw new Error('CREATIVE_REVISION_FILE_AND_REASON_REQUIRED: 例如 node index.js revise-creative input/production.json input/revision.json "用户确认改场景光照"');
    console.log(JSON.stringify(await reviseCreative(ctx, readJson(path.resolve(root, rest[0])), rest[1]), null, 2)); return;
  }
  if (command === 'revise-script') {
    if (rest[0] === '--instructions') {
      if (rest.length !== 2) throw new Error('REVISION_INSTRUCTIONS_REQUIRED');
      const replacement = await planRevision(ctx, rest[1]);
      console.log(JSON.stringify(await reviseScript(ctx, replacement, '模型按导演指令修订：' + rest[1]), null, 2)); return;
    }
    if (rest.length !== 2) throw new Error('REVISION_FILE_AND_REASON_REQUIRED');
    console.log(JSON.stringify(await reviseScript(ctx, readJson(path.resolve(root, rest[0])), rest[1]), null, 2)); return;
  }
  if (command === 'redo') {
    if (rest.length !== 3) throw new Error('REDO_SCOPE_AND_REASON_REQUIRED');
    console.log(JSON.stringify(await redo(ctx, rest[0], rest[1], rest[2]), null, 2)); return;
  }
  // Local repair only: no authorization, no upload, no reservation. It re-assembles the export.
  if (command === 'local-edit') {
    const { shotId, options } = parseLocalEditArgs(rest);
    console.log(JSON.stringify(await recordLocalEdit(ctx, shotId, options), null, 2)); return;
  }
  if (command === 'audio-review') {
    console.log(JSON.stringify(await runAudioReviews(ctx, rest), null, 2)); return;
  }
  if (command === 'accept-audio') {
    if (rest.length !== 2) throw new Error('AUDIO_DECISION_AND_NOTE_REQUIRED');
    console.log(JSON.stringify(await recordAudioDecision(ctx, rest[0], rest[1]), null, 2)); return;
  }
  if (command === 'apply-rework') {
    if (rest.length !== 2) throw new Error('REWORK_TARGET_AND_CONFIRMATION_REQUIRED');
    console.log(JSON.stringify(await applyRework(ctx, rest[0], rest[1]), null, 2)); return;
  }
  if (command === 'approve') { await approve(ctx, rest[0]); console.log('已记录素材确认，可继续run'); return; }
  // Controlled recovery of an ambiguous planning submission. The manifest is mandatory, so a recovery can
  // never be applied to the wrong production, and the registration is resumable and idempotent. No request
  // is sent here: the provider evidence is registered and the retry operation (a rework, not a new first
  // generation) is recorded for the ordinary planning flow to pick up.
  if (command === 'recover-script') {
    if (!manifest) throw new Error('MANIFEST_REQUIRED: 恢复登记必须显式指定制作清单，例如 input/second-film/production.json');
    const options = { decision: 'regenerate', evidenceFile: null, reason: null };
    for (let index = 0; index + 1 < rest.length; index += 2) {
      const flag = rest[index], value = rest[index + 1];
      if (flag === '--evidence') options.evidenceFile = value;
      else if (flag === '--decision') options.decision = value;
      else if (flag === '--reason') options.reason = value;
      else throw new Error('INVALID_ARGUMENTS:' + flag);
    }
    if (rest.length % 2) throw new Error('INVALID_ARGUMENTS:' + rest[rest.length - 1]);
    if (!options.evidenceFile) throw new Error('RECOVERY_EVIDENCE_FILE_REQUIRED');
    console.log(JSON.stringify(await recoverScriptPlan(ctx, options), null, 2)); return;
  }
  if (command === 'settle' || command === 'adopt-task' || command === 'adopt-response') {
    await withLock(path.join(root, 'jobs', 'aliyun', 'run.lock'), async () => {
      if (command === 'settle') {
        if (!/^\d+$/.test(rest[1])) throw new Error('AMOUNT_MUST_BE_INTEGER_CENTS');
        await new Budget(root, ctx.config, ctx.directory).settle(safeId(rest[0]), Number(rest[1]), rest[2]);
      } else if (command === 'adopt-response') {
        new Operations(path.join(ctx.directory, 'operations')).adoptResponse(rest[0], readJson(path.resolve(root, rest[1])), rest[2]);
      } else new Operations(path.join(ctx.directory, 'operations')).adoptTask(rest[0], rest[1], rest[2]);
    });
    console.log('已保存核实记录'); return;
  }
  throw new Error('UNKNOWN_COMMAND');
}
if (require.main === module) main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
module.exports = { main };
