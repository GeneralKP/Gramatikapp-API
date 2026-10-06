import { Router } from "express";
import { getUserFromToken } from "../auth/auth.service.js";
import { loadCompactStudyQueue, loadCompactStudyCards, loadCompactStudyMore } from "./studyTransport.js";

export function studyTransportRouter(options: { authenticate?: typeof getUserFromToken } = {}): Router {
  const router = Router();
  for (const [path, load] of [["queue", loadCompactStudyQueue], ["cards", loadCompactStudyCards], ["more", loadCompactStudyMore]] as const) {
    router.post(`/api/study/${path}`, async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const user = await (options.authenticate ?? getUserFromToken)((req.headers.authorization || "").replace(/^Bearer /, ""));
        if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
        res.json(await load(user, req.body ?? {}));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const invalid = /^(Invalid |Study card unavailable)/.test(message);
        res.status(invalid ? 400 : 503).json({ error: invalid ? message : "The study cards could not be loaded. Please retry." });
      }
    });
  }
  return router;
}
