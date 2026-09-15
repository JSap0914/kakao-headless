import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Long } from 'bson';
import { SendGuard } from '../src/guard.mjs';
import { LocoTransport } from '../src/transport.mjs';

test('guard plus adapter: nullable direct room, numeric author, raw BSON response, one write',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kh-integration-'));let writes=0;let sent='';
 const client={
  getChat:async()=>({chat_id:'9007199254740993',title:null,display_name:'Fixture test room',type:'DirectChat',active_members:2}),
  getMemberSnapshot:async()=>({chat_id:'9007199254740993',complete:true,active_members:2,members:[{user_id:'11',nickname:'Fixture self'},{user_id:'22',nickname:'Fixture recipient'}]}),
  acquireSession:async()=>({sendMessage:async(id,text)=>{assert.equal(id.toString(),'9007199254740993');writes++;sent=text;return{statusCode:0,body:{status:0,logId:Long.fromString('9007199254740995'),chatId:id}};}}),
  getMessagePage:async()=>({messages:[{log_id:'9007199254740995',author_id:11,message:sent}],complete:true,next_cursor:null})
 };
 try{
  const guard=new SendGuard({stateDir:dir,transport:new LocoTransport(client,'11')});
  const preview=await guard.preview('9007199254740993','One harmless fixture test.');
  assert.equal(writes,0);assert.equal(preview.label,'Fixture test room');
  const result=await guard.send(preview.previewId);assert.equal(result.status,'verified');assert.equal(writes,1);
  await assert.rejects(guard.send(preview.previewId),{code:'ALREADY_ATTEMPTED'});assert.equal(writes,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
