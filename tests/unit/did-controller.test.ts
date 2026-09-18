import { describe, expect, it, vi } from 'vitest';
import { ownsIdentityController, IOTA_IDENTITY_ORIGINS } from '../../src/security/did-controller.js';
const legacy='0x'+'f'.repeat(64), controller='0x'+'a'.repeat(64), cap='0x'+'c'.repeat(64), address='0x'+'1'.repeat(64);
function fixture(network: string, native = true) {
  const did=`did:iota:${network==='mainnet'?'':network+':'}${controller}`, origin=IOTA_IDENTITY_ORIGINS[network];
  const object:any={data:{objectId:cap,type:native?`${origin}::controller::ControllerCap`:`${legacy}::oid_identity::ControllerCap`,owner:{AddressOwner:address},content:{dataType:'moveObject',fields:{controller_of:controller}}}};
  const identity:any={data:{type:`${origin}::identity::Identity`,content:{dataType:'moveObject',fields:{deleted:false,deleted_did:false,did_doc:{fields:{controllers:{fields:{contents:[{fields:{key:cap,value:'1'}}]}}}}}}}};
  const client:any={getOwnedObjects:vi.fn(async()=>({data:[object],hasNextPage:false})),getObject:vi.fn(async()=>identity)};
  return {did,object,identity,client,verify:()=>ownsIdentityController(client,network,legacy,did,address)};
}
describe.each(['testnet','mainnet'])('controller verification on %s', network=>{
  it('accepts native IOTA Identity and configured ObjectID controllers',async()=>{
    const native=fixture(network);expect(await native.verify()).toBe(true);
    expect(native.client.getObject).toHaveBeenCalledWith({id:controller,options:{showType:true,showContent:true}});
    const original=fixture(network,false);expect(await original.verify()).toBe(true);expect(original.client.getObject).not.toHaveBeenCalled();
  });
  it('rejects lookalike packages and controllers from another network or address',async()=>{
    const f=fixture(network);f.object.data.type='0x'+'e'.repeat(64)+'::controller::ControllerCap';expect(await f.verify()).toBe(false);
    const other=fixture(network);other.object.data.type=`${IOTA_IDENTITY_ORIGINS[network==='mainnet'?'testnet':'mainnet']}::controller::ControllerCap`;expect(await other.verify()).toBe(false);
    const owner=fixture(network);owner.object.data.owner.AddressOwner='0x'+'2'.repeat(64);expect(await owner.verify()).toBe(false);
    const differentDid=fixture(network);differentDid.object.data.content.fields.controller_of='0x'+'b'.repeat(64);expect(await differentDid.verify()).toBe(false);
  });
  it('rejects deleted identities, removed controllers and zero controller weight',async()=>{
    for(const key of ['deleted','deleted_did']){const f=fixture(network);f.identity.data.content.fields[key]=true;expect(await f.verify()).toBe(false);}
    const removed=fixture(network);removed.identity.data.content.fields.did_doc.fields.controllers.fields.contents=[];expect(await removed.verify()).toBe(false);
    const zero=fixture(network);zero.identity.data.content.fields.did_doc.fields.controllers.fields.contents[0].fields.value='0';expect(await zero.verify()).toBe(false);
  });
  it('checks subsequent owned-object pages',async()=>{
    const f=fixture(network);f.client.getOwnedObjects.mockResolvedValueOnce({data:[],hasNextPage:true,nextCursor:'next'});
    expect(await f.verify()).toBe(true);expect(f.client.getOwnedObjects.mock.calls[1][0].cursor).toBe('next');
  });
});
