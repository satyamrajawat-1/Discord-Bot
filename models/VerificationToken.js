// models/VerificationToken.js
const mongoose = require("mongoose");

const VerificationTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  discordId: { type: String, required: true },
  email: { type: String }, // set after successful oauth
  username: { type: String }, // local-part of email
  batch: { type: String },
  branch: { type: String },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
});

VerificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // automatic TTL removal if Mongo supports

module.exports = mongoose.model("VerificationToken", VerificationTokenSchema);
