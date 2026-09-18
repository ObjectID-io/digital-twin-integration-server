const security = [{ ApiKey: [] }, { Bearer: [] }];
const errors = { "401": { description: "Missing or invalid credentials" }, "403": { description: "Tenant owner required; no global/device/disabled-auth access" }, "503": { description: "Encryption key/storage unavailable or authenticated integrity check failed" } };
const id = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const metadata = { type: "object", required: ["id", "name", "contentType", "size", "sha256", "createdAt", "createdBy"], properties: {
  id: { type: "string", format: "uuid" }, name: { type: "string" }, contentType: { type: "string" }, size: { type: "integer", minimum: 0, maximum: 16777216 }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, createdAt: { type: "string", format: "date-time" }, createdBy: { type: "string", description: "Authenticated tenant owner DID" },
} };
export const filePaths = {
  "/api/v1/files": {
    post: { tags: ["Encrypted files"], summary: "Store an immutable private file without a Twin or IOTA transaction", security,
      description: "Raw bytes (not multipart/base64), max 16 MiB; no Content-Encoding. Dedicated server-side AES-256-GCM encryption. Non-idempotent: retries create new IDs. Tenant owner REST API key or configured JWT with matching sub required.",
      parameters: [{ name: "X-File-Name", in: "header", required: true, description: "Percent-encoded UTF-8 filename, no path/control characters, max 240 decoded UTF-8 bytes", schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } }, "*/*": { schema: { type: "string", format: "binary" } } } },
      responses: { "201": { description: "Stored; Location points to metadata", content: { "application/json": { schema: metadata } } }, "400": { description: "Invalid filename/MIME type" }, "413": { description: "File exceeds 16 MiB" }, "415": { description: "Compressed request bodies unsupported" }, ...errors } },
    get: { tags: ["Encrypted files"], summary: "List only the authenticated tenant's file metadata", security,
      parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } }, { name: "after", in: "query", schema: { type: "string", format: "uuid" } }],
      responses: { "200": { description: "Lexicographic ID page, not a chronological snapshot", content: { "application/json": { schema: { type: "object", properties: { files: { type: "array", items: metadata }, nextCursor: { type: "string", nullable: true } } } } } }, "400": { description: "Invalid pagination" }, ...errors } },
  },
  "/api/v1/files/{id}": { get: { tags: ["Encrypted files"], summary: "Read authenticated file metadata", security, parameters: [id], responses: { "200": { description: "Decrypted metadata (no storage URI)", content: { "application/json": { schema: metadata } } }, "404": { description: "Unknown ID or another tenant's file" }, ...errors } } },
  "/api/v1/files/{id}/content": { get: { tags: ["Encrypted files"], summary: "Download verified original bytes as an attachment", security, parameters: [id], responses: { "200": { description: "AES-GCM authenticated bytes; Cache-Control no-store, nosniff, attachment, X-File-SHA256", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, "404": { description: "Unknown ID or another tenant's file" }, ...errors } } },
};
