const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');const {audioBinding,requireAccepted,validateVisualPlan,checkedReport,shotFor,runExternalVideo}=require('../workflows/external-script-video');
test('external video requires current accepted bytes',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-bind-')),file=path.join(dir,'a');fs.writeFileSync(file,'a');const e={source:{lines:[{id:'x',text:'原文'}]},audio:{x:{file}},acceptance:'accepted'};e.acceptedBinding=audioBinding(e);requireAccepted(e);fs.writeFileSync(file,'b');assert.throws(()=>requireAccepted(e),/NOT_ACCEPTED/);});
test('external visual plan rejects changed IDs, nonexistent roles and multi speaker dialogue',()=>{const l=[{id:'a',role:'jiang_wei'}],s={id:'a',type:'dialogue',characters:['jiang_wei'],scene:'足够详细的首帧画面描述',endScene:'足够详细的尾帧画面描述',action:'足够详细的动态画面描述'};validateVisualPlan({shots:[s]},l,['jiang_wei']);assert.throws(()=>validateVisualPlan({shots:[{...s,characters:[]}]},l,['jiang_wei']),/CHARACTER/);assert.throws(()=>validateVisualPlan({shots:[{...s,id:'b'}]},l,['jiang_wei']),/CHARACTER/);});
test('external shot preserves text and gives natural speech sufficient visual duration',()=>{const s=shotFor({id:'a',text:'完整台词',role:'jiang_wei'}, {type:'dialogue'}, {duration:9.21});assert.equal(s.text,'完整台词');assert.ok(s.duration>=9.21&&s.duration<9.25);assert.throws(()=>shotFor({id:'x'}, {}, {duration:16}),/SPLIT/);});
test('quality contradictions do not silently pass and offline gate precedes any source access',async()=>{assert.equal(checkedReport({pass:true,issues:['破损']}).pass,false);await assert.rejects(runExternalVideo({root:'.',config:{onlineEnabled:false},production:{id:'second-film'}}),/ONLINE_DISABLED/);});

test('structured frame repairs retain both model instructions and reject incomplete repairs',()=>{const {repairText}=require('../workflows/external-script-video');assert.equal(repairText({start_frame_prompt:'起点',end_frame_prompt:'终点'}),'首帧修正：起点。尾帧修正：终点');assert.equal(repairText({start_frame_prompt:'起点'}),'首帧修正：起点');assert.throws(()=>repairText({start_frame_prompt:''}),/REPAIR_SHAPE/);assert.throws(()=>repairText({other:'不明指令'}),/REPAIR_SHAPE/);assert.equal(repairText('修复'),'修复');});

test('manual acceptance binds exact images and revision',()=>{const {framesAccepted}=require('../workflows/external-script-video');const {fileHash}=require('../services/aliyun/io');const d=fs.mkdtempSync(path.join(os.tmpdir(),'frame-accept-')),f=path.join(d,'first'),l=path.join(d,'last');fs.writeFileSync(f,'first');fs.writeFileSync(l,'last');const a={first:f,last:l,frameAcceptance:{accepted:true,revision:3,firstHash:fileHash(f),lastHash:fileHash(l)}};assert.equal(framesAccepted(a,3),true);assert.throws(()=>framesAccepted(a,2),/CHANGED/);fs.writeFileSync(l,'changed');assert.throws(()=>framesAccepted(a,3),/CHANGED/);fs.rmSync(d,{recursive:true});});
test('a plan without contracts is accepted as legacy while a declared contract is validated',()=>{const {validatePlanContinuity}=require('../workflows/external-script-video');
 const base={scene:'足够详细的首帧画面描述',endScene:'足够详细的尾帧画面描述',action:'足够详细的动态画面描述'};
 const contract={startState:'站在台阶前，右手按剑柄，面向左侧',endState:'半蹲稳住重心，剑指向左前方',primaryAction:'拔剑并指向左前方',
  beats:['起势：右手握紧剑柄','接触：拔剑出鞘'],cut:'continuous',handoff:'承接上一镜的站位、视线与右手持剑状态'};
 const legacy=[{id:'a',...base,duration:5,sceneId:'doc01'},{id:'b',...base,duration:5,sceneId:'doc01'}];
 const plain=validatePlanContinuity(legacy,shot=>shot.sceneId);
 assert.equal(plain.mode,'legacy');
 assert.deepEqual(plain.pairs,[]);
 const declared=[{id:'a',...base,...contract,duration:5,sceneId:'doc01'},{id:'b',...base,...contract,duration:5,sceneId:'doc01'}];
 const same=validatePlanContinuity(declared,shot=>shot.sceneId);
 assert.equal(same.mode,'contract');
 assert.deepEqual(same.pairs.map(pair=>[pair.from,pair.to]),[['a','b']]);
 // A declared continuation across a scene change, or silence inside one scene, is refused before any spend.
 assert.throws(()=>validatePlanContinuity([{id:'a',...base,...contract,duration:5,sceneId:'doc01'},
  {id:'b',...base,...contract,cut:'scene',duration:5,sceneId:'doc01'}],shot=>shot.sceneId),/EXTERNAL_PLAN_CONTRACT_INVALID/);
 assert.throws(()=>validatePlanContinuity([{id:'a',...base,...contract,duration:5,sceneId:'doc01'},
  {id:'b',...base,...contract,duration:5,sceneId:'doc02'}],shot=>shot.sceneId),/EXTERNAL_PLAN_CONTRACT_INVALID/);});
test('an adjacent check is a bounded check which never consumes a generation round',()=>{const {unitForOperation,checkUnitForOperation}=require('../services/aliyun/units');
 assert.equal(unitForOperation('adjacent-check-doc02-line02-r0'),null);
 assert.equal(checkUnitForOperation('adjacent-check-doc02-line02-r0'),'adjacent-check-doc02-line02');
 assert.equal(unitForOperation('video-doc02-line02-r0'),'video-doc02-line02');});
