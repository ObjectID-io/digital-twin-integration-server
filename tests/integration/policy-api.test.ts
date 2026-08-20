import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("mutation API policy integration", () => {
  async function mutate(roleType: string, method: "state" | "model" | "event" | "maturity" | "interface" | "metadata") {
    const adapter = new FakeObjectIdAdapter();
    adapter.twins.set("0xtwin", { id: "0xtwin" });
    adapter.setChildren("0xtwin", "OIDTwinRoleGrant", [{ twinId: "0xtwin", subjectDid: "did:caller", roleType }]);
    const app = createApp(testConfig({ security: { serviceDid: "did:caller" } }), adapter).app;
    if (method === "state") return request(app).post("/api/v1/twins/0xtwin/states").send({ value: 1 });
    if (method === "model") return request(app).post("/api/v1/twins/0xtwin/models").send({ modelType: "simulation" });
    if (method === "event") return request(app).post("/api/v1/twins/0xtwin/events").send({ eventType: 120 });
    if (method === "interface") return request(app).post("/api/v1/twins/0xtwin/interfaces").send({ protocol: "MQTT", networkType: 2 });
    if (method === "metadata") return request(app).patch("/api/v1/twins/0xtwin").send({ name: "Updated", description: "", mutableMetadata: "{}" });
    return request(app).post("/api/v1/twins/0xtwin/maturity/assessments").send({ maturityLevel: 3 });
  }

  it("allows DATA_PROVIDER to publish state", async () => expect((await mutate("DATA_PROVIDER", "state")).status).toBe(202));
  it("denies DATA_PROVIDER from adding a model", async () => expectDenied(await mutate("DATA_PROVIDER", "model")));
  it("allows MODEL_PROVIDER to add a model", async () => expect((await mutate("MODEL_PROVIDER", "model")).status).toBe(202));
  it("allows MAINTAINER to emit a maintenance event", async () => expect((await mutate("MAINTAINER", "event")).status).toBe(202));
  it("denies MAINTAINER from creating a maturity assessment", async () => expectDenied(await mutate("MAINTAINER", "maturity")));
  it("allows CERTIFIER to create a maturity assessment", async () => expect((await mutate("CERTIFIER", "maturity")).status).toBe(202));
  it("denies AUDITOR mutations", async () => expectDenied(await mutate("AUDITOR", "state")));
  it("allows OWNER mutations", async () => expect((await mutate("OWNER", "interface")).status).toBe(202));
  it("allows STEWARD to update Twin metadata", async () => expect((await mutate("STEWARD", "metadata")).status).toBe(200));
  it("denies OPERATOR from updating Twin metadata", async () => expectDenied(await mutate("OPERATOR", "metadata")));
});

function expectDenied(response: request.Response) {
  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe("TWIN_POLICY_DENIED");
}
