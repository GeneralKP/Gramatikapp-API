import 'dotenv/config';
import assert from 'node:assert/strict';
import { BSON, MongoClient } from 'mongodb';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { generateToken } from '../src/features/auth/auth.service.js';
import { CEFR_LEVELS } from '../src/features/levels/levels.js';
const { chromium } = createRequire(new URL('../../german-gramatic-web/package.json', import.meta.url))('playwright');
assert.match(process.env.MONGODB_URI ?? '', /^mongodb:\/\/127\.0\.0\.1:27019\//);
const client = await new MongoClient(process.env.MONGODB_URI!).connect(), db = client.db('study_curriculum_browser_fixture');
const source = BSON.deserialize(await readFile('.local/study-level-audit/source.bson')) as any;
const user = await db.collection('users').findOne({ _id: source.user._id }); assert.ok(user);
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const context = await browser.newContext(), page = await context.newPage(), errors: string[] = [];
  page.setDefaultTimeout(15000);
  await db.collection('userprogresses').deleteMany({ userId: user._id }); await db.collection('reviewevents').deleteMany({ userId: user._id });
  page.on('pageerror', e => errors.push(e.message));
  await context.addInitScript(({ user, token }) => { localStorage.setItem('german_gramatic_user', JSON.stringify(user)); localStorage.setItem('german_gramatic_token', token); localStorage.setItem('german_gramatic_settings', JSON.stringify(user.settings)); localStorage.setItem('i18nextLng', 'en'); }, { user: { id: String(user._id), email: user.email, authProvider: 'email', settings: user.settings }, token: generateToken(user as never) });
  await page.route(/\/(graphql|api\/study\/.*)$/, route => { assert.ok(['127.0.0.1:4000', 'localhost:4000'].includes(new URL(route.request().url()).host)); return route.continue(); });
  for (const type of ['WORD', 'PHRASE'] as const) {
    const relations = await db.collection(type === 'WORD' ? 'WORDS_ES_DE' : 'PHRASES_ES_DE').find().toArray();
    const german = await db.collection(type === 'WORD' ? 'WORDS_DE' : 'PHRASES_DE').find().toArray();
    const spanish = await db.collection(type === 'WORD' ? 'WORDS_ES' : 'PHRASES_ES').find().toArray();
    const plan = CEFR_LEVELS.flatMap(level => {
      const de = german.find(r => r.cefrLevel === level)!, relation = relations.find(r => r.translated.equals(de._id))!, es = spanish.find(r => r._id.equals(relation.main))!;
      return type === 'WORD' ? [{ level, direction: 'DE_ES', answer: es.word }, { level, direction: 'ES_DE', answer: de.word }] : [{ level, direction: 'ES_DE', answer: de.phrase }];
    });
    const responseReady = page.waitForResponse(response => response.url().endsWith('/api/study/queue'));
    await page.goto(`http://127.0.0.1:5173/learn/${type === 'WORD' ? 'words' : 'phrases'}`);
    const packet = await (await responseReady).json();
    const received = [...packet.items, ...packet.manifest];
    console.log(`Checking browser ${type}`);
    for (let i = 0; i < plan.length; i++) {
      await page.getByRole('heading').first().waitFor();
      // API shells carry the authoritative queue and real catalog text. The web
      // page must display each prompt in that order across starter hydration.
      const packet = received.filter(r => r.type === type)[i];
      assert.ok(packet, `Missing ${type} queue item ${i}`);
      const relation = relations.find(r => r._id.toString() === (packet.schedule.state.relationId ?? packet.id))
        ?? relations.find(r => german.some(de => de._id.equals(r.translated) && (de.word ?? de.phrase) === packet.german));
      const level = german.find(de => de._id.equals(relation?.translated))?.cefrLevel;
      assert.equal(level, plan[i].level);
      if (type === 'WORD') assert.equal(packet.card.direction, plan[i].direction);
      const prompt = type === 'WORD' ? packet.card.prompt : packet.spanish;
      await page.getByRole('heading', { name: prompt, exact: true }).waitFor();
      const answer = type === 'WORD' ? packet.card.answer : plan[i].answer;
      if (type === 'WORD' && plan[i].direction === 'DE_ES') {
        await page.getByRole('button', { name: 'Show Spanish translation', exact: true }).click();
      } else {
        const input = page.getByRole('textbox'); await input.waitFor();
        await input.fill(answer); await page.getByRole('button', { name: 'Show answer', exact: true }).click();
      }
      await page.getByRole('button', { name: 'Easy', exact: true }).click();
    }
    await page.getByRole('heading', { name: 'Session Complete!', exact: true }).waitFor();
    const deadline = Date.now() + 15000;
    while (await db.collection('reviewevents').countDocuments({ userId: user._id, itemType: type }) < plan.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 30));
    assert.equal(await db.collection('reviewevents').countDocuments({ userId: user._id, itemType: type }), plan.length);
    console.log(`PASS real Chrome → HTTP → Mongo: ${type}, A1.1–C2.2, ${plan.length} displayed cards/receipts`);
  }
  assert.deepEqual(errors, []);
} catch (error) { const pages = browser.contexts().flatMap(c => c.pages()); if (pages[0]) console.log((await pages[0].locator('body').innerText()).slice(0, 2400)); throw error; } finally { await browser.close(); await client.close(); }
