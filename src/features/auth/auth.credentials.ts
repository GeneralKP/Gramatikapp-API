import { GraphQLError } from "graphql";

const MAX_EMAIL_CHARACTERS = 320;
let activePasswordWork = 0;

/** bcryptjs shares the API CPU; reject overload instead of retaining a waiting queue. */
export async function withPasswordWork<T>(work: () => Promise<T>): Promise<T> {
  if (activePasswordWork >= 2) {
    throw new GraphQLError("Too many requests. Please retry shortly.", { extensions: {
      code: "TOO_MANY_REQUESTS",
      http: { status: 429, headers: new Map([["retry-after", "1"]]) },
    } });
  }
  activePasswordWork++;
  try { return await work(); }
  finally { activePasswordWork--; }
}

/** Login keeps legacy address formats and case matching; registration checks new addresses. */
export function validateCredentials(email: unknown, password: unknown, mode: "login" | "register"): string {
  if (typeof email !== "string" || !email.length || email.length > MAX_EMAIL_CHARACTERS
    || (mode === "register" && !/^[^\s@]+@[^\s@]+$/.test(email))) {
    throw new GraphQLError(mode === "register" ? "Enter a valid email address." : "Invalid email or password", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  if (typeof password !== "string" || password.length < (mode === "register" ? 6 : 1)) {
    throw new GraphQLError(mode === "register" ? "Password must be at least 6 characters" : "Invalid email or password", {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  return email.toLowerCase();
}
