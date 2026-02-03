import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
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

  // Create Apollo Server
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
  });

  // Start the server with context
  const { url } = await startStandaloneServer(server, {
    listen: { port: PORT },
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
  });

  console.log(`🚀 Server ready at ${url}`);
  console.log(`📊 GraphQL Playground available at ${url}`);
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
