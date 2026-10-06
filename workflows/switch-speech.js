const fs=require('node:fs'),path=require('node:path');
const {readJson,withLock,hash}=require('../services/aliyun/io');
const {loadState,saveState}=require('./production');
const {Budget}=require('../services/aliyun/budget');
function validateProfile(profile,shots){
 if(profile?.models?.speech!=='qwen-audio-3.0-tts-plus'||profile.models.voiceEnrollment!=='voice-enrollment'||Object.keys(profile.models).some(k=>!['speech','voiceEnrollment'].includes(k)))throw Error('INVALID_SPEECH_PROFILE');
 for(const shot of shots.filter(s=>s.type==='dialogue'||s.type==='narration')){const d=profile.delivery?.[shot.id];if(!d||typeof d.instruction!=='string'||!d.instruction.trim()||d.instruction.length>400||!Number.isFinite(d.rate)||d.rate<0.5||d.rate>2)throw Error('INVALID_SPEECH_DELIVERY:'+shot.id);}
}
async function switchSpeech(ctx,profile,reason){
 if(typeof reason!=='string'||!reason.trim())throw Error('MIGRATION_REASON_REQUIRED');
 return withLock(path.join(ctx.root,'jobs/aliyun/run.lock'),async()=>{
 const s=loadState(ctx);if(!s.script)throw Error('SCRIPT_REQUIRED');validateProfile(profile,s.script.shots);
 if(s.speechProfile){if(hash(s.speechProfile)===hash(profile))return {alreadyPrepared:true};throw Error('SPEECH_PROFILE_ALREADY_SET');}
 const entries=new Map(new Budget(ctx.root,ctx.config,ctx.directory).report().entries.map(e=>[e.id,e]));
 const bases=new Set();
 for(const shot of s.script.shots){if(!['dialogue','narration'].includes(shot.type))continue;bases.add('voice-'+shot.speaker);bases.add('speech-'+shot.id);for(const prefix of ['video','video-check']){const base=prefix+'-'+shot.id,id=base+'-r'+(s.revisions?.[base]||0);if(fs.existsSync(path.join(ctx.directory,'operations',id+'.json'))||entries.has(id)||s.assets[shot.id]?.video)throw Error('SPEECH_MIGRATION_VIDEO_EXISTS:'+id);}}
 const advances=[];
 for(const base of bases){const revision=s.revisions?.[base]||0,id=base+'-r'+revision,file=path.join(ctx.directory,'operations',id+'.json');if(!fs.existsSync(file)){if(entries.has(id))throw Error('RESERVED_OPERATION_RECORD_MISSING:'+id);continue;}const op=readJson(file);if(op.status!=='succeeded'||!entries.has(id)||op.id!==id)throw Error('SPEECH_MIGRATION_UNRESOLVED:'+id);if(revision+1>=ctx.config.maxAttemptsPerAsset)throw Error('REVISION_ATTEMPTS_EXHAUSTED:'+id);advances.push({base,revision:revision+1});}
 s.history||=[];s.history.push({kind:'speech-model-migration',at:new Date().toISOString(),reason,script:structuredClone(s.script),assets:structuredClone(s.assets),characters:structuredClone(s.characters),timeline:s.timed||null,preview:s.preview||null,previousModels:ctx.config.models});
 s.revisions||={};for(const a of advances)s.revisions[a.base]=a.revision;
 for(const shot of s.script.shots){if(!['dialogue','narration'].includes(shot.type))continue;shot.speechRate=1;for(const base of ['driving','performance'])s.revisions[base+'-'+shot.id]=s.revisions['speech-'+shot.id]||0;for(const k of ['audio','audioHash','speechRaw','audioQuality'])delete s.assets[shot.id][k];}
 s.speechProfile=structuredClone(profile);s.audioAcceptance='new-model-pending-generation-and-listening';s.audioReview={status:'pending',note:'语音模型已切换，需重新生成并试听',at:new Date().toISOString()};delete s.audioReviews;delete s.audioRecords;s.stage='script';for(const k of ['timed','preview','output','acceptance','lastError','costForecast'])delete s[k];s.editRevision=(s.editRevision||0)+1;saveState(ctx,s);return {model:profile.models.speech,revision:s.editRevision,networkRequests:0};
 });
}
module.exports={switchSpeech,validateProfile};
