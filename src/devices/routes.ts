import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";
import { deviceError } from "./schema.js";
import type { DeviceContext, DeviceWorkbench } from "./service.js";
import { AppError } from "../common/errors.js";
import type {DeviceDidAuth} from "./did-auth.js";
export async function workbenchSession(context:DeviceContext, credentials:CredentialProvider) {
  const key=await requiredCredential(credentials,"DTIS_PLANT_ACCESS_KEY");
  if (Buffer.from(key,"base64").length!==32 || Buffer.from(key,"base64").toString("base64")!==key) return deviceError("PLANT_AUTH_CONFIG_INVALID",503);
  return { ownerDid:context.ownerDid,requesterDid:context.requesterDid,token:jwt.sign({context},Buffer.from(key,"base64"),{algorithm:"HS256",issuer:"dtis",audience:"dtis-device-workbench",expiresIn:300,jwtid:randomUUID()}), expiresIn:300 };
}
export function deviceRoutes(service:DeviceWorkbench, credentials:CredentialProvider, nativeAuth?:DeviceDidAuth) {
  const router=express.Router();
  router.use(async (request,response,next)=>{
    try {
      if(!request.header("authorization")) {
        const context=nativeAuth?.context(request);
        if(!context)return deviceError("DEVICE_DID_SESSION_REQUIRED",401);
        response.locals.deviceContext=context;response.set("Cache-Control","no-store");next();return;
      }
      const key=await requiredCredential(credentials,"DTIS_PLANT_ACCESS_KEY");
      const token=/^Bearer (\S+)$/.exec(request.header("authorization")||"")?.[1];
      if(!token) return deviceError("DEVICE_DID_SESSION_REQUIRED",401);
      const claims=jwt.verify(token,Buffer.from(key,"base64"),{algorithms:["HS256"],issuer:"dtis",audience:"dtis-device-workbench",maxAge:300}) as jwt.JwtPayload;
      if(!claims.context?.ownerDid || !claims.context?.requesterDid) return deviceError("DEVICE_DID_SESSION_REQUIRED",401);
      response.locals.deviceContext=claims.context;
      response.set("Cache-Control","no-store"); next();
    } catch(error) { next(error instanceof AppError ? error : new AppError("DEVICE_DID_SESSION_REQUIRED","DID session expired or invalid",401,"AUTHORIZATION")); }
  });
  router.get("/devices",async (_q,r,n)=>{try{r.json({devices:await service.list(r.locals.deviceContext)});}catch(e){n(e);}});
  router.get("/context",(_q,r)=>r.json(r.locals.deviceContext));
  router.post("/devices",async (q,r,n)=>{try{r.status(201).json(await service.register(r.locals.deviceContext,q.body));}catch(e){n(e);}});
  router.post("/devices/:id/inspect",async(q,r,n)=>{try{r.json(await service.inspect(r.locals.deviceContext,String(q.params.id),q.body?.password));}catch(e){n(e);}});
  router.post("/devices/:id/classify",async(q,r,n)=>{try{r.json(await service.classify(r.locals.deviceContext,String(q.params.id),q.body));}catch(e){n(e);}});
  router.post("/devices/:id/revoke",async(q,r,n)=>{try{r.json(await service.revoke(r.locals.deviceContext,String(q.params.id)));}catch(e){n(e);}});
  router.get("/devices/:id/export",async(q,r,n)=>{try{r.json(await service.export(r.locals.deviceContext,String(q.params.id)));}catch(e){n(e);}});
  router.get("/catalog",async(_q,r,n)=>{try{
    r.json(await service.catalog(r.locals.deviceContext));
  }catch(e){n(e);}});
  return router;
}
