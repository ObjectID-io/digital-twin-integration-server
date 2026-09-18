import express from "express";
import {AppError} from "../common/errors.js";
import type {DeviceDidAuth} from "./did-auth.js";

// Native DID sessions only: imported, delegated workbench tokens cannot broaden
// their plant scope by entering the personal management API.
export function myTwinRoutes(auth:DeviceDidAuth, operations:{
 list:(did:string)=>Promise<unknown>;
 edit:(did:string,id:string,input:any)=>Promise<unknown>;
 remove:(did:string,id:string)=>Promise<unknown>;
 credentials?:(did:string,id:string,action:"status"|"download"|"rotate")=>Promise<unknown>;
 exportConfig?:(did:string,id:string)=>Promise<unknown>;
}) {
 const router=express.Router();
 router.use((q,r,n)=>{try{const context=auth.context(q);if(!context)throw new AppError("AUTHENTICATION_REQUIRED","Sign in with your DID",401,"AUTHORIZATION");r.locals.did=context.ownerDid;r.set("Cache-Control","no-store");n();}catch(e){n(e);}});
 router.get("/",async(_q,r)=>{r.json({twins:await operations.list(r.locals.did)});});
 router.get("/:id/export",async(q,r)=>{
  const id=String(q.params.id);
  if(!/^0x[0-9a-f]{64}$/i.test(id))throw new AppError("INVALID_TWIN_ID","Invalid Twin ID",422,"VALIDATION");
  if(!operations.exportConfig)throw new AppError("TWIN_EXPORT_UNAVAILABLE","Configuration export unavailable",404,"VALIDATION");
  r.json(await operations.exportConfig(r.locals.did,id));
 });
 router.all("/:id/credentials",async(q,r)=>{
  const id=String(q.params.id),action=q.method==="GET"?"status":q.body?.action;
  if(!/^0x[0-9a-f]{64}$/i.test(id)||!["GET","POST"].includes(q.method)||!["status","download","rotate"].includes(action)||action==="rotate"&&q.body?.confirm!==true)throw new AppError("CREDENTIAL_CONFIRMATION_REQUIRED","Confirm credential regeneration explicitly",422,"VALIDATION");
  if(!operations.credentials)throw new AppError("DEVICE_CREDENTIALS_UNAVAILABLE","Device credentials unavailable",503,"VALIDATION");
  r.json(await operations.credentials(r.locals.did,id,action));
 });
 router.post("/:id/edit",async(q,r)=>{
  if(!/^0x[0-9a-f]{64}$/i.test(String(q.params.id)) || typeof q.body?.name!=="string" || !q.body.name.trim() || q.body.name.length>128 || typeof q.body.description!=="string" || q.body.description.length>4096)throw new AppError("INVALID_TWIN_INPUT","Provide a name and description",422,"VALIDATION");
  r.json(await operations.edit(r.locals.did,String(q.params.id),{name:q.body.name.trim(),description:q.body.description}));
 });
 router.post("/delete",async(q,r)=>{
  const ids=q.body?.ids;
  if(q.body?.confirm!==true || !Array.isArray(ids) || !ids.length || ids.length>50 || new Set(ids).size!==ids.length || ids.some(id=>typeof id!=="string"||!/^0x[0-9a-f]{64}$/i.test(id)))throw new AppError("DELETE_CONFIRMATION_REQUIRED","Confirm 1–50 distinct Twin IDs",422,"VALIDATION");
  const results=[];
  for(const id of ids){try{const result=await operations.remove(r.locals.did,id);results.push({id,deleted:true,result});}catch(e){results.push({id,deleted:false,error:e instanceof AppError?e.code:"DELETE_FAILED_CHECK_CHAIN_BEFORE_RETRY"});}}
  r.json({results});
 });
 return router;
}
