import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppRuntime } from "../../src/api/app.js";
import { testConfig } from "../fixtures/config.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { MAX_FILE_BYTES } from "../../src/files/service.js";
import jwt from "jsonwebtoken";

describe("generic encrypted files", () => {
  let directory: string, runtime: AppRuntime;
  const auth = (key = "a-secret") => ({ "x-api-key": key });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dtis-files-"));
    vi.stubEnv("DTIS_FILE_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DTIS_TENANTS_JSON", JSON.stringify({ tenants: ["a", "b"].map((id) => ({ tenantId: id, customerId: id, ownerDid: `did:iota:0x${id.repeat(64)}`, subscriptionId: `0x${id.repeat(64)}`, apiKeyHash: createHash("sha256").update(`${id}-secret`).digest("hex") })) }));
    runtime = createApp(testConfig({ dataset: { directory: join(directory, "blobs") }, security: { authMode: "api-key", tenantProvisioning: { enabled: false, provisioningKeyCredential: "UNUSED", dynamicTenantFile: join(directory, "tenants.json") } } }), new FakeObjectIdAdapter());
  });
  afterEach(async () => { await runtime.stop(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
  const upload = (data: Buffer = Buffer.from([0, 255, 10, 17]), name = "machine.bin", type = "application/octet-stream") => request(runtime.app).post("/api/v1/files").set(auth()).set("X-File-Name", encodeURIComponent(name)).set("Content-Type", type).send(data);
  it("round-trips binary bytes, lists metadata and downloads safely", async () => {
    const data = randomBytes(8192), response = await upload(data);
    expect(response.status).toBe(201);
    const id = response.body.id;
    expect(response.body).toMatchObject({ name: "machine.bin", size: data.length, createdBy: `did:iota:0x${"a".repeat(64)}`, sha256: createHash("sha256").update(data).digest("hex") });
    const fetched = await request(runtime.app).get(`/api/v1/files/${id}/content`).set(auth());
    expect(fetched.status).toBe(200); expect(fetched.body).toEqual(data);
    expect(fetched.headers["content-disposition"]).toContain("attachment;");
    expect(fetched.headers["cache-control"]).toBe("no-store");
    expect(fetched.headers["x-content-type-options"]).toBe("nosniff");
    expect((await request(runtime.app).get(`/api/v1/files/${id}`).set(auth())).body).toEqual(response.body);
    expect((await request(runtime.app).get("/api/v1/files").set(auth())).body.files).toEqual([response.body]);
  });
  it("preserves JSON without the ordinary JSON body parser", async () => {
    const json = '{ "secret": true, "value":  42 }';
    const response = await request(runtime.app).post("/API/v1/files").set(auth()).set("X-File-Name", "report.json").set("Content-Type", "application/json").send(json);
    expect(response.status).toBe(201);
    expect((await request(runtime.app).get(`/api/v1/files/${response.body.id}/content`).set(auth())).body.toString()).toBe(json);
  });
  it("denies anonymous, invalid credentials and cross-tenant reads", async () => {
    const { body } = await upload();
    for (const path of ["", `/${body.id}`, `/${body.id}/content`]) {
      expect((await request(runtime.app).get(`/api/v1/files${path}`)).status).toBe(401);
      expect((await request(runtime.app).get(`/api/v1/files${path}`).set(auth("device-password"))).status).toBe(401);
    }
    expect((await request(runtime.app).get(`/api/v1/files/${body.id}/content`).set(auth("b-secret"))).status).toBe(404);
    expect((await request(runtime.app).get("/api/v1/files").set(auth("b-secret"))).body.files).toEqual([]);
    expect((await request(runtime.app).post("/api/v1/files").set("Content-Type", "application/octet-stream").send(Buffer.alloc(8000))).status).toBe(401);
  });
  it("rejects disabled auth and global keys without a tenant", async () => {
    vi.stubEnv("DTIS_TENANTS_JSON", "{\"tenants\":[]}"); vi.stubEnv("DTIS_API_KEY", "global-key");
    expect((await request(runtime.app).get("/api/v1/files").set(auth("global-key"))).status).toBe(403);
    const disabled = createApp(testConfig(), new FakeObjectIdAdapter());
    try { expect((await request(disabled.app).get("/api/v1/files")).status).toBe(403); } finally { await disabled.stop(); }
  });
  it("requires a JWT subject matching the registered owner DID", async () => {
    vi.stubEnv("DTIS_JWT_SECRET", "jwt-test-only-secret");
    const jwtRuntime = createApp(testConfig({ security: { authMode: "jwt" } }), new FakeObjectIdAdapter());
    try {
      const token = jwt.sign({ tenantId: "a", sub: "did:iota:someone-else" }, "jwt-test-only-secret", { expiresIn: "1m" });
      expect((await request(jwtRuntime.app).get("/api/v1/files").auth(token, { type: "bearer" })).status).toBe(403);
    } finally { await jwtRuntime.stop(); }
  });
  it("handles empty Unicode-named files and rejects compressed request bodies", async () => {
    const response = await upload(Buffer.alloc(0), "manuale caffè.pdf", "application/pdf");
    expect(response.status).toBe(201); expect(response.body.size).toBe(0);
    const result = await request(runtime.app).get(`/api/v1/files/${response.body.id}/content`).set(auth());
    expect(result.status).toBe(200); expect(result.headers["content-disposition"]).toContain("caff%C3%A8.pdf");
    expect((await request(runtime.app).post("/api/v1/files").set(auth()).set("Content-Encoding", "gzip").send("invalid")).status).toBe(415);
  });
  it("encrypts filename, DID and payload and fails closed on corruption", async () => {
    const { body } = await upload(Buffer.from("private-payload"));
    const scope = createHash("sha256").update("a").digest("hex");
    const indexPath = join(directory, "files", scope, `${body.id}.idx`);
    const index = await readFile(indexPath);
    expect(index.toString()).not.toContain("machine.bin"); expect(index.toString()).not.toContain("did:iota:a");
    const blobs = join(directory, "blobs", "twins", "unscoped", "files");
    const path = join(blobs, (await readdir(blobs))[0]!); const bytes = await readFile(path);
    expect(bytes.toString()).not.toContain("private-payload");
    bytes[30] = bytes[30]! ^ 1; await writeFile(path, bytes);
    expect((await request(runtime.app).get(`/api/v1/files/${body.id}/content`).set(auth())).status).toBe(503);
    index[30] = index[30]! ^ 1; await writeFile(indexPath, index);
    expect((await request(runtime.app).get(`/api/v1/files/${body.id}`).set(auth())).status).toBe(503);
  });
  it("rejects traversal, invalid metadata, oversize files and missing encryption key", async () => {
    expect((await upload(Buffer.from("x"), "../file")).status).toBe(400);
    expect((await upload(Buffer.from("x"), "bad\nname")).status).toBe(400);
    expect((await upload(Buffer.alloc(MAX_FILE_BYTES + 1))).status).toBe(413);
    vi.stubEnv("DTIS_FILE_ENCRYPTION_KEY", "");
    expect((await upload()).status).toBe(503);
  });
  it("paginates and stores repeated uploads as distinct immutable IDs", async () => {
    const a = await upload(), b = await upload(); expect(a.body.id).not.toBe(b.body.id);
    const first = (await request(runtime.app).get("/api/v1/files?limit=1").set(auth())).body;
    const second = (await request(runtime.app).get(`/api/v1/files?limit=1&after=${first.nextCursor}`).set(auth())).body;
    expect(first.files).toHaveLength(1); expect(second.files).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(first.files[0].id).not.toBe(second.files[0].id);
    expect((await request(runtime.app).get("/api/v1/files?limit=1000").set(auth())).status).toBe(400);
  });
});
