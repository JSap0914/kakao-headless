import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cli=new URL('../src/cli.mjs',import.meta.url);
function run(args){const r=spawnSync(process.execPath,[cli.pathname,...args],{encoding:'utf8',timeout:10000});return{...r,json:r.stdout?JSON.parse(r.stdout):null};}
test('doctor is offline and does not claim live verification',()=>{const r=run(['doctor']);assert.equal(r.status,0);assert.equal(r.json.live_kakao_tested,false);assert.equal(r.json.aside_builtin_modified,false);});
test('unknown command fails closed before keychain',()=>{const r=run(['destroy']);assert.equal(r.status,1);assert.equal(r.json.error,'INVALID_COMMAND');});
test('risk acknowledgement and confirmation required before credentials or network',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kh-cli-'));try{
  let r=run(['chats','--state-dir',dir]);assert.equal(r.json.error,'ACKNOWLEDGE_UNOFFICIAL_ACCOUNT_RISK');
  r=run(['send','123','--ack-risk','--state-dir',dir]);assert.equal(r.json.error,'EXPLICIT_CONFIRM_REQUIRED');assert.equal(r.status,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('receipt works offline with no provider or account requirement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kh-cli-'));const id='41d949c0-49ee-4b4e-b62e-8c3952a2b223';try{
  await writeFile(join(dir,id+'.reservation.json'),JSON.stringify({previewId:id,status:'unknown',code:'ATTEMPT_RESERVED'}));
  const r=run(['receipt',id,'--state-dir',dir]);assert.equal(r.status,0);assert.equal(r.json.status,'unknown');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('receipt traversal is rejected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'kh-cli-'));try{const r=run(['receipt','../../etc/passwd','--state-dir',dir]);assert.equal(r.status,1);assert.equal(r.json.error,'INVALID_PREVIEW_ID');}finally{await rm(dir,{recursive:true,force:true});}
});
