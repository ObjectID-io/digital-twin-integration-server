import { describe, expect, it } from "vitest";
import { mqttMessageToState } from "../../src/twin/mqttMapping.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";

describe("incoming MQTT integration", () => {
  it("maps a fake broker message and publishes OIDTwinState", async () => {
    const objectid = new FakeObjectIdAdapter();
    const mapped = mqttMessageToState({
      mapping: { topic: "factory/+/temperature", twinId: "0xtwin", aspect: "telemetry", sampleType: "observed", qos: 1 },
      topic: "factory/motor1/temperature", value: { celsius: 42 }, observedAt: 100,
    });
    await objectid.publishState(mapped.twinId, mapped.state);
    expect(objectid.calls[0]).toMatchObject({ method: "publishState", twinId: "0xtwin" });
    expect(objectid.calls[0]!.input).toMatchObject({
      sourceUri: "objectid-connector://mqtt",
      payloadInline: "",
      payloadHash: "609251dd2304f4c177c1ec37acecdd9542673a1318afffa3b19ecdd73641d5b1",
    });
  });
});
