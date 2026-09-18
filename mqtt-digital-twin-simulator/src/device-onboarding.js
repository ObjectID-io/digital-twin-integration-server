import { createCipheriv, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export function onboardingConfig(value) {
  if (value?.specVersion !== "objectid.device-onboarding.v1") return null;
  if (!/^device-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.deviceId) ||
      !["testnet","mainnet"].includes(value.network) || !/^[a-z0-9_-]{1,96}$/i.test(value.tenantId)) throw Error("Invalid bootstrap device scope");
  const root = (value.network === "mainnet" ? "objectid/mainnet" : "objectid")+"/tenants/"+value.tenantId+"/devices/"+value.deviceId;
  if (value.mqtt?.topics?.telemetry !== root+"/telemetry") throw Error("Invalid bootstrap device topic");
  if (!/^(wss|mqtts):\/\//.test(value.mqtt?.endpoint || "") || !value.mqtt.username || !value.mqtt.password) throw Error("Secure MQTT device credentials required");
  if (value.encryption && (value.encryption.algorithm!=="AES-256-GCM" || value.encryption.kdf!=="scrypt" || typeof value.encryption.password!=="string" || !value.encryption.password || value.encryption.password.length>1024)) throw Error("Invalid device encryption configuration");
  return {...value,bootstrapDevice:true,objectid:{network:value.network,tenantId:value.tenantId,twinIds:[value.deviceId]},twin:{id:value.deviceId,name:value.name},
    mqtt:{...value.mqtt,topics:[{twinId:value.deviceId,dataset:root+"/telemetry"}]}};
}
export async function devicePayload(sample,password) {
  if (!password) return sample;
  const salt=randomBytes(16), nonce=randomBytes(12), key=await derive(password,salt,32);
  const cipher=createCipheriv("aes-256-gcm",key,nonce);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(sample),"utf8"),cipher.final()]);
  return {encrypted:true,algorithm:"AES-256-GCM",salt:salt.toString("base64"),nonce:nonce.toString("base64"),authTag:cipher.getAuthTag().toString("base64"),ciphertext:ciphertext.toString("base64")};
}
