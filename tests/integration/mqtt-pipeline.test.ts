import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { AppError } from "../../src/common/errors.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";
import { testConfig } from "../fixtures/config.js";

describe("MQTT queue pipelines", () => {
  const directory = "./data/test-mqtt-pipeline";
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("queues a state mapping and publishes it through the worker", async () => {
    const adapter = new FakeObjectIdAdapter();
    const runtime = createApp(testConfig(), adapter);
    await runtime.ingestMqttMessage({
      mapping: { topic: "factory/+/temperature", twinId: "0xtwin", mode: "state", aspect: "telemetry", sampleType: "observed" },
      topic: "factory/motor1/temperature", value: { celsius: 42 }, observedAt: 100,
    });
    expect(runtime.queue.size()).toBe(1);
    await runtime.worker.processNext();
    expect(adapter.calls[0]).toMatchObject({ method: "publishState", twinId: "0xtwin" });
  });

  it("flushes dataset samples to off-chain storage without creating an on-chain event", async () => {
    const adapter = new FakeObjectIdAdapter();
    const runtime = createApp(testConfig({ dataset: { directory } }), adapter);
    const mapping = { topic: "factory/motor1/raw", twinId: "0xtwin", mode: "dataset" as const, datasetType: "telemetry", windowSeconds: 60 };
    await runtime.ingestMqttMessage({ mapping, topic: mapping.topic, value: { value: 40 }, observedAt: 100 });
    await runtime.ingestMqttMessage({ mapping, topic: mapping.topic, value: { value: 42 }, observedAt: 200 });
    await runtime.aggregator.flush("0xtwin:factory/motor1/raw");
    const stored = (await runtime.storage.listManagedObjects()).find((item) => item.twinId === "0xtwin" && ["dataset", "datasets"].includes(item.category))!;
    const bytes = await readFile(new URL(stored.uri));
    const content = JSON.parse(bytes.toString());
    expect(content.samples).toHaveLength(2);
    expect(content).toMatchObject({ twinId: "0xtwin", fromTimestamp: 100, toTimestamp: 200 });
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(adapter.calls.some((item) => item.method === "addDataset")).toBe(false);
  });

  it("retries a temporary pre-submission failure and eventually succeeds", async () => {
    class FlakyAdapter extends FakeObjectIdAdapter {
      failures = 1;
      override async publishState(twinId: string, input: unknown) {
        if (this.failures-- > 0) throw new AppError("RPC_TIMEOUT", "RPC timeout", 503, "NETWORK", { retryable: true, submissionUnknown: false });
        return super.publishState(twinId, input);
      }
    }
    const adapter = new FlakyAdapter();
    const runtime = createApp(testConfig(), adapter);
    await runtime.worker.enqueue(runtime.worker.createJob("PUBLISH_STATE", "0xtwin", { value: 1 }, "retry-1"));
    await runtime.worker.processNext();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.worker.processNext();
    expect(adapter.calls.filter((call) => call.method === "publishState")).toHaveLength(1);
    expect(runtime.worker.failedJobs).toHaveLength(0);
  });

  it("does not retry deterministic insufficient-credit failures", async () => {
    class CreditAdapter extends FakeObjectIdAdapter {
      override async publishState(_twinId: string, _input: unknown): Promise<never> {
        throw new AppError("OBJECTID_INSUFFICIENT_CREDIT", "Insufficient Credit", 402, "CREDIT");
      }
    }
    const runtime = createApp(testConfig(), new CreditAdapter());
    await runtime.worker.enqueue(runtime.worker.createJob("PUBLISH_STATE", "0xtwin", { value: 1 }, "credit-1"));
    await runtime.worker.processNext();
    expect(runtime.queue.size()).toBe(0);
    expect(runtime.worker.failedJobs[0]?.error.code).toBe("OBJECTID_INSUFFICIENT_CREDIT");
  });
});
