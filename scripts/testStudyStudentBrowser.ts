import 'dotenv/config';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ObjectId } from 'mongodb';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { generateToken } from '../src/features/auth/auth.service.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { simulationCards } from './lib/studyIntervalSimulation.js';
import { studyReviewOptions } from '../src/features/progress/studyScheduling.js';

if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27019/')) throw new Error('Use the disposable replica set on port 27019.');
const { chromium } = createRequire(new URL('../../german-gramatic-web/package.json', import.meta.url))('playwright');
const db = await connectDatabase(), userId = new ObjectId();
const phrases = process.argv.includes('--phrases');
const cards = simulationCards(userId, 10).slice(phrases ? 10 : 0, phrases ? 20 : 10);
const user = { _id: userId, email: `student-${userId}@example.invalid`, authProvider: 'email', settings: { ...defaultUserSettings, soundEnabled: false, dailyNewCards: 10 }, createdAt: cards[0].createdAt };
let browser;
try {
  await db.users.insertOne(user);
  await db.progress.insertMany(cards);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext(), page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await context.addInitScript(({ user, token }) => {
    localStorage.setItem('german_gramatic_user', JSON.stringify(user));
    localStorage.setItem('german_gramatic_token', token);
    localStorage.setItem('german_gramatic_settings', JSON.stringify(user.settings));
    localStorage.setItem('i18nextLng', 'en');
  }, { user: { id: String(userId), email: user.email, authProvider: user.authProvider, settings: user.settings }, token: generateToken(user) });
  // Real HTTP and MongoDB; abort any accidental non-loopback API destination.
  await page.route('**/graphql', route => {
    assert.ok(['localhost:4000', '127.0.0.1:4000'].includes(new URL(route.request().url()).host));
    return route.continue();
  });
  await page.route('**/api/study/**', route => {
    assert.ok(['localhost:4000', '127.0.0.1:4000'].includes(new URL(route.request().url()).host));
    return route.continue();
  });
  await page.clock.install({ time: new Date('2026-04-10T10:00:00Z') });
  const waitReceipts = async (count: number) => {
    const deadline = Date.now() + 10000;
    while (await db.reviewEvents.countDocuments({ userId }) < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await db.reviewEvents.countDocuments({ userId }), count);
  };
  const review = async () => {
    const heading = page.getByRole('heading', { name: phrases ? /^frase \d+$/ : /^palabra \d+$/ });
    await heading.waitFor();
    const prompt = await heading.innerText(), card = cards.find(p => p.card.prompt === prompt)!;
    assert.ok(card);
    await page.getByRole('textbox').fill(card.card.answer);
    await page.getByRole('button', { name: 'Show answer', exact: true }).click();
    if (phrases) {
      const stored = await db.progress.findOne({ _id: card._id });
      if (stored.scheduler.phase === 'NEW') {
        const time = new Date(await page.evaluate(() => new Date().toISOString()));
        assert.deepEqual(studyReviewOptions(stored, time).map(o => o.delaySeconds), [7, 30, 180, 365].map(days => days * 86400));
        for (const [grade, label] of Object.entries({ again: '7d', hard: '30d', good: '6mo', easy: '1y' })) {
          assert.equal(await page.getByTestId(`review-delay-${grade}`).innerText(), label);
        }
      }
      if (stored.scheduler.phase === 'REVIEW') {
        const time = new Date(await page.evaluate(() => new Date().toISOString()));
        const options = studyReviewOptions(stored, time);
        assert.equal(options[0].phase, 'RELEARNING');
        assert.ok(options.every((o, i) => !i || o.delaySeconds >= options[i - 1].delaySeconds));
        assert.ok(options.find(o => o.grade === 'GOOD')!.delaySeconds / 86400 > stored.interval, 'The revealed Good interval grows');
        const delays = [];
        for (const option of options) {
          const label = option.grade[0] + option.grade.slice(1).toLowerCase();
          const button = page.getByRole('button', { name: label, exact: true });
          assert.equal(await button.getAttribute('title'), await page.evaluate(date => new Date(date).toLocaleString(), option.nextDueDate), 'Displayed phrase due date agrees with API preview');
          delays.push(await page.getByTestId(`review-delay-${option.grade.toLowerCase()}`).innerText());
        }
        assert.equal(new Set(delays).size, 4, 'All established phrase time labels are distinct');
        assert.equal(await page.getByRole('button', { name: 'Revisit', exact: true }).count(), 0);
      }
    }
    await page.getByRole('button', { name: 'Good', exact: true }).click();
  };
  await page.goto(`http://127.0.0.1:5173/learn/${phrases ? 'phrases' : 'words'}`);
  for (let i = 0; i < 10; i++) await review();
  // Phrase Good ends today's session immediately. Word Good keeps minute
  // repetitions local; its batch is acknowledged after the second round.
  if (phrases) await waitReceipts(10);
  const learningCards = await db.progress.find({ userId }).toArray();
  if (phrases) {
    assert.ok(learningCards.every(p => p.scheduler.phase === 'REVIEW' && p.interval === 180 && p.totalReviews === 1));
    const due = Math.min(...learningCards.map(p => +p.nextDueDate));
    await page.clock.setSystemTime(new Date(due - 60000)); await page.reload();
    await page.getByRole('heading', { name: 'Cards are still available', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: /^frase \d+$/ }).count(), 0);
    assert.equal(await db.reviewEvents.countDocuments({ userId }), 10);
  }
  await page.clock.setSystemTime(phrases ? new Date(Math.max(...learningCards.map(p => +p.nextDueDate)) + 3600000) : new Date('2026-04-10T10:15:00Z'));
  if (phrases) await page.reload();
  for (let i = 0; i < 10; i++) await review();
  await page.getByRole('heading', { name: 'Session Complete!', exact: true }).waitFor();
  await waitReceipts(20);
  let saved = await db.progress.find({ userId }).toArray();
  assert.equal(saved.length, 10);
  assert.ok(saved.every(p => p.scheduler.phase === 'REVIEW' && p.totalReviews === 2 && (phrases ? p.interval > 180 : p.interval === 1)));
  if (!phrases) assert.ok(saved.every(p => p.nextDueDate.toISOString() === '2026-04-11T02:00:00.000Z'));
  if (phrases) {
    const receipts = await db.reviewEvents.find({ userId, itemType: 'PHRASE' }).toArray();
    assert.equal(receipts.length, 20);
    for (const receipt of receipts) {
      const before = { ...cards.find(p => p.itemId.equals(receipt.itemId)), ...receipt.before };
      const preview = studyReviewOptions(before, receipt.reviewedAt).find(o => o.grade === receipt.grade)!;
      assert.equal(receipt.after.nextDueDate.toISOString(), preview.nextDueDate, 'All phrase receipts retain their original previewed due date');
    }
    assert.ok(saved.every(p => p.ease === 2.5 && p.failureIndex === 0 && p.scheduler.options.intervalMultiplier === 1));
    console.log(JSON.stringify({ browserPhraseIntervals: [learningCards.map(p => p.interval), saved.map(p => p.interval)] }));
  } else {
    await page.clock.setSystemTime(new Date('2026-04-11T10:00:00Z'));
    await page.reload();
    for (let i = 0; i < 10; i++) await review();
    await page.getByRole('heading', { name: 'Session Complete!', exact: true }).waitFor();
    await waitReceipts(30);
    saved = await db.progress.find({ userId }).toArray();
    assert.ok(saved.every(p => p.totalReviews === 3 && p.interval > 1));
    assert.equal(await db.reviewEvents.countDocuments({ userId, reviewedAt: { $gte: new Date('2026-04-10'), $lt: new Date('2026-04-12') } }), 30);
    assert.ok(saved.every(p => p.failureIndex === 0));
  }
  assert.deepEqual(errors, []);
  console.log(phrases
    ? 'PASS real Chrome → HTTP API → Mongo: 10-phrase student across six months, exact 7/30/180/365-day first options and adaptive review, 20 receipts, growing displayed/saved intervals, distinct labels, stable presets and before-due eligibility'
    : 'PASS real Chrome → local HTTP API → Mongo: 10-word student on 10/11 April, advancing 15 minutes/one day, 30 original-time receipts, graduation and growing intervals');
} finally {
  await browser?.close();
  await db.reviewEvents.deleteMany({ userId });
  await db.progress.deleteMany({ userId });
  await db.users.deleteOne({ _id: userId });
  await closeDatabase();
}
