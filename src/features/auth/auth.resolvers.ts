import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { defaultUserSettings, type User, type UserSettings } from "./auth.types.js";
import { requireUserId, type AuthContext } from "./auth.context.js";
import { studyMetadata } from "../progress/studyLoading.js";
import {
  registerWithEmail,
  loginWithEmail,
} from "./auth.service.js";

type GraphQLUser = Omit<User, "createdAt"> & { id: string; createdAt: string };

function toGraphQL(user: User | null): GraphQLUser | null {
  if (!user) return null;
  return {
    ...user,
    id: user._id.toString(),
    createdAt: user.createdAt.toISOString(),
    settings: {
      ...defaultUserSettings,
      ...user.settings,
    },
  };
}

export interface GraphQLContext extends AuthContext {}

export const authResolvers = {
  Query: {
    me: async (_: unknown, __: unknown, context: GraphQLContext) => {
      if (!context.user) return null;
      return toGraphQL(context.user);
    },

    user: async (_: unknown, { id }: { id: string }, context: GraphQLContext) => {
      requireUserId(context, id);
      return toGraphQL(context.user);
    },

    userByEmail: async (_: unknown, { email }: { email: string }, context: GraphQLContext) => {
      if (!context.user || context.user.email.toLowerCase() !== email.toLowerCase()) throw new Error("Unauthorized");
      return toGraphQL(context.user);
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
      const ownerId = requireUserId(context, userId);
      const db = getDb();

      const user = await db.users.findOne({ _id: ownerId });
      if (!user) throw new Error("User not found");
      const dailyLimit = newSettings.dailyNewCards;
      if (dailyLimit !== undefined && (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 1000)) {
        throw new Error("Choose a daily new-card limit from 0 to 1000.");
      }

      const updatedSettings: UserSettings = {
        ...user.settings,
        ...newSettings,
      };

      await db.users.updateOne(
        { _id: ownerId },
        {
          $set: { settings: updatedSettings, updatedAt: new Date() },
        },
      );

      const updatedUser = await db.users.findOne({ _id: ownerId });
      return toGraphQL(updatedUser);
    },
  },
  UserSettings: {
    dailyNewCards: (settings: UserSettings) => settings.dailyNewCards ?? 20,
  },
  User: {
    settings: async (user: GraphQLUser, _: unknown, context: GraphQLContext): Promise<UserSettings & { dailyNewCards: number }> => ({
      ...defaultUserSettings,
      ...user.settings,
      dailyNewCards: user.settings?.dailyNewCards
        ?? (await studyMetadata(context, new ObjectId(user.id ?? user._id), user)).limit,
    }),
  },
};
