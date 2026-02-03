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
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

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
