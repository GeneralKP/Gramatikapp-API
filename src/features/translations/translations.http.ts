import { Router } from "express";
import { getUserFromToken } from "../auth/auth.service.js";
import { translatePhraseWord } from "./translations.service.js";

export function wordTranslationRouter(options: { authenticate?: typeof getUserFromToken; lookup?: typeof translatePhraseWord } = {}): Router {
  const router = Router();
  router.post("/api/word-translations", async (req, res) => {
    try {
      const user = await (options.authenticate ?? getUserFromToken)((req.headers.authorization || "").replace(/^Bearer /, ""));
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      const result = await (options.lookup ?? translatePhraseWord)(req.body ?? {});
      res.status(result.status === "PENDING" ? 202 : 200).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const invalid = /^(Provide |Supported language pairs|Invalid phrase context)/.test(message);
      res.status(invalid ? 400 : 503).json({ error: invalid ? message : "This word could not be translated and saved. Please retry." });
    }
  });
  return router;
}
