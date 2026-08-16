import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { CommandTransportSigner } from "../../src/commands/signing.js";

describe("command transport signing", () => {
  it("adds a verifiable RFC 8785 HMAC authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "objectid-command-key-"));
    const key = Buffer.alloc(32, 9);
    const keyFile = join(directory, "key.txt");
    await writeFile(keyFile, key.toString("base64"));
    const payload = { specVersion: "objectid.command.v1", commandId: "urn:uuid:123e4567-e89b-42d3-a456-426614174000" };
    const value = await new CommandTransportSigner(keyFile, "key-1").sign(payload);
    expect(value.authorization).toMatchObject({ type: "ObjectIDIntegrationServerHmac", algorithm: "HS256", keyId: "key-1", canonicalization: "RFC8785" });
    expect(value.authorization?.signature).toBe(createHmac("sha256", key).update(canonicalize(payload)!).digest("base64url"));
  });

  it("rejects signing keys shorter than 256 bits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "objectid-command-key-"));
    const keyFile = join(directory, "key.txt");
    await writeFile(keyFile, Buffer.alloc(16).toString("base64"));
    await expect(new CommandTransportSigner(keyFile).initialize()).rejects.toThrow(/at least 32 random bytes/);
  });
});
