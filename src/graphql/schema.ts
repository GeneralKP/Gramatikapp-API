import { loadFilesSync } from "@graphql-tools/load-files";
import { mergeTypeDefs, mergeResolvers } from "@graphql-tools/merge";
import { IResolvers } from "@graphql-tools/utils";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { authResolvers } from "../features/auth/auth.resolvers.js";
import { phrasesResolvers } from "../features/phrases/phrases.resolvers.js";
import { progressResolvers } from "../features/progress/progress.resolvers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load all .graphql files from features
const typesArray = loadFilesSync(
  join(__dirname, "../features/**/*.schema.graphql"),
);

export const typeDefs = mergeTypeDefs(typesArray);

export const resolvers: IResolvers = mergeResolvers([
  authResolvers,
  phrasesResolvers,
  progressResolvers,
]);
