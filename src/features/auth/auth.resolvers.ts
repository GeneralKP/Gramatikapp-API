import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { User, UserSettings } from "./auth.types.js";
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

    user: async (_: unknown, { id }: { id: string }) => {
      const db = getDb();
      const user = await db.users.findOne({ _id: new ObjectId(id) });
      return toGraphQL(user);
    },

    userByEmail: async (_: unknown, { email }: { email: string }) => {
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
    ) => {
      const db = getDb();

      const user = await db.users.findOne({ _id: new ObjectId(userId) });
      if (!user) throw new Error("User not found");

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
};
