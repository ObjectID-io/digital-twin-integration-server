import { AppError } from "../common/errors.js";
import type { ObjectIdAdapter, TwinRoleGrant } from "../objectid/types.js";

export enum TwinAction {
  PublishState = "publish_state",
  AddDataset = "add_dataset",
  AddModel = "add_model",
  AddInterface = "add_interface",
  EmitMaintenanceEvent = "emit_maintenance_event",
  EmitBusinessEvent = "emit_business_event",
  CreateMaturityAssessment = "maturity_assessment",
  ModifyComposition = "modify_composition",
  ModifyIdentifierMapping = "modify_identifier_mapping",
  ModifyMetadata = "modify_metadata",
  DeleteTwin = "delete_twin",
  ExecuteCommand = "execute_command",
}
export type TwinActionValue = `${TwinAction}`;
export interface TwinAuthorizationContext { callerDid: string; ownerDid?: string; stewardDid?: string; grants: TwinRoleGrant[] }

const permissions: Record<string, TwinAction[]> = {
  OWNER: Object.values(TwinAction),
  STEWARD: Object.values(TwinAction),
  OPERATOR: [TwinAction.PublishState, TwinAction.EmitBusinessEvent, TwinAction.ExecuteCommand],
  MAINTAINER: [TwinAction.PublishState, TwinAction.AddDataset, TwinAction.EmitMaintenanceEvent, TwinAction.ExecuteCommand],
  DATA_PROVIDER: [TwinAction.PublishState, TwinAction.AddDataset],
  MODEL_PROVIDER: [TwinAction.AddModel],
  SERVICE_PROVIDER: [TwinAction.AddInterface],
  CERTIFIER: [TwinAction.CreateMaturityAssessment, TwinAction.EmitBusinessEvent],
  AUDITOR: [],
};

const numericRoles: Record<string, string> = {
  "1": "OWNER", "2": "STEWARD", "4": "OPERATOR", "5": "MAINTAINER", "6": "DATA_PROVIDER",
  "7": "MODEL_PROVIDER", "8": "SERVICE_PROVIDER", "9": "CERTIFIER", "10": "AUDITOR",
};

export class PolicyEngine {
  assertAllowed(context: TwinAuthorizationContext, action: TwinActionValue, now = Date.now()) {
    const nativeAuthority = context.callerDid === context.ownerDid || context.callerDid === context.stewardDid;
    const allowedByGrant = context.grants.some((grant) =>
      grant.subjectDid === context.callerDid &&
      (!grant.validFrom || grant.validFrom <= now) &&
      (!grant.validTo || grant.validTo === 0 || grant.validTo >= now) &&
      (permissions[numericRoles[String(grant.roleType)] ?? String(grant.roleType).toUpperCase()] ?? []).includes(action as TwinAction));
    if (!nativeAuthority && !allowedByGrant) {
      throw new AppError(
        "TWIN_POLICY_DENIED",
        "Caller is not allowed to perform this operation; local policy denies the requested action",
        403,
        "AUTHORIZATION",
        { action, twinId: context.grants[0]?.twinId },
      );
    }
    return true;
  }
}

export class TwinPolicyAuthorizer {
  private readonly cache = new Map<string, { expiresAt: number; grants: TwinRoleGrant[] }>();
  constructor(
    private readonly objectid: ObjectIdAdapter,
    private readonly engine = new PolicyEngine(),
    private readonly ttlMs = 15_000,
  ) {}

  async assertAllowed(twinId: string, subjectDid: string, action: TwinAction) {
    const twin = await this.objectid.getTwin(twinId);
    if (!twin) throw new AppError("TWIN_NOT_FOUND", "Twin was not found", 404, "OBJECTID");
    const now = Date.now();
    let cached = this.cache.get(twinId);
    if (!cached || cached.expiresAt <= now) {
      cached = { grants: await this.objectid.getTwinRoleGrants(twinId), expiresAt: now + this.ttlMs };
      this.cache.set(twinId, cached);
    }
    const fields = fieldsOf(twin);
    return this.engine.assertAllowed({
      callerDid: subjectDid,
      ownerDid: optionalDid(fields.owner_did ?? fields.ownerDid),
      stewardDid: optionalDid(fields.steward_did ?? fields.stewardDid),
      grants: cached.grants,
    }, action, now);
  }
}

function fieldsOf(value: any) { return value?.data?.content?.fields ?? value?.content?.fields ?? value?.fields ?? value ?? {}; }
function optionalDid(value: unknown) { return value === undefined || value === null || value === "" ? undefined : String(value); }
