import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config/types.js";
import { AppError } from "../common/errors.js";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";
import type { StorageRouter } from "../storage/storage-router.js";
import { toBuffer } from "../storage/bytes.js";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export function fileCatalogDirectory(config: AppConfig) {
  const tenantFile = config.security.tenantProvisioning?.dynamicTenantFile;
  return resolve(tenantFile ? dirname(tenantFile) : "/data", "files");
}
export interface FileMetadata { id: string; name: string; contentType: string; size: number; sha256: string; createdAt: string; createdBy: string }
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const missing = () => new AppError("FILE_NOT_FOUND", "File not found in the authenticated tenant", 404, "VALIDATION");

/** Immutable encrypted files. Index names and blob names reveal neither filename nor DID. */
export class FileService {
  constructor(private readonly storage: StorageRouter, private readonly credentials: CredentialProvider, private readonly directory: string) {}

  private async key() {
    const encoded = await requiredCredential(this.credentials, "DTIS_FILE_ENCRYPTION_KEY");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) throw new AppError("FILE_KEY_INVALID", "Expected a canonical base64 32-byte file encryption key", 503, "AUTHORIZATION");
    return key;
  }
  private aad(tenant: string, id: string, purpose: string) { return Buffer.from(JSON.stringify(["dtis-files", 1, digest(tenant), id, purpose])); }
  private encrypt(bytes: Buffer, key: Buffer, aad: Buffer) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
  }
  private decrypt(bytes: Buffer, key: Buffer, aad: Buffer) {
    if (bytes.length < 29 || bytes[0] !== 1) throw new Error("Invalid envelope");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
    cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(13, 29));
    return Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]);
  }
  async store(tenant: string, subject: string, name: string, contentType: string, data: Buffer): Promise<FileMetadata> {
    if (!Buffer.isBuffer(data) || data.length > MAX_FILE_BYTES) throw new AppError("FILE_TOO_LARGE", "Maximum file size is 16 MiB", 413, "VALIDATION");
    if (!name.trim() || Buffer.byteLength(name) > 240 || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "/" || char === "\\") || name === "." || name === ".."
      || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(contentType) || contentType.length > 128) {
      throw new AppError("FILE_METADATA_INVALID", "Supply a filename without path/control characters and a MIME type without parameters", 400, "VALIDATION");
    }
    const key = await this.key(), id = randomUUID();
    const metadata: FileMetadata = { id, name, contentType, size: data.length, sha256: digest(data), createdAt: new Date().toISOString(), createdBy: subject };
    const blob = await this.storage.store({ data: this.encrypt(data, key, this.aad(tenant, id, "content")), category: "files", fileName: `${id}.bin`, contentType: "application/octet-stream" });
    const folder = join(this.directory, digest(tenant));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `.${id}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        // URI is encrypted too: all retrieval is by a server-issued ID, never a caller-supplied URI.
        await handle.writeFile(this.encrypt(Buffer.from(JSON.stringify({ metadata, uri: blob.uri })), key, this.aad(tenant, id, "index")));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, join(folder, `${id}.idx`));
      if (process.platform !== "win32") { const dir = await open(folder, "r"); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    return metadata;
  }
  private async record(tenant: string, id: string) {
    if (!validId(id)) throw missing();
    let bytes: Buffer;
    try { bytes = await readFile(join(this.directory, digest(tenant), `${id}.idx`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw missing(); throw error; }
    const key = await this.key();
    try {
      const record = JSON.parse(this.decrypt(bytes, key, this.aad(tenant, id, "index")).toString("utf8")) as { metadata: FileMetadata; uri: string };
      if (record.metadata?.id !== id || typeof record.uri !== "string") throw new Error("Invalid index");
      return record;
    } catch { throw new AppError("FILE_INTEGRITY_FAILURE", "File index authentication failed", 503, "INTERNAL"); }
  }
  async metadata(tenant: string, id: string) { return (await this.record(tenant, id)).metadata; }
  async read(tenant: string, id: string) {
    const { metadata, uri } = await this.record(tenant, id), key = await this.key();
    try {
      const data = this.decrypt(await toBuffer(await this.storage.read(uri)), key, this.aad(tenant, id, "content"));
      if (data.length !== metadata.size || digest(data) !== metadata.sha256) throw new Error("Digest mismatch");
      return { metadata, data };
    } catch { throw new AppError("FILE_INTEGRITY_FAILURE", "File content could not be authenticated or read", 503, "INTERNAL"); }
  }
  async list(tenant: string, after: string | undefined, limit: number) {
    if ((after && !validId(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("FILE_PAGE_INVALID", "Use a valid file ID cursor and limit 1..100", 400, "VALIDATION");
    // Verify encryption configuration even for an empty catalog.
    await this.key();
    let names: string[];
    try { names = await readdir(join(this.directory, digest(tenant))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
    const ids = names.filter((name) => name.endsWith(".idx") && validId(name.slice(0, -4))).map((name) => name.slice(0, -4)).sort().filter((id) => !after || id > after);
    const page = ids.slice(0, limit);
    return { files: await Promise.all(page.map((id) => this.metadata(tenant, id))), nextCursor: ids.length > limit ? page.at(-1) : null };
  }
}
