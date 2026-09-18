// VPS smoke check: uses existing tenant credentials without exposing them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const mainnet = process.argv[2] === "mainnet";
const root = mainnet ? "/root/digital-twin-integration-server-mainnet" : "/root/digital-twin-integration-server";
const base = mainnet ? "https://dtis.objectid.io/mainnet" : "https://dtis.objectid.io";
const credentials = JSON.parse(await readFile(`${root}/secrets/credentials.json`, "utf8"));
const registry = typeof credentials.DTIS_TENANTS_JSON === "string" ? JSON.parse(credentials.DTIS_TENANTS_JSON) : credentials.DTIS_TENANTS_JSON;
const tenant = registry?.tenants?.find((item) => item.apiKeyCredential && credentials[item.apiKeyCredential]);
const headers = tenant ? { "x-api-key": credentials[tenant.apiKeyCredential] } : null;
const fetchApi = (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(30000) });
assert.equal((await fetchApi("/api/v1/files")).status, 401);
const spec = await (await fetchApi("/openapi.json")).json();
assert.ok(spec.paths["/api/v1/files/{id}/content"]);
if (!headers) {
  assert.ok(mainnet, "No existing tenant credential available for testnet smoke verification");
  console.log("Mainnet: anonymous denial and OpenAPI verified; authenticated test skipped (no recoverable static tenant key)");
  process.exit(0);
}
const list = await fetchApi("/api/v1/files", { headers }); assert.equal(list.status, 200);
assert.ok(Array.isArray((await list.json()).files));
if (!mainnet && process.argv.includes("--upload")) {
  const bytes = Buffer.from("ObjectID generic encrypted file API verification.\n");
  const stored = await fetchApi("/api/v1/files", { method: "POST", headers: { ...headers, "X-File-Name": "dtis-file-api-smoke-test.txt", "Content-Type": "text/plain" }, body: bytes });
  assert.equal(stored.status, 201);
  const metadata = await stored.json();
  const downloaded = await fetchApi(`/api/v1/files/${metadata.id}/content`, { headers });
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal(downloaded.headers.get("cache-control"), "no-store");
  assert.ok(downloaded.headers.get("content-disposition").startsWith("attachment;"));
  console.log(`Testnet encrypted store/retrieve verified; diagnostic file ID ${metadata.id}`);
}
console.log(`${mainnet ? "Mainnet" : "Testnet"}: authenticated list, anonymous denial and OpenAPI verified`);
