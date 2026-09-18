import express from "express";
import type { AppConfig } from "../config/types.js";
import { AppError } from "../common/errors.js";
import { FileService, MAX_FILE_BYTES } from "./service.js";

export function fileRoutes(service: FileService, authMode: AppConfig["security"]["authMode"]) {
  const router = express.Router();
  router.use((request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const actor = request.auth;
    if (authMode === "disabled" || !actor?.accounting?.tenantId || actor.subject !== actor.accounting.ownerDid) {
      return next(new AppError("FILE_ACCESS_DENIED", "Authenticated tenant owner credentials required; global, device and disabled-auth access are not accepted", 403, "AUTHORIZATION"));
    }
    if (request.method === "POST" && request.header("content-encoding") && request.header("content-encoding") !== "identity") {
      return next(new AppError("FILE_ENCODING_UNSUPPORTED", "Compressed file request bodies are not supported", 415, "VALIDATION"));
    }
    next();
  });
  router.post("/", express.raw({ type: () => true, limit: MAX_FILE_BYTES, inflate: false }), async (request, response) => {
    let name: string;
    try { name = decodeURIComponent(request.header("x-file-name") ?? ""); }
    catch { throw new AppError("FILE_METADATA_INVALID", "X-File-Name must be percent-encoded UTF-8", 400, "VALIDATION"); }
    const metadata = await service.store(request.auth!.accounting!.tenantId, request.auth!.subject, name,
      request.header("content-type") || "application/octet-stream", Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0));
    response.status(201).location(`/api/v1/files/${metadata.id}`).json(metadata);
  });
  router.get("/", async (request, response) => {
    if (request.query.after !== undefined && typeof request.query.after !== "string") throw new AppError("FILE_PAGE_INVALID", "Invalid cursor", 400, "VALIDATION");
    response.json(await service.list(request.auth!.accounting!.tenantId, request.query.after as string | undefined, request.query.limit === undefined ? 25 : Number(request.query.limit)));
  });
  router.get("/:id", async (request, response) => response.json(await service.metadata(request.auth!.accounting!.tenantId, request.params.id!)));
  router.get("/:id/content", async (request, response) => {
    const { metadata, data } = await service.read(request.auth!.accounting!.tenantId, request.params.id!);
    response.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "Content-Length": String(data.length), "X-File-SHA256": metadata.sha256, "Content-Security-Policy": "sandbox; default-src 'none'" }).send(data);
  });
  return router;
}
