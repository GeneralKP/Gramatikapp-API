import dotenv from "dotenv";
import { connectDatabase, closeDatabase } from "./lib/database.js";
import { createApplication } from "./app.js";
import { warmStudyCatalog, startStudyCatalogRefresh, stopStudyCatalogRefresh } from "./features/progress/studyLoading.js";

dotenv.config();

const PORT = parseInt(process.env.PORT || "4000", 10);
const HOST = process.env.HOST?.trim() || undefined;

async function startServer() {
  await connectDatabase();
  await warmStudyCatalog();
  startStudyCatalogRefresh();
  const { httpServer, server } = await createApplication();

  await new Promise<void>((resolve) =>
    httpServer.listen({ port: PORT, ...(HOST ? { host: HOST } : {}) }, resolve),
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopStudyCatalogRefresh();
    try {
      // Drain active HTTP requests before closing transaction connections.
      await server.stop();
      await closeDatabase();
      process.exit(0);
    } catch {
      console.error("Failed to shut down cleanly");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });

  console.log(`🚀 Server ready at http://${HOST || "localhost"}:${PORT}/graphql`);
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
