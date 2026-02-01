import mongoose, { Schema, Document } from "mongoose";

export type AuthProvider = "email" | "google";

export interface IUserSettings {
  soundEnabled: boolean;
  darkMode: boolean;
}

export interface IUser extends Document {
  email: string;
  passwordHash?: string;
  authProvider: AuthProvider;
  settings: IUserSettings;
  createdAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: false, // Optional for OAuth providers
    },
    authProvider: {
      type: String,
      enum: ["email", "google"],
      default: "email",
    },
    settings: {
      soundEnabled: {
        type: Boolean,
        default: true,
      },
      darkMode: {
        type: Boolean,
        default: false,
      },
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index({ email: 1 });

export const User = mongoose.model<IUser>("User", userSchema);
