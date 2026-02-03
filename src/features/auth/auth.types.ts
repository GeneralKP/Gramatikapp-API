import { ObjectId } from "mongodb";

export type AuthProvider = "email" | "google";

export interface UserSettings {
  soundEnabled: boolean;
  selectSound: boolean;
  successSound: boolean;
  errorSound: boolean;
  popSound: boolean;
  darkMode: boolean;
}

export interface User {
  _id: ObjectId;
  email: string;
  passwordHash?: string;
  authProvider: AuthProvider;
  settings: UserSettings;
  createdAt: Date;
  updatedAt?: Date;
}

/** Default settings for new users */
export const defaultUserSettings: UserSettings = {
  soundEnabled: true,
  selectSound: true,
  successSound: true,
  errorSound: true,
  popSound: true,
  darkMode: false,
};
