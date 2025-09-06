require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const app = express();

/* ---------------------------- Config ---------------------------- */
const {
  MONGO_URI = "mongodb://127.0.0.1:27017/streaky",
  PORT = 4000,
  JWT_ACCESS_SECRET = "change-me",
  JWT_REFRESH_SECRET = "change-me-too",
} = process.env;

// If your Vite dev server runs at 5173:
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: false, // using Authorization header (not cookies)
  })
);
app.use(express.json());

/* --------------------------- MongoDB ---------------------------- */
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("Mongo error:", err));

/* --------------------------- Schemas ---------------------------- */
const UserSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, required: true, index: true },
    passwordHash: { type: String, required: true },
    // Optional: for refresh token rotation/revocation if you want
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const TaskSchema = new mongoose.Schema({
  id: String, // keep client id for React keys
  text: String,
  done: Boolean,
});

const ListSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    title: String,
    streak: { type: Number, default: 0 },
    lastCompletedDate: { type: String, default: null },
    completedToday: { type: Boolean, default: false },
    tasks: [TaskSchema],
  },
  { timestamps: true }
);

const OverallSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", unique: true },
    streak: { type: Number, default: 0 },
    lastCompletedDate: { type: String, default: null },
    completedToday: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const User = mongoose.model("User", UserSchema);
const List = mongoose.model("List", ListSchema);
const Overall = mongoose.model("Overall", OverallSchema);

/* -------------------------- JWT helpers ------------------------- */
function signAccessToken(user) {
  // include tokenVersion if you plan to rotate refresh tokens
  return jwt.sign(
    { sub: user._id.toString(), tv: user.tokenVersion || 0, email: user.email },
    JWT_ACCESS_SECRET,
    { expiresIn: "15m" }
  );
}
function signRefreshToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), tv: user.tokenVersion || 0 },
    JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
}
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing token" });
  try {
    const payload = jwt.verify(token, JWT_ACCESS_SECRET);
    req.userId = payload.sub;
    req.tokenVersion = payload.tv;
    next();
  } catch (e) {
    return res.status(401).json({ error: "invalid/expired token" });
  }
}

/* --------------------------- Auth APIs -------------------------- */
// Register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: "email and password required" });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: "email already in use" });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash });

    // Initialize Overall for this user
    await Overall.create({ userId: user._id });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user._id, email: user.email },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "registration failed" });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "invalid credentials" });

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    res.json({
      accessToken,
      refreshToken,
      user: { id: user._id, email: user.email },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "login failed" });
  }
});

// Refresh access token
app.post("/auth/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken)
      return res.status(400).json({ error: "missing refreshToken" });

    const payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: "invalid refresh token" });

    // Optional: if you rotate refresh tokens, verify tokenVersion matches
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: "refresh token revoked" });
    }

    const accessToken = signAccessToken(user);
    res.json({ accessToken });
  } catch (e) {
    return res.status(401).json({ error: "invalid/expired refresh token" });
  }
});

// (Optional) Logout → increment tokenVersion to revoke outstanding refresh tokens
app.post("/auth/logout", requireAuth, async (req, res) => {
  await User.findByIdAndUpdate(req.userId, { $inc: { tokenVersion: 1 } });
  res.sendStatus(204);
});

/* -------------------------- Protected APIs ---------------------- */
// Overall (per-user; auto-create on first GET)
app.get("/overall", requireAuth, async (req, res) => {
  let doc = await Overall.findOne({ userId: req.userId }).lean();
  if (!doc) {
    const created = await Overall.create({ userId: req.userId });
    doc = created.toObject();
  }
  res.json(doc);
});

app.put("/overall", requireAuth, async (req, res) => {
  const updated = await Overall.findOneAndUpdate(
    { userId: req.userId },
    { $set: req.body },
    { new: true, upsert: true }
  ).lean();
  res.json(updated);
});

// Lists (CRUD) – always scoped to req.userId
app.get("/lists", requireAuth, async (req, res) => {
  const docs = await List.find({ userId: req.userId }).lean();
  res.json(docs);
});

app.post("/lists", requireAuth, async (req, res) => {
  const body = req.body || {};
  const created = await List.create({ ...body, userId: req.userId });
  res.status(201).json(created);
});

app.put("/lists/:id", requireAuth, async (req, res) => {
  // Ensure users can only update their own lists
  const updated = await List.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId },
    req.body,
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json(updated);
});

app.delete("/lists/:id", requireAuth, async (req, res) => {
  const deleted = await List.findOneAndDelete({
    _id: req.params.id,
    userId: req.userId,
  });
  if (!deleted) return res.status(404).json({ error: "not found" });
  res.sendStatus(204);
});

/* -------------------------- Healthcheck ------------------------- */
app.get("/", (_req, res) => res.send("API is working!"));

app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
app.get("/__routes", (_req, res) => {
  const list = [];
  app._router.stack.forEach((m) => {
    if (m.route) {
      const methods = Object.keys(m.route.methods).join(",").toUpperCase();
      list.push(`${methods} ${m.route.path}`);
    }
  });
  res.json(list);
});
