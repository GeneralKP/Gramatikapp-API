import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// Build MongoDB URI from environment variables
// Supports both full MONGODB_URI or separate DB_USER, DB_USER_PASSWORD, DB_CLUSTER vars
function getMongoURI(): string {
  // If full URI is provided, use it directly
  if (process.env.MONGODB_URI) {
    return process.env.MONGODB_URI;
  }

  // Build from separate parts (for Render deployment)
  const dbUser = process.env.DB_USER;
  const dbPassword = process.env.DB_USER_PASSWORD;
  const dbCluster = process.env.DB_CLUSTER;

  if (dbUser && dbPassword && dbCluster) {
    return `mongodb+srv://${dbUser}:${dbPassword}@${dbCluster}.mongodb.net/gramatikapp?retryWrites=true&w=majority`;
  }

  // Local development fallback
  return "mongodb://localhost:27017/german-gramatic";
}

const MONGODB_URI = getMongoURI();

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ MongoDB connected successfully");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

export const disconnectDB = async (): Promise<void> => {
  await mongoose.disconnect();
  console.log("MongoDB disconnected");
};
