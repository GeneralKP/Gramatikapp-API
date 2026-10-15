import type { ApolloServerPlugin } from "@apollo/server";
import type { RequestHandler } from "express";
import { GraphQLError, Kind, parse, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from "graphql";
import { addressBucket, WindowBudget } from "./requestSecurity.js";

export const graphqlRequestLimits: RequestHandler = (req, res, next) => {
  // Express 5 leaves an unparsed body undefined; Apollo 4's adapter expects an
  // object even for GET so its own CSRF/method checks can return a client error.
  if (req.body === undefined) req.body = {};
  const source = req.method === "GET" ? req.query.query : req.body?.query;
  if (typeof source === "string" && (source.length > 65_536 || Buffer.byteLength(source, "utf8") > 65_536)) {
    const message = "GraphQL document is too large. Use variables for request data.";
    res.status(413).json({ error: message, errors: [{ message, extensions: { code: "BAD_USER_INPUT" } }] });
    return;
  }
  if (typeof source === "string") {
    let document: DocumentNode;
    try { document = parse(source, { maxTokens: 5000 }); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Invalid GraphQL document.";
      res.status(400).json({ errors: [{ message, extensions: { code: "GRAPHQL_PARSE_FAILED" } }] });
      return;
    }
    try {
      // Validation itself merges overlapping fields and can be expensive. Check
      // unused operations/fragments too, before passing the document to Apollo.
      for (const definition of document.definitions) {
        if (definition.kind === Kind.OPERATION_DEFINITION || definition.kind === Kind.FRAGMENT_DEFINITION) {
          inspectOperation(document, definition.selectionSet);
        }
      }
    } catch (error) {
      if (!(error instanceof GraphQLError)) { next(error); return; }
      const { http: _http, ...extensions } = error.extensions;
      res.status(400).json({ errors: [{ message: error.message, extensions }] });
      return;
    }
  }
  next();
};

const catalogFields = new Set(["words", "word", "wordRelations", "wordRelationsWithoutPhrases", "wordsWithoutTranslation", "newPhrases", "newPhrase", "phraseRelations"]);
interface SelectionScope { fields: Map<string, number>; children: Map<string, SelectionScope> }
const selectionScope = (): SelectionScope => ({ fields: new Map(), children: new Map() });

function inspectOperation(document: DocumentNode, root: SelectionSetNode) {
  const fragments = new Map(document.definitions
    .filter((node): node is FragmentDefinitionNode => node.kind === Kind.FRAGMENT_DEFINITION)
    .map(node => [node.name.value, node]));
  let authenticationFields = 0, catalogReads = 0, selections = 0, rootFields = 0, maxRepeatedField = 0;
  function check(set: SelectionSetNode, depth = 1, visiting = new Set<string>(), scope = selectionScope()) {
    if (set.selections.length > 100) throw operationTooLarge();
    for (const selection of set.selections) {
      if (++selections > 1000 || depth > 16) throw operationTooLarge();
      if (selection.kind === Kind.FIELD) {
        const count = (scope.fields.get(selection.name.value) ?? 0) + 1;
        scope.fields.set(selection.name.value, count);
        maxRepeatedField = Math.max(maxRepeatedField, count);
        if (depth === 1) {
          if (++rootFields > 40) throw operationTooLarge();
          if (selection.name.value === "login" || selection.name.value === "register") authenticationFields++;
          if (catalogFields.has(selection.name.value)) catalogReads++;
        }
        if (selection.selectionSet) {
          // GraphQL merges repeated parent response keys. Reuse their child
          // scope so splitting aliases over those parents cannot reset limits.
          const responseKey = selection.alias?.value ?? selection.name.value;
          let child = scope.children.get(responseKey);
          if (!child) scope.children.set(responseKey, child = selectionScope());
          check(selection.selectionSet, depth + 1, visiting, child);
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        check(selection.selectionSet, depth, visiting, scope);
      } else if (!visiting.has(selection.name.value)) {
        const fragment = fragments.get(selection.name.value);
        if (fragment) check(fragment.selectionSet, depth, new Set([...visiting, selection.name.value]), scope);
      }
      if (authenticationFields > 1) throw new GraphQLError("Use only one authentication operation per request.", {
        extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
      });
    }
  }
  check(root);
  return { authenticationFields, catalogReads, maxRepeatedField };
}

/** Inspect the selected operation on every request, including cached documents. */
export function graphqlSecurity(): ApolloServerPlugin<{ clientAddress: string; user: unknown }> {
  const visitors = new WindowBudget(10, 60_000);
  const processBudget = new WindowBudget(120, 60_000, 1);
  const catalogVisitors = new WindowBudget(30, 60_000);
  const catalogProcess = new WindowBudget(300, 60_000, 1);
  let activeCatalogReads = 0;
  return {
    async requestDidStart() {
      let ownsCatalogSlot = false;
      return {
        async didResolveOperation({ document, operation, contextValue }) {
          const { authenticationFields, catalogReads, maxRepeatedField } = inspectOperation(document, operation.selectionSet);
          if (!contextValue.user && catalogReads) {
            if (catalogReads > 2 || maxRepeatedField > 2) throw operationTooLarge();
            const retryAfter = catalogVisitors.consume(addressBucket(contextValue.clientAddress)) || catalogProcess.consume("all");
            if (retryAfter || activeCatalogReads >= 4) throw tooManyRequests(retryAfter || 1);
            activeCatalogReads++;
            ownsCatalogSlot = true;
          }
          if (authenticationFields) {
            const retryAfter = visitors.consume(addressBucket(contextValue.clientAddress)) || processBudget.consume("all");
            if (retryAfter) throw tooManyRequests(retryAfter);
          }
        },
        async willSendResponse() {
          // HTTP disconnects do not cancel Mongo queries. Retain capacity until
          // Apollo finishes executing, even when the caller has gone away.
          if (ownsCatalogSlot) { ownsCatalogSlot = false; activeCatalogReads--; }
        },
      };
    },
  };
}

function tooManyRequests(retryAfter: number) {
  return new GraphQLError("Too many requests. Please wait and try again.", {
    extensions: { code: "TOO_MANY_REQUESTS", http: { status: 429, headers: new Map([["retry-after", String(retryAfter)]]) } },
  });
}

function operationTooLarge() {
  return new GraphQLError("GraphQL operation is too large. Split it into smaller requests.", {
    extensions: { code: "BAD_USER_INPUT", http: { status: 400 } },
  });
}
