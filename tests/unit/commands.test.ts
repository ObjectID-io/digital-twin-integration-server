import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import type { TwinConnector } from "../../src/connectors/types.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "objectid-commands-"));
  const writes: any[] = [];
  const mqtt: TwinConnector = { type: "mqtt", async connect() {}, async read() {}, async write(value) { writes.push(value); }, async healthCheck() { return { healthy: true, checkedAt: new Date().toISOString() }; }, async disconnect() {} };
  const service = new CommandService({
    enabled: true,
    storeFile: join(directory, "commands.json"),
    requestTopicTemplate: "objectid/twins/{twinId}/commands/request",
    resultTopic: "objectid/twins/+/commands/+/result",
    catalogs: [{
      twinId: "0xtwin",
      interfaceId: "urn:test",
      commands: [{
        name: "setMode", version: "1.0", riskClass: "operational", timeoutSeconds: 30,
        parametersSchema: { type: "object", required: ["mode"], additionalProperties: false, properties: { mode: { enum: ["automatic", "maintenance"] } } },
      }],
    }],
  }, mqtt);
  return { directory, writes, service };
}

describe("ObjectID command service", () => {
  it("validates, persists and dispatches an allowlisted command with QoS 1", async () => {
    const { directory, writes, service } = await fixture();
    const value = await service.create("0xtwin", "did:iota:testnet:0xcaller", { command: { name: "setMode", version: "1.0", parameters: { mode: "maintenance" } } });
    expect(value.status).toBe("dispatched");
    expect(writes[0]).toMatchObject({ topic: "objectid/twins/0xtwin/commands/request", qos: 1, retain: false });
    expect(JSON.parse(await readFile(join(directory, "commands.json"), "utf8"))[0].requestedBy.did).toBe("did:iota:testnet:0xcaller");
  });

  it("rejects unknown, invalid and safety commands", async () => {
    const { service } = await fixture();
    await expect(service.create("0xtwin", "did:a", { command: { name: "unknown", parameters: {} } })).rejects.toThrow(/not present/);
    await expect(service.create("0xtwin", "did:a", { command: { name: "setMode", version: "1.0", parameters: { mode: "unsafe" } } })).rejects.toThrow(/do not match/);
  });
});
