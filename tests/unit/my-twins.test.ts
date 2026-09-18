import {describe,it,expect,vi} from "vitest";
import express from "express";
import request from "supertest";
import {myTwinRoutes} from "../../src/devices/my-twins.js";
import type {DeviceDidAuth} from "../../src/devices/did-auth.js";
const id="0x"+"a".repeat(64),other="0x"+"b".repeat(64);
function setup(authenticated=true){
 const ops={exportConfig:vi.fn(async()=>({specVersion:"objectid.twin-catalog.v1",twins:[{twinId:id}]})),list:vi.fn(async()=>[]),edit:vi.fn(async()=>({ok:true})),remove:vi.fn(async(_did:string,selected:string)=>{if(selected===other)throw Error("chain unavailable");return {ok:true};})};
 const app=express();app.use(express.json());app.use(myTwinRoutes({context:()=>authenticated?{ownerDid:"owner"}:null} as unknown as DeviceDidAuth,ops));app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.status||500).json({error:e.code}));return {app,ops};
}
describe("personal Twin management",()=>{
 it("exports configuration only for the authenticated DID",async()=>{const {app,ops}=setup();const r=await request(app).get(`/${id}/export`).expect(200);expect(r.body.specVersion).toBe("objectid.twin-catalog.v1");expect(ops.exportConfig).toHaveBeenCalledWith("owner",id);const denied=setup(false);await request(denied.app).get(`/${id}/export`).expect(401);expect(denied.ops.exportConfig).not.toHaveBeenCalled();});
 it("rejects rotation without explicit confirmation",async()=>{const {app}=setup();await request(app).post(`/${id}/credentials`).send({action:"rotate"}).expect(422);await request(app).post(`/${id}/credentials`).send({action:"unsupported"}).expect(422);});
 it("rejects anonymous access and does not invoke operations",async()=>{const {app,ops}=setup(false);await request(app).get("/").expect(401);await request(app).post("/delete").send({confirm:true,ids:[id]}).expect(401);expect(ops.remove).not.toHaveBeenCalled();});
 it("binds edits to authenticated DID and only permits editable fields",async()=>{const {app,ops}=setup();await request(app).post(`/${id}/edit`).send({name:" Updated ",description:"text",ownerDid:"attacker",mutableMetadata:"overwrite"}).expect(200);expect(ops.edit).toHaveBeenCalledWith("owner",id,{name:"Updated",description:"text"});});
 it("requires explicit, bounded, distinct deletion targets",async()=>{const {app,ops}=setup();for(const body of [{ids:[id]},{confirm:true,ids:[]},{confirm:true,ids:[id,id]},{confirm:true,ids:["invalid"]}])await request(app).post("/delete").send(body).expect(422);expect(ops.remove).not.toHaveBeenCalled();});
 it("reports partial deletion without claiming failed targets succeeded",async()=>{const {app}=setup();const r=await request(app).post("/delete").send({confirm:true,ids:[id,other]}).expect(200);expect(r.body.results.map((r:any)=>r.deleted)).toEqual([true,false]);});
});
