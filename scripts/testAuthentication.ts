import 'dotenv/config';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {MongoClient,ObjectId} from 'mongodb';
import {graphql} from 'graphql';
import {makeExecutableSchema} from '@graphql-tools/schema';
import {connectDatabase,closeDatabase} from '../src/lib/database.js';
import {typeDefs,resolvers} from '../src/graphql/schema.js';
import {generateToken,getUserFromToken,hashPassword} from '../src/features/auth/auth.service.js';
import {defaultUserSettings} from '../src/features/auth/auth.types.js';
import {DEFAULT_OPTIONS} from '../src/features/progress/scheduler.js';
const owner=new ObjectId('000000000000000000000001'),other=new ObjectId('000000000000000000000002');
const user={_id:owner,email:'auth@example.invalid',authProvider:'email',settings:{...defaultUserSettings},createdAt:new Date('2026-10-06T00:00:00Z'),passwordHash:await hashPassword('fixture-password')};
const profile={_id:owner,defaultOptions:{...DEFAULT_OPTIONS,newPerDay:37}};
let reads:Record<string,number>={};let profiles:any[]=[profile];
let cap:any;
const projection=(row:any,fields:any)=>Object.fromEntries(Object.keys(fields).filter(key=>fields[key]&&row[key]!==undefined).map(key=>[key,row[key]]));
const collection=(name:string)=>({async createIndex(){},async dropIndex(){},async findOne(filter:any,options:any={}){
 reads[name]=(reads[name]??0)+1;
 const row=name==='users' && (!filter._id||String(filter._id)===String(owner)) && (!filter.email||filter.email===user.email)?{...user,settings:{...user.settings,...(cap===undefined?{}:{dailyNewCards:cap})}}:name==='schedulerprofiles'?profiles.find(p=>String(p._id)===String(filter._id)):null;
 return row ? options.projection?projection(row,options.projection):row : null;
}});
MongoClient.prototype.connect=async function(){return this;};MongoClient.prototype.db=function(){return {collection} as any;};
await connectDatabase();
const secret=process.env.JWT_SECRET||'dev-secret-change-in-production';
const sign=(payload:any,options:any={})=>jwt.sign(payload,secret,{expiresIn:3600,...options});
const fields='id email authProvider createdAt settings{soundEnabled selectSound successSound errorSound popSound darkMode dailyNewCards}';
const schema=makeExecutableSchema({typeDefs,resolvers});
try {
 for(const [name,token] of [
  ['empty',''],['malformed','not-a-token'],['wrong-signature',jwt.sign({userId:String(owner),email:user.email},'wrong-secret')],
  ['expired',sign({userId:String(owner),email:user.email},{expiresIn:-1})],
  ['not-yet-valid',sign({userId:String(owner),email:user.email,nbf:Math.floor(Date.now()/1000)+3600})],
  ['wrong-algorithm',sign({userId:String(owner),email:user.email},{algorithm:'HS384'})],
  ['invalid-owner',sign({userId:'invalid',email:user.email})],
  ['invalid-payload',sign({userId:String(owner),email:{unexpected:true}})],
 ] as const){reads={};assert.equal(await getUserFromToken(token),null,name);assert.equal(reads.users??0,0,`${name} must fail before querying MongoDB`);}
 reads={};assert.equal(await getUserFromToken(sign({userId:String(other),email:user.email})),null);assert.equal(reads.users,1,'deleted account checked against database');
 for(const scenario of ['fallback','explicit-zero','no-profile']){
  cap=scenario==='explicit-zero'?0:undefined;profiles=scenario==='no-profile'?[]:[profile];reads={};
  const authenticated=await getUserFromToken(generateToken(user as any));assert.ok(authenticated);assert.equal(authenticated.passwordHash,undefined,'authentication must not fetch password hashes');
  const result=await graphql({schema,source:`query($id:ID!,$email:String!){me{${fields}} user(id:$id){${fields}} userByEmail(email:$email){${fields}}}`,variableValues:{id:String(owner),email:user.email.toUpperCase()},contextValue:{user:authenticated}});
  assert.equal(result.errors,undefined,result.errors?.map(x=>x.message).join(';'));
  const expected={id:String(owner),email:user.email,authProvider:'email',createdAt:user.createdAt.toISOString(),settings:{...defaultUserSettings,dailyNewCards:scenario==='explicit-zero'?0:scenario==='no-profile'?20:37}};
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)),{me:expected,user:expected,userByEmail:expected});
  assert.equal(reads.users,1,'Me and own-user aliases reuse the authenticated user');
  assert.equal(reads.schedulerprofiles??0,scenario==='explicit-zero'?0:1,'profile fallback fetched at most once per request');
 }
 for(const ctx of [{user:null},{user}]){
  reads={};const result=await graphql({schema,source:'query($id:ID!){user(id:$id){id} userByEmail(email:"other@example.invalid"){id} allProgress(userId:$id){itemId} dueItems(userId:$id){itemId} studyQueueCounts(userId:$id){review}}',variableValues:{id:String(other)},contextValue:ctx});
  assert.ok(result.errors?.every(error=>error.message==='Unauthorized'));assert.deepEqual(reads,{},'unauthorized fields must not read another account');
 }
 const result=await graphql({schema,source:'query{me{id}}',contextValue:{user:null}});assert.deepEqual(JSON.parse(JSON.stringify(result.data)),{me:null});
 profiles=[profile];cap=undefined;
 const loginSource=`mutation($email:String!,$password:String!){login(email:$email,password:$password){token user{${fields}}}}`;
 for(const [email,password] of [[user.email,'incorrect'],['missing@example.invalid','fixture-password']]){
  reads={};const rejected=await graphql({schema,source:loginSource,variableValues:{email,password},contextValue:{user:null}});
  assert.equal(rejected.errors?.[0].message,'Invalid email or password');assert.equal(reads.users,1);assert.equal(reads.schedulerprofiles??0,0);
 }
 reads={};const login=await graphql({schema,source:loginSource,variableValues:{email:user.email.toUpperCase(),password:'fixture-password'},contextValue:{user:null}});
 assert.equal(login.errors,undefined);const payload=JSON.parse(JSON.stringify(login.data)).login;
 assert.deepEqual(payload.user,{id:String(owner),email:user.email,authProvider:'email',createdAt:user.createdAt.toISOString(),settings:{...defaultUserSettings,dailyNewCards:37}});
 const claims=jwt.verify(payload.token,secret,{algorithms:['HS256']}) as jwt.JwtPayload;
 assert.equal(claims.userId,String(owner));assert.equal(claims.email,user.email);assert.equal(claims.exp!-claims.iat!,7*24*60*60);
 assert.equal(reads.users,1,'successful login/settings do not re-fetch the account');assert.equal(reads.schedulerprofiles,1);
 console.log('PASS JWT validation before database access, deleted accounts, password-hash projection, exact auth response shape, default/zero quotas, bounded reads and ownership isolation');
 console.log('PASS normalized email login, rejected credentials, exact login user response and seven-day HS256 token');
}finally{await closeDatabase();}
