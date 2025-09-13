// ------------------ Imports ------------------
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const passport = require("passport");
const { Strategy: GoogleStrategy } = require("passport-google-oauth20");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

// ------------------ App + DB ------------------
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// ------------------ Session ------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || "keyboard cat",
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

// ------------------ Schemas ------------------
const UserSchema = new mongoose.Schema({
  discordId: String,
  email: String,
  verified: { type: Boolean, default: false },
});
const User = mongoose.model("User", UserSchema);

const TokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  discordId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 }, // TTL 5 min
});
const Token = mongoose.model("Token", TokenSchema);

// ------------------ Passport Google ------------------
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails[0].value;

        // Only allow @iiitkota.ac.in emails
        if (!email.endsWith("@iiitkota.ac.in")) {
          return done(null, false, {
            message: "Only @iiitkota.ac.in emails allowed",
          });
        }

        let user = await User.findOne({ email });
        if (!user) {
          user = await User.create({
            email,
            verified: true,
          });
        } else {
          user.verified = true;
          await user.save();
        }

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

// ------------------ Routes ------------------

// Generate link + QR
app.get("/api/generate-link/:discordId", async (req, res) => {
  try {
    const token = uuidv4();
    await Token.create({ token, discordId: req.params.discordId });

    const url = `${BASE_URL}/auth/google?token=${token}`;
    const qr = await QRCode.toDataURL(url);

    res.json({ url, qr });
  } catch (err) {
    console.error("Generate link error:", err);
    res.json({ error: "Failed to generate link" });
  }
});

// Google OAuth Start - use state param
app.get("/auth/google", async (req, res, next) => {
  const token = req.query.token;
  if (!token) return res.send("❌ Missing token.");

  const tokenDoc = await Token.findOne({ token });
  if (!tokenDoc) return res.send("❌ Invalid or expired verification link.");

  passport.authenticate("google", {
    scope: ["profile", "email"],
    state: token, // pass token as state
  })(req, res, next);
});

// Google OAuth Callback
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/auth/failure" }),
  async (req, res) => {
    try {
      const token = req.query.state; // get token back
      const tokenDoc = await Token.findOne({ token });
      if (!tokenDoc) {
        return res.send("❌ Invalid or expired verification link.");
      }

      const { discordId } = tokenDoc;
      const email = req.user.email;

      if (!email.endsWith("@iiitkota.ac.in")) {
        return res.send("❌ Please login with your @iiitkota.ac.in email.");
      }

      // Save user in DB
      let user = await User.findOne({ discordId });
      if (!user) {
        user = await User.create({ discordId, email, verified: true });
      } else {
        user.email = email;
        user.verified = true;
        await user.save();
      }

      // Discord role assignment
      try {
        const guild = await discordClient.guilds.fetch(process.env.GUILD_ID);
        const member = await guild.members.fetch(discordId);

        const username = email.split("@")[0]; // e.g., 2024kucp1234
        const batch = username.substring(0, 4);
        const branchCode = username.substring(4, 8).toUpperCase();
        let branch = "UNKNOWN";
        if (branchCode === "KUCP") branch = "CSE";
        else if (branchCode === "KUEC") branch = "ECE";
        else if (branchCode === "KUAD") branch = "AIDE";

        // Batch role
        let batchRole = guild.roles.cache.find((r) => r.name === batch);
        if (!batchRole) {
          batchRole = await guild.roles.create({
            name: batch,
            color: "Blue",
            reason: "Batch role created by bot",
          });
        }

        // Branch role
        let branchRole = guild.roles.cache.find((r) => r.name === branch);
        if (!branchRole) {
          branchRole = await guild.roles.create({
            name: branch,
            color: "Green",
            reason: "Branch role created by bot",
          });
        }

        await member.roles.add(batchRole);
        await member.roles.add(branchRole);
        await member.setNickname(username);

        console.log(`✅ Verified ${discordId} (${email})`);
      } catch (err) {
        console.error("❌ Role/Nickname error:", err);
      }

      await Token.deleteOne({ token }); // remove used token

      res.send("✅ Verification successful! You can return to Discord.");
    } catch (err) {
      console.error("Callback error:", err);
      res.send("❌ Server error during verification.");
    }
  }
);

app.get("/auth/failure", (req, res) =>
  res.send("❌ Google Authentication Failed")
);

// ------------------ Discord Bot ------------------
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

discordClient.once("ready", () => {
  console.log(`🤖 Logged in as ${discordClient.user.tag}`);
});

// !verify command
discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.toLowerCase() === "!verify") {
    try {
      const discordId = message.author.id;

      const fetch = (await import("node-fetch")).default;
      const res = await fetch(`${BASE_URL}/api/generate-link/${discordId}`);
      const data = await res.json();

      if (data.error) {
        return message.reply("⚠️ Could not generate verification link.");
      }

      try {
        await message.author.send(
          `📌 To verify your IIITKota email, click this link (valid 5 min):\n${data.url}`
        );
        await message.author.send(`📷 Or scan this QR code:\n${data.qr}`);
        await message.reply("✅ I've sent you a DM with your verification link.");
      } catch {
        await message.reply(
          `⚠️ Couldn't DM you. Use this link instead:\n${data.url}`
        );
      }
    } catch (err) {
      console.error("!verify error:", err);
      message.reply("⚠️ Something went wrong.");
    }
  }
});

// ------------------ Start ------------------
discordClient.login(process.env.DISCORD_TOKEN);
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
