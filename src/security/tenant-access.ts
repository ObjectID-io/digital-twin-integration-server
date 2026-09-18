import express from "express";
import {randomBytes} from "node:crypto";
import {AppError} from "../common/errors.js";
import type {DeviceDidAuth} from "../devices/did-auth.js";
import type {TenantRegistry} from "./tenants.js";

// Native DID authentication is required; callers cannot choose an owner or tenant.
// Subscription issuance and commercial operations deliberately do not live here.
export function tenantAccessRoutes(auth:Pick<DeviceDidAuth,"context">,tenants:Pick<TenantRegistry,"credentialStatus"|"rotateExternalCredentials"|"revokeExternalCredentials">,subscriptionCurrent:(did:string)=>Promise<boolean>,options:{network:string;apiUrl:string;mqttUrl?:string}) {
 const router=express.Router(),busy=new Set<string>();
 router.use((q,r,n)=>{try{
   const context=auth.context(q);
   if(!context)throw new AppError("AUTHENTICATION_REQUIRED","Sign in with your DID",401,"AUTHORIZATION");
   r.locals.did=context.ownerDid;r.set("Cache-Control","no-store");n();
 }catch(e){n(e);}});
 router.get("/",async(_q,r)=>r.json(await tenants.credentialStatus(r.locals.did)));
 router.post("/:action",async(q,r)=>{
   const did:string=r.locals.did,action=String(q.params.action);
   if(!["rotate","revoke"].includes(action))throw new AppError("ACTION_NOT_FOUND","Unknown credential action",404,"VALIDATION");
   if(q.body?.confirm!==true)throw new AppError("CONFIRMATION_REQUIRED","Explicit confirmation required",422,"VALIDATION");
   if(busy.has(did))throw new AppError("TENANT_BUSY","Operation already in progress",409,"VALIDATION");
   busy.add(did);
   try {
     const current=await tenants.credentialStatus(did);
     if(!current.tenantId)throw new AppError("TENANT_NOT_FOUND","No tenant registered for this DID",404,"AUTHORIZATION");
     if(action==="revoke"){r.json(await tenants.revokeExternalCredentials(did,false));return;}
     if(!await subscriptionCurrent(did))throw new AppError("SUBSCRIPTION_INACTIVE","Manage your subscription in DT",402,"AUTHORIZATION");
     const apiKey=randomBytes(32).toString("base64url"),mqttPassword=randomBytes(32).toString("base64url");
     const username=current.mqttUsername||`oid_tenant_${options.network}_${current.tenantId.replace(/[^a-z0-9_-]/gi,"_")}`;
     const status=await tenants.rotateExternalCredentials(did,apiKey,username,mqttPassword,current.twinIds);
     r.json({specVersion:"objectid.tenant-access.v1",network:options.network,ownerDid:did,tenantId:status.tenantId,version:status.version,api:{endpoint:options.apiUrl,apiKey},mqtt:{endpoint:options.mqttUrl,username,password:mqttPassword}});
   }finally{busy.delete(did);}
 });
 return router;
}
