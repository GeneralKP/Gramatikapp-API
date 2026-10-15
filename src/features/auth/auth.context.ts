import type { ObjectId } from "mongodb";
import type { User } from "./auth.types.js";

export interface AuthContext {
  user: User | null;
}

/** Reject unauthenticated callers and cross-account access before database work. */
export function requireUserId(context: AuthContext, expectedUserId?: string): ObjectId {
  const user = context?.user;
  if (!user || (expectedUserId !== undefined && user._id.toString() !== expectedUserId)) {
    throw new Error("Unauthorized");
  }
  return user._id;
}
