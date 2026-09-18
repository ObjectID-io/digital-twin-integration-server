// Run on the deployment host. Never emit credential values.
import { randomBytes } from "node:crypto";
import { readFile, open, rename, stat } from "node:fs/promises";
const path = process.argv[2];
if (!["/root/digital-twin-integration-server/secrets/credentials.json", "/root/digital-twin-integration-server-mainnet/secrets/credentials.json"].includes(path)) throw new Error("Unexpected credential file");
const credentials = JSON.parse(await readFile(path, "utf8"));
if (credentials.DTIS_FILE_ENCRYPTION_KEY) {
  const key = Buffer.from(credentials.DTIS_FILE_ENCRYPTION_KEY, "base64");
  if (key.length !== 32 || key.toString("base64") !== credentials.DTIS_FILE_ENCRYPTION_KEY) throw new Error("Existing file encryption key invalid; refusing replacement");
  console.log("Existing file encryption key preserved");
} else {
  const mode = (await stat(path)).mode & 0o777;
  credentials.DTIS_FILE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const temporary = `${path}.files-${process.pid}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(`${JSON.stringify(credentials, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  console.log("Dedicated file encryption key configured; no existing credentials changed");
}
