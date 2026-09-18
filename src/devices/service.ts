import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PlantService } from "../plants/service.js";
import type { CreationContext } from "../plants/twin-creation.js";
import type { TenantRegistry } from "../security/tenants.js";
import { classifyPayload, classifySignals, decodeDevicePayload, deviceError, discoverSignals, encodeDevicePayload } from "./schema.js";
export type DeviceContext = Omit<CreationContext, "plantId"> & { plantId?: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scope = (owner: string) => "devices:" + owner;
export class DeviceWorkbench {
  private samples = new Map<string,{ value: any; receivedAt: number; sampleId: string }>();
  private busy = new Set<string>();
  constructor(private readonly store: PlantService, private readonly tenants: TenantRegistry,
    private readonly createTwin: (body: any, context: DeviceContext, prepareOnly?: boolean) => Promise<any>,
    private readonly publish: (message: any) => Promise<void>,
    private readonly options: { network:string; apiUrl:string; mqttUrl:string; topicPrefix:string; mqttEnabled:boolean; verifyTwin?: (id:string,ownerDid:string)=>Promise<boolean>; verifyStorageTwin?: (id:string,storageOwner:string)=>Promise<boolean>; membership?: (id:string,ownerDid:string)=>Promise<any> }) {}
  async catalog(context: DeviceContext) {
    // Broadening is read-only and only for the owner, never a delegated operator.
    const reader = context.requesterDid === context.ownerDid ? {...context,source:"dt" as const} : context;
    const devices = await this.list(reader);
    const twins = [];
    for (const device of devices.filter(d=>d.state==="created")) {
      try {
        const exported = await this.export(reader,device.id);
        twins.push(...exported.twins);
      } catch(error:any) { if(error.code!=="DEVICE_TWIN_NO_LONGER_OWNED") throw error; }
    }
    return {network:this.options.network,twins};
  }
  private allowed(document: any, context: DeviceContext) {
    if (context.source === "twinscope" && (document.context.plantId !== context.plantId || document.context.tenantId !== context.tenantId)) return false;
    return document.ownerDid === context.ownerDid && (context.requesterDid === context.ownerDid ||
      (document.context.requesterDid === context.requesterDid && document.context.plantId === context.plantId && document.context.nodeId === context.nodeId));
  }
  async list(context: DeviceContext) {
    return (await this.store.list(scope(context.ownerDid))).filter(item => this.allowed(item.document,context)).map(item => {
      const d:any = item.document, sample = this.latest(item.id);
      return { id:item.id, name:d.name, state:d.state, twinId:d.twinId, network:this.options.network,
        receivedAt:sample?.receivedAt ?? null, encrypted:sample?.value?.encrypted === true,
        signals:d.signals || [], revokedAt:d.revokedAt, plantId:d.plantId || d.context.plantId, tenantId:d.context.tenantId };
    });
  }
  private latest(id:string) {
    const sample = this.samples.get(id);
    if (sample && Date.now()-sample.receivedAt > 15*60_000) { this.samples.delete(id); return undefined; }
    return sample;
  }
  private async record(context: DeviceContext,id:string) {
    const found = (await this.store.list(scope(context.ownerDid))).find(item => item.id===id);
    if (!found || !this.allowed(found.document,context)) return deviceError("DEVICE_NOT_FOUND",404);
    return found;
  }
  async register(context: DeviceContext,input:any) {
    if (!this.options.apiUrl || (this.options.mqttEnabled && !this.options.mqttUrl)) return deviceError("DEVICE_PUBLIC_ENDPOINT_NOT_CONFIGURED",503);
    if (typeof input?.name !== "string" || !input.name.trim() || input.name.length>128 ||
        (input.encryptionPassword !== undefined && (typeof input.encryptionPassword !== "string" || input.encryptionPassword.length>1024))) return deviceError("DEVICE_INPUT_INVALID");
    const accounting = await this.tenants.findByOwnerDid(context.ownerDid);
    if (!accounting) return deviceError("DEVICE_SUBSCRIPTION_ACCOUNT_REQUIRED",402);
    if ((await this.list({...context, requesterDid:context.ownerDid})).length>=64) return deviceError("DEVICE_LIMIT",409);
    const id="device-"+randomUUID(), password=randomBytes(32).toString("base64url"), httpToken=randomBytes(32).toString("base64url");
    const username="oid_bootstrap_"+this.options.network+"_"+id.slice(7);
    const root=this.options.topicPrefix+"/"+accounting.tenantId+"/devices/"+id;
    await this.store.put(scope(context.ownerDid),id,{revision:0,publication:null,document:{
      ownerDid:context.ownerDid, context, name:input.name.trim(), state:"waiting", tokenHash:digest(httpToken),
      encryptionRequired:Boolean(input.encryptionPassword), createdAt:new Date().toISOString(), tenantId:accounting.tenantId,
    }});
    if(this.options.mqttEnabled) await this.tenants.rotateBootstrapCredentials(context.ownerDid,id,username,password);
    const configuration={ specVersion:"objectid.device-onboarding.v1", network:this.options.network, deviceId:id, name:input.name.trim(),
      tenantId:accounting.tenantId, http:{ endpoint:this.options.apiUrl+"/device-input/"+accounting.tenantId+"/"+id, token:httpToken },
      ...(this.options.mqttEnabled?{mqtt:{endpoint:this.options.mqttUrl,username,password,topics:{telemetry:root+"/telemetry"}}}:{}),
      encryption:input.encryptionPassword?{algorithm:"AES-256-GCM",kdf:"scrypt",password:input.encryptionPassword}:null };
    const saved=await this.record(context,id);
    await this.store.put(scope(context.ownerDid),id,{revision:saved.revision,publication:null,document:{...saved.document,deviceConfiguration:configuration}});
    return configuration;
  }
  async ingest(tenantId:string,id:string,payload:any,token?:string,mqtt=false) {
    if (!/^device-[a-f0-9-]{36}$/.test(id)) return deviceError("DEVICE_NOT_FOUND",404);
    const accounting=await this.tenants.get(tenantId);
    const context:DeviceContext={ownerDid:accounting.ownerDid,requesterDid:accounting.ownerDid,tenantId:null,source:"dt"};
    const record=await this.record(context,id), d:any=record.document;
    if(d.credentialRotationPending)return deviceError("DEVICE_CREDENTIAL_ROTATION_PENDING",409);
    if(d.tenantId!==tenantId) return deviceError("DEVICE_NOT_FOUND",404);
    if(d.revokedAt) return deviceError("DEVICE_REVOKED",403);
    if(!mqtt && (!token || !timingSafeEqual(Buffer.from(d.tokenHash,"hex"),Buffer.from(digest(token),"hex")))) return deviceError("DEVICE_CREDENTIALS_INVALID",401);
    if (Buffer.byteLength(JSON.stringify(payload) || "")>65536) return deviceError("DEVICE_SAMPLE_TOO_LARGE",413);
    if(d.encryptionRequired && payload?.encrypted!==true) return deviceError("DEVICE_ENCRYPTION_REQUIRED",403);
    const previous=this.samples.get(id);
    if(previous && Date.now()-previous.receivedAt<1000) return; // Bounded acquisition: one latest sample per second.
    if(this.samples.size>=256&&!this.samples.has(id)) this.samples.delete(this.samples.keys().next().value!);
    this.samples.set(id,{value:payload,receivedAt:Date.now(),sampleId:randomUUID()});
    if(d.state==="created"&&d.twinId) {
      const decoded=await decodeDevicePayload(payload,d.payloadPassword);
      const telemetry=classifyPayload(decoded,d.signals);
      const classified={...telemetry,schema:"objectid.telemetry.classified.v1",assetId:d.twinId,observedAt:new Date(telemetry.position?.observedAt ?? Date.now()).toISOString()};
      const value=d.payloadPassword?await encodeDevicePayload(classified,d.payloadPassword):classified;
      const topic=this.options.topicPrefix+"/"+tenantId+"/devices/"+id+"/telemetry";
      await this.publish({mapping:{tenantId,twinId:d.twinId,mode:"dataset",datasetType:"telemetry",topic},topic,value,observedAt:Date.now()});
    }
  }
  // Internal only: called after a current DID policy check, never returns a password.
  async decodeSharedPayload(ownerDid: string, twinId: string, payload: any) {
    if (payload?.encrypted !== true) return payload;
    const records = await this.store.list(scope(ownerDid));
    const found = records.find(item => item.document.ownerDid === ownerDid && item.document.twinId === twinId && item.document.state === 'created' && !item.document.revokedAt);
    const password = found?.document.payloadPassword;
    if (typeof password !== 'string' || !password || ((this.options.verifyStorageTwin || this.options.verifyTwin) && !await (this.options.verifyStorageTwin || this.options.verifyTwin)!(twinId, ownerDid))) return deviceError('SHARED_SOURCE_DECRYPTION_UNAVAILABLE', 409);
    return decodeDevicePayload(payload, password);
  }
  async inspect(context:DeviceContext,id:string,password?:string) {
    await this.record(context,id);
    const sample=this.latest(id); if(!sample) return deviceError("DEVICE_WAITING_FOR_DATA",409);
    const payload=await decodeDevicePayload(sample.value,password);
    return { sampleId:sample.sampleId, receivedAt:sample.receivedAt, signals:discoverSignals(payload) };
  }
  async revoke(context:DeviceContext,id:string) {
    if(this.busy.has(id)) return deviceError("DEVICE_BUSY",409);
    this.busy.add(id);
    try {
      const record=await this.record(context,id);
      const document={...record.document,revokedAt:new Date().toISOString()};
      await this.store.put(scope(context.ownerDid),id,{revision:record.revision,publication:null,document});
      this.samples.delete(id);
      if(this.options.mqttEnabled) await this.tenants.revokeTwinCredentials(context.ownerDid,id);
      return {revoked:true};
    } finally {this.busy.delete(id);}
  }
  async classify(context:DeviceContext,id:string,input:any) {
    if(this.busy.has(id)) return deviceError("DEVICE_BUSY",409);
    this.busy.add(id);
    try {
      const record=await this.record(context,id), d:any=record.document;
      if(d.revokedAt) return deviceError("DEVICE_REVOKED",403);
      if(d.state==="created") return this.export(context,id);
      if(d.state==="creating" || d.state==="uncertain") return deviceError("DEVICE_CREATION_RECONCILIATION_REQUIRED",409);
      const sample=this.latest(id);
      if(!sample) return deviceError("DEVICE_WAITING_FOR_DATA",409);
      // A recent sample is always decoded again; having a schema is not proof of decryption.
      const payload=await decodeDevicePayload(sample.value,input?.password);
      const signals=classifySignals(input?.signals,payload);
      const creationContext:DeviceContext = {...d.context,requesterDid:context.requesterDid};
      if(typeof input?.name!=="string"||!input.name.trim()||input.name.length>128) return deviceError("TWIN_NAME_REQUIRED");
      const creationBody = { name:input.name.trim(), namespace:creationContext.source==="twinscope"?"objectid.twinscope":"objectid", twinType:"device", targetKind:"physical-asset",
        lifecycleState:1, fidelityLevel:1, maturityLevel:1, plantId:creationContext.plantId,nodeId:creationContext.nodeId,
        visibility:"private",dataVisibility:"private",
        mutableMetadata:JSON.stringify({objectid:{deviceId:id,signalSchema:{version:1,signals}}}) };
      // Validate subscription and ownership before marking an attempt as potentially on-chain.
      await this.createTwin(creationBody,creationContext,true);
      const pending:any={...d,state:"creating",signals,payloadPassword:sample.value?.encrypted?input.password:undefined};
      const saved=await this.store.put(scope(context.ownerDid),id,{revision:record.revision,publication:null,document:pending});
      try {
        const created=await this.createTwin(creationBody,creationContext);
        const twinId=created.twinId||created.id;
        if(!/^0x[0-9a-f]{64}$/i.test(twinId)) throw Error("Invalid Twin receipt");
        await this.store.put(scope(context.ownerDid),id,{revision:saved.revision,publication:null,
          document:{...pending,state:"created",twinId,plantId:created.plantId,name:input.name.trim()}});
        return this.export(context,id);
      } catch { return deviceError("DEVICE_CREATION_RECONCILIATION_REQUIRED",409); }
    } finally {this.busy.delete(id);}
  }
  async export(context:DeviceContext,id:string) {
    const record=await this.record(context,id), d:any=record.document;
    if(d.state!=="created") return deviceError("DEVICE_TWIN_NOT_CREATED",409);
    if(this.options.verifyTwin && !await this.options.verifyTwin(d.twinId,d.ownerDid)) return deviceError("DEVICE_TWIN_NO_LONGER_OWNED",404);
    const membership = await this.options.membership?.(d.twinId,d.ownerDid);
    return {specVersion:"objectid.twin-catalog.v1",network:this.options.network,integrationServer:this.options.apiUrl,
      twins:[{twinId:d.twinId,deviceId:id,name:d.name,ownerDid:d.ownerDid,plantId:membership?.plantId ?? d.plantId,tenantId:membership ? membership.tenantId : d.context.tenantId,plantName:membership?.name,nodeId:membership?.nodeId,signals:d.signals,schemaVersion:1}]};
  }
  async deviceCredentials(context:DeviceContext,twinId:string,action:"status"|"download"|"rotate", storageAuthority = false) {
    const verify = storageAuthority ? this.options.verifyStorageTwin : this.options.verifyTwin;
    if(!verify || !await verify(twinId,context.ownerDid))return deviceError("DEVICE_TWIN_NO_LONGER_OWNED",403);
    const matches=(await this.list(context)).filter(d=>d.twinId===twinId);
    if(!matches.length)return this.legacyCredentials(context,twinId,action);
    if(matches.length!==1)return deviceError("MULTIPLE_DEVICES_REQUIRE_SELECTION",409);
    const id=matches[0]!.id;
    if(this.busy.has(id))return deviceError("DEVICE_BUSY",409);
    this.busy.add(id);
    try {
      const record=await this.record(context,id),d:any=record.document;
      const recoverable=Boolean(d.deviceConfiguration&&!d.revokedAt&&!d.credentialRotationPending);
      if(action==="status")return {associated:true,deviceId:id,recoverable,revoked:Boolean(d.revokedAt),rotationPending:Boolean(d.credentialRotationPending)};
      if(action==="download"){if(!recoverable)return deviceError("DEVICE_CREDENTIALS_NOT_RECOVERABLE",409);return d.deviceConfiguration;}
      const encryptionPassword=d.payloadPassword || d.deviceConfiguration?.encryption?.password;
      if(d.encryptionRequired&&!encryptionPassword)return deviceError("DEVICE_ENCRYPTION_PASSWORD_UNAVAILABLE",409);
      const password=randomBytes(32).toString("base64url"),httpToken=randomBytes(32).toString("base64url"),username="oid_bootstrap_"+this.options.network+"_"+id.slice(7);
      const root=this.options.topicPrefix+"/"+d.tenantId+"/devices/"+id;
      const configuration={specVersion:"objectid.device-onboarding.v1",network:this.options.network,deviceId:id,name:d.name,tenantId:d.tenantId,
        http:{endpoint:this.options.apiUrl+"/device-input/"+d.tenantId+"/"+id,token:httpToken},
        ...(this.options.mqttEnabled?{mqtt:{endpoint:this.options.mqttUrl,username,password,topics:{telemetry:root+"/telemetry"}}}:{}),
        encryption:encryptionPassword?{algorithm:"AES-256-GCM",kdf:"scrypt",password:encryptionPassword}:null};
      // Persist encrypted first, fail closed until broker rotation and final save succeed.
      const pending=await this.store.put(scope(context.ownerDid),id,{revision:record.revision,publication:null,document:{...d,credentialRotationPending:true,deviceConfiguration:configuration,tokenHash:digest(httpToken)}});
      if(this.options.mqttEnabled)await this.tenants.rotateBootstrapCredentials(context.ownerDid,id,username,password);
      await this.store.put(scope(context.ownerDid),id,{revision:pending.revision,publication:null,document:{...pending.document,credentialRotationPending:false,revokedAt:undefined}});
      this.samples.delete(id);return configuration;
    } finally {this.busy.delete(id);}
  }
  private async legacyCredentials(context:DeviceContext,twinId:string,action:"status"|"download"|"rotate") {
    if(this.busy.has(twinId))return deviceError("DEVICE_BUSY",409);
    this.busy.add(twinId);
    try {
      if(!await this.tenants.isDynamic(context.ownerDid))return action==="status"?{associated:false}:deviceError("DEVICE_NOT_ASSOCIATED",404);
      const status=await this.tenants.twinCredentialStatus(context.ownerDid,twinId);
      if(!status.mqttUsername)return action==="status"?{associated:false}:deviceError("DEVICE_NOT_ASSOCIATED",404);
      const storageScope="device-exports:"+context.ownerDid,record=(await this.store.list(storageScope)).find(r=>r.id===twinId);
      const saved:any=record?.document, recoverable=Boolean(status.active&&saved?.version===status.version&&saved?.configuration);
      if(action==="status")return {associated:true,legacy:true,recoverable,revoked:!status.active};
      if(action==="download"){if(!recoverable)return deviceError("DEVICE_CREDENTIALS_NOT_RECOVERABLE",409);return saved.configuration;}
      const password=randomBytes(32).toString("base64url"),updated=await this.tenants.rotateTwinCredentials(context.ownerDid,twinId,status.mqttUsername,password);
      const root=this.options.topicPrefix+"/"+status.tenantId+"/twins/"+twinId;
      const commandPrefix=this.options.topicPrefix.replace(/\/tenants$/,"");
      const configuration={specVersion:"objectid.device-provisioning.v1",network:this.options.network,twinId,tenantId:status.tenantId,subscriptionId:status.subscriptionId,active:true,version:updated.version,
        objectid:{network:this.options.network,tenantId:status.tenantId,subscriptionId:status.subscriptionId},twin:{id:twinId},mqtt:{endpoint:this.options.mqttUrl,username:status.mqttUsername,password,topics:{state:root+"/telemetry/state",dataset:root+"/telemetry/dataset",commandRequests:commandPrefix+"/twins/"+twinId+"/commands/request",commandResults:commandPrefix+"/twins/"+twinId+"/commands/+/result"}}};
      await this.store.put(storageScope,twinId,{revision:record?.revision||0,publication:null,document:{version:updated.version,configuration}});
      return configuration;
    } finally {this.busy.delete(twinId);}
  }
}
