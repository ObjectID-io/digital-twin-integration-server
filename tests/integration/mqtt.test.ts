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
    expect((objectid.calls[0]!.input as any).payloadInline).toBe('{"celsius":42}');
  });
});
