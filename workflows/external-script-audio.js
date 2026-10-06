const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson, hash, fileHash, withLock } = require('../services/aliyun/io');
const { authorization, Budget } = require('../services/aliyun/budget');
const { Operations } = require('../services/aliyun/operations');
const { UnitAttempts } = require('../services/aliyun/units');
const { Models } = require('../services/aliyun/models');
const { Media } = require('../services/aliyun/media');
const { providerClient, loadState, saveState } = require('./production');
const SYSTEM_MODEL = 'qwen3-tts-instruct-flash';
const VOICES = ['Neil', 'Moon', 'Eldric Sage', 'Vincent', 'Ethan', 'Kai'];
const ROLE_IDS = { 姜维: 'jiang_wei', 钟会: 'zhong_hui', 邓艾: 'deng_ai', 士兵: 'soldiers' };
function quoted(text) { return [...text.matchAll(/"([^"]+)"/g)].map(m => m[1]); }
function parseTables(tables) {
  if (!Array.isArray(tables) || tables.length !== 1 || tables[0].length !== 9) throw Error('EXTERNAL_TABLE_SHAPE');
  const scenes = [], lines = [];
  for (const [index, row] of tables[0].slice(1).entries()) {
    if (row.length !== 5) throw Error('EXTERNAL_ROW_SHAPE');
    const scene = { id: 'doc' + String(index + 1).padStart(2, '0'), visual: row[1], emotion: row[4], sourceCells: row };
    scenes.push(scene);
    const add = (role, text, direction) => lines.push({ id: scene.id + '-line' + String(lines.filter(l => l.sceneId === scene.id).length + 1).padStart(2, '0'), sceneId: scene.id, role, text, direction, emotion: scene.emotion });
    const narration = quoted(row[2]);
    if (narration.length !== 1) throw Error('EXTERNAL_NARRATION_MISSING');
    add(row[2].includes('姜维低诵') ? 'jiang_wei' : 'narrator', narration[0], row[2].split('"')[0].trim());
    if (index === 7) { scene.endingCaption = quoted(row[3]).join(''); continue; }
    let role = null, direction = '';
    for (const line of row[3].split(/\r?\n/)) {
      const actor = /^(姜维|钟会|邓艾|士兵)（([^）]+)）：/.exec(line);
      if (actor) { role = ROLE_IDS[actor[1]]; direction = actor[2]; }
      for (const text of quoted(line)) { if (!role) throw Error('EXTERNAL_SPEAKER_MISSING'); add(role, text, direction); }
    }
  }
  return { version: 1, title: '一计害三贤', scenes, lines, sourceHash: hash(tables), preserveAllDialogue: true, timing: 'measured-natural-speech', endingCaption: scenes[7].endingCaption };
}
function validateDelivery(plan, source) {
  if (!plan || !plan.voices || !Array.isArray(plan.delivery) || plan.delivery.length !== source.lines.length) throw Error('EXTERNAL_DELIVERY_SHAPE');
  for (const role of new Set(source.lines.map(l => l.role))) if (role !== 'jiang_wei' && !VOICES.includes(plan.voices[role])) throw Error('EXTERNAL_VOICE_INVALID:' + role);
  if (new Set(['narrator','zhong_hui','deng_ai','soldiers'].map(r=>plan.voices[r])).size !== 4) throw Error('EXTERNAL_VOICES_NOT_DISTINCT');
  const byId = new Map(plan.delivery.map(d => [d.id, d]));
  if (byId.size !== source.lines.length) throw Error('EXTERNAL_DELIVERY_DUPLICATE');
  for (const line of source.lines) {
    const d = byId.get(line.id);
    if (!d || typeof d.instruction !== 'string' || !d.instruction.trim() || d.instruction.length > 400) throw Error('EXTERNAL_INSTRUCTION_MISSING:' + line.id);
  }
  return plan;
}
async function systemSpeech(models, id, line, voice, instruction, destination) {
  if (!VOICES.includes(voice)) throw Error('EXTERNAL_VOICE_INVALID');
  const input = { text: line.text, voice, language_type: 'Chinese', instructions: instruction, optimize_instructions: false };
  return models.asset(id, { endpoint: '/api/v1/services/aigc/multimodal-generation/generation', model: SYSTEM_MODEL,
    text: line.text, voice, input, cents: null }, async () => ({ model: SYSTEM_MODEL, input }), destination,
    result => { if (result.output?.finish_reason !== 'stop') throw Error('SPEECH_OUTPUT_INCOMPLETE:' + id); return result.output?.audio?.url; });
}
async function runExternalAudio(context, sourceFile, { client: injectedClient, log = console.log } = {}) {
  authorization(context.root, context.config, context.production.id);
  return withLock(path.join(context.root, 'jobs/aliyun/run.lock'), async () => {
    const source = parseTables(readJson(path.resolve(context.root, sourceFile)));
    const state = loadState(context), directory = path.join(context.directory, 'external-script');
    if (state.externalScript && state.externalScript.sourceHash !== source.sourceHash) throw Error('EXTERNAL_SOURCE_CHANGED');
    const attempts = new UnitAttempts(context.directory), budget = new Budget(context.root, context.config, context.directory);
    const media = new Media(context.root, context.project);
    const ops = new Operations(path.join(context.directory,'operations'), providerClient(context.root,injectedClient),budget,log,context.config.pollIntervalSeconds,context.config.pollTimeoutSeconds,attempts);
    const models = new Models(context.config,ops,media,path.join(directory,'vision-cache'));
    const clone = state.characters?.jiang_wei?.voices?.['qwen-audio-3.0-tts-plus'];
    if (!clone) throw Error('EXTERNAL_JIANGWEI_VOICE_REQUIRED');
    state.externalScript ||= { sourceHash: source.sourceHash, sourceFile, importedAt: new Date().toISOString(),
      authority: 'user-supplied DOCX; user accepted all lines, multiple voices and longer duration', source, audio: {}, status: 'imported', acceptance: 'pending' };
    const external = state.externalScript;
    const save = () => { state.budget=budget.report(); state.unitRounds=attempts.summary(); state.updatedAt=new Date().toISOString(); saveState(context,state); };
    save();
    const plus = new Models({...context.config,models:{...context.config.models,speech:'qwen-audio-3.0-tts-plus'}},ops,media,path.join(directory,'vision-cache'));
    if (!external.deliveryPlan) {
      const prompt = '你只负责用户已定稿文档的配音选角和表演指令，禁止改写或增删任何台词，不审核或返工故事。姜维沿用克隆音色无需选音色。为narrator、zhong_hui、deng_ai、soldiers选择四个不同的系统男声音色，候选Neil(播音)、Moon(年轻男声)、Eldric Sage(沧桑老者)、Vincent(沙哑男声)、Ethan(温暖男声)、Kai(舒缓男声)。旁白第三人称沉稳历史叙事；钟会较高亢自信凌厉；邓艾苍老嘶哑悲愤；士兵怒喊；姜维保持低沉参考声线并遵照每句舞台要求。正常语速不为时长赶读，无新增台词。只输出JSON {"voices":{"narrator":"音色","zhong_hui":"音色","deng_ai":"音色","soldiers":"音色"},"delivery":[{"id":"输入id","instruction":"不超过120字的具体中文表演指令"}]}，每句恰好一项，含文档气声、恭顺、低诵、愤怒、低声进言、振臂、嘶吼等区别。'+JSON.stringify(source.lines);
      const {json} = await models.plan('plan-material-external-delivery-r0',{purpose:'external-voice-direction',prompt,reservationCents:context.config.planner.reservationCents});
      external.deliveryPlan=validateDelivery(json,source); save();
    }
    validateDelivery(external.deliveryPlan,source);
    try {
      for (const line of source.lines) {
        const delivery=external.deliveryPlan.delivery.find(d=>d.id===line.id);
        const id='speech-'+line.id+'-r0', destination=path.join(directory,'audio',id+'.wav');
        log('配音 '+line.id+' '+line.role);
        const model=line.role==='jiang_wei'?'qwen-audio-3.0-tts-plus':SYSTEM_MODEL;
        const voice=line.role==='jiang_wei'?clone:external.deliveryPlan.voices[line.role];
        const raw=line.role==='jiang_wei'?await plus.speech(id,line.text,voice,destination,{instruction:delivery.instruction,rate:1}):await systemSpeech(models,id,line,voice,delivery.instruction,destination);
        const info=media.audio(raw);
        external.audio[line.id]={file:raw,hash:fileHash(raw),duration:info.duration,quality:info.quality,operation:id,model,voice,text:line.text,instruction:delivery.instruction};save();
      }
      const preview=path.join(context.root,'output',context.production.id,'audio-review');fs.mkdirSync(preview,{recursive:true});
      const names=[];let time=0;const timeline=[];
      for(const [i,line] of source.lines.entries()) {
        const a=external.audio[line.id],name='line-'+String(i+1).padStart(2,'0')+'.wav',dest=path.join(preview,name);
        media.normalizeAudio(a.file,dest);names.push(name);
        timeline.push({...line,start:time,end:time+a.duration,file:dest});time+=a.duration;
      }
      fs.writeFileSync(path.join(preview,'concat.txt'),names.map(n=>"file '"+n+"'").join('\n'),'utf8');
      media.command(['-f','concat','-safe','1','-i','concat.txt','-c:a','pcm_s16le','full-dialogue.wav'],preview);
      const full=path.join(preview,'full-dialogue.wav');
      const binding=hash(source.lines.map(l=>({id:l.id,text:l.text,hash:external.audio[l.id].hash})));
      external.audioBinding=binding;external.preview=full;external.spokenSeconds=time;external.timeline=timeline;external.status='audio-awaiting-user';
      writeJson(path.join(directory,'audio-timeline.json'),timeline);save();
      return { status:external.status,lines:source.lines.length,spokenSeconds:time,preview:full,voices:external.deliveryPlan.voices };
    } catch(error){external.lastError=error.message;save();throw error;}
  });
}
module.exports={parseTables,validateDelivery,systemSpeech,runExternalAudio,VOICES,SYSTEM_MODEL};
