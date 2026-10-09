import { Router } from "express";
import compression from 'compression';
import { constants } from 'node:zlib';
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { getUserFromToken, verifyToken } from "../auth/auth.service.js";
import type { SchedulerProfile } from "./reviews.js";
import { loadCompactStudyQueue, loadCompactStudyCards, loadCompactStudyMore } from "./studyTransport.js";

export function studyTransportRouter(options: { authenticate?: typeof getUserFromToken } = {}): Router {
  const router = Router();
  // The native fetch stack and browsers negotiate/decode these transparently.
  // Compress only card reads; authentication and mutation receipts stay separate.
  router.use(['/api/study/queue', '/api/study/cards', '/api/study/more'], compression({ threshold: 1024, level: 1,
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: 2 } },
  }));
  for (const [path, load] of [["queue", loadCompactStudyQueue], ["cards", loadCompactStudyCards], ["more", loadCompactStudyMore]] as const) {
    router.post(`/api/study/${path}`, async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        const token = (req.headers.authorization || "").replace(/^Bearer /, "");
        let prepared: { userId: ObjectId; profile: Promise<SchedulerProfile | null> } | undefined;
        if (path === "queue" && !options.authenticate) {
          const payload = verifyToken(token);
          if (!payload) { res.status(401).json({ error: "Unauthorized" }); return; }
          const userId = new ObjectId(payload.userId);
          // Start only after signature/payload validation. This profile is fresh
          // but observed earlier within this request than the account result.
          const profile = Promise.resolve().then(() => getDb().schedulerProfiles.findOne({ _id: userId }));
          void profile.catch(() => undefined);
          prepared = { userId, profile };
        }
        const user = await (options.authenticate ?? getUserFromToken)(token);
        if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
        res.json(await (path === "queue" ? loadCompactStudyQueue(user, req.body ?? {}, prepared) : load(user, req.body ?? {})));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const invalid = /^(Invalid |Study card unavailable)/.test(message);
        res.status(invalid ? 400 : 503).json({ error: invalid ? message : "The study cards could not be loaded. Please retry." });
      }
    });
  }
  return router;
}
