import { describe, expect, it } from "vitest";
import { IdentifierResolver } from "../../src/resolver/service.js";
import { FakeObjectIdAdapter } from "../fixtures/fakeObjectId.js";

describe("identifier resolution", () => {
  it("resolves a GS1 identifier to an ERP identifier from ObjectID mappings", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.setChildren("0xtwin", "OIDTwinIdentifier", [
      { objectId: "0xgs1", fields: { scheme: "GS1", value: "09506000134352" } },
      { objectId: "0xerp", fields: { scheme: "SAP", value: "EQ-42" } },
    ]);
    adapter.setChildren("0xtwin", "OIDTwinIdentifierMapping", [{ fields: { source_identifier_id: "0xgs1", target_identifier_id: "0xerp" } }]);
    const result = await new IdentifierResolver(adapter).resolveTo("0xtwin", "GS1", "09506000134352", "SAP");
    expect((result.target as any).fields.value).toBe("EQ-42");
  });

  it("uses the ObjectID indexer for global cross-scheme resolution", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.identifierIndex.set("sap:EQ-42", { twinId: "0xtwin", identifier: { objectId: "0xsap" } });
    adapter.setChildren("0xtwin", "OIDTwinIdentifier", [
      { objectId: "0xsap", fields: { scheme: "SAP", value: "EQ-42" } },
      { objectId: "0xgs1", fields: { scheme: "GS1", value: "09506000134352" } },
    ]);
    adapter.setChildren("0xtwin", "OIDTwinIdentifierMapping", [{ fields: { source_identifier_id: "0xsap", target_identifier_id: "0xgs1", mapping_type: 1 } }]);
    const result = await new IdentifierResolver(adapter).resolveToGlobal("SAP", "EQ-42", "GS1");
    expect(result).toMatchObject({ twinId: "0xtwin", matches: [{ scheme: "GS1", value: "09506000134352", mappingType: "EQUIVALENT" }] });
  });
});
