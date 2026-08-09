import { AppError } from "../common/errors.js";
import { identifierResolutionFailures, identifierResolutions } from "../health/metrics.js";
import type { ObjectIdAdapter } from "../objectid/types.js";
import type { TwinIndexer } from "../indexer/types.js";

function fieldsOf(value: any) { return value?.data?.content?.fields ?? value?.content?.fields ?? value?.fields ?? {}; }
function idOf(value: any) { return String(value?.data?.objectId ?? value?.objectId ?? fieldsOf(value).id ?? ""); }
const mappingTypes: Record<string, string> = { "1": "EQUIVALENT", "2": "ALIAS", "3": "RESOLVES_TO", "4": "DERIVED_FROM", "5": "EXTERNAL" };

export class IdentifierResolver {
  constructor(private readonly objectid: ObjectIdAdapter, private readonly indexer?: TwinIndexer) {}

  async getTwinIdentifiers(twinId: string) { return this.objectid.getTwinChildren(twinId, "OIDTwinIdentifier"); }

  async resolve(twinId: string, scheme: string, value: string) {
    return (await this.getTwinIdentifiers(twinId)).filter((item) => identifierMatches(item, scheme, value));
  }

  async resolveGlobal(scheme: string, value: string) {
    identifierResolutions.inc({ mode: "global" });
    try {
      const matches = await this.findIndexed(scheme, value);
      if (!matches.length) throw new AppError("IDENTIFIER_NOT_FOUND", "Identifier was not found", 404, "OBJECTID");
      return { twinId: matches[0]!.twinId, source: { scheme, value }, matches };
    } catch (error) { identifierResolutionFailures.inc({ mode: "global" }); throw error; }
  }

  async resolveTo(twinId: string, sourceScheme: string, value: string, targetScheme: string) {
    const { source, mapping, target } = await this.resolveWithinTwin(twinId, sourceScheme, value, targetScheme);
    return { source, mapping, target };
  }

  async resolveToGlobal(sourceScheme: string, value: string, targetScheme: string) {
    identifierResolutions.inc({ mode: "cross_scheme" });
    try {
      const matches = await this.findIndexed(sourceScheme, value);
      const found = matches[0];
      if (!found) throw new AppError("IDENTIFIER_NOT_FOUND", "Source identifier was not found", 404, "OBJECTID");
      const { mapping, target } = await this.resolveWithinTwin(found.twinId, sourceScheme, value, targetScheme);
      const targetFields = fieldsOf(target);
      const mappingFields = fieldsOf(mapping);
      return {
        twinId: found.twinId,
        source: { scheme: sourceScheme, value },
        matches: [{
          scheme: String(targetFields.scheme),
          value: String(targetFields.value),
          mappingType: mappingTypes[String(mappingFields.mapping_type)] ?? String(mappingFields.mapping_type ?? "UNKNOWN"),
        }],
      };
    } catch (error) { identifierResolutionFailures.inc({ mode: "cross_scheme" }); throw error; }
  }

  private async resolveWithinTwin(twinId: string, sourceScheme: string, value: string, targetScheme: string) {
    const identifiers = await this.getTwinIdentifiers(twinId);
    const source = identifiers.find((item) => identifierMatches(item, sourceScheme, value));
    if (!source) throw new AppError("IDENTIFIER_NOT_FOUND", "Source identifier was not found", 404, "OBJECTID");
    const mappings = await this.objectid.getTwinChildren(twinId, "OIDTwinIdentifierMapping");
    const mapping = mappings.find((item) => String(fieldsOf(item).source_identifier_id) === idOf(source));
    if (!mapping) throw new AppError("IDENTIFIER_MAPPING_NOT_FOUND", "Identifier mapping was not found", 404, "OBJECTID");
    const target = identifiers.find((item) => idOf(item) === String(fieldsOf(mapping).target_identifier_id));
    if (!target || String(fieldsOf(target).scheme).toLowerCase() !== targetScheme.toLowerCase()) {
      throw new AppError("TARGET_IDENTIFIER_NOT_FOUND", "Mapped target identifier was not found", 404, "OBJECTID");
    }
    return { source, mapping, target };
  }

  private async findIndexed(scheme: string, value: string) {
    if (this.indexer) return this.indexer.findTwinByIdentifier(scheme, value);
    const found = await this.objectid.findTwinByIdentifier(scheme, value);
    return found ? [found] : [];
  }
}

function identifierMatches(item: unknown, scheme: string, value: string) {
  const fields = fieldsOf(item);
  return String(fields.scheme).toLowerCase() === scheme.toLowerCase() && String(fields.value) === value;
}
