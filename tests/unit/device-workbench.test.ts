import { describe,it,expect,vi } from "vitest";
import { DeviceWorkbench, type DeviceContext } from "../../src/devices/service.js";
import { mqttMessageToDataset } from "../../src/twin/mqttMapping.js";
import { DatasetWindowAggregator } from "../../src/twin/datasetAggregator.js";
import { TwinRealtimeHub } from "../../src/realtime/hub.js";
import { positionFromPayload } from "../../src/realtime/position.js";
import { classifySignals, classifyPayload, discoverSignals, encodeDevicePayload, decodeDevicePayload } from "../../src/devices/schema.js";
const owner="did:iota:testnet:0x"+"a".repeat(64), twinId="0x"+"b".repeat(64);
const context:DeviceContext={ownerDid:owner,requesterDid:owner,tenantId:null,source:"dt"};
const sample={measurements:{temperature:{value:42,unit:"Cel"},speed:{value:12,unit:"rpm"}}};
const signals=[{key:"temperature",source:"/measurements/temperature/value",name:"Product temperature",unit:"Cel"}];
function fixture(verifyTwin?: (id:string,owner:string)=>Promise<boolean>, verifyStorageTwin?: (id:string,owner:string)=>Promise<boolean>) {
  const records=new Map<string,any>();
  const store={list:async(scope:string)=>[...records.values()].filter(r=>r.scope===scope),put:async(scope:string,id:string,input:any)=>{
    const old=records.get(id);if((old?.revision||0)!==input.revision)throw Error("conflict");
    const next={id,scope,...input,revision:input.revision+1};records.set(id,next);return next;
  }};
  const tenants={findByOwnerDid:async()=>({ownerDid:owner,tenantId:"tenant-a"}),get:async()=>({ownerDid:owner}),rotateBootstrapCredentials:vi.fn(),revokeTwinCredentials:vi.fn()};
  const create=vi.fn(async(_body:any,_context:any,prepare?:boolean)=>prepare?{}:{twinId,plantId:"personal"});
  const publish=vi.fn(async(_message:any)=>{});
  const service=new DeviceWorkbench(store as any,tenants as any,create,publish,{network:"testnet",apiUrl:"https://dtis.example",mqttUrl:"wss://dtis.example/mqtt",topicPrefix:"objectid/tenants",mqttEnabled:true,verifyTwin,verifyStorageTwin});
  return {service,records,create,publish,tenants};
}
describe("device-first onboarding",()=>{
  it.each([false,true])("preserves moving positions through device classification, encrypted=%s",async(encrypted)=>{
    const f=fixture(), password=encrypted?"device-secret":undefined;
    const config=await f.service.register(context,{name:"Mobile asset",encryptionPassword:password});
    await f.service.ingest("tenant-a",config.deviceId,encrypted?await encodeDevicePayload(sample,password!):sample,config.http.token);
    await f.service.classify(context,config.deviceId,{name:"Mobile asset",signals,password});
    const hub=new TwinRealtimeHub();
    for(let index=0;index<2;index++) {
      const raw={...sample,observedAt:`2026-09-11T09:20:0${index}Z`,position:{coordinates:[9.19+index*0.01,45.46,120],speed:{value:10,unit:"m/s"},heading:{value:index*90,unit:"deg"},accuracy:{value:4.5,unit:"m"},ignored:"not forwarded"}};
      const payload=encrypted?await encodeDevicePayload(raw,password!):raw;
      const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+2000*(index+1));
      try {await f.service.ingest("tenant-a",config.deviceId,payload,config.http.token);} finally {clock.mockRestore();}
      const message=f.publish.mock.calls[index]![0];
      if(encrypted) {
        expect(message.value.encrypted).toBe(true);
        expect(message.value.position).toBeUndefined();
      }
      const value=encrypted?await decodeDevicePayload(message.value,password!):message.value;
      expect(value.position.ignored).toBeUndefined();
      expect(value.measurements.temperature.value).toBe(42);
      const event=hub.publish({...message,value});
      expect(event.position).toEqual(positionFromPayload(raw,0));
      expect(event.position?.speedKph).toBe(36);
    }
    expect(hub.latest(twinId)?.position?.coordinates).toEqual([9.2,45.46,120]);
  });
  it("decrypts sharing sources internally only for their current owner and active device", async () => {
    let owned = true;
    const f = fixture(async () => owned), password = 'local-test-secret';
    const config = await f.service.register(context, { name: 'Shared encrypted source', encryptionPassword: password });
    const payload = await encodeDevicePayload(sample, password);
    await f.service.ingest('tenant-a', config.deviceId, payload, config.http.token);
    await f.service.classify(context, config.deviceId, { name: 'Encrypted', signals, password });
    expect(await f.service.decodeSharedPayload(owner, twinId, payload)).toEqual(sample);
    await expect(f.service.decodeSharedPayload('another-owner', twinId, payload)).rejects.toThrow('SHARED_SOURCE_DECRYPTION_UNAVAILABLE');
    owned = false;
    await expect(f.service.decodeSharedPayload(owner, twinId, payload)).rejects.toThrow('SHARED_SOURCE_DECRYPTION_UNAVAILABLE');
  });
  it("keeps encrypted sources bound to original storage after ownership transfer", async () => {
    let originalOwner = true, sameSubscription = true;
    const f = fixture(async () => originalOwner, async () => sameSubscription), password = 'transfer-test-secret';
    const config = await f.service.register(context, { name: 'Transferred source', encryptionPassword: password });
    const payload = await encodeDevicePayload(sample, password);
    await f.service.ingest('tenant-a', config.deviceId, payload, config.http.token);
    await f.service.classify(context, config.deviceId, { name: 'Encrypted', signals, password });
    originalOwner = false;
    expect(await f.service.decodeSharedPayload(owner, twinId, payload)).toEqual(sample);
    await expect(f.service.decodeSharedPayload('new-owner', twinId, payload)).rejects.toThrow('SHARED_SOURCE_DECRYPTION_UNAVAILABLE');
    sameSubscription = false;
    await expect(f.service.decodeSharedPayload(owner, twinId, payload)).rejects.toThrow('SHARED_SOURCE_DECRYPTION_UNAVAILABLE');
  });
  it("retains location aliases and rejects invalid structured positions",()=>{
    const raw={...sample,location:{latitude:45,longitude:9,heading:0}};
    expect(classifyPayload(raw,classifySignals(signals,raw)).position).toMatchObject({coordinates:[9,45],heading:{value:0,unit:"deg"}});
    expect(()=>classifyPayload({...sample,position:{coordinates:[9,91]}},classifySignals(signals,sample))).toThrow("Position latitude");
  });
  it.each([false,true])("archives classified device samples, encrypted=%s",async(encrypted)=>{
    const f=fixture(),password=encrypted?"device-secret":undefined;
    const config=await f.service.register(context,{name:"Archive",encryptionPassword:password});
    const payload=encrypted?await encodeDevicePayload(sample,password!):sample;
    await f.service.ingest("tenant-a",config.deviceId,payload,config.http.token);
    await f.service.classify(context,config.deviceId,{name:"Archive",signals,password});
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+2000);
    try {await f.service.ingest("tenant-a",config.deviceId,payload,config.http.token);} finally {clock.mockRestore();}
    const mapped=mqttMessageToDataset(f.publish.mock.calls[0]![0]);
    expect(mapped.metadata.datasetType).toBe("telemetry");
    expect(mapped.key).toContain(config.deviceId);
    const store=vi.fn(async()=>({uri:"memory://dataset",hash:"sha256:test"}));
    const aggregator=new DatasetWindowAggregator(300000,{type:"memory",store} as any,async()=>{});
    aggregator.ingest(mapped.key,mapped.value,mapped.metadata,mapped.observedAt,mapped.windowMs);
    await aggregator.close();
    expect(store).toHaveBeenCalledOnce();
    const archived=JSON.parse((store.mock.calls as any)[0][0].data.toString());
    expect(archived.twinId).toBe(twinId);
    const value=archived.samples[0].value;
    if(encrypted) expect(value.encrypted).toBe(true);
    expect(encrypted?await decodeDevicePayload(value,password!):value).toMatchObject({measurements:{temperature:{value:42}}});
  });
  it("lists personal classified Twins for the supervisor without granting device access to delegates",async()=>{
    const f=fixture(async()=>true),config=await f.service.register(context,{name:'Test 2'});
    await f.service.ingest('tenant-a',config.deviceId,sample,config.http.token);
    await f.service.classify(context,config.deviceId,{name:'Test 2',signals});
    const supervisor={...context,source:'twinscope' as const,tenantId:'industry',plantId:'factory',nodeId:'machine'};
    expect((await f.service.catalog(supervisor)).twins).toHaveLength(1);
    expect(await f.service.list(supervisor)).toHaveLength(0);
    expect((await f.service.catalog({...supervisor,requesterDid:'delegate'})).twins).toHaveLength(0);
    expect(JSON.stringify(await f.service.catalog(supervisor))).not.toContain(config.http.token);
  });
  it("supports legacy transport credentials and rejects stale saved versions",async()=>{
    const f=fixture(async()=>true);let version=1;
    Object.assign(f.tenants,{isDynamic:async()=>true,twinCredentialStatus:async()=>({mqttUsername:"legacy",tenantId:"tenant-a",subscriptionId:"sub",active:true,version}),rotateTwinCredentials:vi.fn(async()=>({version:++version}))});
    expect(await f.service.deviceCredentials(context,twinId,"status")).toMatchObject({associated:true,legacy:true,recoverable:false});
    await expect(f.service.deviceCredentials(context,twinId,"download")).rejects.toThrow("DEVICE_CREDENTIALS_NOT_RECOVERABLE");
    const config:any=await f.service.deviceCredentials(context,twinId,"rotate");expect(config.specVersion).toBe("objectid.device-provisioning.v1");
    expect(config.twin.id).toBe(twinId);expect(config.objectid.network).toBe("testnet");expect(config.mqtt.password).toBeTruthy();
    expect(await f.service.deviceCredentials(context,twinId,"download")).toEqual(config);
    version++;
    await expect(f.service.deviceCredentials(context,twinId,"download")).rejects.toThrow("DEVICE_CREDENTIALS_NOT_RECOVERABLE");
  });
  it("downloads without rotation, rotates with persisted recovery, and rejects old HTTP credentials",async()=>{
    const f=fixture(async()=>true),config=await f.service.register(context,{name:"Mixer"});
    await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);
    await f.service.classify(context,config.deviceId,{name:"Mixer",signals});
    const original:any=await f.service.deviceCredentials(context,twinId,"download");expect(original.http.token).toBe(config.http.token);
    expect(f.tenants.rotateBootstrapCredentials).toHaveBeenCalledTimes(1);
    const rotated:any=await f.service.deviceCredentials(context,twinId,"rotate");expect(rotated.http.token).not.toBe(config.http.token);
    expect(await f.service.deviceCredentials(context,twinId,"download")).toEqual(rotated);
    await expect(f.service.ingest("tenant-a",config.deviceId,sample,config.http.token)).rejects.toThrow("DEVICE_CREDENTIALS_INVALID");
    await f.service.ingest("tenant-a",config.deviceId,sample,rotated.http.token);
    expect(JSON.stringify(await f.service.list(context))).not.toContain(rotated.http.token);
  });
  it("denies credential retrieval after ownership changes",async()=>{
    const f=fixture(async()=>false);
    await expect(f.service.deviceCredentials(context,twinId,"status")).rejects.toThrow("DEVICE_TWIN_NO_LONGER_OWNED");
    await expect(f.service.deviceCredentials(context,twinId,"download")).rejects.toThrow("DEVICE_TWIN_NO_LONGER_OWNED");
  });
  it("fails closed when broker rotation fails",async()=>{
    const f=fixture(async()=>true),config=await f.service.register(context,{name:"Mixer"});
    await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);
    await f.service.classify(context,config.deviceId,{name:"Mixer",signals});
    f.tenants.rotateBootstrapCredentials.mockRejectedValueOnce(Error("broker unavailable"));
    await expect(f.service.deviceCredentials(context,twinId,"rotate")).rejects.toThrow("broker unavailable");
    await expect(f.service.deviceCredentials(context,twinId,"download")).rejects.toThrow("DEVICE_CREDENTIALS_NOT_RECOVERABLE");
    await expect(f.service.ingest("tenant-a",config.deviceId,sample,config.http.token)).rejects.toThrow("DEVICE_CREDENTIAL_ROTATION_PENDING");
  });
  it("does not export a Twin after its on-chain ownership changes or it is deleted",async()=>{
    let owned=true;
    const f=fixture(async()=>owned),config=await f.service.register(context,{name:"Mixer"});
    await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);
    await f.service.classify(context,config.deviceId,{name:"Mixer",signals});
    owned=false;
    await expect(f.service.export(context,config.deviceId)).rejects.toThrow("DEVICE_TWIN_NO_LONGER_OWNED");
  });
  it("discovers stable paths, validates keys and rejects unknown fields",()=>{
    expect(discoverSignals(sample)).toHaveLength(2);
    expect(classifyPayload(sample,classifySignals(signals,sample))).toEqual({measurements:{temperature:{value:42,unit:"Cel",label:"Product temperature"}}});
    expect(()=>classifySignals([...signals,...signals],sample)).toThrow("SIGNAL_INVALID");
    expect(()=>classifySignals([{...signals[0],source:"/missing"}],sample)).toThrow("SIGNAL_INVALID");
    expect(()=>classifySignals([{...signals[0],key:"__proto__"}],sample)).toThrow("SIGNAL_INVALID");
  });
  it("requires the correct password to inspect encrypted data",async()=>{
    const f=fixture(), config=await f.service.register(context,{name:"Mixer",encryptionPassword:"device-secret"});
    const encrypted=await encodeDevicePayload(sample,"device-secret");
    await expect(f.service.ingest("tenant-a",config.deviceId,sample,config.http.token)).rejects.toThrow("DEVICE_ENCRYPTION_REQUIRED");
    await f.service.ingest("tenant-a",config.deviceId,encrypted,config.http.token);
    await expect(f.service.inspect(context,config.deviceId,"wrong")).rejects.toThrow("DEVICE_DECRYPTION_FAILED");
    expect((await f.service.inspect(context,config.deviceId,"device-secret")).signals).toHaveLength(2);
    expect(await decodeDevicePayload(encrypted,"device-secret")).toEqual(sample);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("creates once, exports no secrets and routes future samples to the Twin",async()=>{
    const f=fixture(), config=await f.service.register(context,{name:"Mixer"});
    await expect(f.service.ingest("tenant-a",config.deviceId,sample,"wrong")).rejects.toThrow("DEVICE_CREDENTIALS_INVALID");
    await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);
    const result=await f.service.classify(context,config.deviceId,{name:"Mixer Twin",signals});
    expect(result.twins[0]?.twinId).toBe(twinId);
    expect(f.create.mock.calls.filter(c=>!c[2])).toHaveLength(1);
    await f.service.classify(context,config.deviceId,{name:"Again",signals});
    expect(f.create.mock.calls.filter(c=>!c[2])).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/password|token|seed|apiKey/i);
    const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+2000);
    try {await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);} finally {clock.mockRestore();}
    expect(f.publish.mock.calls[0]?.[0]).toMatchObject({mapping:{twinId,mode:"dataset"},value:{measurements:{temperature:{value:42}}}});
  });
  it("isolates owner and plant scope; revocation blocks HTTP and MQTT",async()=>{
    const f=fixture(), config=await f.service.register(context,{name:"Mixer"});
    await expect(f.service.inspect({...context,ownerDid:"other",requesterDid:"other"},config.deviceId)).rejects.toThrow("DEVICE_NOT_FOUND");
    expect(await f.service.list({...context,source:"twinscope",plantId:"other",tenantId:"tenant-a"})).toEqual([]);
    await f.service.revoke(context,config.deviceId);
    await expect(f.service.ingest("tenant-a",config.deviceId,sample,config.http.token)).rejects.toThrow("DEVICE_REVOKED");
    await expect(f.service.ingest("tenant-a",config.deviceId,sample,undefined,true)).rejects.toThrow("DEVICE_REVOKED");
    expect(f.tenants.revokeTwinCredentials).toHaveBeenCalledWith(owner,config.deviceId);
  });
  it("does not lock the device on failed subscription preflight",async()=>{
    const f=fixture(), config=await f.service.register(context,{name:"Mixer"});
    await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);
    f.create.mockRejectedValueOnce(Error("SUBSCRIPTION_REQUIRED"));
    await expect(f.service.classify(context,config.deviceId,{name:"Mixer",signals})).rejects.toThrow("SUBSCRIPTION_REQUIRED");
    expect(f.records.get(config.deviceId).document.state).toBe("waiting");
  });
  it("never retries an ambiguous on-chain attempt automatically",async()=>{
    const f=fixture(), config=await f.service.register(context,{name:"Mixer"});
    await f.service.ingest("tenant-a",config.deviceId,sample,config.http.token);
    f.create.mockImplementation(async(_b,_c,prepare)=>{if(prepare)return {};throw Error("timeout");});
    await expect(f.service.classify(context,config.deviceId,{name:"Mixer",signals})).rejects.toThrow("RECONCILIATION_REQUIRED");
    await expect(f.service.classify(context,config.deviceId,{name:"Mixer",signals})).rejects.toThrow("RECONCILIATION_REQUIRED");
    expect(f.create.mock.calls.filter(c=>!c[2])).toHaveLength(1);
  });
});
