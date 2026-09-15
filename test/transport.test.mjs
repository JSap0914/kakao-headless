import test from 'node:test';
import assert from 'node:assert/strict';
import { LocoTransport, validId, validAccount, loadProvider } from '../src/transport.mjs';

test('IDs remain exact and invalid IDs fail closed', () => {
  assert.equal(validId('9223372036854775807'),'9223372036854775807');
  for (const x of [1, '01', '0', '-1','9223372036854775808','../1']) assert.throws(()=>validId(x));
});
test('credential device paths and unsafe numeric user IDs rejected', () => {
  const a={oauth_token:'fixture',user_id:'123',device_uuid:'fixture-uuid',device_type:'tablet'};
  assert.equal(validAccount(a),a);
  assert.throws(()=>validAccount({...a,device_uuid:'../../stolen'}));
  assert.throws(()=>validAccount({...a,user_id:'9007199254740993'}));
});
test('raw WRITE invoked once, never convenience retry API', async () => {
  let raw=0; const packet={statusCode:0,body:{status:0,logId:'101'}};
  const c={acquireSession:async()=>({sendMessage:async(id,text)=>{raw++;assert.equal(id.toString(),'9007199254740993');assert.equal(text,'test');return packet;}}),sendMessage:()=>{throw Error('must not call');}};
  assert.equal(await new LocoTransport(c,'1').writeOnce('9007199254740993','test'),packet);assert.equal(raw,1);
});
test('raw WRITE exception is not replayed',async()=>{
  let n=0;const t=new LocoTransport({acquireSession:async()=>({sendMessage:async()=>{n++;throw Error('lost');}})},'1');
  await assert.rejects(t.writeOnce('12','test'));assert.equal(n,1);
});
test('strict history pagination returns latest N without a markRead API',async()=>{
  let calls=0; const t=new LocoTransport({getMessagePage:async(id,o)=>{calls++;return calls===1?{messages:[{log_id:'10'},{log_id:'11'}],complete:false,next_cursor:'11'}:{messages:[{log_id:'12'}],complete:true,next_cursor:null};}},'1');
  assert.deepEqual(await t.getMessages('2',{count:2}),[{log_id:'11'},{log_id:'12'}]);assert.equal(calls,2);
});
test('history provider failure never becomes empty success',async()=>{
  const t=new LocoTransport({getMessagePage:async()=>{throw Error('rejected');}},'1');await assert.rejects(t.getMessages('2'));
});
test('history cap and stuck cursors are explicit errors',async()=>{
  const t=new LocoTransport({getMessagePage:async()=>({messages:[],complete:false,next_cursor:'3'})},'1');await assert.rejects(t.getMessages('2'),{code:'INCOMPLETE_HISTORY'});
});
test('incomplete member snapshots cannot authorize a send',async()=>{
  const t=new LocoTransport({getMemberSnapshot:async()=>({chat_id:'2',complete:true,active_members:2,members:[{user_id:'1'}]})},'1');await assert.rejects(t.getMembers('2'),{code:'INCOMPLETE_MEMBERS'});
});
test('optional real pinned provider import contract without network', {skip:process.env.TEST_PROVIDER!=='1'},async()=>{
  const p=await loadProvider();const c=new p.KakaoTalkClient();
  for(const name of ['login','acquireSession','getChats','getChat','getMemberSnapshot','getMessagePage','close'])assert.equal(typeof c[name],'function',name);
  for(const name of ['attemptLogin','generateDeviceUuid','requestPasscode','registerDevice','refreshKakaoOAuthToken'])assert.equal(typeof p[name],'function',name);
  c.close();
});

test('actual provider strict history accepts bridge page size with network stubbed', {skip:process.env.TEST_PROVIDER!=='1'},async()=>{
 const p=await loadProvider();const c=new p.KakaoTalkClient();
 const {Long}=await import('bson');
 // Replace only the network executor on this test instance, not the page API.
 c.executeWithReconnect=async operation=>operation({session:{getChatLogs:async()=>({statusCode:0,body:{status:0,eof:true,chatLogs:[{chatId:Long.fromString('2'),logId:Long.fromString('3'),authorId:1,message:'fixture',type:1,sendAt:100}]}})},loginResult:{}});
 try {const rows=await new LocoTransport(c,'1').getMessages('2',{count:200});assert.equal(rows.length,1);assert.equal(rows[0].log_id,'3');assert.equal(rows[0].author_id,'1');}finally{c.close();}
});
