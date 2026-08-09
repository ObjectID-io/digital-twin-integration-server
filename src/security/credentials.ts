import { readFile } from "node:fs/promises";
import { AppError } from "../common/errors.js";

export interface CredentialProvider {
  get(name: string): Promise<string | undefined>;
}

export class EnvironmentCredentialProvider implements CredentialProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async get(name: string) { return this.env[name]; }
}

export class FileCredentialProvider implements CredentialProvider {
  constructor(private readonly path: string) {}
  async get(name: string) {
    const data = JSON.parse(await readFile(this.path, "utf8")) as Record<string, string>;
    return data[name];
  }
}

export async function requiredCredential(provider: CredentialProvider, name: string) {
  const value = await provider.get(name);
  if (!value) throw new AppError("CREDENTIAL_MISSING", `Credential '${name}' is not configured`, 503, "AUTHORIZATION");
  return value;
}

export async function resolveCredentialReferences(value: unknown, provider: CredentialProvider): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveCredentialReferences(item, provider)));
  if (value && typeof value === "object") {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveCredentialReferences(item, provider)])));
  }
  if (typeof value === "string") {
    const match = /^\$\{credential:([^}]+)\}$/.exec(value);
    if (match) return requiredCredential(provider, match[1]!);
  }
  return value;
}
