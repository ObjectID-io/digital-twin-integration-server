import { AppError } from "../common/errors.js";

export interface CleanupChild { id: string; type: string; fields: Record<string, any> }
export interface CleanupCall { name: string; ids: string[] }
const simple: Record<string, string> = {
  OIDTwinAspect: "cleanup_aspect", OIDTwinRelation: "cleanup_relation",
  OIDTwinIdentifier: "cleanup_identifier", OIDTwinModelRef: "cleanup_model_ref",
  OIDTwinDataset: "cleanup_dataset", OIDTwinCommand: "cleanup_command",
  OIDTwinComposition: "cleanup_composition", OIDTwinIdentifierMapping: "cleanup_identifier_mapping",
  OIDTwinRoleGrant: "cleanup_role_grant", OIDTwinState: "cleanup_state",
  OIDTwinFidelityProfile: "cleanup_fidelity_profile", OIDTwinMaturityAssessment: "cleanup_maturity_assessment",
  OIDTwinEvent: "remove_event",
};

/** Select a bounded batch. Receiving parents are never reused inside a PTB. */
export function planCleanup(children: CleanupChild[], packageId: string): CleanupCall[] {
  const prefix = `${packageId}::oid_twin::`;
  const byId = new Map(children.map(child => [child.id, child]));
  const kind = (child: CleanupChild) => child.type.startsWith(prefix) ? child.type.slice(prefix.length) : "";
  const parent = (child: CleanupChild, key: string, expected: string) => {
    const id = String(child.fields[key] ?? "");
    if (kind(byId.get(id) ?? { id, type: "", fields: {} }) !== expected) throw invalid("Missing cleanup parent");
    return id;
  };
  // Validate every entry before preparing irreversible cleanup.
  for (const child of children) {
    const type = kind(child);
    if (!simple[type] && !["OIDTwinCompositionMember", "OIDTwinMaturityIndicator", "OIDTwinInterface", "OIDTwinInterfaceNetwork"].includes(type)) throw invalid("Unknown registered child type");
    if (type === "OIDTwinCompositionMember") parent(child, "composition_id", "OIDTwinComposition");
    if (type === "OIDTwinMaturityIndicator") parent(child, "assessment_id", "OIDTwinMaturityAssessment");
    if (type === "OIDTwinInterfaceNetwork") parent(child, "interface_id", "OIDTwinInterface");
  }
  const member = children.find(c => kind(c) === "OIDTwinCompositionMember");
  if (member) return [{ name: "cleanup_composition_member", ids: [parent(member, "composition_id", "OIDTwinComposition"), member.id] }];
  const indicator = children.find(c => kind(c) === "OIDTwinMaturityIndicator");
  if (indicator) return [{ name: "cleanup_maturity_indicator", ids: [parent(indicator, "assessment_id", "OIDTwinMaturityAssessment"), indicator.id] }];
  const calls: CleanupCall[] = [];
  for (const child of children) {
    const type = kind(child);
    if (type === "OIDTwinInterfaceNetwork") continue;
    if (type === "OIDTwinInterface") {
      const networks = children.filter(c => kind(c) === "OIDTwinInterfaceNetwork" && c.fields.interface_id === child.id);
      if (networks.length > 1) throw invalid("Duplicate interface network");
      calls.push({ name: networks.length ? "cleanup_interface_v2" : "cleanup_interface", ids: [child.id, ...networks.map(n => n.id)] });
    } else calls.push({ name: simple[type]!, ids: [child.id] });
  }
  return calls.sort((a, b) => Number(a.name === "remove_event") - Number(b.name === "remove_event")).slice(0, 16);
}

function invalid(message: string) { return new AppError("OBJECTID_CLEANUP_INCOMPLETE", message, 409, "OBJECTID"); }
