import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { AppError } from "../common/errors.js";
import { IsoProfileRegistry } from "../profiles/registry.js";

export class ProfileRegistry extends IsoProfileRegistry {
  constructor(private readonly legacyDirectory: string) { super(legacyDirectory); }

  private pathFor(uri: string) {
    const match = /^objectid-profile:\/\/([^/]+)\/(.+)\/v(\d+)$/.exec(uri);
    if (!match) throw new AppError("PROFILE_URI_INVALID", `Invalid profile URI '${uri}'`, 400, "SCHEMA");
    const [, group, name, version] = match;
    const path = resolve(this.legacyDirectory, group!, `${name!.replaceAll("/", "-")}-v${version}.json`);
    const root = resolve(this.legacyDirectory) + sep;
    if (!path.startsWith(root)) throw new AppError("PROFILE_PATH_INVALID", "Profile path escapes registry", 400, "SCHEMA");
    return path;
  }

  async load(uri: string): Promise<Record<string, any>> {
    try {
      const manifest = await this.getProfile(uri);
      return manifest.type === "VALIDATION_PROFILE" ? await this.loadSchema(uri) : await this.getDefinition(uri);
    }
    catch (error) { if (!(error instanceof AppError) || error.code !== "PROFILE_NOT_FOUND") throw error; }
    try { return JSON.parse(await readFile(this.pathFor(uri), "utf8")); }
    catch (error: any) {
      if (error?.code === "ENOENT") throw new AppError("PROFILE_NOT_FOUND", `Profile '${uri}' was not found`, 404, "SCHEMA");
      throw error;
    }
  }

  async validate(uri: string, payload: unknown) {
    const result = await this.validateAgainstProfile(uri, payload);
    if (!result.valid) throw new AppError("SCHEMA_VALIDATION_FAILED", "Payload does not match its semantic profile", 422, "SCHEMA", { errors: result.errors });
    return payload;
  }
}
