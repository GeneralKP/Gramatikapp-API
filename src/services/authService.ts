import bcrypt from "bcryptjs";
import jwt, { SignOptions } from "jsonwebtoken";
import { User, IUser } from "../models/index.js";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const SALT_ROUNDS = 10;

export interface AuthResult {
  user: IUser;
  token: string;
}

export interface TokenPayload {
  userId: string;
  email: string;
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare password with hash
 */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token for user
 */
export function generateToken(user: IUser): string {
  const payload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email,
  };
  // 7 days in seconds
  const expiresInSeconds = 7 * 24 * 60 * 60;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresInSeconds });
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Register a new user with email and password
 */
export async function registerWithEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  // Check if user already exists
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    throw new Error("User with this email already exists");
  }

  // Validate password
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  // Create user
  const passwordHash = await hashPassword(password);
  const user = await User.create({
    email: email.toLowerCase(),
    passwordHash,
    authProvider: "email",
    settings: {
      soundEnabled: true,
      darkMode: false,
    },
  });

  const token = generateToken(user);
  return { user, token };
}

/**
 * Login with email and password
 */
export async function loginWithEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  const user = await User.findOne({ email: email.toLowerCase() });

  if (!user) {
    throw new Error("Invalid email or password");
  }

  if (user.authProvider !== "email") {
    throw new Error(`Please sign in with ${user.authProvider}`);
  }

  if (!user.passwordHash) {
    throw new Error("Invalid email or password");
  }

  const isValid = await verifyPassword(password, user.passwordHash);
  if (!isValid) {
    throw new Error("Invalid email or password");
  }

  const token = generateToken(user);
  return { user, token };
}

/**
 * Get user from token
 */
export async function getUserFromToken(token: string): Promise<IUser | null> {
  const payload = verifyToken(token);
  if (!payload) return null;

  return User.findById(payload.userId);
}

/**
 * Login/Register with OAuth provider (for future Google sign-in)
 * This creates a user if they don't exist, or logs them in if they do
 */
export async function loginWithProvider(
  provider: "google",
  email: string,
  _providerToken: string, // For validation with provider API
): Promise<AuthResult> {
  // TODO: Validate providerToken with the provider's API
  // For now, we trust the token (will be validated by frontend SDK)

  let user = await User.findOne({ email: email.toLowerCase() });

  if (user) {
    // User exists - check if they used a different provider
    if (user.authProvider !== provider) {
      throw new Error(
        `This email is registered with ${user.authProvider}. Please sign in with ${user.authProvider}.`,
      );
    }
  } else {
    // Create new user
    user = await User.create({
      email: email.toLowerCase(),
      authProvider: provider,
      settings: {
        soundEnabled: true,
        darkMode: false,
      },
    });
  }

  const token = generateToken(user);
  return { user, token };
}
