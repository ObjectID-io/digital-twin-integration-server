import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../common/errors.js";
import type { AppConfig } from "../config/types.js";
import { requiredCredential, type CredentialProvider } from "./credentials.js";

export interface AuthProvider {
  authenticate(request: Request): Promise<{ subject: string; claims?: Record<string, unknown> }>;
}

export class DisabledAuthProvider implements AuthProvider {
  async authenticate() { return { subject: "local-development" }; }
}

export class ApiKeyAuthProvider implements AuthProvider {
  constructor(private readonly credentials: CredentialProvider, private readonly credentialName: string) {}
  async authenticate(request: Request) {
    const expected = await requiredCredential(this.credentials, this.credentialName);
    if (request.header("x-api-key") !== expected) throw new AppError("AUTH_INVALID_API_KEY", "Invalid or missing API key", 401, "AUTHORIZATION");
    return { subject: "api-key" };
  }
}

export class JwtAuthProvider implements AuthProvider {
  constructor(private readonly credentials: CredentialProvider, private readonly credentialName: string) {}
  async authenticate(request: Request) {
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) throw new AppError("AUTH_MISSING_TOKEN", "Bearer token is required", 401, "AUTHORIZATION");
    const secret = await requiredCredential(this.credentials, this.credentialName);
    try {
      const claims = jwt.verify(token, secret) as jwt.JwtPayload;
      return { subject: String(claims.sub ?? "jwt"), claims };
    } catch {
      throw new AppError("AUTH_INVALID_TOKEN", "JWT is invalid or expired", 401, "AUTHORIZATION");
    }
  }
}

export function createAuthProvider(config: AppConfig, credentials: CredentialProvider): AuthProvider {
  if (config.security.authMode === "api-key") return new ApiKeyAuthProvider(credentials, config.security.apiKeyCredential);
  if (config.security.authMode === "jwt") return new JwtAuthProvider(credentials, config.security.jwtSecretCredential);
  return new DisabledAuthProvider();
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
    interface Request { auth?: { subject: string; claims?: Record<string, unknown> } }
  }
}
