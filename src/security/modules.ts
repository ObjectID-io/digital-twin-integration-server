import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import express from "express";
import { AppError } from "../common/errors.js";
import type { DeviceDidAuth } from "../devices/did-auth.js";
import type { TenantRegistry } from "./tenants.js";

export const moduleIds = ["ai", "commands", "rest"] as const;
export type ModuleId = typeof moduleIds[number];
type Entry = { enabled: boolean; updatedAt: string; updatedBy: string };
/** One server process owns this file; failed persistence never changes effective state. */
export class TenantModules {
  private state: Record<string, Partial<Record<ModuleId, Entry>>> = Object.create(null);
  constructor(private file: string) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed.version !== 1 || !parsed.tenants || typeof parsed.tenants !== "object" || Array.isArray(parsed.tenants)) throw Error("Invalid module settings");
      for (const entries of Object.values(parsed.tenants) as any[]) {
        if (!entries || typeof entries !== "object" || Object.entries(entries).some(([key, value]: [string, any]) => !moduleIds.includes(key as ModuleId) || typeof value?.enabled !== "boolean")) throw Error("Invalid module settings");
      }
      this.state = parsed.tenants;
    }
  }
  enabled(tenant: string, module: ModuleId) { return this.state[tenant]?.[module]?.enabled ?? true; }
  set(tenant: string, module: ModuleId, enabled: boolean, did: string) {
    const entry = { enabled, updatedAt: new Date().toISOString(), updatedBy: did };
    const next = { ...this.state, [tenant]: { ...this.state[tenant], [module]: entry } };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, tenants: next }), { mode: 0o600 });
    renameSync(this.file + ".tmp", this.file);
    this.state = next;
  }
  assertEnabled(tenant: string | undefined, module: ModuleId) {
    if (tenant && !this.enabled(tenant, module)) throw new AppError("MODULE_PAUSED", "This module is paused by the tenant owner", 409, "AUTHORIZATION");
  }
}

export function moduleRoutes(auth: Pick<DeviceDidAuth, "context">, tenants: Pick<TenantRegistry, "findByOwnerDid">,
  settings: TenantModules, available: (tenant: string, module: ModuleId) => boolean, changed: (tenant: string, module: ModuleId, enabled: boolean) => void) {
  const router = express.Router();
  router.use(async (q, r, next) => {
    try {
      const context = auth.context(q);
      if (!context) throw new AppError("AUTHENTICATION_REQUIRED", "Sign in with your DID", 401, "AUTHORIZATION");
      const account = await tenants.findByOwnerDid(context.ownerDid);
      if (!account) throw new AppError("TENANT_NOT_FOUND", "No tenant registered for this DID", 403, "AUTHORIZATION");
      r.locals.account = account; r.set("Cache-Control", "no-store"); next();
    } catch (e) { next(e); }
  });
  const status = (tenant: string) => ({ modules: moduleIds.map(id => ({ id, available: available(tenant, id), enabled: available(tenant, id) && settings.enabled(tenant, id) })) });
  router.get("/", (_q, r) => r.json(status(r.locals.account.tenantId)));
  router.post("/:module", (q, r) => {
    const module = String(q.params.module) as ModuleId, { tenantId, ownerDid } = r.locals.account;
    if (!moduleIds.includes(module) || typeof q.body?.enabled !== "boolean") throw new AppError("INVALID_MODULE", "Choose a module and enabled boolean", 422, "VALIDATION");
    if (!available(tenantId, module)) throw new AppError("MODULE_UNAVAILABLE", "Module requires server configuration", 409, "VALIDATION");
    settings.set(tenantId, module, q.body.enabled, ownerDid);
    changed(tenantId, module, q.body.enabled);
    r.json(status(tenantId));
  });
  return router;
}
