import {test} from "node:test";
import assert from "node:assert/strict";
import {createDecipheriv,scryptSync} from "node:crypto";
import {loadSimulatorConfigFromValue,validateIntegrationConfig} from "../src/config.js";
import {devicePayload} from "../src/device-onboarding.js";
import {isHostedDeviceProvisioning} from "../src/control-server.js";
const id="device-11111111-2222-3333-4444-555555555555";
const config={specVersion:"objectid.device-onboarding.v1",network:"testnet",deviceId:id,name:"Mixer",tenantId:"tenant-a",
  mqtt:{endpoint:"wss://dtis.objectid.io/mqtt",username:"device-user",password:"device-secret",topics:{telemetry:`objectid/tenants/tenant-a/devices/${id}/telemetry`}},
  encryption:{algorithm:"AES-256-GCM",kdf:"scrypt",password:"encryption-secret"}};
test("bootstrap credentials work without any on-chain Twin or command ACL",async()=>{
  assert.equal(validateIntegrationConfig(config).bootstrapDevice,true);
  assert.equal(isHostedDeviceProvisioning(config),true);
  const runtime=await loadSimulatorConfigFromValue(config,{});
  assert.equal(runtime.assetId,id);assert.equal(runtime.topic,config.mqtt.topics.telemetry);
  assert.equal(runtime.commandTopic,"");assert.equal(runtime.stateTopic,"");
  assert.equal(runtime.encryptionPassword,"encryption-secret");
  assert.equal(runtime.machineName,"Mixer");
});
test("rejects topic scope tampering and network mismatch",()=>{
  assert.throws(()=>validateIntegrationConfig({...config,network:"mainnet"}),/topic/);
  assert.throws(()=>validateIntegrationConfig({...config,mqtt:{...config.mqtt,topics:{telemetry:"objectid/#"}}}),/topic/);
  assert.equal(isHostedDeviceProvisioning({...config,mqtt:{...config.mqtt,endpoint:"wss://evil.example/mqtt"}}),false);
});
test("device encryption matches IS scrypt AES-GCM envelope",async()=>{
  const value=await devicePayload({temperature:42},"password");
  const decipher=createDecipheriv("aes-256-gcm",scryptSync("password",Buffer.from(value.salt,"base64"),32),Buffer.from(value.nonce,"base64"));
  decipher.setAuthTag(Buffer.from(value.authTag,"base64"));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext,"base64")),decipher.final()])),{temperature:42});
});
