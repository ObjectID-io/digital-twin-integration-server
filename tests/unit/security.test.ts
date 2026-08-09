import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/common/logger.js";
import { EnvironmentCredentialProvider, resolveCredentialReferences } from "../../src/security/credentials.js";

describe("credential security", () => {
  it("resolves credential references only in memory", async () => {
    const result = await resolveCredentialReferences({ password: "${credential:MQTT_PASSWORD}" }, new EnvironmentCredentialProvider({ MQTT_PASSWORD: "secret" }));
    expect(result).toEqual({ password: "secret" });
  });
  it("redacts nested secrets", () => expect(redactSecrets({ user: "a", nested: { accessToken: "secret" } })).toEqual({ user: "a", nested: { accessToken: "[REDACTED]" } }));
});

describe("storage credential redaction", () => {
  it("redacts S3, MinIO and Azure secret fields", () => {
    expect(redactSecrets({ secretAccessKey: "s3-secret", connectionString: "azure-secret", sasToken: "sas-secret", accessKeyId: "public-id" })).toEqual({
      secretAccessKey: "[REDACTED]", connectionString: "[REDACTED]", sasToken: "[REDACTED]", accessKeyId: "public-id",
    });
  });
});
