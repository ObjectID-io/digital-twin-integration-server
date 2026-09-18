import { expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { AiAnalysisConnector } from "../../src/connectors/ai-analysis.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

it("adds AI output to private snapshots without changing stored telemetry", async () => {
  const adapter = new FakeObjectIdAdapter(); adapter.twins.set("0xtwin", { id: "0xtwin", revision: 2 });
  const runtime = createApp(testConfig(), adapter);
  const ai = new AiAnalysisConnector(vi.fn().mockResolvedValue(new Response(JSON.stringify({ summary: "Observed 42", limitations: "Single sample" }))));
  runtime.connectors.register(ai);
  await ai.connect({ endpoint: "https://agent.example", model: "test", allowDataSharing: true,
    scopes: [{ tenantId: "tenant-a", twinId: "0xtwin", fields: ["temperature"] }] });
  try {
    await runtime.ingestMqttMessage({ mapping: { twinId: "0xtwin", topic: "a", aspect: "telemetry", sampleType: "observed" },
      topic: "a", value: { temperature: 42 }, observedAt: Date.now() });
    ai.observe("tenant-a", runtime.realtime.latest("0xtwin")!);
    await vi.waitFor(() => expect(ai.latest("0xtwin")).not.toBeNull());
    const result = await request(runtime.app).get("/api/v1/twins/0xtwin/realtime/latest");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ payload: { temperature: 42 }, analysis: { kind: "ai-generated", summary: "Observed 42" } });
    expect(runtime.realtime.latest("0xtwin")).not.toHaveProperty("analysis");
    expect(result.headers["cache-control"]).toBe("no-store");
  } finally { await runtime.stop(); }
});
