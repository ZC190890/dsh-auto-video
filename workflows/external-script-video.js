const fs=require('node:fs'),path=require('node:path');
const {readJson,writeJson,hash,fileHash,withLock}=require('../services/aliyun/io');
const {authorization,Budget}=require('../services/aliyun/budget');
const {Operations}=require('../services/aliyun/operations');
const {UnitAttempts}=require('../services/aliyun/units');
const {Models}=require('../services/aliyun/models');
const {Media}=require('../services/aliyun/media');
const { adjacentCheckPrompt,checkCoverage,checkInputChanged,coverageGap,framesCheckPrompt,normalizeReview,operationRecord,QUALITY_RULES_VERSION,readStoredReview,recordedInput,recordedPrompt,
  repairInstruction,reviewBinding,reviewIsReusable,reworkDecision,samplingPlan,videoCheckPrompt}=require('../services/aliyun/quality');
const {CONTRACT_RULES,CONTRACT_SHAPE,contractDigest,contractPrompt,planContinuity,validateContract}=require('./shot-contract');
const {providerClient,loadState,saveState}=require('./production');
function audioBinding(e){return hash(e.source.lines.map(l=>({id:l.id,text:l.text,hash:fileHash(e.audio[l.id].file)})));}
function requireAccepted(e){if(!e||e.acceptance!=='accepted'||e.acceptedBinding!==audioBinding(e))throw Error('EXTERNAL_AUDIO_NOT_ACCEPTED');}
async function acceptExternalAudio(ctx,reason){return withLock(path.join(ctx.root,'jobs/aliyun/run.lock'),async()=>{const s=loadState(ctx),e=s.externalScript;if(!reason?.trim()||!e||e.status!=='audio-awaiting-user')throw Error('EXTERNAL_AUDIO_ACCEPTANCE_NOT_READY');e.acceptance='accepted';e.acceptedBinding=audioBinding(e);e.acceptedAt=new Date().toISOString();e.acceptanceReason=reason;saveState(ctx,s);return {accepted:true,binding:e.acceptedBinding};});}
function validateVisualPlan(plan,lines,characterIds){if(!plan||!Array.isArray(plan.shots)||plan.shots.length!==lines.length)throw Error('EXTERNAL_VISUAL_SHAPE');const ids=new Set();for(const l of lines){const p=plan.shots.find(p=>p.id===l.id);if(!p||ids.has(p.id)||!Array.isArray(p.characters)||p.characters.length>2||p.characters.some(c=>!characterIds.includes(c)))throw Error('EXTERNAL_VISUAL_CHARACTER');ids.add(p.id);if(!['dialogue','narration'].includes(p.type))throw Error('EXTERNAL_VISUAL_TYPE');if(p.type==='dialogue'&&(p.characters.length!==1||p.characters[0]!==l.role))throw Error('EXTERNAL_DIALOGUE_CHARACTER');for(const key of ['scene','endScene','action'])if(typeof p[key]!=='string'||p[key].trim().length<10||p[key].length>1800)throw Error('EXTERNAL_VISUAL_DESCRIPTION:'+key);}return plan;}
// The action contract and the hand-off need the real durations, so they are validated on the assembled
// shot list. A plan that declares contracts must be coherent; a legacy plan is accepted, but then no
// continuity is claimed and the gaps are recorded for the reader.
function validatePlanContinuity(shots,sceneOf){const problems=[];
 for(let i=0;i<shots.length;i++){const shot=shots[i],previous=i?shots[i-1]:null;
  try{validateContract(shot,{duration:Number.isFinite(shot.duration)?shot.duration:null,sceneId:sceneOf(shot),
   previous,previousSceneId:previous?sceneOf(previous):null});}catch(error){problems.push(error.message);}}
 if(problems.length)throw Error('EXTERNAL_PLAN_CONTRACT_INVALID:'+problems.join('|'));
 return planContinuity(shots,sceneOf);}
// Structured review: verdict pass/rework/undetermined, evidence per issue (what was seen, what was
// expected, when, in which image), severity and the smallest repair scope. The old pass/issues shape is
// still readable, and a pass that contradicts its own findings is never allowed through.
function checkedReport(value,options={}){return normalizeReview(value,options);}
// One idempotent registration for a frames repair. The frames revision moves together with the video
// revision (the old video number must never be reused with different first/last frames), and the results
// that were built from the old pixels — the shot's own reviews and the neighbouring pairs that used them —
// are dropped so the next run re-checks them under a controlled revision. The rounds themselves still come
// from the shared unit ledger; nothing here invents a new budget.
function queueFramesRepair(e, shotId, { fix = null, reason = null, from = null } = {}) {
  if (!e || typeof e !== 'object') throw Error('EXTERNAL_STATE_REQUIRED');
  if (typeof shotId !== 'string' || !shotId.trim()) throw Error('EXTERNAL_SHOT_REQUIRED');
  e.framesRepairQueue ||= {};
  e.mediaRevisions ||= {};
  const frames = e.mediaRevisions['frames-' + shotId] || 0;
  const video = e.mediaRevisions['video-' + shotId] || 0;
  const signature = hash({ shotId, fix, reason, from });
  const pending = e.framesRepairQueue[shotId];
  // The same repair registered again on the same revisions (a resumed or duplicated call) is a no-op, so an
  // interrupted registration can never advance the revisions twice. Once the shot has produced a new round
  // (the revisions moved on), a further registration is a genuinely new round and does advance them.
  if (pending && pending.signature === signature && pending.applied !== true && pending.frames === frames && pending.video === video)
    return { already: true, shotId, frames, video };
  const nextFrames = frames + 1;
  const nextVideo = video + 1;
  e.mediaRevisions['frames-' + shotId] = nextFrames;
  e.mediaRevisions['video-' + shotId] = nextVideo;
  const asset = e.media?.[shotId];
  if (asset) {
    delete asset.frameReview; delete asset.videoReview; delete asset.frameDecision; delete asset.videoDecision;
    delete asset.videoFix; delete asset.qualityPause;
  }
  for (const [key, entry] of Object.entries(e.adjacencyReviews || {}))
    if (key === shotId || entry?.from === shotId) {
      // 受影响的相邻检查走受控修订：丢掉旧结论并推进它的修订号，让下一次检查落到新的操作号上。
      delete e.adjacencyReviews[key];
      e.adjacencyRevisions ||= {};
      e.adjacencyRevisions[key] = (e.adjacencyRevisions[key] || 0) + 1;
    }
  e.framesRepairQueue[shotId] = { signature, shotId, fix, reason, from, applied: false, frames: nextFrames, video: nextVideo, at: new Date().toISOString() };
  return { queued: true, shotId, frames: nextFrames, video: nextVideo };
}
// The coverage text is derived from the checks that actually exist for each line: a current record states
// its sampled times, an older record keeps its own input boundary. History is described, never rewritten.
function coverageBoundary(e,lines){const fresh=[],legacy=[];
 for(const line of lines){const review=(e.media?.[line.id]||{}).videoReview;if(!review)continue;
  const times=review.binding?.sampling?.times||review.evidence?.sampling||null;
  const images=review.evidence?.imageCount??review.provenance?.coverage??null;
  const described=times&&times.length?times.length+'个时点（'+times.join('/')+'秒）':images?images+'张输入图':'未记录';
  (review.provenance?.protocol==='legacy'?legacy:fresh).push(line.id+'：'+described);}
 const parts=[];
 if(fresh.length)parts.push('按目标首帧＋抽帧＋目标尾帧检查（'+fresh.join('；')+'）');
 if(legacy.length)parts.push('旧记录按原覆盖边界保留（'+legacy.join('；')+'）');
 return '完整解码及抽帧检查'+(parts.length?'：'+parts.join('；'):'（无抽帧记录）')+'；抽帧只覆盖所列时点，不代表逐帧动作、口型或声音已验收';}
function repairText(fix){if(typeof fix==='string'&&fix.trim())return fix.trim();if(fix&&typeof fix==='object'&&!Array.isArray(fix)){const keys=Object.keys(fix);if(keys.length&&keys.every(k=>['start_frame_prompt','end_frame_prompt'].includes(k)&&typeof fix[k]==='string'&&fix[k].trim()))return keys.map(k=>(k==='start_frame_prompt'?'首帧修正：':'尾帧修正：')+fix[k]).join('。');}throw Error('EXTERNAL_REPAIR_SHAPE');}
function framesAccepted(a,r){const v=a.frameAcceptance;if(!v)return false;if(v.revision!==r||v.firstHash!==fileHash(a.first)||v.lastHash!==fileHash(a.last))throw Error('EXTERNAL_FRAME_ACCEPTANCE_CHANGED');return v.accepted===true;}
function shotFor(line,visual,audio){const duration=Math.max(2,Math.ceil(audio.duration*30)/30);if(duration>15)throw Error('EXTERNAL_LINE_REQUIRES_SPLIT:'+line.id);return {...visual,id:line.id,text:line.text,speaker:line.role,emotion:line.emotion,needsLastFrame:true,duration,speechDuration:audio.duration};}
async function runExternalVideo(ctx,{until='final',client:injectedClient,log=console.log}={}){
 if(!['plan','frames','video','final'].includes(until))throw Error('INVALID_STAGE');authorization(ctx.root,ctx.config,ctx.production.id);
 return withLock(path.join(ctx.root,'jobs/aliyun/run.lock'),async()=>{
 const state=loadState(ctx),e=state.externalScript;requireAccepted(e);
 const dir=path.join(ctx.directory,'external-script'),media=new Media(ctx.root,ctx.project),budget=new Budget(ctx.root,ctx.config,ctx.directory),attempts=new UnitAttempts(ctx.directory);
 const ops=new Operations(path.join(ctx.directory,'operations'),providerClient(ctx.root,injectedClient),budget,log,ctx.config.pollIntervalSeconds,ctx.config.pollTimeoutSeconds,attempts);
 const models=new Models(ctx.config,ops,media,path.join(dir,'vision-cache'));
 const reviewPrompt=(id,prompt)=>{const f=path.join(ctx.directory,'operations',id+'.json');return fs.existsSync(f)?readJson(f).spec.prompt:prompt;};
 e.visualPlans||={};e.media||={};e.mediaRevisions||={};
 const save=()=>{state.budget=budget.report();state.unitRounds=attempts.summary();state.updatedAt=new Date().toISOString();saveState(ctx,state);};
 const characters=Object.entries(state.characters).map(([id,c])=>({id,traits:c.traits}));
 try{
 for(const sc of e.source.scenes){const lines=e.source.lines.filter(l=>l.sceneId===sc.id);
 if(!e.visualPlans[sc.id]){log('安排画面 '+sc.id);const prompt='用户已批准外部定稿与配音，你仅把原场景适配为逐段视频首尾画面和动作提示。禁止重写台词、改变故事或审核历史质量。每个输入line恰好一镜，id必须原样；顺序不变。使用原角色国风插画参考，横屏16:9，不增人物饰物或改变盔甲。旁白和内心低诵用narration；具名人物实际讲话可dialogue，此时只出现该说话人，单人近景嘴部可见。士兵喊话放在军队远景用narration，画中具名人物闭口，喊声来自画外。每个scene和endScene写具体人物方位、景别机位、服饰兵器、前中后景环境材质、光线和动作起止；两者应为同一连续动作且不得凭空换武器。保持文档动作顺序，多个line的镜头只执行本段动作，不要每段重复全场。每个镜头还必须写出动作约束字段（生成与审核共用同一份，不得只写形容词）：'+CONTRACT_SHAPE+'。'+CONTRACT_RULES.map((rule,index)=>(index+1)+'）'+rule).join('')+'同场景相邻镜头必须把上一镜的结束状态接到本镜的起始状态（cut=continuous），换场景或跳时间写cut=scene或time并说明；用户定稿决定剧情、道具与动作，参考图只约束身份、服饰与画风。战斗必须动态格挡突刺有重量，无血腥伤口特写。最多2个具名角色同框，所有出现的具名人物必须列入characters；空数组仅无人或无名士兵。不要把台词、字幕、标志或文字画入图中。台词不输出，只输出JSON {"shots":[{"id":"原id","type":"dialogue或narration","characters":["角色id"],"scene":"首帧150字左右","endScene":"尾帧100字左右","action":"连续动作及运镜80字左右"}]}。'+JSON.stringify({scene:sc.visual,lines:lines.map(l=>({...l,seconds:e.audio[l.id].duration})),characters,style:ctx.production.style});
 const planId='plan-material-external-visual-'+sc.id+'-r0',sent=recordedPrompt(ctx.directory,planId,prompt);const {json}=await models.plan(planId,{purpose:'external-visual-direction',prompt:sent,reservationCents:ctx.config.planner.reservationCents});const plan=validateVisualPlan(json,lines,characters.map(c=>c.id));e.visualPlans[sc.id]={...plan,contractVersion:sent===prompt?2:1};save();}
 validateVisualPlan(e.visualPlans[sc.id],lines,characters.map(c=>c.id));}
// A plan that declares action contracts must be coherent before any paid frame generation; a legacy plan
// (no contract fields) is accepted and simply claims no continuity. The gaps are recorded for the reader.
 const planShots=e.source.lines.map(line=>{const visual=e.visualPlans[line.sceneId].shots.find(p=>p.id===line.id);return {...shotFor(line,visual,e.audio[line.id]),sceneId:line.sceneId};});
 const continuityPlan=validatePlanContinuity(planShots,shot=>shot.sceneId);
 e.continuity={mode:continuityPlan.mode,pairs:continuityPlan.pairs,gaps:continuityPlan.gaps,
  checkedPairs:continuityPlan.pairs.map(pair=>pair.to)};save();
 e.status='visual-planned';save();if(until==='plan')return {status:e.status};
 for(const line of e.source.lines){const visual=e.visualPlans[line.sceneId].shots.find(p=>p.id===line.id),shot=shotFor(line,visual,e.audio[line.id]);const a=e.media[line.id]||={};
 // The same constraint reaches generation and both checks; a legacy plan (no contract) keeps exactly the
 // wording its requests were sent with, so no fingerprint changes behind the user's back.
 const contractText=contractPrompt(shot,{docFirst:true}),contractId=contractDigest(shot,ctx.config.planner?.promptVersion),sceneText=e.source.scenes.find(sc=>sc.id===line.sceneId).visual;
 const refs=visual.characters.flatMap(id=>{const c=state.characters[id];return visual.characters.length===1?[...new Set([c.original,c.front])]:[c.front];});if(!refs.length)refs.push(state.characters.jiang_wei.original);
 const frameLabels=[{label:'目标首帧'},{label:'目标尾帧'},...refs.map((r,i)=>({label:'身份参考'+(i+1)}))];
 for(;;){const r=e.mediaRevisions['frames-'+line.id]||0;if(framesAccepted(a,r)){log('复用用户验收画面 '+line.id);break;}log('首尾帧 '+line.id+' 第'+(r+1)+'轮');
 const firstId='first-'+line.id+'-r'+r,lastId='last-'+line.id+'-r'+r,checkId='frame-check-'+line.id+'-r'+r;
 const identity=visual.characters.map(id=>id+':'+state.characters[id].traits).join('；');
 const firstParts=[ctx.production.style+'。首帧：'+shot.scene+'。角色身份映射：'+identity+'。',
  contractText?contractText+'保持参考中的身份、脸型、服饰与画风；武器与道具按上面的文档约束，不照抄参考图，单幅横屏画面，无文字水印。'
   :'保持参考身份、脸型、服饰和武器，单幅横屏画面，无文字水印。'];
 if(refs.length&&visual.characters.length===0)firstParts.push('参考仅用于画风，勿画姜维。');
 if(a.frameFix)firstParts.push(a.frameFix);
 const raw=await models.image(firstId,recordedPrompt(ctx.directory,firstId,firstParts.join('')),refs.slice(0,3),path.join(dir,'frames',firstId+'.png'));
 a.first=media.prepareImage(raw,path.join(dir,'frames','first-ready-'+line.id+'-r'+r+'.png'));save();
 const lastParts=[ctx.production.style+'。图1是首帧，其余为角色参考，保持身份、服饰兵器、场景光线，只推进动作至尾帧：'+shot.endScene+'。'];
 if(contractText)lastParts.push(contractText+'尾帧只描述单一静止瞬间，与首帧属于同一连续动作。');
 lastParts.push('不要文字、拼图、水印。');
 if(a.frameFix)lastParts.push(a.frameFix);
 const last=await models.image(lastId,recordedPrompt(ctx.directory,lastId,lastParts.join('')),[a.first,...refs].slice(0,3),path.join(dir,'frames',lastId+'.png'));
 a.last=media.prepareImage(last,path.join(dir,'frames','last-ready-'+line.id+'-r'+r+'.png'));save();
 const frameImages=[a.first,a.last,...refs].slice(0,5),frameLabelsUsed=frameLabels.slice(0,frameImages.length),frameBinding=reviewBinding({shotId:line.id,revision:r,first:fileHash(a.first),last:fileHash(a.last),contract:contractId,promptVersion:ctx.config.planner?.promptVersion});
 if(!a.frameReview||a.frameReview.revision!==r||!reviewIsReusable(a.frameReview,frameBinding)){
  const storedFrame=readStoredReview(ctx.directory,checkId,{duration:shot.duration,imageCount:frameImages.length,
   ...(contractText?{binding:frameBinding}:{images:frameImages.map(fileHash)})});
  if(storedFrame){a.frameReview={...storedFrame.report,revision:r,binding:frameBinding,reusedFrom:checkId,
    provenance:storedFrame.provenance,coverageGap:coverageGap(storedFrame.spec,frameLabelsUsed)};log('复用输入一致的首尾帧质检 '+line.id);}
  else{const prompt=recordedPrompt(ctx.directory,checkId,'用户文档场景是道具与动作的最高依据：'+sceneText+'。参考图中的武器只作外观参考，文档指定佩剑时不得因参考图长矛而判错或强制恢复长矛。躬身长揖不等于跪地叩头，首尾按文档动作。'+framesCheckPrompt({shot,images:frameLabelsUsed,contract:contractText,docFirst:true}));
   const firstRecord=operationRecord(ctx.directory,checkId);
   if(firstRecord&&checkInputChanged(firstRecord,{prompt,images:frameImages.map(fileHash)})){
    a.qualityPause={stage:'frames',code:'CHECK_INPUT_CHANGED',
     reason:'该首尾帧检查已有记录，但当前输入与当时不同（协议或覆盖不同）；不换号、不重绑，需人工核实或用受控修订显式升级',
     recorded:checkCoverage(firstRecord),at:new Date().toISOString()};e.status='quality-awaiting-user';save();
    throw Error('EXTERNAL_CHECK_INPUT_CHANGED:'+checkId+':已有记录与当前输入不一致，未重发也未换号');}
   const {json}=await models.plan(checkId,{purpose:'external-frame-quality',prompt,images:frameImages,reservationCents:ctx.config.planner.reservationCents,
    evidence:contractText?{digest:frameBinding.digest,rules:QUALITY_RULES_VERSION}:null});
   a.frameReview={...checkedReport(json,{duration:shot.duration,imageCount:frameImages.length}),revision:r,binding:frameBinding};}
  save();}
 const frameDecision=reworkDecision(a.frameReview,{hasLastFrame:true});
 if(frameDecision.action==='accept'){const queued=e.framesRepairQueue?.[line.id];if(queued&&queued.applied!==true&&e.mediaRevisions['frames-'+line.id]===queued.frames){queued.applied=true;queued.appliedAt=new Date().toISOString();log('首尾帧返工已完成 '+line.id);}if(frameDecision.observations?.length)log('首尾帧仅有轻微差异，已记录不重做 '+line.id);a.frameDecision={action:'accept',code:frameDecision.code,at:new Date().toISOString()};save();break;}
 if(frameDecision.action==='pause'){a.qualityPause={stage:'frames',code:frameDecision.code,reason:frameDecision.reason,review:a.frameReview,at:new Date().toISOString()};e.status='quality-awaiting-user';save();throw Error('EXTERNAL_FRAME_QUALITY_'+frameDecision.code+':'+line.id+':'+frameDecision.reason);}
 if(r>=3){const found=a.frameReview.issues.map(i=>i.observed).join('；');await attempts.markExhausted('first-'+line.id,found);await attempts.markExhausted('last-'+line.id,found);throw Error('EXTERNAL_FRAMES_EXHAUSTED:'+line.id);}
 delete a.qualityPause;a.frameFix='。修正：'+repairInstruction(a.frameReview);queueFramesRepair(e,line.id,{fix:a.frameFix,reason:'首尾帧质检要求重做画面'});save();}
 }
 e.status='frames-ready';save();if(until==='frames')return {status:e.status,shots:e.source.lines.length};
 for(const line of e.source.lines){const visual=e.visualPlans[line.sceneId].shots.find(p=>p.id===line.id),shot=shotFor(line,visual,e.audio[line.id]),a=e.media[line.id],contractText=contractPrompt(shot,{docFirst:true}),contractId=contractDigest(shot,ctx.config.planner?.promptVersion);
 const driving=media.normalizeAudio(e.audio[line.id].file,path.join(dir,'audio','drive-'+line.id+'.wav'),2);
 for(;;){const r=e.mediaRevisions['video-'+line.id]||0;log('动态视频 '+line.id+' 第'+(r+1)+'轮');const videoId='video-'+line.id+'-r'+r,checkId='video-check-'+line.id+'-r'+r;
 const wanted={...shot,action:shot.action+(contractText?'。'+contractText:'')+(a.videoFix?'。修正：'+a.videoFix:'')};
 a.video=await models.video(videoId,recordedInput(ctx.directory,videoId,'shot',wanted),a.first,a.last,driving,path.join(dir,'video',videoId+'.mp4'));a.videoInfo=media.video(a.video,shot.duration);media.command(['-v','error','-i',a.video,'-f','null','-']);save();
 const plan=samplingPlan(shot.duration),samples=media.sampleFramesAt(a.video,path.join(dir,'video-check',checkId),plan.times,checkId+'-');
 const videoImages=[a.first,...samples.map(s=>s.file),a.last],videoLabels=[{label:'目标首帧'},...samples.map(s=>({label:'视频'+s.at+'秒抽帧'})),{label:'目标尾帧'}];
 const videoBinding=reviewBinding({shotId:line.id,revision:r,first:fileHash(a.first),last:fileHash(a.last),video:fileHash(a.video),contract:contractId,promptVersion:ctx.config.planner?.promptVersion,sampling:plan});
 if(!a.videoReview||a.videoReview.revision!==r||!reviewIsReusable(a.videoReview,videoBinding)){
  const storedVideo=readStoredReview(ctx.directory,checkId,{duration:shot.duration,imageCount:videoImages.length,sampledTimes:plan.times,actualFrameIndexes:[2,3,4],
   ...(contractText?{binding:videoBinding}:{images:videoImages.map(fileHash)})});
  if(storedVideo){const gap=coverageGap(storedVideo.spec,videoLabels);a.videoReview={...storedVideo.report,revision:r,binding:videoBinding,reusedFrom:checkId,provenance:storedVideo.provenance,coverageGap:gap,missingLastFrameComparison:!!gap};log('复用输入一致的视频质检 '+line.id);}
  else{const prompt=recordedPrompt(ctx.directory,checkId,videoCheckPrompt({shot,images:videoLabels,duration:shot.duration,contract:contractText,docFirst:true}));
   const videoRecord=operationRecord(ctx.directory,checkId);
   if(videoRecord&&checkInputChanged(videoRecord,{prompt,images:videoImages.map(fileHash)})){
    // 旧检查的真实输入（例如首帧＋4个旧时点抽帧）无法复现：明确暂停，既不重绑也不换号重新请求。
    a.qualityPause={stage:'video',code:'CHECK_INPUT_CHANGED',
     reason:'该视频检查已有记录，但当前输入与当时不同（协议或覆盖不同）；不换号、不重绑，需人工核实或用受控修订显式升级',
     recorded:checkCoverage(videoRecord),at:new Date().toISOString()};e.status='quality-awaiting-user';save();
    throw Error('EXTERNAL_CHECK_INPUT_CHANGED:'+checkId+':已有记录与当前输入不一致，未重发也未换号');}
   const {json}=await models.plan(checkId,{purpose:'external-video-quality',prompt,images:videoImages,reservationCents:ctx.config.planner.reservationCents,
    evidence:contractText?{digest:videoBinding.digest,rules:QUALITY_RULES_VERSION}:null});
   a.videoReview={...checkedReport(json,{duration:shot.duration,imageCount:videoImages.length,sampledTimes:plan.times,actualFrameIndexes:[2,3,4]}),revision:r,binding:videoBinding,
    evidence:{sampling:plan.times,imageCount:videoImages.length,order:videoLabels.map(l=>l.label),coverage:plan.coverage}};}
  save();}
 const videoDecision=reworkDecision(a.videoReview);
 if(videoDecision.action==='accept'){if(videoDecision.observations?.length)log('视频仅有轻微差异，已记录不重做 '+line.id);a.videoDecision={action:'accept',code:videoDecision.code,at:new Date().toISOString()};save();break;}
 if(videoDecision.action==='pause'){a.qualityPause={stage:'video',code:videoDecision.code,reason:videoDecision.reason,review:a.videoReview,at:new Date().toISOString()};e.status='quality-awaiting-user';save();throw Error('EXTERNAL_VIDEO_QUALITY_'+videoDecision.code+':'+line.id+':'+videoDecision.reason);}
 // A problem that lives in the target frames must repair the frames, not the video: no video round is spent.
 if(videoDecision.unit==='frames'){a.frameFix='。修正：'+repairInstruction(a.videoReview);queueFramesRepair(e,line.id,{fix:a.frameFix,reason:videoDecision.reason});a.qualityPause={stage:'video',code:'FRAMES_REPAIR_REQUIRED',reason:videoDecision.reason,at:new Date().toISOString()};save();throw Error('EXTERNAL_VIDEO_QUALITY_FRAMES_REPAIR_SCHEDULED:'+line.id+':已登记首尾帧返工，重新执行同一命令继续');}
 if(r>=3){await attempts.markExhausted('video-'+line.id,a.videoReview.issues.map(i=>i.observed).join('；'));throw Error('EXTERNAL_VIDEO_EXHAUSTED:'+line.id);}
 a.videoFix='。修正：'+repairInstruction(a.videoReview);e.mediaRevisions['video-'+line.id]=r+1;save();}
 }
 // Adjacent-shot continuity: only between shots of the same scene where the later shot declares a
 // continuation, and only once both videos exist. A scene change or a time jump is never an error, and a
 // plan without contracts (legacy) is simply not checked — no continuity is claimed for it either.
 // The contract was already validated before the frames were generated (see e.continuity); the shot list
 // built there is reused here to locate the neighbouring pairs.
 const continuity={mode:e.continuity?.mode||'legacy',pairs:e.continuity?.pairs||[],gaps:e.continuity?.gaps||[]};
 if(continuity.mode==='contract'&&continuity.pairs.length){
  e.adjacencyReviews||={};e.adjacencyDecisions||={};
  for(const pair of continuity.pairs){
   const from=planShots.find(s=>s.id===pair.from),to=planShots.find(s=>s.id===pair.to),fa=e.media[pair.from],ta=e.media[pair.to];
   if(!fa?.video||!ta?.video)continue;
   const endSample=media.sampleFramesAt(fa.video,path.join(dir,'adjacent',pair.to),[Math.max(.03,from.duration-0.05)],pair.to+'-prev-')[0];
   const startSample=media.sampleFramesAt(ta.video,path.join(dir,'adjacent',pair.to),[0.03],pair.to+'-next-')[0];
   const images=[fa.last,endSample.file,ta.first,startSample.file];
   const labels=[{label:'前镜目标尾帧'},{label:'前镜实际结束'},{label:'后镜目标首帧'},{label:'后镜实际开始'}];
   const base='adjacent-check-'+pair.to;
   const bindingFor=revision=>reviewBinding({shotId:pair.to,revision,first:fileHash(fa.last),last:fileHash(startSample.file),
    video:fileHash(ta.video),contract:contractDigest(to,ctx.config.planner?.promptVersion),promptVersion:ctx.config.planner?.promptVersion,
    sampling:{count:2,times:[endSample.at,startSample.at]},
    extra:{kind:'adjacent',from:pair.from,fromRevision:e.mediaRevisions['video-'+pair.from]||0,adjacentVideo:fileHash(fa.video),
     adjacentContract:contractDigest(from,ctx.config.planner?.promptVersion),adjacentSampling:[endSample.at]}});
   const previous=e.adjacencyReviews?.[pair.to];
   if(previous&&!reviewIsReusable(previous,bindingFor(e.adjacencyRevisions?.[pair.to]||0))){
    // 输入变了：走受控修订——丢掉旧结论并推进该检查的修订号，新请求落到新操作号上，既不覆盖历史记录，
    // 也不能靠新编号绕开检查次数（checkUnitForOperation 会把所有修订合并到同一个检查额度）。
    delete e.adjacencyReviews[pair.to];e.adjacencyRevisions||={};e.adjacencyRevisions[pair.to]=(e.adjacencyRevisions[pair.to]||0)+1;save();}
   // 操作号、请求证据与状态绑定必须使用同一个修订版本：修订号刚刚推进过，绑定必须按新修订号重算。
   const revision=e.adjacencyRevisions?.[pair.to]||0,binding=bindingFor(revision);
   const id=base+'-r'+revision;
   // 首次响应与缓存恢复必须共用同一组校验选项：定位规则（时点与实际抽帧图序）只在两处一致时才成立。
   const reviewOptions={duration:to.duration,imageCount:images.length,sampledTimes:[endSample.at,startSample.at],actualFrameIndexes:[2,4]};
   if(!reviewIsReusable(e.adjacencyReviews[pair.to],binding)){
    const stored=readStoredReview(ctx.directory,id,{...reviewOptions,binding});
    let report;
    if(stored)report={...stored.report,provenance:stored.provenance};
    else{const {json}=await models.plan(id,{purpose:'adjacent-continuity',prompt:recordedPrompt(ctx.directory,id,adjacentCheckPrompt({pair:{...pair,fromDuration:from.duration},images:labels,duration:to.duration,docFirst:true})),images,
      reservationCents:ctx.config.planner.reservationCents,evidence:{digest:binding.digest,rules:QUALITY_RULES_VERSION}});
     report=checkedReport(json,reviewOptions);}
    e.adjacencyReviews[pair.to]={report,binding,from:pair.from,revision:binding.revision,
     evidence:{images:labels.map(l=>l.label),sampledAt:{previous:endSample.at,current:startSample.at}},at:new Date().toISOString()};save();}
   const report=e.adjacencyReviews[pair.to].report,decision=reworkDecision(report,{hasLastFrame:true});
   e.adjacencyDecisions[pair.to]={action:decision.action,code:decision.code,reason:decision.reason,at:new Date().toISOString()};save();
   if(decision.action==='pause'){e.status='quality-awaiting-user';save();throw Error('EXTERNAL_ADJACENT_QUALITY_'+decision.code+':'+pair.to+':'+decision.reason);}
   if(decision.action==='repair'){
    const rounds=attempts.status('first-'+pair.to);
    if(!rounds||rounds.hasRoundsLeft===false){e.adjacencyDecisions[pair.to].blocked='NO_ROUNDS_LEFT';e.status='quality-awaiting-user';save();throw Error('EXTERNAL_ADJACENT_EXHAUSTED:'+pair.to);}
    e.media[pair.to].frameFix='。修正：'+repairInstruction(report);
    queueFramesRepair(e,pair.to,{fix:e.media[pair.to].frameFix,reason:decision.reason,from:pair.from});
    e.adjacencyDecisions[pair.to].repair='frames-'+pair.to;save();
    throw Error('EXTERNAL_ADJACENT_REPAIR_SCHEDULED:'+pair.to+':已按最小范围登记后镜首尾帧返工，重新执行同一命令继续');}
  }
 }
 e.status='video-ready';save();if(until==='video')return {status:e.status};
 const outputDir=path.join(ctx.root,'output',ctx.production.id,'user-script-v1');fs.mkdirSync(outputDir,{recursive:true});
 const black=path.join(outputDir,'black.png');if(!fs.existsSync(black))media.command(['-f','lavfi','-i','color=c=black:s=1920x1080','-frames:v','1',black]);
 let cursor=0;const shots=e.source.lines.map(line=>{const p=e.visualPlans[line.sceneId].shots.find(p=>p.id===line.id),s=shotFor(line,p,e.audio[line.id]);s.start=cursor;cursor+=s.duration;s.end=cursor;return s;});
 const assets=Object.fromEntries(e.source.lines.map(l=>[l.id,{...e.media[l.id],audio:e.audio[l.id].file}]));
 const timeline={title:e.source.title,shots,ending:{image:black,caption:e.source.endingCaption,cardSeconds:3,blackSeconds:.5,start:cursor},totalDuration:cursor+3.5};
 writeJson(path.join(dir,'video-timeline.json'),timeline);e.output=media.assemble(timeline,assets,outputDir);e.status='final-awaiting-playback';e.finalDuration=timeline.totalDuration;e.qualityBoundary=coverageBoundary(e,e.source.lines);save();return {status:e.status,output:e.output,duration:e.finalDuration};
 }catch(error){e.lastError=error.message;e.status='paused';save();throw error;}
 });
}
module.exports={audioBinding,coverageBoundary,requireAccepted,acceptExternalAudio,validateVisualPlan,validatePlanContinuity,checkedReport,repairText,framesAccepted,shotFor,queueFramesRepair,runExternalVideo};
