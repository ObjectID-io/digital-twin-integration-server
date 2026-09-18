import { Router } from "express";
import type { CredentialProvider } from "../security/credentials.js";
import { authorizePlantAccess, authorizePlantIdentity } from "./auth.js";
import { AppError } from "../common/errors.js";
import type { PlantService } from "./service.js";

export function plantRoutes(service: PlantService, credentials: CredentialProvider, validateBindings?: (tenantId:string, ownerDid:string, plantId:string, document:any)=>Promise<void>) {
  const router = Router();
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  router.get("/public", async (_request, response) => {
    response.json({ plants: await service.listPublic() });
  });
  router.get("/", async (request, response) => {
    const tenantId = await authorizePlantAccess(request.headers.authorization, credentials);
    response.json({ plants: await service.list(tenantId) });
  });
  router.put("/:id", async (request, response) => {
    const { tenantId, ownerDid } = await authorizePlantIdentity(request.headers.authorization, credentials);
    const input = request.body;
    if (input?.document && typeof input.document === "object" && !Array.isArray(input.document)) {
      if (input.document.ownerDid && input.document.ownerDid !== ownerDid) throw new AppError("PLANT_OWNER_MISMATCH", "Plant ownership cannot be reassigned through a document edit", 403, "AUTHORIZATION");
      input.document = { ...input.document, ownerDid, tenantId };
    }
    response.json(await service.put(tenantId, request.params.id, input, () => validateBindings?.(tenantId,ownerDid,request.params.id,input.document) || Promise.resolve()));
  });
  return router;
}
