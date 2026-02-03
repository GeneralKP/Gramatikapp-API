import { User } from "./src/models/index.js";
import { hashPassword } from "./src/services/authService.js";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const resetPassword = async () => {
  try {
    const mongoUri =
      process.env.MONGODB_URI || "mongodb://localhost:27017/german-gramatic";
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB");

    const email = "kevinandrespmgelcas@gmail.com";
    const newPassword = "Asd$123";

    const user = await User.findOne({ email });

    if (!user) {
      console.log(`User ${email} not found.`);
      process.exit(1);
    }

    const hashedPassword = await hashPassword(newPassword);
    user.passwordHash = hashedPassword;
    await user.save();

    console.log(`Password for ${email} successfully reset.`);
    process.exit(0);
  } catch (err) {
    console.error("Error resetting password:", err);
    process.exit(1);
  }
};

resetPassword();
