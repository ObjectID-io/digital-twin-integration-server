import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";
import { toBuffer } from "../storage/bytes.js";
import type { StorageRouter } from "../storage/storage-router.js";

export interface Publication { name: string; coordinates: [number, number] }
export interface PlantUpdate { revision: number; document: Record<string, unknown>; publication: Publication | null }
interface Pointer { scope: string; plant: string; revision: number; uri: string; publication: (Publication & { id: string }) | null }
interface Catalog { version: 1; plants: Pointer[] }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id);
const invalid = () => new AppError("PLANT_INPUT_INVALID", "Expected revision, document object, and publication null or {name,coordinates:[longitude,latitude]}", 400, "VALIDATION");

function publication(value: unknown): Publication | null {
  if (value === null) return null;
  if (!object(value) || !exactKeys(value, ["name", "coordinates"]) || typeof value.name !== "string"
    || !value.name.trim() || value.name.length > 256 || !Array.isArray(value.coordinates)
    || value.coordinates.length !== 2) throw invalid();
  const [longitude, latitude] = value.coordinates;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) throw invalid();
  return { name: value.name, coordinates: [longitude, latitude] };
}

export function plantCatalogDirectory(config: AppConfig): string {
  const tenantFile = config.security.tenantProvisioning?.dynamicTenantFile;
  return resolve(tenantFile ? dirname(tenantFile) : "/data", "plants");
}

export class PlantService {
  readonly catalogFile: string;
  constructor(private readonly storage: StorageRouter, private readonly credentials: CredentialProvider, private readonly directory: string) {
    this.catalogFile = join(directory, "catalog.json");
  }

  async listPublic() {
    // Public reads never fetch blobs or obtain the encryption credential.
    return (await this.catalog()).plants.flatMap((plant) => plant.publication === null ? [] : [{
      id: plant.publication.id, name: plant.publication.name,
      coordinates: [plant.publication.coordinates[0], plant.publication.coordinates[1]],
      visibility: "public" as const,
    }]);
  }

  async list(tenantId: string) {
    const key = await this.encryptionKey();
    const scope = hash(tenantId);
    const pointers = (await this.catalog()).plants.filter((plant) => plant.scope === scope);
    return Promise.all(pointers.map(async (pointer) => {
      try {
        const bytes = await toBuffer(await this.storage.read(pointer.uri));
        // Version byte, 96-bit nonce, 128-bit tag, then encrypted JSON.
        if (bytes.length < 30 || bytes[0] !== 1) throw new Error("Invalid envelope");
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
        decipher.setAAD(this.aad(pointer));
        decipher.setAuthTag(bytes.subarray(13, 29));
        const record: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString("utf8"));
        if (!object(record) || !validId(record.id) || hash(record.id) !== pointer.plant || !object(record.document)) throw new Error("Invalid document");
        const published = pointer.publication;
        return { id: record.id, revision: pointer.revision, document: record.document,
          publication: published ? { name: published.name, coordinates: published.coordinates } : null };
      } catch { throw new AppError("PLANT_INTEGRITY_FAILURE", "Plant document could not be authenticated or read", 503, "INTERNAL"); }
    }));
  }

  async put(tenantId: string, id: string, input: unknown, validate?: () => Promise<void>) {
    if (!validId(id) || !object(input) || !exactKeys(input, ["revision", "document", "publication"])
      || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0
      || (input.revision as number) >= Number.MAX_SAFE_INTEGER || !object(input.document)) throw invalid();
    const update: PlantUpdate = { revision: input.revision as number, document: input.document, publication: publication(input.publication) };
    const key = await this.encryptionKey();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // An exclusive filesystem lock coordinates independent DTIS processes sharing this catalog.
    // Never steal stale locks: a paused writer must not overwrite a newer revision.
    const lockPath = join(this.directory, "catalog.lock");
    const lock = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new AppError("PLANT_WRITE_BUSY", "Plant catalog is locked; retry the request", 409, "VALIDATION");
      throw error;
    });
    try {
      const catalog = await this.catalog();
      const scope = hash(tenantId);
      const plantHash = hash(id);
      const previous = catalog.plants.find((plant) => plant.scope === scope && plant.plant === plantHash);
      if ((previous?.revision ?? 0) !== update.revision) {
        throw new AppError("PLANT_REVISION_CONFLICT", "Plant revision does not match", 409, "VALIDATION", { revision: previous?.revision ?? 0 });
      }
      // Association checks run under the same cross-process catalog lock as commit.
      await validate?.();
      const pointer: Pointer = { scope, plant: plantHash, revision: update.revision + 1, uri: "",
        publication: update.publication ? { id, ...update.publication } : null };
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(this.aad(pointer));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ id, document: update.document }), "utf8"), cipher.final()]);
      const stored = await this.storage.store({
        data: Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]),
        contentType: "application/octet-stream", fileName: `${randomUUID()}.bin`, category: "plants",
        // No twinId or identifying metadata: both providers place this in twins/unscoped/plants.
      });
      pointer.uri = stored.uri;
      catalog.plants = catalog.plants.filter((plant) => plant.scope !== scope || plant.plant !== plantHash);
      catalog.plants.push(pointer);
      await this.commit(catalog);
      return { id, revision: pointer.revision, document: update.document, publication: update.publication };
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  private aad(pointer: Pointer) {
    return Buffer.from(JSON.stringify(["dtis-plants", 1, pointer.scope, pointer.plant, pointer.revision, pointer.publication]));
  }

  private async encryptionKey() {
    const encoded = await requiredCredential(this.credentials, "DTIS_PLANT_ENCRYPTION_KEY");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) {
      throw new AppError("PLANT_ENCRYPTION_CONFIG_INVALID", "Plant encryption credential must be canonical base64 encoding of 32 bytes", 503, "AUTHORIZATION");
    }
    return key;
  }

  private async catalog(): Promise<Catalog> {
    let text: string;
    try { text = await readFile(this.catalogFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, plants: [] }; throw error; }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.plants)) throw new Error("Invalid catalog");
      const seen = new Set<string>();
      const plants = parsed.plants.map((value: unknown): Pointer => {
        if (!object(value) || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope)
          || typeof value.plant !== "string" || !/^[a-f0-9]{64}$/.test(value.plant)
          || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
          || typeof value.uri !== "string" || !value.uri) throw new Error("Invalid pointer");
        const identity = JSON.stringify([value.scope, value.plant]);
        if (seen.has(identity)) throw new Error("Duplicate pointer");
        seen.add(identity);
        let published: Pointer["publication"] = null;
        if (value.publication !== null) {
          if (!object(value.publication) || !exactKeys(value.publication, ["id", "name", "coordinates"])
            || !validId(value.publication.id) || hash(value.publication.id) !== value.plant) throw new Error("Invalid projection");
          published = { id: value.publication.id, ...publication({ name: value.publication.name, coordinates: value.publication.coordinates })! };
        }
        return { scope: value.scope, plant: value.plant, revision: value.revision as number, uri: value.uri, publication: published };
      });
      return { version: 1, plants };
    } catch { throw new AppError("PLANT_CATALOG_INVALID", "Plant catalog is invalid", 503, "INTERNAL"); }
  }

  private async commit(catalog: Catalog) {
    const temporary = join(this.directory, `.catalog-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(catalog)); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.catalogFile);
      // POSIX directory fsync makes rename durable across a crash. Windows does not support it.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
