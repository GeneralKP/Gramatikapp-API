import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { getUserFromToken } from '../auth/auth.service.js';
import { getDb } from '../../lib/database.js';
import { readCardEdits } from './cardEdits.js';
import { loadCompactStudyCards } from './studyTransport.js';

/** Dictionary reads only personal overlays for the displayed page. Rich owned cards load on Edit. */
export function cardEditsRouter(): Router {
  const router = Router();
  for (const path of ['read', 'editor'] as const) router.post(`/api/card-edits/${path}`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const user = await getUserFromToken((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
      const { itemType, relationIds, relationId, direction } = req.body ?? {};
      if (!['WORD', 'PHRASE'].includes(itemType)) throw new Error('Invalid card type.');
      const ids = path === 'read' ? relationIds : [relationId];
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) throw new Error('Invalid dictionary entries.');
      const edits = await readCardEdits(user._id, itemType, ids.map(id => new ObjectId(id)));
      const overlays = edits.map(edit => ({ relationId: String(edit.relationId), itemType: edit.itemType, version: edit.version, flag: edit.flag, ...(edit.content ? { content: edit.content } : {}) }));
      if (path === 'read') { res.json({ edits: overlays }); return; }
      if (!['ES_DE', 'DE_ES'].includes(direction)) throw new Error('Invalid study direction.');
      const rows = await getDb().progress.find({ userId: user._id, itemType, supersededByAnki: { $ne: true },
        $and: [{ $or: [{ relationId: new ObjectId(relationId) }, { relationId: null, itemId: new ObjectId(relationId) }] }, { $or: [{ 'card.direction': direction }, { card: null }] }] })
        .project({ itemId: 1 }).sort({ updatedAt: -1, _id: 1 }).limit(1).toArray();
      const packet = rows.length ? await loadCompactStudyCards(user, { itemIds: [String(rows[0].itemId)] }) : undefined;
      res.json({ edits: overlays, ...(packet ? { packet } : {}) });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'The editor could not be loaded.' }); }
  });
  return router;
}
