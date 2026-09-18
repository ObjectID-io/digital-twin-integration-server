import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { TenantModules, moduleRoutes } from "../../src/security/modules.js";

describe("tenant module controls", () => {
  it("persists isolated switches across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "dtis-modules-"));
    try {
      const file = join(dir, "settings.json"), store = new TenantModules(file);
      store.set("tenant-a", "ai", false, "did-a");
      expect(new TenantModules(file).enabled("tenant-a", "ai")).toBe(false);
      expect(store.enabled("tenant-b", "ai")).toBe(true);
      expect(() => store.assertEnabled("tenant-a", "ai")).toThrow();
    } finally { rmSync(dir, { recursive: true }); }
  });
  it("requires login, derives tenant from DID, rejects unavailable modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dtis-modules-"));
    try {
      const auth = { context: vi.fn().mockReturnValue(null) }, changed = vi.fn();
      const app = express(); app.use(express.json());
      const store = new TenantModules(join(dir, "settings.json"));
      app.use(moduleRoutes(auth, {findByOwnerDid: vi.fn().mockResolvedValue({tenantId:"tenant-a",ownerDid:"did-a"})}, store, (_t,m)=>m!=="rest", changed));
      app.use((e:any,_q:any,r:any,_n:any)=>r.status(e.statusCode||500).json({error:e.message}));
      const denied = await request(app).get("/"); expect(denied.status).not.toBe(200);
      auth.context.mockReturnValue({ownerDid:"did-a"});
      expect((await request(app).post("/ai").send({enabled:false,tenantId:"tenant-b"})).status).toBe(200);
      expect(store.enabled("tenant-a","ai")).toBe(false);expect(store.enabled("tenant-b","ai")).toBe(true);
      expect(changed).toHaveBeenCalledWith("tenant-a","ai",false);
      expect((await request(app).post("/rest").send({enabled:true})).status).not.toBe(200);
      expect((await request(app).post("/ai").send({enabled:"false"})).status).not.toBe(200);
    } finally { rmSync(dir,{recursive:true}); }
  });
});
