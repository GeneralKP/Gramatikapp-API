import 'dotenv/config';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connectDatabase, closeDatabase } from '../src/lib/database.js';
import { defaultUserSettings } from '../src/features/auth/auth.types.js';
import { generateToken } from '../src/features/auth/auth.service.js';
import { initialScheduler, DEFAULT_OPTIONS } from '../src/features/progress/scheduler.js';

if (!process.env.MONGODB_URI?.startsWith('mongodb://127.0.0.1:27019/')) throw new Error('Use disposable loopback MongoDB on port 27019.');
const require=createRequire(new URL('../../german-gramatic-web/package.json',import.meta.url)),{chromium}=require('playwright');
const db=await connectDatabase(),userId=new ObjectId(),es=new ObjectId(),de=new ObjectId(),relation=new ObjectId(),now=new Date();
const user:any={_id:userId,email:`study-sync-${userId}@example.invalid`,authProvider:'email',createdAt:now,settings:{...defaultUserSettings,soundEnabled:false,dailyNewCards:2}};
const token=generateToken(user),port=4259,apiUrl=`http://127.0.0.1:${port}`,app=process.env.TEST_APP_URL||'http://127.0.0.1:5175';
const compiled=readFileSync('dist/index.js','utf8'),needle='httpServer.listen({ port: PORT }, resolve)';assert.ok(compiled.includes(needle));writeFileSync('dist/test-study-sync-index.js',compiled.replace(needle,'httpServer.listen({ port: PORT, host: "127.0.0.1" }, resolve)'));
const api=spawn(process.execPath,['dist/test-study-sync-index.js'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let started=false;api.stdout.on('data',data=>{if(data.toString().includes('Server ready'))started=true;});api.stderr.on('data',()=>{});
const wait=async(check:()=>Promise<boolean>)=>{const until=Date.now()+30000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Study sync browser state timed out');};
let browser:any,closing=false;
try{
 await db.users.insertOne(user);
 await db.wordsES.insertOne({_id:es,word:'casa',gramaticalCategories:['NOUN'],examples:[],contexts:['university'],createdAt:now});
 await db.wordsDE.insertOne({_id:de,word:'Haus',gramaticalCategories:['NOUN'],examples:[],contexts:['university'],forms:{gender:'das'},createdAt:now});
 await db.relationsWordsEsDe.insertOne({_id:relation,main:es,translated:de,createdAt:now});
 const docs:any[]=[];
 for(let i=0;i<105;i++){
  const fresh=i<2,p:any={_id:new ObjectId(),userId,itemId:new ObjectId(),itemType:'WORD',relationId:relation,isNew:fresh,failureIndex:0,ease:2.5,interval:fresh?0:30,repetitions:fresh?0:5,totalReviews:fresh?0:5,lapses:0,lastReviewed:fresh?null:new Date(now.getTime()-30*86400000),nextDueDate:new Date(now.getTime()-86400000),createdAt:now,
    card:{source:'ANKI',sourceCardId:String(1790000000000+i),sourceNoteGuid:fresh?'sync-new-word':`sync-${i}`,direction:i===0?'DE_ES':'ES_DE',prompt:i===0?'das Haus':`casa ${i}`,answer:i===0?'casa':'das Haus',acceptedAnswers:[i===0?'casa':'das Haus'],notes:'',examples:[],deck:'Browser',tags:[]}};
  p.scheduler=initialScheduler(p,{...DEFAULT_OPTIONS,newMix:2,reviewsPerDay:5000,newPerDay:2});docs.push(p);
 }
 await db.progress.insertMany(docs);await wait(async()=>started);
 browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'en-US'});
 await context.addInitScript(({token,user}:any)=>{localStorage.setItem('german_gramatic_token',token);localStorage.setItem('german_gramatic_user',JSON.stringify(user));localStorage.setItem('german_gramatic_settings',JSON.stringify(user.settings));localStorage.setItem('i18nextLng','en');},{token,user:{...user,id:String(userId)}});
 const page=await context.newPage();page.setDefaultTimeout(15000);const errors:string[]=[],writes:any[]=[],queries:string[]=[];
 page.on('pageerror',(error:Error)=>errors.push(error.message));
 await context.route('**/graphql',async(route:any)=>{queries.push(route.request().postDataJSON().operationName);const response=await route.fetch({url:`${apiUrl}/graphql`});const payload=await response.json();if(payload.errors)console.error(route.request().postDataJSON().operationName,payload.errors.slice(0,3).map((x:any)=>x.message));if(route.request().postDataJSON().operationName==='DueItems')console.log('Due snapshot',payload.data?.dueItems?.length,payload.data?.dueItems?.[0]?.wordRelation?.main?.contexts);await route.fulfill({response});});
 let loseResponse=true;
 await context.route('**/api/study/sync',async(route:any)=>{
  try { writes.push(route.request().postDataJSON()); const response=await route.fetch({url:`${apiUrl}/api/study/sync`});if(loseResponse){loseResponse=false;await route.abort('failed');}else await route.fulfill({response}); } catch { if(!closing) errors.push('Study sync test proxy failed'); }
 });
 await page.goto(`${app}/learn/words/university`);
 try { await page.getByRole('heading',{name:'das Haus',exact:true}).waitFor(); } catch(error) { console.error(await page.locator('body').innerText());console.error(errors);throw error; }
 await page.getByTestId('practice-queue-counts').getByLabel('New cards: 2',{exact:true}).waitFor();
 await page.keyboard.press('Enter');await page.getByRole('button',{name:'Good',exact:true}).click();
 await page.getByRole('heading',{name:'casa 1',exact:true}).waitFor();
 assert.equal(await page.getByTestId('practice-queue-counts').getByLabel('New cards: 1',{exact:true}).count(),1);
 assert.equal(await page.getByTestId('practice-queue-counts').getByLabel('Learning cards: 1',{exact:true}).count(),1);
 await page.locator('input[type="text"]').fill('das Haus');await page.keyboard.press('Enter');await page.getByRole('button',{name:'Good',exact:true}).click();
 await page.getByRole('heading',{name:'casa 2',exact:true}).waitFor();
 assert.equal(await page.getByTestId('practice-queue-counts').getByLabel('New cards: 0',{exact:true}).count(),1);
 const queryStart=queries.length;
 for(let i=2;i<102;i++){
  await page.getByRole('heading',{name:`casa ${i}`,exact:true}).waitFor();
  await page.locator('input[type="text"]').fill(i===2?'wrong':'das Haus');await page.keyboard.press('Enter');
  await page.getByTestId('review-bar').waitFor();
  await page.waitForTimeout(300); // feedback shortcuts intentionally ignore accidental double Enter for 250ms
  await page.keyboard.press('4');
 }
 await page.getByRole('heading',{name:'casa 102',exact:true}).waitFor();
 assert.equal(writes.length,0,'102 ratings + wrong Check must make no study write during active practice');assert.equal(queries.length,queryStart,'no polling or per-rating queries during practice');
 assert.equal(await db.reviewEvents.countDocuments({userId}),0);
 assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('german_gramatic_study:')).length),103);
 await page.getByRole('button',{name:'Previous card',exact:true}).click();await page.getByRole('button',{name:'Check',exact:true}).waitFor();assert.equal(await page.locator('input[type="text"]').inputValue(),'');assert.equal(await page.getByTestId('review-bar').count(),0);assert.equal(writes.length,0);
 await page.locator('input[type="text"]').fill('das Haus');await page.keyboard.press('Enter');await page.getByTestId('review-bar').waitFor();
 await page.waitForTimeout(300);await page.keyboard.press('4');await page.getByRole('heading',{name:'casa 102',exact:true}).waitFor();
 mkdirSync('../.local/ui-review',{recursive:true});await page.screenshot({path:'../.local/ui-review/study-local-counters.jpg'});
 console.log('PASS real API/Mongo browser: blue-to-red counters, 102 immediate local reviews, durable Check/Undo and zero per-card requests');
 await page.getByRole('button',{name:'Open menu',exact:true}).click();await page.getByRole('button',{name:'Dashboard',exact:true}).click();
 await wait(async()=>writes.length===1 && !loseResponse);await page.getByRole('status').filter({hasText:'saved on this device'}).waitFor();
 assert.equal(writes[0].operations.length,100);assert.ok(await db.reviewEvents.countDocuments({userId})>90);
 await page.reload();await wait(async()=>await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('german_gramatic_study:')).length)===0);
 assert.equal(await db.reviewEvents.countDocuments({userId}),103);assert.equal(await db.reviewEvents.countDocuments({userId,reversedAt:{$ne:null}}),1);
 assert.equal((await db.progress.findOne({_id:docs[2]._id})).failureIndex,1);
 const originals=writes[0].operations;assert.deepEqual(writes[1].operations,originals,'reload retries the exact same lost batch');
 assert.ok(writes.length>=3 && writes.length<=4,'bounded retry; pagehide may retry concurrently with reopening');assert.ok(writes.every(batch=>batch.operations.length<=100));
 console.log('PASS lost batch response after commit, reload replay, acknowledged queue removal, stable IDs and exact Mongo counts');
 await page.goto(`${app}/settings`);const limit=page.getByLabel('New cards per day',{exact:true});await limit.waitFor();assert.equal(await limit.inputValue(),'2');await limit.fill('6');await page.getByRole('button',{name:'Save limit',exact:true}).click();await page.getByText('Daily limit saved.',{exact:true}).waitFor();assert.equal((await db.users.findOne({_id:userId})).settings.dailyNewCards,6);
 await page.screenshot({path:'../.local/ui-review/daily-new-card-limit-mobile.jpg'});await page.setViewportSize({width:1280,height:920});await page.screenshot({path:'../.local/ui-review/daily-new-card-limit-desktop.jpg'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
 console.log('PASS daily-limit UI persists to the authenticated account; mobile/desktop layout');
 const unauthorized=await fetch(`${apiUrl}/api/study/sync`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(writes[0])});assert.equal(unauthorized.status,401);
}finally{
 closing=true; if(browser)await browser.close();api.kill('SIGTERM');if(api.exitCode===null)await once(api,'exit');
 await db.progress.deleteMany({userId});await db.reviewEvents.deleteMany({userId});await db.users.deleteOne({_id:userId});await db.wordsES.deleteOne({_id:es});await db.wordsDE.deleteOne({_id:de});await db.relationsWordsEsDe.deleteOne({_id:relation});await closeDatabase();
}
