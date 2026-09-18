import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppRuntime } from "../../src/api/app.js";
import { PlantService, plantCatalogDirectory } from "../../src/plants/service.js";
import { EnvironmentCredentialProvider } from "../../src/security/credentials.js";
import { testConfig } from "../fixtures/config.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";

describe("encrypted plant API", () => {
  let directory: string;
  let runtime: AppRuntime;
  let accessKey: Buffer;
  let config: ReturnType<typeof testConfig>;
  const document = { ownerDid: "did:iota:supervisor-a", tenantId: "a", name: "private facility", tree: [{ secret: "secret tree" }], media: ["secret image"], areas: ["secret area"], twinBindings: { asset: "secret twin" }, visibility: "public", legacyMigration: { arbitrary: [true, null, { source: "legacy" }] } };
  const publication = { name: "Public facility", coordinates: [9, 45] };
  const body = (revision = 0, published = true) => ({ revision, document, publication: published ? publication : null });
  const token = (claims: Record<string, unknown> = {}, key: jwt.Secret = accessKey, algorithm: jwt.Algorithm = "HS256") => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: "twinscope", aud: "dtis-plants", sub: "did:iota:supervisor-a", tenantId: "a", role: "tenant_supervisor", iat: now, exp: now + 60, jti: randomUUID(), ...claims };
    return jwt.sign(JSON.parse(JSON.stringify(payload)), key, { algorithm });
  };
  const put = (value: object = body(), bearer = token(), id = "plant-1") => request(runtime.app).put(`/api/plants/${id}`).auth(bearer, { type: "bearer" }).send(value);
  const list = (bearer = token()) => request(runtime.app).get("/api/plants").auth(bearer, { type: "bearer" });

  beforeEach(async () => {
    const root = resolve("data");
    await mkdir(root, { recursive: true });
    directory = await mkdtemp(join(root, "plants-test-"));
    accessKey = randomBytes(32);
    vi.stubEnv("DTIS_PLANT_ACCESS_KEY", accessKey.toString("base64"));
    vi.stubEnv("DTIS_PLANT_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DTIS_PLANT_SUPERVISORS", JSON.stringify({ a: "did:iota:supervisor-a", b: "did:iota:supervisor-b" }));
    config = testConfig({
      dataset: { directory: join(directory, "blobs") },
      security: { tenantProvisioning: { enabled: false, provisioningKeyCredential: "UNUSED", dynamicTenantFile: join(directory, "tenants.json") } },
    });
    runtime = createApp(config, new FakeObjectIdAdapter());
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); });

  it("stores connection secrets in a separate encrypted supervisor-only catalog", async () => {
    const profile = { label: "Server", apiToken: "connection-secret" };
    const save = await request(runtime.app).put("/api/plant-connections/profile-1").auth(token(), { type: "bearer" }).send({ revision: 0, document: profile, publication });
    expect(save.status).toBe(200);
    expect(save.body.publication).toBeNull();
    expect((await request(runtime.app).get("/api/plant-connections")).status).toBe(401);
    expect((await request(runtime.app).get("/api/plant-connections").auth(token({ role: "viewer" }), { type: "bearer" })).status).toBe(403);
    expect((await request(runtime.app).get("/api/plant-connections").auth(token({ tenantId: "b", sub: "did:iota:supervisor-b" }), { type: "bearer" })).body.connections).toEqual([]);
    expect((await list()).body.plants).toEqual([]);
    expect((await request(runtime.app).get("/api/plants/public")).body.plants).toEqual([]);
    const catalog = await readFile(join(directory, "plants", "connections", "catalog.json"), "utf8");
    expect(catalog).not.toContain("connection-secret");
    expect((await request(runtime.app).get("/api/plant-connections").auth(token(), { type: "bearer" })).body.connections[0].document).toEqual(profile);
    expect((await request(runtime.app).put("/api/plant-connections/profile-1").auth(token(), { type: "bearer" }).send({ revision: 0, document: profile })).status).toBe(409);
  });

  it("persists the entire encrypted document through StorageRouter and survives restart", async () => {
    expect((await put()).body).toEqual({ id: "plant-1", revision: 1, document, publication });
    const catalog = await readFile(join(directory, "plants", "catalog.json"), "utf8");
    for (const secret of ["secret tree", "secret image", "secret area", "secret twin", "private facility", "supervisor-a"]) expect(catalog).not.toContain(secret);
    const blobs = join(directory, "blobs", "twins", "unscoped", "plants");
    const ciphertext = await readFile(join(blobs, (await readdir(blobs))[0]!));
    expect(ciphertext[0]).toBe(1);
    expect(ciphertext.toString()).not.toContain("secret");
    expect(await runtime.storage.listManagedObjects()).toEqual([]);
    expect((await list()).body).toEqual({ plants: [{ id: "plant-1", revision: 1, document, publication }] });
    const restarted = new PlantService(runtime.storage, new EnvironmentCredentialProvider(), plantCatalogDirectory(config));
    expect(await restarted.list("a")).toEqual([{ id: "plant-1", revision: 1, document, publication }]);
    expect(plantCatalogDirectory(testConfig())).toBe(resolve("/data", "plants"));
  });

  it("serves only explicit public fields without a blob read or encryption credential", async () => {
    await put();
    await put(body(0, false), token(), "private");
    expect(await readFile(join(directory, "plants", "catalog.json"), "utf8")).not.toContain('"private"');
    vi.stubEnv("DTIS_PLANT_ENCRYPTION_KEY", "");
    const read = vi.spyOn(runtime.storage, "read").mockRejectedValue(new Error("Must never read"));
    const publicResponse = await request(runtime.app).get("/api/plants/public");
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.body).toEqual({ plants: [{ id: "plant-1", ...publication, visibility: "public" }] });
    expect(publicResponse.headers["cache-control"]).toBe("no-store");
    expect(read).not.toHaveBeenCalled();
    const credentials = { get: vi.fn().mockRejectedValue(new Error("Must never obtain credentials")) };
    await new PlantService(runtime.storage, credentials, plantCatalogDirectory(config)).listPublic();
    expect(credentials.get).not.toHaveBeenCalled();
    expect((await list()).status).toBe(503);
  });

  it("unpublishes atomically and ignores visibility embedded in the private document", async () => {
    await put();
    expect((await put(body(1, false))).status).toBe(200);
    expect((await request(runtime.app).get("/api/plants/public")).body).toEqual({ plants: [] });
  });

  it("requires independent plant auth even when ordinary DTIS authentication is disabled", async () => {
    expect((await request(runtime.app).get("/api/plants")).status).toBe(401);
    expect((await request(runtime.app).put("/api/plants/plant-1").send(body())).status).toBe(401);
    expect((await list(token({}, accessKey.toString("base64")))).status).toBe(401);
  });

  it.each([
    [{ tenantId: "b" }, 403], [{ tenantId: "unknown" }, 403], [{ tenantId: "__proto__" }, 403],
    [{ role: "viewer" }, 403], [{ sub: "did:iota:impostor" }, 403],
    [{ iss: "other" }, 401], [{ aud: "other" }, 401], [{ exp: 1 }, 401],
    [{ exp: undefined }, 401], [{ jti: undefined }, 401],
    [{ iat: Math.floor(Date.now() / 1000) + 120 }, 401],
    [{ exp: Math.floor(Date.now() / 1000) + 600 }, 401],
  ])("rejects invalid claims %j", async (claims, status) => {
    expect((await list(token(claims))).status).toBe(status);
    expect((await put(body(), token(claims))).status).toBe(status);
  });

  it("rejects signature tampering and unexpected algorithms", async () => {
    expect((await list(token({}, randomBytes(32)))).status).toBe(401);
    expect((await list(token({}, accessKey, "HS384"))).status).toBe(401);
  });

  it.each(["DTIS_PLANT_ACCESS_KEY", "DTIS_PLANT_SUPERVISORS", "DTIS_PLANT_ENCRYPTION_KEY"])("fails closed on missing or malformed %s", async (name) => {
    for (const value of ["", "invalid"]) {
      vi.stubEnv(name, value);
      expect((await put()).status).toBe(503);
      expect((await list()).status).toBe(503);
    }
  });

  it("isolates tenant lists, IDs, revisions and updates using signed tenant claims", async () => {
    await put();
    const b = token({ tenantId: "b", sub: "did:iota:supervisor-b" });
    expect((await list(b)).body).toEqual({ plants: [] });
    expect((await put({ ...body(1), document: { tree: "tenant b" } }, b)).status).toBe(409);
    expect((await put({ ...body(0, false), document: { tree: "tenant b" } }, b)).status).toBe(200);
    expect((await list()).body.plants[0].document).toEqual(document);
    expect((await list(b)).body.plants[0].document).toEqual({ tree: "tenant b", ownerDid: "did:iota:supervisor-b", tenantId: "b" });
    expect((await put({ ...body(1), tenantId: "b" })).status).toBe(400);
  });

  it("enforces optimistic revisions across independent writers", async () => {
    await put();
    expect((await put(body())).status).toBe(409);
    const second = new PlantService(runtime.storage, new EnvironmentCredentialProvider(), plantCatalogDirectory(config));
    const first = new PlantService(runtime.storage, new EnvironmentCredentialProvider(), plantCatalogDirectory(config));
    const outcomes = await Promise.allSettled([first.put("a", "plant-1", body(1)), second.put("a", "plant-1", body(1))]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await list()).body.plants[0].revision).toBe(2);
  });

  it("retains the old pointer when blob storage fails and releases the lock", async () => {
    await put();
    const store = vi.spyOn(runtime.storage, "store").mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await put(body(1))).status).toBe(500);
    expect((await list()).body.plants[0].revision).toBe(1);
    store.mockRestore();
    expect((await put(body(1))).status).toBe(200);
  });

  it("rejects ciphertext corruption without returning any decrypted records", async () => {
    await put();
    const original = runtime.storage.read.bind(runtime.storage);
    vi.spyOn(runtime.storage, "read").mockImplementation(async (uri) => {
      const data = Buffer.from(await original(uri) as Buffer);
      data[data.length - 1] = data[data.length - 1]! ^ 1;
      return data;
    });
    const response = await list();
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("PLANT_INTEGRITY_FAILURE");
    expect(response.text).not.toContain("secret");
  });

  it("binds ciphertext to tenant, plant ID, revision and publication", async () => {
    await put();
    await put(body(), token(), "plant-2");
    const path = join(directory, "plants", "catalog.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const changes of [{ plant: "a".repeat(64) }, { revision: 2 }, { publication: null }, { uri: original.plants[1].uri }]) {
      const changed = structuredClone(original);
      Object.assign(changed.plants[0], changes);
      await writeFile(path, JSON.stringify(changed));
      expect((await list()).status).toBe(503);
    }
  });

  it("fails closed on a corrupt catalog instead of resetting revisions", async () => {
    await put();
    await writeFile(join(directory, "plants", "catalog.json"), "{");
    expect((await list()).status).toBe(503);
    expect((await put()).status).toBe(503);
    expect((await request(runtime.app).get("/api/plants/public")).status).toBe(503);
  });

  it.each([
    { ...body(), revision: -1 }, { ...body(), revision: 0.5 }, { ...body(), document: [] },
    { ...body(), publication: { ...publication, privateField: "leak" } },
    { ...body(), publication: { ...publication, coordinates: [0, 91] } },
    { ...body(), publication: { ...publication, coordinates: [181, 0] } },
    { ...body(), publication: { ...publication, coordinates: [0] } },
    { ...body(), publication: { ...publication, coordinates: [0, 0, 0] } },
    { ...body(), publication: { ...publication, coordinates: ["9", 45] } },
    { ...body(), publication: { ...publication, coordinates: { latitude: 45, longitude: 9 } } },
    { ...body(), publication: undefined },
  ])("validates writes strictly %j", async (value) => { expect((await put(value)).status).toBe(400); });

  it("accepts image documents over the default body limit with the scoped parser", async () => {
    const large = { ...body(), document: { ...document, media: Array.from({ length: 4 }, () => ({ data: "a".repeat(13 * 1024 * 1024 / 4) })) } };
    expect((await put(large)).status).toBe(200);
    expect(JSON.stringify((await list()).body.plants[0].document)).toBe(JSON.stringify(large.document));
    expect((await request(runtime.app).post("/api/v1/not-a-route").send(large)).status).toBe(413);
  });
});
