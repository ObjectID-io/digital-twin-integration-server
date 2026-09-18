import {it,expect} from 'vitest';
import {validatePlantBindings} from '../../src/plants/association.js';
const owner='did:iota:testnet:0x'+'a'.repeat(64),id='0x'+'b'.repeat(64);
const credentials={get:async()=>JSON.stringify({industry:owner})};
const document={tree:{id:'factory',children:[{id:'machine'}]},twinIds:{machine:id}};
it('validates ownership, node existence, uniqueness and other operational bindings',async()=>{
  const plants:any[]=[];const service={list:async(scope:string)=>scope==='industry'?plants:[]};
  const validate=(doc:any=document,did=owner)=>validatePlantBindings(service as any,credentials,async()=>({fields:{owner_did:did}}),'industry',owner,'factory',doc);
  await expect(validate()).resolves.toBeUndefined();
  await expect(validate(document,'other')).rejects.toMatchObject({code:'PLANT_TWIN_OWNER_MISMATCH'});
  await expect(validate({...document,twinIds:{missing:id}})).rejects.toMatchObject({code:'PLANT_TWIN_BINDING_CONFLICT'});
  plants.push({id:'other',document:{ownerDid:owner,twinIds:{node:id}}});
  await expect(validate()).rejects.toMatchObject({code:'TWIN_ALREADY_ASSIGNED'});
});
