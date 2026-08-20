import { describe, expect, it } from "vitest";
import { dynamicTenantMapping, mqttMatch } from "../../src/connectors/mqtt.js";
import { mqttMessageToState } from "../../src/twin/mqttMapping.js";
import { OpcUaConnector } from "../../src/connectors/opcua.js";
import { opcuaSubscriptionErrors } from "../../src/health/metrics.js";

describe("connector mappings", () => {
  it("supports MQTT wildcards", () => { expect(mqttMatch("factory/+/temperature", "factory/m1/temperature")).toBe(true); expect(mqttMatch("factory/#", "factory/line/m1/temp")).toBe(true); });
  it("maps MQTT data to OIDTwinState input", () => {
    const result = mqttMessageToState({ mapping: { topic: "factory/#", twinId: "0xtwin", aspect: "telemetry", sampleType: "observed" }, topic: "factory/m1/temp", value: 42, observedAt: 100 });
    expect(result.twinId).toBe("0xtwin"); expect(result.state.payloadInline).toBe("42");
  });
  it("extracts and validates tenant-scoped MQTT topics", () => {
    const twinId = `0x${"a".repeat(64)}`;
    expect(dynamicTenantMapping({ topic: "objectid/tenants/+/twins/+/telemetry/state", twinId: "dynamic", dynamicTenantTopic: true }, `objectid/tenants/free-a/twins/${twinId}/telemetry/state`)).toMatchObject({ tenantId: "free-a", twinId, mode: "state" });
    expect(dynamicTenantMapping({ topic: "#", twinId: "dynamic" }, "objectid/tenants/free-a/twins/not-an-id/telemetry/state")).toBeUndefined();
  });
  it("observes OPC-UA subscription callback failures", async () => {
    let changed: ((value: any) => void) | undefined;
    const session = { read: async () => ({ value: { value: new Date() } }), close: async () => undefined };
    const connector = new OpcUaConnector(
      () => ({ connect: async () => undefined, createSession: async () => session, disconnect: async () => undefined }),
      {
        createSubscription: () => ({ terminate: async () => undefined }),
        createMonitoredItem: () => ({ on: (_name: string, handler: (value: any) => void) => { changed = handler; } }),
      },
    );
    await connector.connect({ endpoint: "opc.tcp://localhost:4840", mappings: [{ nodeId: "ns=2;s=x", twinId: "0xtwin" }] });
    const before = (await opcuaSubscriptionErrors.get()).values.reduce((sum, item) => sum + Number(item.value), 0);
    const subscription = await connector.subscribe(async () => { throw new Error("pipeline failed"); });
    changed?.({ value: { value: 1 } }); await new Promise((resolve) => setTimeout(resolve, 0));
    const after = (await opcuaSubscriptionErrors.get()).values.reduce((sum, item) => sum + Number(item.value), 0);
    expect(after).toBe(before + 1);
    await subscription.close(); await connector.disconnect();
  });
});
