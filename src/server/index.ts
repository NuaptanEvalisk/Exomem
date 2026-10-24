import { Store } from "./store.js";
import { adminApp } from "./admin.js";
import { mcpApp } from "./mcp.js";
const store = new Store(process.env.EXOMEM_DATABASE ?? "data/exomem.sqlite");
const admin = adminApp(store),
  mcp = mcpApp(store);
await admin.listen({
  host: process.env.EXOMEM_ADMIN_HOST ?? "127.0.0.1",
  port: Number(process.env.EXOMEM_ADMIN_PORT ?? 3210),
});
await mcp.listen({
  host: process.env.EXOMEM_MCP_HOST ?? "127.0.0.1",
  port: Number(process.env.EXOMEM_MCP_PORT ?? 3211),
});
console.log("Exomem ready: admin on 3210, MCP on 3211.");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await Promise.all([admin.close(), mcp.close()]);
    store.close();
    process.exit(0);
  });
