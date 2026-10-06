import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "http";
import cors from "cors";
import { connectDatabase, getDb } from "./lib/database.js";
import { typeDefs, resolvers } from "./graphql/schema.js";
import { getUserFromToken } from "./features/auth/auth.service.js";
import { User } from "./features/auth/auth.types.js";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import { translateWritingWord } from "./features/writing/writing.service.js";
import { syncStudy } from "./features/progress/studySync.js";

dotenv.config();

const PORT = parseInt(process.env.PORT || "4000", 10);

export interface GraphQLContext {
  user: User | null;
}

async function startServer() {
  // Connect to MongoDB
  await connectDatabase();

  // Create Express app and HTTP server
  const app = express();
  const httpServer = http.createServer(app);

  // Create Apollo Server with drain plugin
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await server.start();

  // Apply CORS and JSON middleware
  const allowedOrigins = process.env.WEB_ORIGINS?.split(",").map(origin => origin.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : true }));
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });
  app.post("/api/study/sync", async (req, res) => {
    try {
      const user = await getUserFromToken((req.headers.authorization || "").replace(/^Bearer /, ""));
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      res.json(await syncStudy(user._id, req.body?.operations));
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.post("/api/translate", async (req, res) => {
    try {
      const user = await getUserFromToken((req.headers.authorization || "").replace(/^Bearer /, ""));
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (!ObjectId.isValid(req.body?.exerciseId) || typeof req.body?.word !== "string") { res.status(400).json({ error: "Provide an exerciseId and Spanish word." }); return; }
      res.json(await translateWritingWord(user._id, new ObjectId(req.body.exerciseId), req.body.word));
    }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  // Apply GraphQL endpoint
  app.use(
    "/graphql",
    expressMiddleware(server, {
      context: async ({ req }): Promise<GraphQLContext> => {
        // Extract token from Authorization header
        const authHeader = req.headers.authorization || "";
        const token = authHeader.replace("Bearer ", "");

        // Get user from token if present
        let user: User | null = null;
        if (token) {
          user = await getUserFromToken(token);
        }

        return { user };
      },
    }) as unknown as express.RequestHandler,
  );

  await new Promise<void>((resolve) =>
    httpServer.listen({ port: PORT }, resolve),
  );

  console.log(`🚀 Server ready at http://localhost:${PORT}/graphql`);
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
