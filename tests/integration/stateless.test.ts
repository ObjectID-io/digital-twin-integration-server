import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("stateless restart", () => {
  it("reconstructs a Twin with a clean instance from ObjectID", async () => {
    const objectid = new FakeObjectIdAdapter();
    objectid.twins.set("0xtwin", { id: "0xtwin", revision: 7, name: "Machine" });
    const instanceA = createApp(testConfig(), objectid);
    await request(instanceA.app).post("/api/v1/twins/0xtwin/states").send({ value: 42 });
    instanceA.idempotency.clear();
    const instanceB = createApp(testConfig(), objectid);
    const response = await request(instanceB.app).get("/api/v1/twins/0xtwin");
    expect(response.body).toMatchObject({ id: "0xtwin", revision: 7, name: "Machine" });
  });
});
