import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { MemoryIdempotencyStore } from "../../src/security/idempotency.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("shared idempotency", () => {
  it("allows only one mutation across two instances sharing a store", async () => {
    class SlowAdapter extends FakeObjectIdAdapter {
      override async publishState(twinId: string, input: unknown) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return super.publishState(twinId, input);
      }
    }
    const adapter = new SlowAdapter();
    adapter.twins.set("0xtwin", { id: "0xtwin" });
    const store = new MemoryIdempotencyStore();
    const instanceA = createApp(testConfig(), adapter, store);
    const instanceB = createApp(testConfig(), adapter, store);
    const send = (app: typeof instanceA.app) => request(app).post("/api/v1/twins/0xtwin/states").set("Idempotency-Key", "shared-key").send({ value: 1 });
    const responses = await Promise.all([send(instanceA.app), send(instanceB.app)]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(adapter.calls.filter((call) => call.method === "publishState")).toHaveLength(1);
  });
});
