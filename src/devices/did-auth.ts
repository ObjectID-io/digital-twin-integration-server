import {createHash,randomBytes,randomUUID} from "node:crypto";
import express, {type Request} from "express";
import {IotaClient,getFullnodeUrl} from "@iota/iota-sdk/client";
import {verifyPersonalMessageSignature} from "@iota/iota-sdk/verify";
import {AppError} from "../common/errors.js";
import {requiredCredential,type CredentialProvider} from "../security/credentials.js";
import type {TenantRegistry} from "../security/tenants.js";
import type {DeviceContext} from "./service.js";

const fail=(code:string,status=401):never=>{throw new AppError(code,code,status,"AUTHORIZATION");};
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
type Session={did:string;address:string;expiresAt:number};
export class DeviceDidAuth {
  private challenges=new Map<string,{did:string;message:string;expiresAt:number}>();
  private sessions=new Map<string,Session>();
  readonly cookieName:string;
  readonly origin:string;
  readonly cookiePath:string;
  private client:IotaClient;
  constructor(readonly network:string,readonly publicUrl:string,private credentials:CredentialProvider,
    rpcUrl:string, private verifyController?: (did:string,address:string)=>Promise<boolean>,private now=()=>Date.now()) {
    this.client=new IotaClient({url:rpcUrl || getFullnodeUrl(network as "testnet"|"mainnet")});
    const url=publicUrl?new URL(publicUrl):null;
    this.origin=url?.origin || "";this.cookiePath=(url?.pathname.replace(/\/$/,"") || "")+"/";
    this.cookieName="__Secure-oid_dtis_"+network;
  }
  async configured() {return Boolean(this.origin && /^0x[0-9a-f]{64}$/i.test(await this.credentials.get("DTIS_IDENTITY_PACKAGE_ID") || ""));}
  private normalize(value:unknown) {
    const did=String(value || "").trim(),prefix=this.network==="mainnet"?"did:iota:":`did:iota:${this.network}:`;
    if(!did.startsWith(prefix) || !/^0x[0-9a-f]{64}$/i.test(did.slice(prefix.length)))return fail("DID_NETWORK_INVALID");
    return did;
  }
  private prune() {
    for(const [id,value] of this.challenges)if(value.expiresAt<=this.now())this.challenges.delete(id);
    for(const [id,value] of this.sessions)if(value.expiresAt<=this.now())this.sessions.delete(id);
  }
  async challenge(value:unknown) {
    if(!await this.configured())return fail("DID_LOGIN_NOT_CONFIGURED",503);
    this.prune();if(this.challenges.size>=1000)return fail("DID_CHALLENGE_CAPACITY",429);
    const did=this.normalize(value),challengeId=randomUUID(),expiresAt=this.now()+300_000;
    const message=["ObjectID Integration Server Login",`Audience: ${this.publicUrl}`,`Network: ${this.network}`,`DID: ${did}`,
      `Nonce: ${randomBytes(24).toString("base64url")}`,`Issued At: ${new Date(this.now()).toISOString()}`,`Expires At: ${new Date(expiresAt).toISOString()}`].join("\n");
    this.challenges.set(challengeId,{did,message,expiresAt});return {challengeId,message,expiresAt};
  }
  async verify(input:any) {
    const did=this.normalize(input?.did),id=String(input?.challengeId || ""),challenge=this.challenges.get(id);
    this.challenges.delete(id);
    if(!challenge || challenge.did!==did || challenge.expiresAt<=this.now())return fail("DID_CHALLENGE_INVALID");
    if(typeof input.signature!=="string" || input.signature.length>2048)return fail("DID_SIGNATURE_INVALID");
    let address:string;
    try {address=(await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.message),input.signature)).toIotaAddress();}
    catch {return fail("DID_SIGNATURE_INVALID");}
    if(!await (this.verifyController?this.verifyController(did,address):this.ownsController(did,address)))return fail("DID_CONTROLLER_NOT_OWNED",403);
    this.prune();if(this.sessions.size>=1000)return fail("DID_SESSION_CAPACITY",429);
    const token=randomBytes(32).toString("base64url"),session={did,address,expiresAt:this.now()+1800_000};
    this.sessions.set(hash(token),session);return {token,session};
  }
  private async ownsController(did:string,address:string) {
    const pkg=await requiredCredential(this.credentials,"DTIS_IDENTITY_PACKAGE_ID");
    if(!/^0x[0-9a-f]{64}$/i.test(pkg))return fail("DID_LOGIN_NOT_CONFIGURED",503);
    // Pin the identity package: an unrelated Move package may define an identically named cap.
    const type=`${pkg}::oid_identity::ControllerCap`,controller=did.split(":").at(-1)!.toLowerCase();
    let cursor:string|null|undefined;
    for(let pageNumber=0;pageNumber<20;pageNumber++) {
      const page=await this.client.getOwnedObjects({owner:address,cursor,limit:50,filter:{StructType:type},options:{showContent:true,showType:true}});
      if(page.data.some(item=>item.data?.type===type && item.data.content?.dataType==="moveObject" && !Array.isArray(item.data.content.fields) && String((item.data.content.fields as Record<string,unknown>).controller_of).toLowerCase()===controller))return true;
      if(!page.hasNextPage)return false;cursor=page.nextCursor;
    }
    return false;
  }
  private token(request:Request) {return request.headers.cookie?.split(";").map(x=>x.trim()).find(x=>x.startsWith(this.cookieName+"="))?.slice(this.cookieName.length+1) || "";}
  session(request:Request) {this.prune();return this.sessions.get(hash(this.token(request))) || null;}
  assertOrigin(request:Request) {if(!this.origin || request.header("origin")!==this.origin)return fail("DID_ORIGIN_DENIED",403);}
  context(request:Request):DeviceContext|null {
    const session=this.session(request);if(!session)return null;
    if(!["GET","HEAD"].includes(request.method))this.assertOrigin(request);
    return {ownerDid:session.did,requesterDid:session.did,tenantId:null,source:"dt"};
  }
  cookie(token:string,age=1800) {return `${this.cookieName}=${token}; Path=${this.cookiePath}; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;}
  logout(request:Request) {this.sessions.delete(hash(this.token(request)));}
}
export function deviceDidRoutes(auth:DeviceDidAuth,tenants:TenantRegistry) {
  const router=express.Router();
  router.use((_q,r,n)=>{r.set("Cache-Control","no-store");n();});
  router.get("/session",async(q,r)=>{
    const session=auth.session(q),account=session?await tenants.findByOwnerDid(session.did):null;
    r.json({available:await auth.configured(),network:auth.network,session,subscriptionConfigured:Boolean(account),subscriptionUrl:auth.network==="mainnet"?"https://dt.objectid.io/":"https://dt-demo.objectid.io/"});
  });
  router.post("/challenge",async(q,r)=>{auth.assertOrigin(q);r.json(await auth.challenge(q.body?.did));});
  router.post("/verify",async(q,r)=>{auth.assertOrigin(q);const result=await auth.verify(q.body);r.setHeader("Set-Cookie",auth.cookie(result.token));r.json(result.session);});
  router.post("/logout",(q,r)=>{auth.assertOrigin(q);auth.logout(q);r.setHeader("Set-Cookie",auth.cookie("",0));r.status(204).end();});
  return router;
}
