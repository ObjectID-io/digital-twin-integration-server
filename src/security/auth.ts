import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import { requiredCredential, type CredentialProvider } from "./credentials.js";
import { TenantRegistry } from "./tenants.js";
import type { AccountingContext } from "../objectid/types.js";

export interface AuthProvider {
  authenticate(request: Request): Promise<{ subject: string; claims?: Record<string, unknown>; accounting?: AccountingContext }>;
}

export class DisabledAuthProvider implements AuthProvider {
  constructor(private readonly tenants?: TenantRegistry) {}
  async authenticate() { return { subject: "local-development", accounting: await this.tenants?.default() }; }
}

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly credentials: CredentialProvider, private readonly credentialName: string, private readonly tenants: TenantRegistry) {}
  async authenticate(request: Request) {
    const tenant = await this.tenants.authenticateApiKey(request.header("x-api-key"));
    if (tenant) return { subject: tenant.ownerDid, accounting: tenant };
    const expected = await requiredCredential(this.credentials, this.credentialName);
    if (request.header("x-api-key") !== expected) throw new AppError("AUTH_INVALID_API_KEY", "Invalid or missing API key", 401, "AUTHORIZATION");
    return { subject: "api-key" };
  }
}

export class JwtAuthProvider implements AuthProvider {
  constructor(private readonly credentials: CredentialProvider, private readonly credentialName: string, private readonly tenants: TenantRegistry) {}
  async authenticate(request: Request) {
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new AppError("AUTH_MISSING_TOKEN", "Bearer token is required", 401, "AUTHORIZATION");
    const secret = await requiredCredential(this.credentials, this.credentialName);
    try {
      const claims = jwt.verify(token, secret) as jwt.JwtPayload;
      const tenantId = String(claims.tenant_id ?? claims.tenantId ?? "");
      const accounting = await this.tenants.configured() ? await this.tenants.get(tenantId) : undefined;
      return { subject: String(claims.sub ?? "jwt"), claims, accounting };
    } catch {
      throw new AppError("AUTH_INVALID_TOKEN", "JWT is invalid or expired", 401, "AUTHORIZATION");
    }
  }
}

export function createAuthProvider(config: AppConfig, credentials: CredentialProvider, tenants = new TenantRegistry(config.security, credentials)): AuthProvider {
  if (config.security.authMode === "api-key") return new ApiKeyAuthProvider(credentials, config.security.apiKeyCredential, tenants);
  if (config.security.authMode === "jwt") return new JwtAuthProvider(credentials, config.security.jwtSecretCredential, tenants);
  return new DisabledAuthProvider(tenants);
}

export function authMiddleware(provider: AuthProvider) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      request.auth = await provider.authenticate(request);
      next();
    } catch (error) { next(error); }
  };
}

declare global {
  // Express request augmentation requires the declaration-merging namespace form.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { auth?: { subject: string; claims?: Record<string, unknown>; accounting?: AccountingContext } }
  }
}
