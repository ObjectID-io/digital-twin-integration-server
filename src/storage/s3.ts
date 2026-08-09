import { createHash } from "node:crypto";
import {
  DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { AppError } from "../common/errors.js";
import type { CredentialProvider } from "../security/credentials.js";
import { requiredCredential } from "../security/credentials.js";
import { categoryDirectory, safeSegment, toBuffer } from "./bytes.js";
import type { S3StorageConfig, StorageProvider, StoreInput } from "./types.js";

interface S3Sender { send(command: unknown): Promise<any> }

export class S3StorageProvider implements StorageProvider {
  readonly type = "s3";
  private readonly client: S3Sender;
  constructor(
    private readonly config: S3StorageConfig,
    credentials: CredentialProvider,
    client?: S3Sender,
  ) {
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: config.accessKeyEnv && config.secretKeyEnv ? async () => ({
        accessKeyId: await requiredCredential(credentials, config.accessKeyEnv!),
        secretAccessKey: await requiredCredential(credentials, config.secretKeyEnv!),
      }) : undefined,
    });
  }

  async store(input: StoreInput) {
    const bytes = await toBuffer(input.data);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = this.keyFor(input, digest);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
      }));
    } catch (error) { throw storageError("STORAGE_S3_PUT_FAILED", error); }
    return {
      uri: `s3://${this.config.bucket}/${key}`, hash: `sha256:${digest}`, hashAlgorithm: "sha256" as const,
      size: bytes.byteLength, contentType: input.contentType,
    };
  }

  async read(uri: string) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.keyFromUri(uri) }));
      if (!result.Body) return Buffer.alloc(0);
      if (typeof result.Body.transformToByteArray === "function") return Buffer.from(await result.Body.transformToByteArray());
      return toBuffer(result.Body);
    } catch (error) { throw storageError("STORAGE_S3_READ_FAILED", error); }
  }

  async exists(uri: string) {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: this.keyFromUri(uri) })); return true; }
    catch (error: any) { if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) return false; throw storageError("STORAGE_S3_HEAD_FAILED", error); }
  }

  async delete(uri: string) {
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.keyFromUri(uri) })); }
    catch (error) { throw storageError("STORAGE_S3_DELETE_FAILED", error); }
  }

  async healthCheck() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return { healthy: true, checkedAt: new Date().toISOString() };
    } catch {
      return { healthy: false, message: "S3 bucket is not accessible", checkedAt: new Date().toISOString() };
    }
  }

  supportsUri(uri: string) {
    const uriPrefix = `s3://${this.config.bucket}/`;
    if (!uri.startsWith(uriPrefix)) return false;
    const configuredPrefix = String(this.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    return !configuredPrefix || uri.slice(uriPrefix.length).startsWith(`${configuredPrefix}/`);
  }

  private keyFor(input: StoreInput, digest: string) {
    const prefix = String(this.config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const path = [
      prefix, "twins", safeSegment(input.twinId, "unscoped"), categoryDirectory(input.category),
      `${digest}-${safeSegment(input.fileName, "object.bin")}`,
    ].filter(Boolean);
    return path.join("/");
  }

  private keyFromUri(uri: string) {
    const prefix = `s3://${this.config.bucket}/`;
    if (!this.supportsUri(uri)) throw new AppError("STORAGE_URI_UNSUPPORTED", "URI does not belong to this S3 provider", 400, "VALIDATION");
    return uri.slice(prefix.length);
  }
}

function storageError(code: string, error: unknown) {
  return new AppError(code, error instanceof Error ? error.message : "S3 storage operation failed", 503, "CONNECTOR");
}
