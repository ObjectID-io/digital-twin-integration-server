import { access, readdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import { AppError } from "../common/errors.js";

const require = createRequire(import.meta.url);
const AjvModule = require("ajv/dist/2020") as any;
const FormatsModule = require("ajv-formats") as any;
const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = FormatsModule.default ?? FormatsModule;

export type ProfileStatus = "experimental" | "validated" | "deprecated";
export type ProfileType = "VALIDATION_PROFILE" | "MATURITY_PROFILE" | "INTERFACE_PROFILE" | string;

export interface ProfileManifest {
  id: string;
  version: string;
  standard: string;
  type: ProfileType;
  description: string;
  schema?: string;
  definition?: string;
  semanticReference: string;
  status: ProfileStatus;
}

export interface ProfileValidation {
  profile: string;
  version: string;
  valid: boolean;
  errors: Array<{ path: string; code: string; message: string }>;
}

interface RegisteredProfile { manifest: ProfileManifest; manifestPath: string }

export class IsoProfileRegistry {
  private readonly ajv: any;
  private readonly validators = new Map<string, ValidateFunction>();
  private profiles?: Map<string, RegisteredProfile>;

  constructor(private readonly directory: string) {
    this.ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  async listProfiles() {
    await this.ensureLoaded();
    return [...new Map([...this.profiles!.values()].map(({ manifest }) => [manifest.id, manifest])).values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async getProfile(id: string) {
    await this.ensureLoaded();
    const registered = this.profiles!.get(id);
    if (!registered) throw new AppError("PROFILE_NOT_FOUND", `Profile '${id}' was not found`, 404, "SCHEMA");
    return registered.manifest;
  }

  async getProfileVersion(id: string) { return (await this.getProfile(id)).version; }

  async loadSchema(id: string): Promise<Record<string, any>> {
    await this.ensureLoaded();
    const registered = this.profiles!.get(id);
    if (!registered) throw new AppError("PROFILE_NOT_FOUND", `Profile '${id}' was not found`, 404, "SCHEMA");
    if (registered.manifest.type !== "VALIDATION_PROFILE" || !registered.manifest.schema) {
      throw new AppError("PROFILE_NOT_VALIDATABLE", `Profile '${id}' is not a validation profile`, 422, "SCHEMA");
    }
    const schemaPath = resolve(dirname(registered.manifestPath), registered.manifest.schema);
    this.assertInsideRegistry(schemaPath);
    return JSON.parse(await readFile(schemaPath, "utf8"));
  }

  async validateAgainstProfile(id: string, payload: unknown): Promise<ProfileValidation> {
    const manifest = await this.getProfile(id);
    if (manifest.type !== "VALIDATION_PROFILE") throw new AppError("PROFILE_NOT_VALIDATABLE", `Profile '${id}' is not a validation profile`, 422, "SCHEMA");
    let validate = this.validators.get(manifest.id);
    if (!validate) {
      validate = this.ajv.compile(await this.loadSchema(id)) as ValidateFunction;
      this.validators.set(manifest.id, validate);
    }
    const valid = Boolean(validate(payload));
    return {
      profile: id,
      version: manifest.version,
      valid,
      errors: valid ? [] : (validate.errors ?? []).map((error) => ({
        path: error.instancePath || "/",
        code: error.keyword,
        message: error.message ?? "schema validation failed",
      })),
    };
  }

  async getDefinition(id: string): Promise<Record<string, any>> {
    await this.ensureLoaded();
    const registered = this.profiles!.get(id);
    if (!registered) throw new AppError("PROFILE_NOT_FOUND", `Profile '${id}' was not found`, 404, "SCHEMA");
    if (!registered.manifest.definition) throw new AppError("PROFILE_DEFINITION_UNAVAILABLE", `Profile '${id}' has no definition`, 422, "SCHEMA");
    const path = resolve(dirname(registered.manifestPath), registered.manifest.definition);
    this.assertInsideRegistry(path);
    return JSON.parse(await readFile(path, "utf8"));
  }

  async getMaturityDefinition(id: string) {
    const profile = await this.getProfile(id);
    if (profile.type !== "MATURITY_PROFILE") throw new AppError("PROFILE_TYPE_MISMATCH", `Profile '${id}' is not a maturity profile`, 422, "SCHEMA");
    return this.getDefinition(id);
  }

  async getInterfaceDefinition(id: string) {
    const profile = await this.getProfile(id);
    if (profile.type !== "INTERFACE_PROFILE") throw new AppError("PROFILE_TYPE_MISMATCH", `Profile '${id}' is not an interface profile`, 422, "SCHEMA");
    return this.getDefinition(id);
  }

  async isReady() {
    try { await access(resolve(this.directory)); await this.ensureLoaded(); return true; } catch { return false; }
  }

  private async ensureLoaded() {
    if (this.profiles) return;
    const profiles = new Map<string, RegisteredProfile>();
    for (const manifestPath of await findFiles(resolve(this.directory), "manifest.json")) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfileManifest;
      validateManifest(manifest, manifestPath);
      if (profiles.has(manifest.id)) throw new AppError("PROFILE_ID_DUPLICATE", `Duplicate profile '${manifest.id}'`, 500, "SCHEMA");
      profiles.set(manifest.id, { manifest, manifestPath });
      profiles.set(manifest.semanticReference, { manifest, manifestPath });
    }
    this.profiles = profiles;
  }

  private assertInsideRegistry(path: string) {
    const root = resolve(this.directory) + sep;
    if (!path.startsWith(root)) throw new AppError("PROFILE_PATH_INVALID", "Profile path escapes registry", 400, "SCHEMA");
  }
}

async function findFiles(directory: string, name: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? findFiles(resolve(directory, entry.name), name)
    : Promise.resolve(entry.name === name ? [resolve(directory, entry.name)] : [])));
  return nested.flat();
}

function validateManifest(value: ProfileManifest, path: string) {
  const required: Array<keyof ProfileManifest> = ["id", "version", "standard", "type", "description", "semanticReference", "status"];
  for (const key of required) if (!value[key]) throw new AppError("PROFILE_MANIFEST_INVALID", `${path}: missing '${key}'`, 500, "SCHEMA");
  if (value.type === "VALIDATION_PROFILE" && !value.schema) throw new AppError("PROFILE_MANIFEST_INVALID", `${path}: validation profile requires 'schema'`, 500, "SCHEMA");
  if (value.type !== "VALIDATION_PROFILE" && !value.definition) throw new AppError("PROFILE_MANIFEST_INVALID", `${path}: definition profile requires 'definition'`, 500, "SCHEMA");
  if (!["experimental", "validated", "deprecated"].includes(value.status)) {
    throw new AppError("PROFILE_MANIFEST_INVALID", `${path}: invalid status '${value.status}'`, 500, "SCHEMA");
  }
}
