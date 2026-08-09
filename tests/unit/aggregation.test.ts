import { describe, expect, it, vi } from "vitest";
import { DatasetWindowAggregator } from "../../src/twin/datasetAggregator.js";

describe("stream dataset aggregation", () => {
  it("flushes a disposable window to storage and ObjectID callback", async () => {
    const store = vi.fn(async () => ({ uri: "file:///dataset.json", hash: "sha256:test" }));
    const commit = vi.fn(async () => undefined);
    const aggregator = new DatasetWindowAggregator(60_000, { store }, commit);
    aggregator.ingest("0xtwin:temperature", 40, { datasetType: "telemetry" }, 100);
    aggregator.ingest("0xtwin:temperature", 42, {}, 200);
    await aggregator.flush("0xtwin:temperature");
    expect(store).toHaveBeenCalledWith("[40,42]");
    expect(commit).toHaveBeenCalledWith("0xtwin:temperature", expect.objectContaining({ sampleCount: 2, periodFrom: 100, periodTo: 200 }));
  });
});
