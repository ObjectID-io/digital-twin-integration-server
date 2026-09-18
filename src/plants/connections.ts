import { Router } from "express";
import type { CredentialProvider } from "../security/credentials.js";
import { authorizePlantAccess } from "./auth.js";
import type { PlantService } from "./service.js";

// Separate encrypted catalog, same supervisor assertion and revision guarantees as plants.
// No public projection and no public route, including for connection secrets.
export function connectionRoutes(service: PlantService, credentials: CredentialProvider) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/", async (req, res) => {
    const tenant = await authorizePlantAccess(req.headers.authorization, credentials);
    res.json({ connections: await service.list(`connections:${tenant}`) });
  });
  router.put("/:id", async (req, res) => {
    const tenant = await authorizePlantAccess(req.headers.authorization, credentials);
    res.json(await service.put(`connections:${tenant}`, req.params.id, {
      revision: req.body?.revision, document: req.body?.document, publication: null,
    }));
  });
  return router;
}
