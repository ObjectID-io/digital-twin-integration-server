import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppError } from "../common/errors.js";
import type { FilesystemStorageConfig, StorageProvider, StoreInput } from "./types.js";
import { categoryDirectory, safeSegment, toBuffer } from "./bytes.js";

export class LocalFilesystemStorageProvider implements StorageProvider {
  readonly type = "filesystem";
  private readonly root: string;
  constructor(private readonly config: FilesystemStorageConfig) { this.root = resolve(config.basePath); }

  async store(input: StoreInput) {
    const bytes = await toBuffer(input.data);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const hash = `sha256:${digest}`;
    const directory = resolve(this.root, "twins", safeSegment(input.twinId, "unscoped"), categoryDirectory(input.category));
    this.assertWithinRoot(directory);
    if (this.config.createDirectories !== false) await mkdir(directory, { recursive: true });
    const original = safeSegment(input.fileName ? basename(input.fileName) : undefined, "object.bin");
    const path = resolve(directory, `${digest}-${original}`);
    this.assertWithinRoot(path);
    await writeFile(path, bytes, { flag: "wx" }).catch((error: any) => { if (error?.code !== "EEXIST") throw error; });
    return {
      uri: this.uriFor(path), hash, hashAlgorithm: "sha256" as const, size: bytes.byteLength, contentType: input.contentType,
    };
  }

  async read(uri: string) { return readFile(this.pathFor(uri)); }
  async exists(uri: string) { try { await access(this.pathFor(uri)); return true; } catch { return false; } }
  async delete(uri: string) { await unlink(this.pathFor(uri)); }

  async healthCheck() {
    try {
      if (this.config.createDirectories !== false) await mkdir(this.root, { recursive: true });
      await access(this.root, this.config.writable === false ? constants.R_OK : constants.R_OK | constants.W_OK);
      if (this.config.writable !== false) {
        const probe = resolve(this.root, `.dtis-health-${randomUUID()}`);
        await writeFile(probe, "health");
        await rm(probe, { force: true });
      }
      return { healthy: true, checkedAt: new Date().toISOString() };
    } catch (error) {
      return { healthy: false, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }

  supportsUri(uri: string) {
    try { this.pathFor(uri); return true; }
    catch { return false; }
  }

  private uriFor(path: string) {
    if (!this.config.uriPrefix || this.config.uriPrefix === "file://") return pathToFileURL(path).toString();
    const suffix = relative(this.root, path).split(sep).map(encodeURIComponent).join("/");
    return `${this.config.uriPrefix.replace(/\/$/, "")}/${suffix}`;
  }

  private pathFor(uri: string) {
    let path: string;
    if (uri.startsWith("file:")) path = fileURLToPath(uri);
    else {
      const prefix = this.config.uriPrefix?.replace(/\/$/, "");
      if (!prefix || !uri.startsWith(`${prefix}/`)) throw new AppError("STORAGE_URI_UNSUPPORTED", "URI does not belong to this filesystem provider", 400, "VALIDATION");
      path = resolve(this.root, ...uri.slice(prefix.length + 1).split("/").map(decodeURIComponent));
    }
    this.assertWithinRoot(path);
    return path;
  }

  private assertWithinRoot(path: string) {
    const normalizedRoot = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    const normalizedPath = resolve(path);
    if (normalizedPath !== this.root && !normalizedPath.startsWith(normalizedRoot)) {
      throw new AppError("STORAGE_PATH_INVALID", "Storage path escapes configured basePath", 400, "VALIDATION");
    }
  }
}
