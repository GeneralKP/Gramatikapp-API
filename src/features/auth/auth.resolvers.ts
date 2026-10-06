import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { User, UserSettings } from "./auth.types.js";
import { dailyNewLimit } from "../progress/dailyLimit.js";
import {
  registerWithEmail,
  loginWithEmail,
  generateToken,
} from "./auth.service.js";

// Default settings for new or incomplete users
const DEFAULT_SETTINGS: UserSettings = {
  soundEnabled: true,
  selectSound: true,
  successSound: true,
  errorSound: true,
  popSound: true,
  darkMode: false,
};

// Helper to convert MongoDB doc to GraphQL format
function toGraphQL(user: User | null) {
  if (!user) return null;
  return {
    ...user,
    id: user._id.toString(),
    createdAt: user.createdAt.toISOString(),
    settings: {
      ...DEFAULT_SETTINGS,
      ...user.settings,
    },
  };
}

export interface GraphQLContext {
  user: User | null;
}

export const authResolvers = {
  Query: {
    me: async (_: unknown, __: unknown, context: GraphQLContext) => {
      if (!context.user) return null;
      return toGraphQL(context.user);
    },

    user: async (_: unknown, { id }: { id: string }, context: GraphQLContext) => {
      if (!context.user || context.user._id.toString() !== id) throw new Error("Unauthorized");
      const db = getDb();
      const user = await db.users.findOne({ _id: new ObjectId(id) });
      return toGraphQL(user);
    },

    userByEmail: async (_: unknown, { email }: { email: string }, context: GraphQLContext) => {
      if (!context.user || context.user.email.toLowerCase() !== email.toLowerCase()) throw new Error("Unauthorized");
      const db = getDb();
      const user = await db.users.findOne({ email: email.toLowerCase() });
      return toGraphQL(user);
    },
  },

  Mutation: {
    register: async (
      _: unknown,
      { email, password }: { email: string; password: string },
    ) => {
      const result = await registerWithEmail(email, password);
      return {
        token: result.token,
        user: toGraphQL(result.user),
      };
    },

    login: async (
      _: unknown,
      { email, password }: { email: string; password: string },
    ) => {
      const result = await loginWithEmail(email, password);
      return {
        token: result.token,
        user: toGraphQL(result.user),
      };
    },

    syncSettings: async (
      _: unknown,
      {
        userId,
        settings: newSettings,
      }: {
        userId: string;
        settings: Partial<UserSettings>;
      },
      context: GraphQLContext,
    ) => {
      if (!context.user || context.user._id.toString() !== userId) throw new Error("Unauthorized");
      const db = getDb();

      const user = await db.users.findOne({ _id: new ObjectId(userId) });
      if (!user) throw new Error("User not found");
      if (newSettings.dailyNewCards !== undefined && (!Number.isInteger(newSettings.dailyNewCards) || newSettings.dailyNewCards < 0 || newSettings.dailyNewCards > 1000)) throw new Error("Choose a daily new-card limit from 0 to 1000.");

      // Merge settings correctly
      const updatedSettings: UserSettings = {
        ...user.settings,
        ...newSettings,
      };

      await db.users.updateOne(
        { _id: new ObjectId(userId) },
        {
          $set: { settings: updatedSettings, updatedAt: new Date() },
        },
      );

      const updatedUser = await db.users.findOne({ _id: new ObjectId(userId) });
      return toGraphQL(updatedUser);
    },
  },
  UserSettings: {
    dailyNewCards: (settings: UserSettings) => settings.dailyNewCards ?? 20,
  },
  User: {
    settings: async (user: any) => ({ ...DEFAULT_SETTINGS, ...user.settings, dailyNewCards: await dailyNewLimit(new ObjectId(user.id ?? user._id)) }),
  },
};
