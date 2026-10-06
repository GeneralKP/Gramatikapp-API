import 'dotenv/config';
import {BSON} from 'mongodb';
const {EJSON}=BSON;
import {mkdir,writeFile} from 'node:fs/promises';
import {connectDatabase,closeDatabase} from '../src/lib/database.js';
import {normalizeContext} from '../src/features/progress/categories.js';
const apply=process.argv.includes('--apply'), db=await connectDatabase();
try {
 const cards=await db.progress.find({'card.source':'ANKI',supersededByAnki:{$ne:true}}).project({itemId:1,relationId:1,card:1}).toArray();
 const tagContexts=new Map<string,Set<string>>();
 const tags:Record<string,string>={arbeit:'work',haushalt:'daily_routine',redewendung:'idioms'};
 for(const card of cards){const id=String(card.relationId??card.itemId),set=tagContexts.get(id)??new Set<string>();for(const tag of card.card?.tags??[]) if(tags[normalizeContext(tag)])set.add(tags[normalizeContext(tag)]);if(card.card?.deck?.includes('Preposiciones'))set.add('prepositions');tagContexts.set(id,set);}
 const changes:any[]=[],report:any[]=[];
 for(const kind of ['WORD','PHRASE']){
  const collections=kind==='WORD'?[db.wordsES,db.wordsDE]:[db.phrasesES,db.phrasesDE];
  const relations=await(kind==='WORD'?db.relationsWordsEsDe:db.relationsPhrasesEsDe).find({}).toArray();
  const maps=await Promise.all(collections.map(async col=>new Map((await col.find({}).toArray()).map(item=>[String(item._id),item]))));
  const parent=new Map<string,string>(),root=(key:string):string=>{const p=parent.get(key);if(!p){parent.set(key,key);return key;}if(p===key)return key;const r=root(p);parent.set(key,r);return r;};
  for(const rel of relations){const a='es:'+rel.main,b='de:'+rel.translated;parent.set(root(a),root(b));}
  const groups=new Map<string,Set<string>>();
  for(const [lang,map] of maps.entries())for(const [id,item] of map){const key=root((lang?'de:':'es:')+id),set=groups.get(key)??new Set<string>();for(const ctx of item.contexts??[])if(normalizeContext(ctx))set.add(normalizeContext(ctx));groups.set(key,set);}
  for(const rel of relations)for(const ctx of tagContexts.get(String(rel._id))??[])groups.get(root('es:'+rel.main))?.add(ctx);
  for(const [lang,map]of maps.entries())for(const [id,item]of map){const contexts=[...(groups.get(root((lang?'de:':'es:')+id))??[])].sort();if(!contexts.length)contexts.push('general_vocabulary');if(JSON.stringify(item.contexts)!==JSON.stringify(contexts))changes.push({collection:collections[lang].collectionName,before:item,contexts});}
  const broken=relations.filter(r=>!maps[0].has(String(r.main))||!maps[1].has(String(r.translated))).length;
  if(broken)throw new Error(`Broken ${kind} relations: ${broken}`);report.push({kind,relations:relations.length,documents:maps[0].size+maps[1].size,broken});
 }
 const dir='.local/audit';await mkdir(dir,{recursive:true});
 if(apply){const backup=`${dir}/categories-before-${Date.now()}.ejson`;await writeFile(backup,EJSON.stringify(changes,null,2),{mode:0o600});for(const col of [db.wordsES,db.wordsDE,db.phrasesES,db.phrasesDE]){const rows=changes.filter(change=>change.collection===col.collectionName);if(!rows.length)continue;await col.bulkWrite(rows.map(change=>({updateOne:{filter:{_id:change.before._id},update:{$set:{contexts:change.contexts}}}})));const saved=new Map((await col.find({_id:{$in:rows.map(change=>change.before._id)}}).toArray()).map(row=>[String(row._id),row]));for(const change of rows){const after=saved.get(String(change.before._id));if(!after)throw new Error('Vocabulary changed during the audit; inspect the private backup.');if(JSON.stringify(after.contexts)!==JSON.stringify(change.contexts))throw new Error('Category update did not persist');delete after.contexts;const before={...change.before};delete before.contexts;if(EJSON.stringify(after)!==EJSON.stringify(before))throw new Error('Unexpected data change');}}console.log(JSON.stringify({applied:changes.length,backup,report},null,2));}else console.log(JSON.stringify({changes:changes.length,report},null,2));
}finally{await closeDatabase();}
