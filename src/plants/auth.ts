import jwt from "jsonwebtoken";
import { AppError } from "../common/errors.js";
import { requiredCredential, type CredentialProvider } from "../security/credentials.js";

export const PLANT_TOKEN_MAX_AGE_SECONDS = 300;

export async function authorizePlantIdentity(header: string | undefined, credentials: CredentialProvider): Promise<{ tenantId: string; ownerDid: string }> {
  const token = /^Bearer ([^\s]+)$/i.exec(header ?? "")?.[1];
  if (!token) throw new AppError("PLANT_AUTH_REQUIRED", "Plant access token required", 401, "AUTHORIZATION");
  const encoded = await requiredCredential(credentials, "DTIS_PLANT_ACCESS_KEY");
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== 32 || secret.toString("base64") !== encoded) throw new AppError("PLANT_AUTH_CONFIG_INVALID", "Plant access credential must be canonical base64 encoding of 32 bytes", 503, "AUTHORIZATION");
  let pins: unknown;
  try { pins = JSON.parse(await requiredCredential(credentials, "DTIS_PLANT_SUPERVISORS")); }
  catch { throw new AppError("PLANT_AUTH_CONFIG_INVALID", "Plant supervisor configuration unavailable", 503, "AUTHORIZATION"); }
  if (!pins || typeof pins !== "object" || Array.isArray(pins)
    || Object.values(pins).some((did) => typeof did !== "string" || !/^did:[a-z0-9]+:\S+$/.test(did))) {
    throw new AppError("PLANT_AUTH_CONFIG_INVALID", "Plant supervisor configuration invalid", 503, "AUTHORIZATION");
  }
  let claims: jwt.JwtPayload;
  try {
    const verified = jwt.verify(token, secret, {
      algorithms: ["HS256"], issuer: "twinscope", audience: "dtis-plants", maxAge: PLANT_TOKEN_MAX_AGE_SECONDS,
    });
    if (typeof verified === "string") throw new Error("Invalid claims");
    claims = verified;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.jti !== "string" || !claims.jti || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
      || claims.iat! > now || claims.exp! <= claims.iat!
      || claims.exp! - claims.iat! > PLANT_TOKEN_MAX_AGE_SECONDS) throw new Error("Invalid lifetime");
  } catch { throw new AppError("PLANT_TOKEN_INVALID", "Invalid or expired plant access token", 401, "AUTHORIZATION"); }
  if (typeof claims.tenantId !== "string" || !claims.tenantId || claims.tenantId.length > 256
    || typeof claims.sub !== "string" || claims.role !== "tenant_supervisor"
    || !Object.hasOwn(pins, claims.tenantId)
    || (pins as Record<string, unknown>)[claims.tenantId] !== claims.sub) {
    throw new AppError("PLANT_ACCESS_DENIED", "Pinned tenant supervisor required", 403, "AUTHORIZATION");
  }
  return { tenantId: claims.tenantId, ownerDid: claims.sub };
}

export async function authorizePlantAccess(header: string | undefined, credentials: CredentialProvider): Promise<string> {
  return (await authorizePlantIdentity(header, credentials)).tenantId;
}
