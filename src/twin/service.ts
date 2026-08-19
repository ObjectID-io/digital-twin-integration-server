import { createHash } from "node:crypto";
import type { AccountingContext, ObjectIdAdapter } from "../objectid/types.js";
import type { ProfileRegistry } from "../schemas/registry.js";
import type { StorageProvider } from "../storage/types.js";
import { AppError } from "../common/errors.js";

export class TwinService {
  constructor(
    private readonly objectid: ObjectIdAdapter,
    private readonly profiles: ProfileRegistry,
    private readonly storage: StorageProvider,
  ) {}

  getTwin(id: string) { return this.objectid.getTwin(id); }
  findTwinsByDid(did: string) { return this.objectid.findTwinsByDid(did); }
  createTwin(input: unknown, accounting?: AccountingContext) { return this.objectid.createTwin(input, accounting); }
  updateTwin(id: string, input: unknown, accounting?: AccountingContext) { return this.objectid.updateTwin(id, input, accounting); }
  publishState(id: string, input: unknown, accounting?: AccountingContext) { return this.objectid.publishState(id, input, accounting); }

  async registerBusinessEvent(twinId: string, input: any, accounting?: AccountingContext) {
    if (input.payloadData === undefined) return this.objectid.emitTwinEvent(twinId, input, accounting);
    const stored = await this.storage.store({
      data: bytesOf(input.payloadData), contentType: input.contentType ?? "application/json",
      fileName: input.fileName ?? "event-payload.json", category: "event-payload", twinId,
    });
    return this.objectid.emitTwinEvent(twinId, {
      ...input, payloadData: undefined, payloadRef: stored.uri, payloadHash: stored.hash,
      payloadSize: stored.size, contentType: stored.contentType,
    }, accounting);
  }

  async createProfiledTwin(input: any, accounting?: AccountingContext) {
    if (input.profile) await this.profiles.validate(String(input.profile), input);
    const twin = await this.objectid.createTwin(input, accounting);
    if (input.profile) {
      await this.objectid.addAspect(String((twin as any)?.id ?? input.id ?? ""), {
        aspectCode: "iso23247_ome", aspectType: "observable-manufacturing-element",
        schemaUri: input.profile, semanticRef: "ISO23247:OME", immutableMetadata: JSON.stringify({ profileId: input.profile }),
      }, accounting);
    }
    return twin;
  }

  async validateBoundProfile(twinId: string, profileId: string, payload: unknown) {
    const twin = await this.objectid.getTwin(twinId);
    if (!twin) throw new AppError("TWIN_NOT_FOUND", "Twin was not found", 404, "OBJECTID");
    const profile = await this.profiles.getProfile(profileId);
    const aspects = await this.objectid.getTwinChildren(twinId, "OIDTwinAspect");
    const bound = aspects.some((aspect: any) => {
      const fields = aspect?.data?.content?.fields ?? aspect?.content?.fields ?? aspect?.fields ?? {};
      return String(fields.aspect_code ?? fields.aspectCode ?? "") === "iso23247_ome"
        && [profileId, profile.semanticReference].includes(String(fields.schema_uri ?? fields.schemaUri ?? ""));
    });
    if (!bound) throw new AppError("PROFILE_NOT_BOUND", `Profile '${profileId}' is not bound to Twin '${twinId}'`, 422, "SCHEMA");
    return this.profiles.validateAgainstProfile(profileId, payload);
  }

  async registerDataset(twinId: string, input: any, accounting?: AccountingContext) {
    if (input.data !== undefined) {
      const stored = await this.storage.store({
        data: Buffer.from(JSON.stringify(input.data)), contentType: input.contentType ?? "application/json",
        fileName: input.fileName ?? "dataset.json", category: "dataset", twinId,
        metadata: { datasetType: String(input.datasetType ?? "dataset") },
      });
      return this.objectid.addDataset(twinId, {
        ...input, data: undefined, storageUri: stored.uri, payloadHash: stored.hash,
        payloadSize: stored.size, hashAlgorithm: stored.hashAlgorithm, contentType: stored.contentType,
      }, accounting);
    }
    if (input.payload && !input.payloadHash) input.payloadHash = `sha256:${createHash("sha256").update(String(input.payload)).digest("hex")}`;
    return this.objectid.addDataset(twinId, input, accounting);
  }

  async registerModel(twinId: string, input: any, accounting?: AccountingContext) {
    if (input.data === undefined) return this.objectid.addModel(twinId, input, accounting);
    const stored = await this.storage.store({
      data: bytesOf(input.data), contentType: input.contentType ?? "application/octet-stream",
      fileName: input.fileName ?? "model.bin", category: "model", twinId,
      metadata: { modelType: String(input.modelType ?? "model") },
    });
    return this.objectid.addModel(twinId, {
      ...input, data: undefined, storageUri: stored.uri, payloadHash: stored.hash,
      payloadSize: stored.size, hashAlgorithm: stored.hashAlgorithm, contentType: stored.contentType,
    }, accounting);
  }
}

function bytesOf(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
}
