import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { collectionConfig, dueDate, plainText } from './lib/anki.js';
import { studyReviewOptions } from '../src/features/progress/studyScheduling.js';
import type { UserProgress } from '../src/features/progress/progress.types.js';

// Read-only audit. Never initializes progress, indexes or scheduler profiles.
const args = process.argv.slice(2);
const option = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const exportPath = option('--export'), outputPath = option('--output'), envPath = option('--env-file');
if (!exportPath || !outputPath || !envPath) throw new Error('Usage: auditPracticeScheduling.ts --export export.json --output report.json --env-file private.env');
const env = dotenv.parse(await readFile(envPath));
const uri = env.MONGODB_URI || `mongodb+srv://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_USER_PASSWORD)}@${env.DB_CLUSTER}.mongodb.net/?retryWrites=true&w=majority`;
const source = JSON.parse(await readFile(exportPath, 'utf8'));
const cards = new Map<string, any>(source.tables.cards.map((card: any) => [String(card.id), card]));
const notes = new Map<number, any>(source.tables.notes.map((note: any) => [note.id, note]));
const latest = new Map<string, number>();
for (const review of source.tables.revlog) if (review.ease > 0) latest.set(String(review.cid), Math.max(latest.get(String(review.cid)) ?? 0, review.id));
const config = collectionConfig(source.tables.config);
const client = await new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect();
try {
  const db = client.db('gramatikapp');
  const [progress, profiles, events, imports, archivedReviews] = await Promise.all([
    db.collection('userprogresses').find({}).toArray(),
    db.collection('schedulerprofiles').find({}).toArray(),
    db.collection('reviewevents').find({}).toArray(),
    db.collection('ANKI_IMPORTS').find({}, { projection: { sourceHash: 1, status: 1 } }).toArray(),
    db.collection('ANKI_REVIEWS').aggregate([
      { $match: { 'raw.ease': { $gt: 0 } } },
      { $group: { _id: { userId: '$userId', cid: '$raw.cid' }, lastReviewed: { $max: '$raw.id' } } },
    ]).toArray(),
  ]);
  const now = new Date();
  const profileById = new Map(profiles.map(p => [String(p._id), p]));
  const archivedLatest = new Map(archivedReviews.map(r => [`${r._id.userId}:${r._id.cid}`, r.lastReviewed]));
  const totals = { progress: progress.length, matchedAnkiCards: 0, identityMismatches: 0, newAnkiCardsWithoutCalendarDue: 0,
    scheduledAnkiCards: 0, sameDueDate: 0, differentDueDate: 0, differencesWithActiveAppReviews: 0, differencesMatchingLatestAppReview: 0,
    differentPhase: 0, differentLastReviewed: 0, differentLifetimeReviews: 0,
    exportReviewHistoryDiffersFromOriginalArchive: 0, appHistoryDiffersFromArchiveWithoutActiveReview: 0,
    appLegacyHistoryWithoutReviewReceipt: 0 };
  const differences: any[] = [];
  for (const p of progress) {
    const receipts = events.filter(e => String(e.userId) === String(p.userId) && String(e.itemId) === String(p.itemId));
    if (p.card?.source === 'APP' && p.lastReviewed && p.totalReviews === undefined && !receipts.some(e => +e.reviewedAt === +p.lastReviewed)) totals.appLegacyHistoryWithoutReviewReceipt++;
    if (p.card?.source !== 'ANKI') continue;
    const card = cards.get(p.card.sourceCardId);
    if (!card) continue;
    totals.matchedAnkiCards++;
    if (notes.get(card.nid)?.guid !== p.card.sourceNoteGuid || p.anki?.ord !== card.ord) { totals.identityMismatches++; continue; }
    const expectedPhase = ['NEW', 'LEARNING', 'REVIEW', 'RELEARNING'][card.type];
    const phaseDiffers = p.scheduler?.phase !== expectedPhase;
    if (phaseDiffers) totals.differentPhase++;
    const last = latest.get(String(card.id)) ?? null;
    if ((p.lastReviewed ? +p.lastReviewed : null) !== last) totals.differentLastReviewed++;
    // repetitions is a success streak; Anki reps is lifetime reviews.
    if (p.totalReviews !== card.reps) totals.differentLifetimeReviews++;
    const archivedLast = archivedLatest.get(`${p.userId}:${card.id}`) ?? null;
    if (last !== archivedLast || p.anki?.reps !== card.reps) totals.exportReviewHistoryDiffersFromOriginalArchive++;
    if (!receipts.some(e => !e.reversedAt) && ((p.lastReviewed ? +p.lastReviewed : null) !== archivedLast || p.totalReviews !== p.anki?.reps))
      totals.appHistoryDiffersFromArchiveWithoutActiveReview++;
    // Anki NEW due values are order positions. No date exists to reconcile.
    if (card.type === 0 && card.queue === 0) { totals.newAnkiCardsWithoutCalendarDue++; continue; }
    const profile = profileById.get(String(p.userId));
    if (!profile) throw new Error('Matched account has no scheduler profile');
    const expected = dueDate(card, source.tables.col[0], { ...config, rollover: profile.rollover }, profile.timeZone, now);
    totals.scheduledAnkiCards++;
    if (+expected === +p.nextDueDate) { totals.sameDueDate++; continue; }
    totals.differentDueDate++;
    const active = receipts.filter(e => !e.reversedAt);
    if (active.length) totals.differencesWithActiveAppReviews++;
    const currentReceipt = active.find(e => e.reviewId === p.lastReviewId);
    const matchesLatestReview = !!currentReceipt && +currentReceipt.after?.nextDueDate === +p.nextDueDate
      && currentReceipt.after?.scheduler?.phase === p.scheduler?.phase;
    if (matchesLatestReview) totals.differencesMatchingLatestAppReview++;
    differences.push({ sourceCardId: String(card.id), direction: p.card.direction, sourceDueDate: expected.toISOString(),
      appDueDate: p.nextDueDate?.toISOString(), sourcePhase: expectedPhase, appPhase: p.scheduler?.phase,
      activeAppReviews: active.length, undoneAppReviews: receipts.length - active.length, matchesLatestAppReview: matchesLatestReview });
  }
  const waggonSourceNotes = source.tables.notes.filter((n: any) => /\b(?:waggon|wagon)\b|vag[oó]n/i.test(plainText(n.flds)));
  const waggon = progress.filter(p => /\b(?:waggon|wagon)\b|vag[oó]n/i.test(`${p.card?.prompt ?? ''} ${p.card?.answer ?? ''}`)).map(p => ({
    source: p.card?.source, direction: p.card?.direction, lastReviewed: p.lastReviewed, nextDueDate: p.nextDueDate,
    lastFailedAt: p.lastFailedAt, interval: p.interval, repetitions: p.repetitions,
    phase: p.scheduler?.phase, failureIndex: p.failureIndex, scheduleVersion: p.scheduleVersion,
    reviewOptions: studyReviewOptions(p as UserProgress, now),
    totalReviewsPresent: p.totalReviews !== undefined,
    receipts: events.filter(e => String(e.userId) === String(p.userId) && String(e.itemId) === String(p.itemId)).map(e => ({
      grade: e.grade, reviewedAt: e.reviewedAt, reversedAt: e.reversedAt,
      previousDueDate: e.before?.nextDueDate, resultingDueDate: e.after?.nextDueDate,
    })),
  }));
  const report = { auditedAt: now.toISOString(), sourceHash: source.sourceHash,
    matchesCompletedImportHash: imports.some(i => i.status === 'complete' && i.sourceHash === source.sourceHash),
    sourceCounts: { notes: notes.size, cards: cards.size, reviews: source.tables.revlog.length }, totals,
    waggonSourceNoteCount: waggonSourceNotes.length, waggon, differences,
    interpretation: 'Snapshot comparison only. App reviews and edits may legitimately diverge from an export. Anki cannot verify APP-only history; absence of a legacy receipt is inconclusive. No database writes.' };
  const output = resolve(outputPath);
  await mkdir(resolve(output, '..'), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, differences: `${differences.length} details saved privately`, output }, null, 2));
} finally { await client.close(); }
