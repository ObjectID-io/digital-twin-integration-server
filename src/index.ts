import { createServer } from "node:http";
import { loadConfig } from "./config/loader.js";
import { logger } from "./common/logger.js";
import { createApp } from "./api/app.js";

const config = await loadConfig();
const runtime = createApp(config);
await runtime.startConnectors();
await runtime.startConnectorIngestion();
const server = createServer(runtime.app);
server.listen(config.server.port, config.server.host, () => {
  logger.info({ host: config.server.host, port: config.server.port }, "digital_twin_integration_server_started");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutdown_started");
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 10_000);
  deadline.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.stop();
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
