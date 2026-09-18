import { readFile } from 'node:fs/promises';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';
const secrets = JSON.parse(await readFile('/run/secrets/dtis_credentials','utf8'));
const did = 'did:iota:testnet:' + secrets.DTIS_TWIN_CONTROLLER_CAP_ID;
const base = 'https://twinscope-demo.objectid.io';
const challenge = await fetch(base+'/api/auth/challenge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({did})});
const c = await challenge.json();
if(!challenge.ok) throw new Error('Challenge HTTP '+challenge.status);
const key = Ed25519Keypair.deriveKeypairFromSeed(secrets.DTIS_IOTA_SEED.replace(/^0x/,''));
const {signature} = await key.signPersonalMessage(new TextEncoder().encode(c.message));
const verify = await fetch(base+'/api/auth/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({did,challengeId:c.challengeId,signature})});
const cookie = verify.headers.get('set-cookie')?.split(';')[0];
console.log(JSON.stringify({stage:'verify',status:verify.status,cookiePresent:Boolean(cookie)}));
if(cookie) {
  for(const route of ['/api/auth/session','/api/aaa/context','/api/my/twins']) {
    const r = await fetch(base+route,{headers:{cookie}});
    const value = await r.json();
    console.log(JSON.stringify({route,status:r.status,error:value.error,role:value.effectiveRole}));
  }
  await fetch(base+'/api/auth/logout',{method:'POST',headers:{cookie}});
}
