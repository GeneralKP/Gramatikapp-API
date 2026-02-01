import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { connectDB } from "./config/db.js";
import { typeDefs } from "./graphql/typeDefs.js";
import { resolvers, GraphQLContext } from "./graphql/resolvers.js";
import { getUserFromToken } from "./services/authService.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = parseInt(process.env.PORT || "4000", 10);

async function startServer() {
  // Connect to MongoDB
  await connectDB();

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
      let user = null;
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
