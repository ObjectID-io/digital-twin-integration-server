import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {loadConfig} from '../dist/config/loader.js';
import {FileCredentialProvider} from '../dist/security/credentials.js';
import {IotaStatePublisher} from '../dist/objectid/iotaStatePublisher.js';
const config=await loadConfig();
const pkg='0x6b9c3016c5e57fea26681d6a60c8b341c3f54fd2432ef19030dc700cf43b1193';
assert.equal(config.objectid.network,'testnet');assert.equal(config.objectid.packageId,pkg);
const credentials=new FileCredentialProvider(config.security.credentialFile);
const publisher=new IotaStatePublisher(config.objectid,credentials);
// Reconcile the first synthetic probe, which authenticated with the owner's API
// token (caller headers cannot override that identity) and already cleared events.
const first='/data/fresh-testnet-smoke-20260908.json';
try {const prior=JSON.parse(await readFile(first,'utf8'));if(!prior.complete){await publisher.deleteTwin(prior.twinId);await writeFile(first,JSON.stringify({...prior,complete:true,reconciled:true}),{mode:0o600});}}catch(e){if(e.code!=='ENOENT')throw e;}
const stateFile='/data/fresh-testnet-smoke-v2-20260908.json';
let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(state?.complete){console.log(JSON.stringify(state));process.exit(0);}
if(!state){
 const result=await publisher.createTwin({name:'Fresh package lifecycle smoke 20260908',twinType:'machine',targetKind:'physical-asset',namespace:'objectid-test',immutableMetadata:{synthetic:true},mutableMetadata:{}});
 state={twinId:result.id,createDigest:result.digest};await writeFile(stateFile,JSON.stringify(state),{mode:0o600,flag:'wx'});
 await publisher.addAspect(state.twinId,{aspectCode:'operational',aspectType:'telemetry'});
 await publisher.publishState(state.twinId,{aspectCode:'operational',sampleType:'test',payloadInline:'{"temperature":21}'});
}
const token=await credentials.get('DTIS_PUBLIC_TENANT_API_KEY');
const owner='did:iota:testnet:0x285bf40af129fa7d8220e98c5258ce4f6169c749a50f58328b1b6ea682df0bd2';
async function request(path,headers={}){
 const response=await fetch('http://127.0.0.1:8080/api/v1/twins/'+state.twinId+path,{method:'DELETE',headers:{'x-api-key':token,'x-objectid-caller-did':owner,...headers}});
 const text=await response.text();let body;try{body=JSON.parse(text)}catch{body={};}return {status:response.status,body};
}
if(!state.eventsDeleted){
 assert.equal((await request('/events/'+('0x'+'a'.repeat(64)))).status,404);
 assert.equal((await request('/events')).status,422);
 assert.equal((await request('/events',{'x-objectid-confirm-delete-events':state.twinId,'x-api-key':'invalid-test-token'})).status,401);
 const blocked=await request('',{'x-objectid-confirm-delete':state.twinId});assert.equal(blocked.status,409,JSON.stringify(blocked));
 const cleared=await request('/events',{'x-objectid-confirm-delete-events':state.twinId});assert.equal(cleared.status,200,JSON.stringify(cleared));assert.equal(cleared.body.eventsDeleted,true);
 state.eventsDeleted=true;await writeFile(stateFile,JSON.stringify(state),{mode:0o600});
}
const removed=await request('',{'x-objectid-confirm-delete':state.twinId});assert.equal(removed.status,200,JSON.stringify(removed));assert.equal(removed.body.deleted,true);
const object=await publisher.client.getObject({id:state.twinId});assert.ok(object.error);
state.complete=true;state.deleteDigest=removed.body.digest;state.checks=['no single-event route','bulk confirmation required','unauthenticated request denied','root delete blocked before bulk','bulk events cleanup','other children cleanup and root deleted'];
await writeFile(stateFile,JSON.stringify(state,null,2),{mode:0o600});console.log(JSON.stringify(state,null,2));
