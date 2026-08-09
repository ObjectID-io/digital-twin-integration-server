import { describe, expect, it } from "vitest";
import { IdentifierResolver } from "../../../src/resolver/service.js";
import { ObjectIdTwinIndexer } from "../../../src/indexer/objectid.js";
import { validateIdentifierMappingInput } from "../../../src/twin/standardsValidation.js";
import { FakeObjectIdAdapter } from "../../fixtures/fakeObjectId.js";
import { testConfig } from "../../fixtures/config.js";

describe("ISO/IEC 30181 identifier evidence", () => {
  it("DT-30181-001 resolves globally and across schemes through the indexer", async () => {
    const adapter = new FakeObjectIdAdapter();
    adapter.identifierIndex.set("sap:EQ-42", { twinId: "0xtwin", identifier: { objectId: "0xsap" } });
    adapter.setChildren("0xtwin", "OIDTwinIdentifier", [
      { objectId: "0xsap", fields: { scheme: "SAP", value: "EQ-42" } },
      { objectId: "0xgs1", fields: { scheme: "GS1", value: "09506000134352" } },
    ]);
    adapter.setChildren("0xtwin", "OIDTwinIdentifierMapping", [{ fields: { source_identifier_id: "0xsap", target_identifier_id: "0xgs1", mapping_type: 1 } }]);
    const resolver = new IdentifierResolver(adapter, new ObjectIdTwinIndexer(adapter, testConfig()));
    expect(await resolver.resolveGlobal("SAP", "EQ-42")).toMatchObject({ twinId: "0xtwin" });
    expect(await resolver.resolveToGlobal("SAP", "EQ-42", "GS1")).toMatchObject({ matches: [{ scheme: "GS1" }] });
  });

  it("DT-30181-002 rejects incomplete and self mappings before chain submission", () => {
    expect(() => validateIdentifierMappingInput({ sourceIdentifierId: "0xa", targetIdentifierId: "0xa" })).toThrowError(/itself/);
    expect(() => validateIdentifierMappingInput({ sourceIdentifierId: "0xa" })).toThrowError(/required/);
  });
});
