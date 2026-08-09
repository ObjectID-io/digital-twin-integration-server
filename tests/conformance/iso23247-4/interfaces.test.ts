import { describe, expect, it } from "vitest";
import { OpcUaConnector } from "../../../src/connectors/opcua.js";
import { NETWORK_TYPES, validateInterfaceInput } from "../../../src/twin/standardsValidation.js";

describe("ISO 23247-4 interface evidence", () => {
  it("DT-23247-4-001 models USER, SERVICE, ACCESS, and PROXIMITY independently from protocol", () => {
    for (const networkType of Object.values(NETWORK_TYPES)) expect(validateInterfaceInput({ networkType, protocol: "MQTT" })).toBeTruthy();
    expect(validateInterfaceInput({ networkType: NETWORK_TYPES.ACCESS, protocol: "OPC_UA" })).toBeTruthy();
  });

  it("DT-23247-4-002 exercises a real-library OPC-UA connector contract with a controlled client", async () => {
    const calls: string[] = [];
    const session = {
      browse: async () => ({ references: [] }), read: async () => ({ value: { value: 42 } }),
      write: async () => ({ isNotGood: () => false }), close: async () => { calls.push("session.close"); },
    };
    const connector = new OpcUaConnector(() => ({
      connect: async () => { calls.push("connect"); }, createSession: async () => session,
      disconnect: async () => { calls.push("disconnect"); },
    }));
    await connector.connect({ endpoint: "opc.tcp://localhost:4840", endpointMustExist: false });
    expect(await connector.browse({ nodeId: "RootFolder" })).toEqual({ references: [] });
    expect(await connector.read({ nodeId: "ns=2;s=Temperature" })).toBe(42);
    await connector.write({ nodeId: "ns=2;s=Setpoint", value: 40 });
    expect((await connector.healthCheck()).healthy).toBe(true);
    await connector.disconnect(); expect(calls).toEqual(["connect", "session.close", "disconnect"]);
  });
});
