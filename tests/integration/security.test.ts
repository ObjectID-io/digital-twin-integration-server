import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("HTTP security", () => {
  afterEach(() => { delete process.env.DTIS_API_KEY; });
  it("rejects missing and invalid API keys", async () => {
    process.env.DTIS_API_KEY = "valid";
    const app = createApp(testConfig({ security: { ...testConfig().security, authMode: "api-key" } }), new FakeObjectIdAdapter()).app;
    expect((await request(app).get("/api/v1/twins/0x1")).status).toBe(401);
    expect((await request(app).get("/api/v1/twins/0x1").set("x-api-key", "invalid")).status).toBe(401);
  });
  it("rejects an invalid JWT", async () => {
    process.env.DTIS_JWT_SECRET = "test-secret";
    const app = createApp(testConfig({ security: { ...testConfig().security, authMode: "jwt" } }), new FakeObjectIdAdapter()).app;
    const response = await request(app).get("/api/v1/twins/0x1").set("authorization", "Bearer invalid.jwt.token");
    expect(response.status).toBe(401);
    delete process.env.DTIS_JWT_SECRET;
  });
  it("rejects oversized payloads", async () => {
    const app = createApp(testConfig({ server: { ...testConfig().server, bodyLimitBytes: 1024 } }), new FakeObjectIdAdapter()).app;
    const response = await request(app).post("/api/v1/twins").send({ data: "x".repeat(2048) });
    expect(response.status).toBe(413);
  });
  it("rejects invalid OME schema", async () => {
    const app = createApp(testConfig(), new FakeObjectIdAdapter()).app;
    const response = await request(app).post("/api/v1/twins").send({ profile: "objectid-profile://iso23247/ome/v1", name: "invalid" });
    expect(response.status).toBe(422);
  });
});
