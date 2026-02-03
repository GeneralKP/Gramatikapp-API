import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import { getDb } from "../../lib/database.js";
import { User, defaultUserSettings } from "./auth.types.js";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const SALT_ROUNDS = 10;

export interface TokenPayload {
  userId: string;
  email: string;
}

export interface AuthResult {
  user: User;
  token: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateToken(user: User): string {
  const payload: TokenPayload = {
    userId: user._id.toString(),
    email: user.email,
  };
  const expiresInSeconds = 7 * 24 * 60 * 60; // 7 days
  return jwt.sign(payload, JWT_SECRET, { expiresIn: expiresInSeconds });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch {
    return null;
  }
}

export async function registerWithEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  const db = getDb();

  const existingUser = await db.users.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    throw new Error("User with this email already exists");
  }

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  const newUser: User = {
    _id: new ObjectId(),
    email: email.toLowerCase(),
    passwordHash,
    authProvider: "email",
    settings: { ...defaultUserSettings },
    createdAt: now,
  };

  await db.users.insertOne(newUser);

  const token = generateToken(newUser);
  return { user: newUser, token };
}

export async function loginWithEmail(
  email: string,
  password: string,
): Promise<AuthResult> {
  const db = getDb();

  const user = await db.users.findOne({ email: email.toLowerCase() });

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

export async function getUserFromToken(token: string): Promise<User | null> {
  const payload = verifyToken(token);
  if (!payload) return null;

  const db = getDb();
  return db.users.findOne({ _id: new ObjectId(payload.userId) });
}
