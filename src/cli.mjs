#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { KeychainVault } from './vault.mjs';
import { Auth } from './auth.mjs';
import { SendGuard } from './guard.mjs';
import { LocoTransport, loadProvider, validAccount, fail, SUPPORTED_VERSION } from './transport.mjs';

const HELP = `kakao-headless 0.1.0 (experimental, macOS Keychain)

  doctor                              Offline runtime/provider check
  auth begin --email EMAIL --ack-risk  Hidden password prompt; phone registration
  auth finish --ack-risk              Finish after confirming code on phone
  auth import --ack-risk              Read credential JSON from stdin into Keychain
  auth refresh --ack-risk             Rotate stored token, explicitly
  auth logout                         Delete local credentials (not server revoke)
  chats [--search NAME] --ack-risk     Existing chat list, no mark-read calls
  history CHAT_ID [--count 30] [--from LOG_ID] --ack-risk
  preview CHAT_ID --text-file FILE --ack-risk
  send PREVIEW_ID --confirm --ack-risk Exactly one local attempt; no retry
  receipt PREVIEW_ID                   Inspect durable local outcome

All output is JSON except help and local password prompts. State defaults to
~/.local/state/kakao-headless; override with --state-dir DIR. Unofficial LOCO
access can restrict your Kakao account. Use a dedicated test account first.
Never run with agent-kakaotalk@0.0.1: it is an empty reservation package.
`;
const out = (value) => console.log(JSON.stringify(value, null, 2));
async function inputJson() {
  if (process.stdin.isTTY) fail('PIPE_JSON_TO_STDIN');
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 65536) fail('INPUT_TOO_LARGE'); }
  try { return JSON.parse(text); } catch { fail('INVALID_INPUT_JSON'); }
}
async function password() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) fail('PASSWORD_REQUIRES_LOCAL_TTY');
  process.stderr.write('Kakao password (hidden): ');
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let secret = '';
    const done = (error) => { process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(secret); };
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') { const e = new Error('CANCELLED'); e.code = 'CANCELLED'; return done(e); }
      if (key.name === 'return' || key.name === 'enter') return done();
      if (key.name === 'backspace') { secret = [...secret].slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && str && !/[\x00-\x1f\x7f]/.test(str)) secret += str;
    };
    process.stdin.on('keypress', onKey);
  });
}
let transport;
try {
  const { values: flags, positionals: args } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: {type:'boolean',short:'h'}, 'ack-risk': {type:'boolean'}, confirm: {type:'boolean'},
    email:{type:'string'}, search:{type:'string'}, count:{type:'string'}, from:{type:'string'},
    'text-file':{type:'string'}, 'state-dir':{type:'string'}
  } });
  const [command, target] = args;
  if (flags.help || !command) { console.log(HELP); }
  else if (command === 'doctor') {
    let provider = 'missing'; try { await loadProvider(); provider = SUPPORTED_VERSION; } catch(e) { provider = e.code; }
    out({ version:'0.1.0', node:process.version, platform:process.platform, keychain_supported:process.platform==='darwin', provider, live_kakao_tested:false, aside_builtin_modified:false });
  } else {
    const known = ['auth','chats','history','preview','send','receipt'];
    if (!known.includes(command) || args.length > 2 || (command==='chats' && target)) fail('INVALID_COMMAND');
    const stateDir = flags['state-dir'] ?? join(homedir(), '.local', 'state', 'kakao-headless');
    await mkdir(stateDir, {recursive:true, mode:0o700}); await chmod(stateDir,0o700);
    const vault = new KeychainVault();
    if (command === 'receipt') {
      out(await new SendGuard({ stateDir, transport: null }).receipt(target));
    } else if (command === 'auth' && target === 'logout') {
      out(await new Auth({vault}).logout());
    } else {
      if (!flags['ack-risk']) fail('ACKNOWLEDGE_UNOFFICIAL_ACCOUNT_RISK');
      if (command === 'auth') {
        if (!['import','begin','finish','refresh'].includes(target)) fail('INVALID_COMMAND');
        if (target === 'import') { await vault.set('account', validAccount(await inputJson())); out({imported:true}); }
        else {
          const auth = new Auth({ vault, provider: await loadProvider() });
          if (target === 'begin') out(await auth.begin(flags.email, await password()));
          if (target === 'finish') out(await auth.finish(await password()));
          if (target === 'refresh') out(await auth.refresh());
        }
      } else {
        if (command === 'send' && !flags.confirm) fail('EXPLICIT_CONFIRM_REQUIRED');
        const account = await vault.get('account'); if (!account) fail('AUTH_REQUIRED');
        transport = await LocoTransport.connect({account,stateDir});
        const guard = new SendGuard({stateDir,transport});
        if (command === 'chats') out(await transport.listChats(flags.search));
        if (command === 'history') out(await transport.getMessages(target,{count:flags.count===undefined?30:Number(flags.count),from:flags.from}));
        if (command === 'preview') {
          if (!flags['text-file']) fail('TEXT_FILE_REQUIRED');
          const text = await readFile(flags['text-file'],'utf8');
          out(await guard.preview(target,text));
        }
        if (command === 'send') {
          const result = await guard.send(target); out(result);
          if (result.status !== 'verified') process.exitCode = 2;
        }
      }
    }
  }
} catch(e) {
  // Never echo provider errors, stacks, passwords or tokens.
  const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(e.code) ? e.code : 'OPERATION_FAILED';
  out({error:code}); process.exitCode = 1;
} finally { transport?.close(); }
