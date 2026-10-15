import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import express from "express";
import http from "http";
import { readFileSync } from "node:fs";
import cors from "cors";
import { typeDefs, resolvers } from "./graphql/schema.js";
import { getUserFromToken } from "./features/auth/auth.service.js";
import { User } from "./features/auth/auth.types.js";
import type { GraphQLContext as AuthContext } from "./features/auth/auth.resolvers.js";
import { ObjectId } from "mongodb";
import { translateWritingWord } from "./features/writing/writing.service.js";
import { syncStudy } from "./features/progress/studySync.js";
import { wordTranslationRouter } from "./features/translations/translations.http.js";
import { studyTransportRouter } from "./features/progress/studyTransport.http.js";
import { cardEditsRouter } from "./features/progress/cardEdits.http.js";
import { graphqlSecurity, graphqlRequestLimits } from "./lib/graphqlSecurity.js";
import { requestAdmission } from "./lib/requestSecurity.js";


// The privileged deployment helper writes this credential-free commit marker.
let release: string | null = null;
try {
  const marker = readFileSync("RELEASE", "utf8").trim();
  if (/^[0-9a-f]{40}$/.test(marker)) release = marker;
} catch { /* Local development and retained Render builds have no marker. */ }

export interface GraphQLContext extends AuthContext {
  clientAddress: string;
}

export async function createApplication(): Promise<{ app: express.Express; httpServer: http.Server; server: ApolloServer<GraphQLContext> }> {
  // Create Express app and HTTP server
  const app = express();
  // Caddy is a direct loopback peer; arbitrary external forwarding headers are not trusted.
  app.set("trust proxy", "loopback");
  app.disable("x-powered-by");
  const httpServer = http.createServer({ headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, app);
  httpServer.maxConnections = 256;

  // Create Apollo Server with drain plugin
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    parseOptions: { maxTokens: 5000 },
    allowBatchedHttpRequests: false,
    csrfPrevention: true,
    includeStacktraceInErrorResponses: false,
    stopOnTerminationSignals: false,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer }), graphqlSecurity()],
  });

  await server.start();

  // Apply CORS and JSON middleware
  const allowedOrigins = process.env.WEB_ORIGINS?.split(",").map(origin => origin.trim()).filter(Boolean);
  app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : true, exposedHeaders: ["Retry-After"] }));
  app.get("/health", (_req, res) => { res.set("Cache-Control", "no-store").json({ status: "ok", release }); });
  app.use(requestAdmission());
  app.use(express.json({ limit: "2mb" }));
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
  app.use(wordTranslationRouter());
  app.use(studyTransportRouter());
  app.use(cardEditsRouter());

  // Apply GraphQL endpoint
  app.use(
    "/graphql",
    graphqlRequestLimits,
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

        return { user, clientAddress: req.ip || req.socket.remoteAddress || "unknown" };
      },
    }) as unknown as express.RequestHandler,
  );

  const parserErrors: express.ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type !== "entity.parse.failed" && error?.type !== "entity.too.large") { next(error); return; }
    const oversized = error.type === "entity.too.large";
    const message = oversized ? "Request body is too large." : "Invalid JSON request.";
    res.status(oversized ? 413 : 400).json({ error: message, errors: [{ message, extensions: { code: "BAD_USER_INPUT" } }] });
  };
  app.use(parserErrors);

  return { app, httpServer, server };
}
