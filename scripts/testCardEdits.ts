import assert from 'node:assert/strict';
import { BSON, MongoClient, ObjectId, type ClientSession } from 'mongodb';
import { connectDatabase, closeDatabase, getDb } from '../src/lib/database.js';
import { validateStudyOperations, syncStudy, type StudyOperation } from '../src/features/progress/studySync.js';
import { applyPersonalContent, type CompactStudyItem } from '../src/features/progress/studyTransport.js';
import { readCardEdits } from '../src/features/progress/cardEdits.js';
import express from 'express';
import { cardEditsRouter } from '../src/features/progress/cardEdits.http.js';
import { generateToken } from '../src/features/auth/auth.service.js';
import type { User } from '../src/features/auth/auth.types.js';
import { DEFAULT_OPTIONS } from '../src/features/progress/scheduler.js';

// Deterministic Mongo responses, including transaction rollback. No socket or production mutation.
type Row = Record<string, unknown>;
let records: Record<string, Row[]> = {};
const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const owner = id(1), other = id(2), relationId = id(3), itemId = id(4), phraseId = id(5);
const matches = (row: Row, query: Row): boolean => Object.entries(query).every(([key, wanted]) => {
  if (key === '$or') return (wanted as Row[]).some(part => matches(row, part));
  if (key === '$and') return (wanted as Row[]).every(part => matches(row, part));
  const actual = key.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Row)[key] : undefined, row);
  if (wanted && typeof wanted === 'object' && '$in' in wanted) return (wanted.$in as unknown[]).some(value => String(actual) === String(value));
  if (wanted && typeof wanted === 'object' && '$ne' in wanted) return String(actual) !== String(wanted.$ne);
  return wanted === null ? actual == null : String(actual) === String(wanted);
});
function collection(name: string) {
  const rows = () => records[name] ??= [];
  return {
    async createIndex() {}, async dropIndex() {},
    async findOne(query: Row) { return rows().find(row => matches(row, query)) ?? null; },
    find(query: Row) { let limit = Infinity; return { project() { return this; }, sort() { return this; }, limit(value: number) { limit = value; return this; }, async toArray() { return rows().filter(row => matches(row, query)).slice(0, limit); } }; },
    async updateOne(query: Row, update: { $set?: Row }) {
      const row = rows().find(row => matches(row, query));
      assert.ok(row, `fixture target exists in ${name}`); Object.assign(row, update.$set);
    },
    async replaceOne(query: Row, value: Row) {
      const index = rows().findIndex(row => matches(row, query));
      if (index < 0) rows().push(value); else rows()[index] = value;
    },
    async insertOne(value: Row) { rows().push(value); },
  };
}
const originalConnect = MongoClient.prototype.connect, originalDb = MongoClient.prototype.db, originalSession = MongoClient.prototype.startSession, originalClose = MongoClient.prototype.close;
MongoClient.prototype.connect = async function () { return this; };
MongoClient.prototype.db = function () { return { collection } as unknown as ReturnType<MongoClient['db']>; };
MongoClient.prototype.close = async function () {};
MongoClient.prototype.startSession = function () {
  return { async withTransaction(work: () => Promise<void>) {
    const snapshot = BSON.EJSON.deserialize(BSON.EJSON.serialize(records)) as typeof records;
    try { return await work(); } catch (error) { records = snapshot; throw error; }
  }, async endSession() {} } as unknown as ClientSession;
};
const now = new Date();
const card = { _id: id(40), userId: owner, relationId, itemId, itemType: 'WORD', failureIndex: 7, failureAttemptIds: ['old_failure_receipt'], writingReinforcementCredit: .25, scheduleVersion: 3,
  ease: 2.5, interval: 30, repetitions: 4, totalReviews: 10, lapses: 2, isNew: false, createdAt: now, lastReviewed: now, nextDueDate: now,
  scheduler: { version: 1, phase: 'REVIEW', queue: 'DAY', interval: 30, ease: 2.5, remainingSteps: 0, scheduledSeconds: 0, lapses: 2, timeZone: 'Europe/Berlin', rollover: 4, options: DEFAULT_OPTIONS } };
records = { WORDS_ES_DE: [{ _id: relationId }], PHRASES_ES_DE: [{ _id: phraseId }], userprogresses: [card, { ...card, _id: id(41), userId: other }], cardedits: [], cardeditevents: [] };
const content = { german: 'Das Haus', spanish: 'La casa', notes: '', examples: ['Das Haus ist groß.'] };
const operation = (overrides: Partial<StudyOperation> = {}): StudyOperation => ({ id: `card_edit_${new ObjectId()}`, kind: 'EDIT', itemId: String(itemId), itemType: 'WORD', sessionId: 'fixture_session_1234', occurredAt: now.toISOString(), expectedVersion: 3,
  edit: { relationId: String(relationId), expectedContentVersion: 0, content, flag: 'BLUE', failureDelta: -2, nextDueDate: '2027-01-02T09:15:00.000Z' }, ...overrides });
const accepted = async (job: StudyOperation, userId = owner) => { const reply = await syncStudy(userId, [job]); assert.deepEqual(reply, { results: [{ id: job.id, success: true }] }); };
try {
  await connectDatabase();
  const originalSchedule = JSON.stringify(card.scheduler);
  const first = operation(); await accepted(first); await accepted(first);
  const stored = await getDb().progress.findOne({ userId: owner, itemId });
  assert.equal(stored.failureIndex, 5); assert.equal(stored.failureVersion, 1); assert.equal(stored.scheduleVersion, 4);
  assert.equal(stored.nextDueDate.toISOString(), first.edit!.nextDueDate); assert.equal(stored.temporaryDueDate, null); assert.equal(stored.lastReviewId, null);
  assert.equal(JSON.stringify(stored.scheduler), originalSchedule); assert.equal(stored.writingReinforcementCredit, .25); assert.deepEqual(stored.failureAttemptIds, ['old_failure_receipt']);
  assert.equal(records.userprogresses[1].failureIndex, 7); assert.equal(records.cardeditevents.length, 1);
  assert.equal((await readCardEdits(owner, 'WORD', [relationId]))[0].content.notes, ''); assert.deepEqual(await readCardEdits(other, 'WORD', [relationId]), []);
  console.log('PASS atomic personal edits, empty notes, five-color flags, manual due without review/history reset, owner isolation and lost-ACK replay');

  const stale = operation({ edit: { ...first.edit!, expectedContentVersion: 0 } });
  const conflict = await syncStudy(owner, [stale]); assert.equal(conflict.results[0].code, 'STALE_CONTENT');
  assert.equal(records.cardeditevents.length, 1); assert.equal(records.userprogresses[0].failureIndex, 5);
  const scheduleConflict = operation({ edit: { relationId: String(relationId), expectedContentVersion: 1, content: { ...content, notes: 'Keep on device' }, nextDueDate: first.edit!.nextDueDate } });
  assert.equal((await syncStudy(owner, [scheduleConflict])).results[0].code, 'STALE_CARD');
  assert.equal((await readCardEdits(owner, 'WORD', [relationId]))[0].version, 1);
  assert.equal((await syncStudy(owner, [operation({ ...first, edit: { ...first.edit!, flag: 'RED' } })])).results[0].code, 'EDIT_ID_REUSED');
  console.log('PASS content/schedule conflicts rollback the whole edit and command identities cannot be reused');

  // A concurrent genuine failure must survive a manual decrease. Retry applies the delta once.
  records.userprogresses[0].failureIndex = 8;
  const decrease = operation({ edit: { relationId: String(relationId), expectedContentVersion: 1, failureDelta: -5 } });
  await accepted(decrease); await accepted(decrease); assert.equal(records.userprogresses[0].failureIndex, 3);
  await accepted(operation({ edit: { relationId: String(relationId), expectedContentVersion: 1, failureDelta: -100 } }));
  assert.equal(records.userprogresses[0].failureIndex, 0);
  const unseen = operation({ itemId: String(phraseId), itemType: 'PHRASE', edit: { relationId: String(phraseId), expectedContentVersion: 0, content: { german: 'Ich lerne.', spanish: 'Aprendo.', notes: 'Personal phrase note', examples: [] }, flag: 'PURPLE' } });
  await accepted(unseen); assert.equal(records.userprogresses.length, 2); assert.equal((await readCardEdits(owner, 'PHRASE', [phraseId]))[0].flag, 'PURPLE');
  const foreign = operation({ edit: { relationId: String(relationId), expectedContentVersion: 0, failureDelta: 1 }, itemId: String(id(99)) });
  assert.equal((await syncStudy(other, [foreign])).results[0].code, 'EDIT_TARGET_UNAVAILABLE');
  console.log('PASS concurrent failures preserved, nonnegative adjustment, unseen dictionary phrase editing without allocating progress and foreign card rejection');

  const dependency = operation({ itemId: String(id(88)), edit: { relationId: String(relationId), expectedContentVersion: 1, flag: 'GREEN' } });
  const blocked = await syncStudy(owner, [stale, dependency]);
  assert.equal(blocked.results[1].code, 'DEPENDENCY_CONFLICT');
  assert.equal((await readCardEdits(owner, 'WORD', [relationId]))[0].flag, 'BLUE');
  const recognitionId = id(70), followerId = id(71);
  const fresh = { ...card, _id: id(72), itemId: recognitionId, scheduleVersion: 0, isNew: true, interval: 0, repetitions: 0, lastReviewed: null, scheduler: { ...card.scheduler, phase: 'NEW', queue: 'NEW' }, card: { sourceNoteGuid: 'new-pair', direction: 'DE_ES' } };
  records.userprogresses.push(fresh, { ...fresh, _id: id(73), itemId: followerId, card: { sourceNoteGuid: 'new-pair', direction: 'ES_DE' } });
  const postpone = operation({ itemId: String(recognitionId), expectedVersion: 0, edit: { relationId: String(relationId), expectedContentVersion: 1, nextDueDate: '2027-02-03T00:00:00.000Z' } });
  await accepted(postpone); await accepted(postpone);
  const follower = records.userprogresses.find(row => String(row.itemId) === String(followerId))!;
  assert.equal((follower.buriedUntil as Date).toISOString(), postpone.edit!.nextDueDate);
  assert.equal(follower.scheduleVersion, 0); assert.equal((fresh.scheduler as Row).phase, 'NEW');
  console.log('PASS cross-direction edit conflicts retain dependencies and postponed NEW recognition keeps its typing prerequisite');

  const mockOwner = { _id: owner, email: 'mock-owner@example.test', authProvider: 'local' } as User;
  const mockOther = { _id: other, email: 'mock-other@example.test', authProvider: 'local' } as User;
  records.users = [mockOwner as unknown as Row, mockOther as unknown as Row];
  const app = express(); app.use(express.json()); app.use(cardEditsRouter());
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request = (token: string, body: Row, path = 'read') => fetch(`http://127.0.0.1:${address.port}/api/card-edits/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    const body = { itemType: 'WORD', relationIds: [String(relationId)], userId: String(owner) };
    assert.equal((await request('', body)).status, 401);
    assert.equal((await request('invalid-token', body)).status, 401);
    const response = await request(generateToken(mockOwner), body);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json() as { edits: Row[] };
    assert.deepEqual(Object.keys(data.edits[0]).sort(), ['content', 'flag', 'itemType', 'relationId', 'version']);
    assert.equal(data.edits[0].flag, 'BLUE');
    assert.deepEqual(await (await request(generateToken(mockOther), body)).json(), { edits: [] }, 'request userId cannot choose the read owner');
    assert.equal((await request(generateToken(mockOwner), { ...body, relationIds: Array(101).fill(String(relationId)) })).status, 400);
    const empty = await request(generateToken(mockOwner), { itemType: 'PHRASE', relationId: String(phraseId), direction: 'ES_DE' }, 'editor');
    assert.equal(empty.status, 200); assert.equal('packet' in await empty.json() as object, false);
    assert.equal((await request(generateToken(mockOwner), { itemType: 'WORD', relationId: String(relationId), direction: 'CLOZE' }, 'editor')).status, 400);
    console.log('PASS authenticated dictionary reads, owner-bound overlays, bounded response shape and unstudied editor without fabricated progress');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }

  for (const flag of ['RED', 'ORANGE', 'GREEN', 'BLUE', 'PURPLE', null] as const) validateStudyOperations([operation({ edit: { relationId: String(relationId), expectedContentVersion: 0, flag } })]);
  for (const edit of [ { flag: 'BLACK' }, { failureDelta: .5 }, { nextDueDate: 'invalid' }, { nextDueDate: '2027-02-30T00:00:00.000Z' }, { nextDueDate: '2027-01-02' }, { content: { ...content, german: '' } }, { content: { ...content, examples: ['ä'.repeat(1001)] } }, { content: { ...content, extra: 'unused browser data' } }, { content: { ...content, notes: '字'.repeat(10000), examples: Array(20).fill('字'.repeat(1000)) } } ]) {
    assert.throws(() => validateStudyOperations([operation({ edit: { relationId: String(relationId), expectedContentVersion: 0, ...edit } as StudyOperation['edit'] })]));
  }
  const shell = { id: String(itemId), type: 'WORD', german: 'Haus', spanish: 'casa', contexts: [], failureIndex: 3,
    card: { sourceNoteGuid: 'house', direction: 'ES_DE', prompt: 'casa', answer: 'Haus', acceptedAnswers: ['Haus', 'Wohnhaus'], notes: 'old', examples: [] } } as unknown as CompactStudyItem;
  const personal = (await readCardEdits(owner, 'WORD', [relationId]))[0];
  const production = applyPersonalContent(shell, personal);
  assert.equal(production.card.prompt, 'La casa'); assert.equal(production.card.answer, 'Das Haus'); assert.deepEqual(production.card.acceptedAnswers, ['Das Haus']); assert.equal(production.card.notes, '');
  const recognition = applyPersonalContent({ ...shell, card: { ...shell.card, direction: 'DE_ES', prompt: 'Haus', answer: 'casa' } }, personal);
  assert.equal(recognition.card.prompt, 'Das Haus'); assert.equal(recognition.card.answer, 'La casa');
  const cloze = applyPersonalContent({ ...shell, card: { ...shell.card, direction: 'CLOZE' } }, personal);
  assert.equal(cloze.card.prompt, shell.card.prompt); assert.deepEqual(cloze.card.acceptedAnswers, shell.card.acceptedAnswers);
  assert.strictEqual(applyPersonalContent(shell), shell);
  console.log('PASS bounded strict edit contracts, both directions, accepted-answer invalidation, cloze identity and unchanged legacy response behavior');
} finally {
  await closeDatabase(); MongoClient.prototype.connect = originalConnect; MongoClient.prototype.db = originalDb; MongoClient.prototype.startSession = originalSession; MongoClient.prototype.close = originalClose;
}
