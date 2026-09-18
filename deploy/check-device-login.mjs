import {readFile} from 'node:fs/promises';
import YAML from 'yaml';
import {IotaClient} from '@iota/iota-sdk/client';
import {Ed25519Keypair} from '@iota/iota-sdk/keypairs/ed25519';
const config=YAML.parse(await readFile('/config/config.yaml','utf8'));
const credentials=JSON.parse(await readFile('/run/secrets/dtis_credentials','utf8'));
const signer=config.objectid.signer;
const client=new IotaClient({url:config.objectid.rpcUrl});
const cap=await client.getObject({id:credentials[signer.controllerCapCredential],options:{showContent:true}});
const id=cap.data?.content?.fields?.controller_of;
if(!/^0x[0-9a-f]{64}$/i.test(id || ''))throw Error('Controller unavailable');
const did=`did:iota:testnet:${id}`;
const key=Ed25519Keypair.deriveKeypairFromSeed(credentials[signer.seedCredential]);
const origin='https://dtis.objectid.io',base='http://127.0.0.1:8080';
async function post(path,body,cookie){const r=await fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});if(!r.ok)throw Error(`Check failed: ${path} HTTP ${r.status}`);return r;}
const c=await (await post('/api/device-auth/challenge',{did})).json();
const signature=(await key.signPersonalMessage(new TextEncoder().encode(c.message))).signature;
const login=await post('/api/device-auth/verify',{did,challengeId:c.challengeId,signature});
const cookie=login.headers.get('set-cookie').split(';')[0];
try {
 const r=await fetch(base+'/api/device-workbench/context',{headers:{Cookie:cookie}});
 const context=await r.json();
 if(r.status!==200 || context.ownerDid!==did || context.requesterDid!==did)throw Error('Context mismatch');
 console.log('Real on-chain DID proof and native cookie context: PASS');
} finally {await post('/api/device-auth/logout',{},cookie);}
console.log('Session logout: PASS. No Twin created, no chain transaction submitted.');
