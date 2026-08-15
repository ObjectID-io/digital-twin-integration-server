import { describe, expect, it, vi } from "vitest";
import { TwinRealtimeHub } from "../../src/realtime/hub.js";

describe("TwinRealtimeHub", () => {
  it("keeps the latest mapped payload and notifies Twin-scoped subscribers", () => {
    const hub = new TwinRealtimeHub();
    const subscriber = vi.fn();
    const unsubscribe = hub.subscribe("0xtwin", subscriber);
    const event = hub.publish({
      mapping: { topic: "factory/+/telemetry", twinId: "0xtwin", mode: "dataset", datasetType: "telemetry" },
      topic: "factory/cnc-1/telemetry", value: { temperature: 42 }, observedAt: 100,
    });
    expect(hub.latest("0xtwin")).toEqual(event);
    expect(subscriber).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(hub.subscriberCount("0xtwin")).toBe(0);
  });

  it("preserves encrypted envelopes without decrypting them", () => {
    const hub = new TwinRealtimeHub();
    const payload = { version: 1, encrypted: true, algorithm: "AES-256-GCM", keyId: "device-2026", nonce: "AA==", ciphertext: "AQ==", authTag: "Ag==" };
    const event = hub.publish({
      mapping: { topic: "factory/device", twinId: "0xtwin", aspect: "telemetry", sampleType: "encrypted" },
      topic: "factory/device", value: payload, observedAt: 200,
    });
    expect(event.payload).toEqual(payload);
    expect(event.encryption).toEqual({ encrypted: true, algorithm: "AES-256-GCM", keyId: "device-2026", version: 1 });
  });
});
