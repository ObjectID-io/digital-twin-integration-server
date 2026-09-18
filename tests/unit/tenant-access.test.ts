import {it,expect,vi} from "vitest";
import express from "express";
import request from "supertest";
import {tenantAccessRoutes} from "../../src/security/tenant-access.js";
function setup(logged=true,current=true){
 const registry={credentialStatus:vi.fn(async()=>({tenantId:"mine",mqttUsername:"existing",twinIds:["twin-a"],version:1,active:true})),rotateExternalCredentials:vi.fn(async()=>({tenantId:"mine",version:2})),revokeExternalCredentials:vi.fn(async()=>({active:false}))};
 const check=vi.fn(async()=>current),app=express();app.use(express.json());
 app.use("/tenant",tenantAccessRoutes({context:()=>logged?{ownerDid:"my-did"}:null} as any,registry as any,check,{network:"testnet",apiUrl:"https://is.example",mqttUrl:"wss://is.example/mqtt"}));
 app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.statusCode||e.status||500).json({error:e.code}));
 return {app,registry,check};
}
it("requires native DID login and explicit confirmation",async()=>{
 await request(setup(false).app).get("/tenant").expect(401);
 const {app,registry}=setup();await request(app).post("/tenant/rotate").send({}).expect(422);
 expect(registry.rotateExternalCredentials).not.toHaveBeenCalled();
 await request(app).post("/tenant/purchase").send({confirm:true}).expect(404);
});
it("binds rotation to the session DID and preserves the existing ACL",async()=>{
 const {app,registry,check}=setup();
 const r=await request(app).post("/tenant/rotate").send({confirm:true,ownerDid:"victim",tenantId:"victim",twinIds:["*"]}).expect(200);
 expect(check).toHaveBeenCalledWith("my-did");
 expect(registry.rotateExternalCredentials).toHaveBeenCalledWith("my-did",expect.any(String),"existing",expect.any(String),["twin-a"]);
 expect(r.body.ownerDid).toBe("my-did");expect(r.body.api.apiKey.length).toBeGreaterThan(32);
 expect(r.headers["cache-control"]).toBe("no-store");
});
it("checks subscription for issuance but allows revocation without touching devices",async()=>{
 const {app,registry}=setup(true,false);
 await request(app).post("/tenant/rotate").send({confirm:true}).expect(402);
 expect(registry.rotateExternalCredentials).not.toHaveBeenCalled();
 await request(app).post("/tenant/revoke").send({confirm:true}).expect(200);
 expect(registry.revokeExternalCredentials).toHaveBeenCalledWith("my-did",false);
});
