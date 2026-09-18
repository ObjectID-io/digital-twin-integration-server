import {it,expect,vi} from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import {deviceRoutes,workbenchSession} from "../../src/devices/routes.js";
const key=Buffer.alloc(32,7).toString("base64"), credentials={get:async()=>key};
const context={ownerDid:"did:iota:testnet:0x"+"a".repeat(64),requesterDid:"did:iota:testnet:0x"+"a".repeat(64),source:"dt" as const,tenantId:null};
it("requires the dedicated short-lived session, not a tenant API key or other JWT audience",async()=>{
  const list=vi.fn(async()=>[]),app=express();
  app.use(express.json());app.use("/api/device-workbench",deviceRoutes({list} as any,credentials));
  app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.statusCode || 401).json({error:e.code}));
  await request(app).get("/api/device-workbench/devices").set("x-api-key","tenant-secret").expect(401);
  const wrong=jwt.sign({context},Buffer.from(key,"base64"),{issuer:"dtis",audience:"dtis-plants",expiresIn:300});
  await request(app).get("/api/device-workbench/devices").auth(wrong,{type:"bearer"}).expect(401);
  const session=await workbenchSession(context,credentials);
  const response=await request(app).get("/api/device-workbench/devices").auth(session.token,{type:"bearer"}).expect(200);
  expect(response.headers["cache-control"]).toBe("no-store");expect(list).toHaveBeenCalledExactlyOnceWith(context);
  expect(session.ownerDid).toBe(context.ownerDid);
  const expired=jwt.sign({context},Buffer.from(key,"base64"),{issuer:"dtis",audience:"dtis-device-workbench",expiresIn:-1});
  await request(app).get("/api/device-workbench/devices").auth(expired,{type:"bearer"}).expect(401);
});
it("rejects an incorrectly configured workbench signing key",async()=>{
  await expect(workbenchSession(context,{get:async()=>"weak"})).rejects.toThrow("PLANT_AUTH_CONFIG_INVALID");
});
