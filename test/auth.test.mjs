import test from 'node:test';
import assert from 'node:assert/strict';
import { Auth } from '../src/auth.mjs';
function fixture(){const entries=new Map();return {entries,vault:{get:async k=>entries.get(k)??null,set:async(k,v)=>entries.set(k,v),delete:async k=>entries.delete(k)}};}
const credentials={access_token:'fixture-access',refresh_token:'fixture-refresh',user_id:'1',device_uuid:'fixture-device',device_type:'tablet'};
test('two-step registration returns challenge immediately and never persists password',async()=>{
  const f=fixture();let reg=0;const provider={generateDeviceUuid:()=>credentials.device_uuid,attemptLogin:async()=>({next_action:'provide_passcode'}),requestPasscode:async()=>({next_action:'confirm_on_phone',passcode:'123456',remaining_seconds:60}),registerDevice:async()=>{reg++;}};
  const auth=new Auth({...f,provider,now:()=>1000});const result=await auth.begin('test@example.invalid','fixture-password');
  assert.equal(result.next_action,'confirm_on_phone_then_auth_finish');assert.equal(reg,0);assert.equal(f.entries.get('pending').expiresAt,61000);assert.ok(!JSON.stringify([...f.entries]).includes('fixture-password'));assert.ok(!JSON.stringify([...f.entries]).includes('123456'));
});
test('finish registers then logs in and saves credentials to vault only',async()=>{
  const f=fixture();f.entries.set('pending',{email:'test@example.invalid',deviceUuid:credentials.device_uuid,expiresAt:5000});const order=[];
  const auth=new Auth({...f,now:()=>1000,provider:{registerDevice:async()=>{order.push('register');return{};},attemptLogin:async()=>{order.push('login');return{authenticated:true,credentials};}}});
  assert.deepEqual(await auth.finish('fixture-password'),{authenticated:true,user_id:'1'});assert.deepEqual(order,['register','login']);assert.equal(f.entries.get('account').oauth_token,credentials.access_token);assert.ok(!f.entries.has('pending'));
});
test('expired registration is rejected before network',async()=>{
  const f=fixture();f.entries.set('pending',{expiresAt:1000,email:'x',deviceUuid:'x'});await assert.rejects(new Auth({...f,provider:{},now:()=>1000}).finish('p'),{code:'LOGIN_CHALLENGE_EXPIRED'});
});
test('server registration rejection does not attempt login',async()=>{
 const f=fixture();f.entries.set('pending',{expiresAt:5000,email:'x',deviceUuid:'fixture-device'});await assert.rejects(new Auth({...f,now:()=>1,provider:{registerDevice:async()=>({error:'no'})}}).finish('p'),{code:'DEVICE_REGISTRATION_FAILED'});
});
test('refresh persists rotated credentials and returns no token',async()=>{
 const f=fixture();f.entries.set('account',{oauth_token:'old',refresh_token:'old-refresh',user_id:'1',device_uuid:'fixture-device',device_type:'tablet'});
 const result=await new Auth({...f,provider:{refreshKakaoOAuthToken:async()=>({accessToken:'new',refreshToken:'new-refresh'})}}).refresh();
 assert.deepEqual(result,{refreshed:true,user_id:'1'});assert.equal(f.entries.get('account').refresh_token,'new-refresh');
});
test('logout accurately reports no remote revoke',async()=>{const f=fixture();f.entries.set('account',{});const r=await new Auth(f).logout();assert.equal(r.server_session_revoked,false);assert.equal(f.entries.size,0);});

test('refresh aborts before remote rotation if credential store cannot update',async()=>{
 let calls=0;const vault={get:async()=>({oauth_token:'fixture-old',refresh_token:'fixture-refresh',user_id:'1',device_uuid:'fixture-device',device_type:'tablet'}),set:async()=>{throw Error('denied');}};
 await assert.rejects(new Auth({vault,provider:{refreshKakaoOAuthToken:async()=>{calls++;}}}).refresh(),{code:'CREDENTIAL_STORE_UNWRITABLE'});assert.equal(calls,0);
});
test('refresh checks persistence before calling provider and stores the rotated token afterwards',async()=>{
 const f=fixture();f.entries.set('account',{oauth_token:'fixture-old',refresh_token:'fixture-refresh',user_id:'1',device_uuid:'fixture-device',device_type:'tablet'});const order=[];const original=f.vault.set;f.vault.set=async(k,v)=>{order.push('store');await original(k,v);};
 await new Auth({...f,provider:{refreshKakaoOAuthToken:async()=>{order.push('rotate');return{accessToken:'fixture-new',refreshToken:'fixture-new-refresh'};}}}).refresh();assert.deepEqual(order,['store','rotate','store']);
});
