import {it,expect,vi} from "vitest";
import express from "express";
import request from "supertest";
import {Ed25519Keypair} from "@iota/iota-sdk/keypairs/ed25519";
import {DeviceDidAuth,deviceDidRoutes} from "../../src/devices/did-auth.js";
import {deviceRoutes} from "../../src/devices/routes.js";
const pkg="0x"+"b".repeat(64),did="did:iota:testnet:0x"+"a".repeat(64),origin="https://dtis.example";
const credentials={get:async()=>pkg},keypair=Ed25519Keypair.deriveKeypairFromSeed("1".repeat(64));
async function sign(auth:DeviceDidAuth) {const c=await auth.challenge(did);return {challengeId:c.challengeId,did,signature:(await keypair.signPersonalMessage(new TextEncoder().encode(c.message))).signature};}
it("DID proof is one-time, scoped to IS/network, expires and checks controller ownership",async()=>{
  let now=1_800_000_000_000;
  const owns=vi.fn(async()=>true),auth=new DeviceDidAuth("testnet",origin,credentials,"",owns,()=>now);
  const input=await sign(auth), result=await auth.verify(input);
  expect(result.session.did).toBe(did);expect(owns).toHaveBeenCalledWith(did,keypair.toIotaAddress());
  await expect(auth.verify(input)).rejects.toThrow("DID_CHALLENGE_INVALID");
  const expired=await sign(auth);now+=300001;await expect(auth.verify(expired)).rejects.toThrow("DID_CHALLENGE_INVALID");
  await expect(auth.challenge(did.replace("testnet:",""))).rejects.toThrow("DID_NETWORK_INVALID");
  owns.mockResolvedValue(false);await expect(auth.verify(await sign(auth))).rejects.toThrow("DID_CONTROLLER_NOT_OWNED");
});
it("pins ControllerCap to the approved identity package, not only its type suffix",async()=>{
  const auth=new DeviceDidAuth("testnet",origin,credentials,"");
  const get=vi.fn(async(_input:any)=>({data:[{data:{type:"0xevil::oid_identity::ControllerCap",content:{dataType:"moveObject",fields:{controller_of:did.split(":").at(-1)}}}}],hasNextPage:false}));
  (auth as any).client={getOwnedObjects:get};
  await expect(auth.verify(await sign(auth))).rejects.toThrow("DID_CONTROLLER_NOT_OWNED");
  expect(get.mock.calls[0]?.[0]).toMatchObject({filter:{StructType:pkg+"::oid_identity::ControllerCap"}});
});
it("native cookie session authorizes the workbench, requires same-origin writes and is revoked on logout",async()=>{
  const auth=new DeviceDidAuth("testnet",origin,credentials,"",async()=>true),app=express(),list=vi.fn(async()=>[]);
  app.use(express.json());app.use("/api/device-auth",deviceDidRoutes(auth,{findByOwnerDid:async()=>null} as any));
  app.use("/api/device-workbench",deviceRoutes({list,register:async()=>({})} as any,credentials,auth));
  app.use((error:any,_q:any,r:any,_n:any)=>r.status(error.status || error.statusCode || 401).json({error:error.code}));
  await request(app).post("/api/device-auth/challenge").set("Origin","https://evil.example").send({did}).expect(403);
  const challenge=await request(app).post("/api/device-auth/challenge").set("Origin",origin).send({did}).expect(200);
  const signature=(await keypair.signPersonalMessage(new TextEncoder().encode(challenge.body.message))).signature;
  const login=await request(app).post("/api/device-auth/verify").set("Origin",origin).send({did,challengeId:challenge.body.challengeId,signature}).expect(200);
  const cookie=String(login.headers["set-cookie"]?.[0]);expect(cookie).toContain("HttpOnly; Secure; SameSite=Strict");
  const session=await request(app).get("/api/device-auth/session").set("Cookie",cookie).expect(200);
  expect(session.body.subscriptionConfigured).toBe(false);expect(session.body.session.did).toBe(did);
  await request(app).get("/api/device-workbench/devices").set("Cookie",cookie).expect(200);
  await request(app).post("/api/device-workbench/devices").set("Cookie",cookie).set("Origin","https://evil.example").send({}).expect(403);
  await request(app).post("/api/device-workbench/devices").set("Cookie",cookie).set("Origin",origin).send({}).expect(201);
  await request(app).post("/api/device-auth/logout").set("Cookie",cookie).set("Origin",origin).expect(204);
  await request(app).get("/api/device-workbench/devices").set("Cookie",cookie).expect(401);
});
