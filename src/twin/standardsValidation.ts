import { AppError } from "../common/errors.js";

export const COMPOSITION_TYPES = { INTEGRATED: 1, UNIFIED: 2, FEDERATED: 3 } as const;
export const NETWORK_TYPES = { USER: 1, SERVICE: 2, ACCESS: 3, PROXIMITY: 4, OTHER: 255 } as const;

export function validateCompositionInput(input: any) {
  const value = Number(input?.compositionType ?? input?.composition_type);
  if (!Object.values(COMPOSITION_TYPES).includes(value as any)) {
    throw new AppError("COMPOSITION_TYPE_INVALID", "compositionType must be INTEGRATED(1), UNIFIED(2), or FEDERATED(3)", 422, "VALIDATION");
  }
  return input;
}

export function validateInterfaceInput(input: any) {
  const value = Number(input?.networkType ?? input?.network_type);
  if (!Object.values(NETWORK_TYPES).includes(value as any)) {
    throw new AppError("NETWORK_TYPE_INVALID", "networkType must identify USER, SERVICE, ACCESS, PROXIMITY, or OTHER", 422, "VALIDATION");
  }
  if (!String(input?.protocol ?? "").trim()) throw new AppError("INTERFACE_PROTOCOL_REQUIRED", "protocol is required", 422, "VALIDATION");
  return input;
}

export function validateIdentifierMappingInput(input: any) {
  const source = String(input?.sourceIdentifierId ?? input?.source_identifier_id ?? "");
  const target = String(input?.targetIdentifierId ?? input?.target_identifier_id ?? "");
  if (!source || !target) throw new AppError("IDENTIFIER_MAPPING_INVALID", "source and target identifier IDs are required", 422, "VALIDATION");
  if (source.toLowerCase() === target.toLowerCase()) throw new AppError("IDENTIFIER_SELF_MAPPING", "an identifier cannot map to itself", 422, "VALIDATION");
  return input;
}
