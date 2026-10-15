import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import express from "express";
import { parse } from "graphql";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { graphqlRequestLimits, graphqlSecurity } from "../src/lib/graphqlSecurity.js";

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), 5000);
    })]);
  } finally { clearTimeout(timeout!); }
}

const structuralApp = express();
let passedStructuralGate = 0;
structuralApp.use(express.json({ limit: "2mb" }));
structuralApp.use("/graphql", graphqlRequestLimits);
structuralApp.post("/graphql", (_req, res) => { passedStructuralGate++; res.sendStatus(204); });
const structuralServer = http.createServer(structuralApp);
structuralServer.listen(0, "127.0.0.1");
await once(structuralServer, "listening");
const structuralOrigin = `http://127.0.0.1:${(structuralServer.address() as { port: number }).port}`;
try {
  const source = `{${"me{id email} ".repeat(900)}}`;
  assert.ok(source.length < 65_536, "The attack fits the source-size budget");
  parse(source, { maxTokens: 5000 });
  const response = await fetch(`${structuralOrigin}/graphql`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: source }),
  });
  assert.equal(response.status, 400, "Repeated response keys must stop before Apollo's quadratic field-merging validation");
  assert.equal(passedStructuralGate, 0, "Oversized structure must not reach schema validation or resolvers");
  assert.match((await response.json()).errors[0].message, /operation.*large/i);
  const expandedFragments = ["fragment F0 on User { id email }"];
  for (let index = 1; index <= 9; index++) expandedFragments.push(`fragment F${index} on User { ...F${index - 1} ...F${index - 1} }`);
  for (const query of [
    `query Safe { me { id } } query Unselected { ${"me{id email} ".repeat(900)} }`,
    `{ me { ...Wide } } fragment Wide on User { ${"id ".repeat(1001)} }`,
    `{me{${"child{".repeat(16)}id${"}".repeat(16)}}}`,
    `{me{...F9}} ${expandedFragments.join("\n")}`,
  ]) {
    const rejected = await fetch(`${structuralOrigin}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, operationName: "Safe" }),
    });
    assert.equal(rejected.status, 400, "All document operations and expanded/deep selections must be bounded before validation");
    assert.equal(passedStructuralGate, 0);
    await rejected.json();
  }
  const normal = await fetch(`${structuralOrigin}/graphql`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ me { id email } }" }),
  });
  assert.equal(normal.status, 204);
  assert.equal(passedStructuralGate, 1, "Normal client documents retain access to the next middleware");
  const loadingFixtures = JSON.parse(readFileSync(new URL("fixtures/loading-queries.json", import.meta.url), "utf8")) as Record<string, string>;
  const requestFixtures = {
    ...loadingFixtures,
    webLogin: "mutation Login($email:String!,$password:String!){login(email:$email,password:$password){token user{id email authProvider settings{soundEnabled selectSound successSound errorSound popSound darkMode dailyNewCards}}}}",
    mobileRegister: "mutation Register($email:String!,$password:String!){register(email:$email,password:$password){token user{id email authProvider settings{soundEnabled selectSound successSound errorSound popSound darkMode dailyNewCards}}}}",
    dashboard: 'query DashboardStats($userId:ID!){studyQueueCounts(userId:$userId,itemType:"WORD"){new learning review total learned} learningPath(userId:$userId){id name level isUnlocked wordsTotal wordsLearned phrasesTotal phrasesLearned}}',
    dictionaryFragments: `query DictionaryWords($limit:Int,$offset:Int,$search:String,$cefrLevel:String){wordRelations(limit:$limit,offset:$offset,search:$search,cefrLevel:$cefrLevel){id main{...DictionaryWordFields} translated{...DictionaryWordFields}}}
      fragment DictionaryWordFields on Word{id word gramaticalCategories contexts examples level cefrLevel notes forms{perfect past imperativ irregularConjugations plural gender gramaticalCase} relatedWords{synonyms antonyms homophones homonymous paronyms verbFamilies}}`,
    readingFragments: `query ReadingPractice{readingPractice{configured model session{id startedAt endedAt reviewCount words{id german spanish failureIndex}} lesson{...ReadingLessonFields}}}
      fragment ReadingLessonFields on ReadingLesson{id sessionId sessionStartedAt sessionEndedAt status error pageCount words{id german spanish failureIndex} pages{index title german spanish wordCount words{id german spanish failureIndex} vocabulary{wordId surfaceForms example} lastAttempt{id requestId pageIndex translation status error feedback{score summary correctedSpanish corrections{original corrected explanation category} omissions{german explanation} vocabulary{wordId understood feedback}}}}}`,
    writingFragments: `query WritingPractice{writingPractice{configured exercise{...WritingExerciseFields}}}
      fragment WritingExerciseFields on WritingExercise{id requestId level focus reinforced selectedWordIds status error createdAt words{id german spanish} sentence{title spanish german mainClause subordinateClause clauseOrder connector grammarExplanation spanishWordCount germanWordCount} lastAttempt{id requestId translation status error feedback{correct score summary correctedGerman corrections{original corrected explanation category} alternatives}}}`,
    mobileMistakes: 'query MostFailedWords($userId:ID!,$limit:Int!,$minFailures:Int!){mostFailedWords(userId:$userId,limit:$limit,minFailures:$minFailures){failureIndex wordRelation{id main{id word gramaticalCategories contexts examples} translated{id word gramaticalCategories contexts examples}} cards{id itemId userId itemType ease interval repetitions nextDueDate failureIndex scheduleVersion schedulerPhase learningQueue learnAheadSeconds studyState card{source sourceCardId sourceNoteGuid direction prompt answer acceptedAnswers notes examples deck tags}}}}',
  };
  for (const [label, query] of Object.entries(requestFixtures)) {
    const accepted = await fetch(`${structuralOrigin}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }),
    });
    assert.equal(accepted.status, 204, `${label}: shipped request shape must fit structural budgets`);
  }
  assert.equal(passedStructuralGate, 1 + Object.keys(requestFixtures).length);
  console.log(`PASS pre-validation rejection and ${Object.keys(requestFixtures).length} web/native request contracts within structural budgets`);
} finally { await new Promise<void>((resolve, reject) => structuralServer.close(error => error ? reject(error) : resolve())); }

const aliasApp = express(), aliasHttp = http.createServer(aliasApp);
let anonymousPhraseExecutions = 0, authenticatedPhraseExecutions = 0;
const aliasApollo = new ApolloServer<{ user: object | null; clientAddress: string }>({
  typeDefs: "type Phrase { words: [Int!]! } type Query { newPhrases: [Phrase!]! }",
  resolvers: { Query: { newPhrases: (_: unknown, __: unknown, context: { user: object | null }) => {
    if (context.user) authenticatedPhraseExecutions++; else anonymousPhraseExecutions++;
    return [{ words: [1] }];
  } } },
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer: aliasHttp }), graphqlSecurity()],
});
await aliasApollo.start();
aliasApp.use(express.json());
aliasApp.use("/graphql", expressMiddleware(aliasApollo, {
  context: async ({ req }) => ({ user: req.headers["x-fixture-authenticated"] === "1" ? {} : null, clientAddress: "203.0.113.71" }),
}) as unknown as express.RequestHandler);
aliasHttp.listen(0, "127.0.0.1");
await once(aliasHttp, "listening");
const aliasOrigin = `http://127.0.0.1:${(aliasHttp.address() as { port: number }).port}`;
const threeAliasResult = { data: { newPhrases: [{ a: [1], b: [1], c: [1] }] } };
const nestedAliasQueries = [
  { label: "direct aliases", query: "{newPhrases{a:words b:words c:words}}", result: threeAliasResult },
  { label: "named fragments", query: "{newPhrases{...A ...B}} fragment A on Phrase{a:words} fragment B on Phrase{b:words c:words}", result: threeAliasResult },
  { label: "inline fragment", query: "{newPhrases{...A ... on Phrase{b:words c:words}}} fragment A on Phrase{a:words}", result: threeAliasResult },
  { label: "merged parent selections", query: "{newPhrases{a:words b:words} newPhrases{c:words d:words}}", result: { data: { newPhrases: [{ a: [1], b: [1], c: [1], d: [1] }] } } },
];
try {
  for (const { query, label } of nestedAliasQueries) {
    const response = await fetch(`${aliasOrigin}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }),
    });
    assert.equal(response.status, 400, `${label}: anonymous repeated nested fields must reject before executing the catalog resolver`);
    assert.equal((await response.json()).errors[0].extensions.code, "BAD_USER_INPUT");
    assert.equal(anonymousPhraseExecutions, 0, "Fragments and inline fragments must share one parent-object repetition budget");
  }
  const normal = await fetch(`${aliasOrigin}/graphql`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{newPhrases{a:words b:words}}" }),
  });
  assert.equal(normal.status, 200);
  assert.deepEqual(await normal.json(), { data: { newPhrases: [{ a: [1], b: [1] }] } });
  assert.equal(anonymousPhraseExecutions, 1);
  for (const { query, result } of nestedAliasQueries) {
    const response = await fetch(`${aliasOrigin}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Fixture-Authenticated": "1" }, body: JSON.stringify({ query }),
    });
    assert.equal(response.status, 200, "Authenticated request contracts retain the broader structural budgets");
    assert.deepEqual(await response.json(), result);
  }
  assert.equal(authenticatedPhraseExecutions, 4);
  console.log("PASS anonymous nested-field amplification rejected across aliases/fragments with authenticated compatibility");
} finally { await aliasApollo.stop(); }

// Real HTTP → Apollo → suspended resolver promises. No database or auth helper
// is replaced, and assertions never inspect the guard's internal counters.
const lifecycleApp = express(), lifecycleHttp = http.createServer(lifecycleApp);
const entered = new Set<string>(), completed = new Set<string>();
const entryWaiters = new Map<string, () => void>(), completionWaiters = new Map<string, () => void>();
const pending = new Map<string, { resolve(value: { id: string }[]): void; reject(error: Error): void }>();
let closedAbortedResponse: () => void;
const abortedResponseClosed = new Promise<void>(resolve => { closedAbortedResponse = resolve; });
const lifecycleApollo = new ApolloServer<{ user: null; clientAddress: string }>({
  typeDefs: "type FixtureWord { id: ID! } type Query { words(requestId: String!): [FixtureWord!]! }",
  resolvers: { Query: { words: (_: unknown, { requestId }: { requestId: string }) => new Promise<{ id: string }[]>((resolve, reject) => {
    entered.add(requestId);
    pending.set(requestId, { resolve, reject });
    entryWaiters.get(requestId)?.();
  }) } },
  includeStacktraceInErrorResponses: false,
  plugins: [ApolloServerPluginDrainHttpServer({ httpServer: lifecycleHttp }), graphqlSecurity(), {
    async requestDidStart() { return { async willSendResponse({ request }) {
      const id = request.variables?.requestId;
      if (typeof id === "string") { completed.add(id); completionWaiters.get(id)?.(); }
    } }; },
  }],
});
await lifecycleApollo.start();
lifecycleApp.use(express.json());
lifecycleApp.use((req, res, next) => {
  if (req.body?.variables?.requestId === "aborted") res.once("close", () => closedAbortedResponse());
  next();
});
lifecycleApp.use("/graphql", expressMiddleware(lifecycleApollo, {
  context: async () => ({ user: null, clientAddress: "203.0.113.70" }),
}) as unknown as express.RequestHandler);
lifecycleHttp.listen(0, "127.0.0.1");
await once(lifecycleHttp, "listening");
const lifecycleOrigin = `http://127.0.0.1:${(lifecycleHttp.address() as { port: number }).port}`;
const post = (requestId: string, signal?: AbortSignal) => fetch(`${lifecycleOrigin}/graphql`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: "query Catalog($requestId:String!){words(requestId:$requestId){id}}", variables: { requestId } }), signal,
});
const awaitEntry = (id: string) => bounded(entered.has(id) ? Promise.resolve() : new Promise<void>(resolve => entryWaiters.set(id, resolve)), `${id}: resolver was never admitted`);
const awaitCompletion = (id: string) => bounded(completed.has(id) ? Promise.resolve() : new Promise<void>(resolve => completionWaiters.set(id, resolve)), `${id}: Apollo did not finish response processing`);
const deny = async (id: string) => {
  const response = await bounded(post(id), `${id}: an overloaded request executed instead of rejecting`);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).errors[0].extensions.code, "TOO_MANY_REQUESTS");
  assert.equal(entered.has(id), false, "Denied catalog requests must not execute their resolver");
};
const abort = new AbortController();
const abortedFetch = post("aborted", abort.signal).then(() => "unexpected success", error => error);
const first = post("first"), second = post("second"), third = post("third");
let replacement: Promise<Response> | undefined, afterFailure: Promise<Response> | undefined, afterAbortCompletion: Promise<Response> | undefined;
try {
  await Promise.all(["first", "second", "third", "aborted"].map(awaitEntry));
  await deny("fifth");
  abort.abort();
  assert.notEqual(await abortedFetch, "unexpected success");
  await bounded(abortedResponseClosed, "The aborted HTTP connection did not close");
  await deny("after-abort");

  pending.get("first")!.resolve([{ id: "first" }]);
  assert.deepEqual(await (await bounded(first, "First request did not complete")).json(), { data: { words: [{ id: "first" }] } });
  replacement = post("replacement");
  await awaitEntry("replacement");

  pending.get("second")!.reject(new Error("Isolated resolver failure"));
  const failed = await (await bounded(second, "Failing resolver did not finish")).json();
  assert.equal(failed.errors[0].message, "Isolated resolver failure");
  afterFailure = post("after-failure");
  await awaitEntry("after-failure");
  await deny("still-full");

  pending.get("aborted")!.resolve([{ id: "aborted" }]);
  await awaitCompletion("aborted");
  afterAbortCompletion = post("after-abort-completed");
  await awaitEntry("after-abort-completed");
  console.log("PASS four catalog operations, fifth rejection, disconnect retention and success/failure capacity recovery");
} finally {
  abort.abort();
  for (const [id, deferred] of pending) deferred.resolve([{ id }]);
  await Promise.allSettled([first, second, third, replacement, afterFailure, afterAbortCompletion, abortedFetch].filter(Boolean));
  await lifecycleApollo.stop();
}
