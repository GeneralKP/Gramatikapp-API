import assert from 'node:assert/strict';
import {ObjectId} from 'mongodb';
import {initialScheduler,DEFAULT_OPTIONS} from '../src/features/progress/scheduler.js';
import {scheduleStudyReview,studyReviewOptions,effectiveDueDate} from '../src/features/progress/studyScheduling.js';
import type {UserProgress} from '../src/features/progress/progress.types.js';
const now=new Date('2026-10-24T10:00:00Z');
const p:UserProgress={_id:new ObjectId(),userId:new ObjectId(),itemId:new ObjectId(),itemType:'WORD',interval:100,ease:2.5,repetitions:8,totalReviews:20,nextDueDate:now,lastReviewed:new Date('2026-07-16T10:00:00Z'),createdAt:now};p.scheduler=initialScheduler(p);
const revisit=scheduleStudyReview(p,'REVISIT',now);assert.equal(effectiveDueDate({...p,...revisit}).getTime()-now.getTime(),86400000);
assert.ok(revisit.nextDueDate.getTime()>now.getTime()+100*86400000);
for(const grade of ['AGAIN','HARD','GOOD','EASY']as const){const completed=scheduleStudyReview({...p,...revisit},grade,new Date(now.getTime()+86400000));assert.equal(completed.nextDueDate.toISOString(),revisit.nextDueDate.toISOString());assert.equal(completed.interval,revisit.interval);assert.equal(completed.ease,revisit.ease);assert.equal(completed.temporaryDueDate,undefined);}
const future={...p,nextDueDate:new Date(now.getTime()+180*86400000)};assert.equal(scheduleStudyReview(future,'REVISIT',now).nextDueDate,future.nextDueDate);
assert.ok(!studyReviewOptions({...future,nextDueDate:new Date(now.getTime()+3600000)},now).some(o=>o.grade==='REVISIT'),'extra practice cannot delay an earlier regular review');
const late=scheduleStudyReview({...p,temporaryDueDate:new Date(now.getTime()-86400000)},'GOOD',now);assert.ok(late.nextDueDate>now);assert.equal(late.temporaryDueDate,undefined);
const phrase={...p,itemType:'PHRASE' as const};assert.deepEqual(studyReviewOptions(phrase,now).map(o=>o.delaySeconds),[7,30,180,365].map(d=>d*86400));
assert.throws(()=>scheduleStudyReview(phrase,'REVISIT',now),/established word/);
const fresh:UserProgress={...p,itemId:new ObjectId(),isNew:true,interval:0,repetitions:0,totalReviews:0,lastReviewed:null};fresh.scheduler=initialScheduler(fresh);
const freshPhrase={...fresh,itemType:'PHRASE' as const};
for(const grade of ['AGAIN','HARD']as const){
 const first=scheduleStudyReview(freshPhrase,grade,now);
 assert.equal(first.scheduler.phase,'LEARNING','new phrases must use their Anki learning steps');
 assert.equal(first.scheduler.queue,'MINUTE');assert.equal(first.interval,0);
 const advanced=scheduleStudyReview({...freshPhrase,...first},'GOOD',first.nextDueDate);
 assert.equal(advanced.scheduler.phase,'LEARNING');
 const graduated=scheduleStudyReview({...freshPhrase,...advanced},'GOOD',advanced.nextDueDate);
 assert.equal(graduated.scheduler.phase,'REVIEW');assert.ok(graduated.interval>=1);
}
for(const grade of ['AGAIN','HARD']as const){
 const first=scheduleStudyReview(fresh,grade,now);
 assert.equal(first.scheduler.phase,'LEARNING');assert.equal(first.scheduler.queue,'MINUTE');assert.equal(first.interval,0);
 const repeated=scheduleStudyReview({...fresh,...first},grade,first.nextDueDate);
 assert.equal(repeated.scheduler.phase,'LEARNING');assert.equal(repeated.scheduler.remainingSteps,DEFAULT_OPTIONS.learningSteps.length);
 const advanced=scheduleStudyReview({...fresh,...repeated},'GOOD',repeated.nextDueDate);
 assert.equal(advanced.scheduler.phase,'LEARNING');assert.equal(advanced.scheduler.remainingSteps,1);
 const graduated=scheduleStudyReview({...fresh,...advanced},'GOOD',advanced.nextDueDate);
 assert.equal(graduated.scheduler.phase,'REVIEW');assert.ok(graduated.interval>=1);assert.equal(graduated.scheduler.queue,'DAY');
}
const rollover=new Date('2026-10-08T01:58:00.000Z');
const crossing=scheduleStudyReview(fresh,'HARD',rollover);
assert.equal(crossing.scheduler.phase,'LEARNING');assert.equal(crossing.scheduler.queue,'DAY');assert.equal(crossing.nextDueDate.toISOString(),'2026-10-08T02:00:00.000Z');
assert.equal(scheduleStudyReview({...fresh,...crossing},'HARD',crossing.nextDueDate).scheduler.phase,'LEARNING','an eligible next-day card remains learning until its final learning step');
console.log('PASS tomorrow extra review across DST, unchanged regular scheduling, all completion grades, late reviews, earlier due protection and phrase policy');
console.log('PASS Again/Hard repeat short learning, Good advances before graduation, and rollover DAY retains learning phase');
