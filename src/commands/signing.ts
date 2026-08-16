import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import canonicalize from "canonicalize";
import { AppError } from "../common/errors.js";

export interface CommandTransportAuthorization {
  type: "ObjectIDIntegrationServerHmac";
  algorithm: "HS256";
  keyId: string;
  canonicalization: "RFC8785";
  signature: string;
}

export class CommandTransportSigner {
  private key?: Buffer;

  constructor(private readonly keyFile?: string, private readonly keyId = "dtis-command-v1") {}

  get enabled() { return Boolean(this.keyFile); }

  async initialize() {
    if (!this.keyFile || this.key) return;
    const encoded = (await readFile(this.keyFile, "utf8")).trim();
    if (!encoded) throw new AppError("COMMAND_SIGNING_KEY_EMPTY", "The command signing key file is empty", 503, "AUTHORIZATION");
    const key = Buffer.from(encoded, "base64");
    if (key.length < 32) throw new AppError("COMMAND_SIGNING_KEY_WEAK", "The command signing key must contain at least 32 random bytes encoded as base64", 503, "AUTHORIZATION");
    this.key = key;
  }

  async sign<T extends object>(payload: T): Promise<T & { authorization?: CommandTransportAuthorization }> {
    if (!this.keyFile) return payload;
    await this.initialize();
    const signature = createHmac("sha256", this.key!).update(canonicalize(payload)!).digest("base64url");
    return { ...payload, authorization: { type: "ObjectIDIntegrationServerHmac", algorithm: "HS256", keyId: this.keyId, canonicalization: "RFC8785", signature } };
  }
}
