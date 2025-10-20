// =====================================================
// 🐦 X / Twitter OAuth2 PKCE + Delete per Tweet (DataTable)
// Node.js + Express + EJS + express-ejs-layouts
// =====================================================

import express from "express";
import session from "express-session";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import expressLayouts from "express-ejs-layouts";
import { fileURLToPath } from "url";

dotenv.config();

// ===== ENVIRONMENT =====
const {
  PORT = 3000,
  BASE_URL = "https://pansa.my.id",
  X_CLIENT_ID,
  X_REDIRECT_URI = `${BASE_URL}/callback`,
  X_SCOPES = "tweet.read tweet.write users.read offline.access",
  SESSION_SECRET = "change-this-super-secret"
} = process.env;

if (!X_CLIENT_ID) {
  console.error("❌ Missing X_CLIENT_ID in .env");
  process.exit(1);
}

// ===== PATH =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== EXPRESS APP =====
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// ===== SESSION (HTTPS + NGINX FIX) =====
app.set("trust proxy", 1);
app.use(
  session({
    name: "xlogin.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      maxAge: 1000 * 60 * 15
    }
  })
);

// ===== UTIL =====
const b64url = (buf) =>
  buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const sha256 = (str) => crypto.createHash("sha256").update(str).digest();
const genVerifier = () => b64url(crypto.randomBytes(32));
const toChallengeS256 = (verifier) => b64url(sha256(verifier));
const newState = () => b64url(crypto.randomBytes(16));

// ===== MIDDLEWARE =====
const ensureAuth = (req, res, next) => {
  if (req.session?.tokens?.access_token) return next();
  res.redirect("/");
};
app.use((req, res, next) => {
  res.locals.title = "X Tools — PansaGroup";
  next();
});

// =====================================================
// ROUTES: PAGES
// =====================================================
app.get("/", (req, res) => {
  res.render("index", {
    layout: "layout",
    title: "Login with X | PansaGroup",
    isAuthed: Boolean(req.session.tokens?.access_token),
    user: req.session.user || null
  });
});

app.get("/dashboard", ensureAuth, (req, res) => {
  res.render("dashboard", {
    layout: "layout",
    title: "Dashboard — X Tools | PansaGroup",
    user: req.session.user,
    tokens: req.session.tokens
  });
});

// =====================================================
// 🔐 LOGIN / CALLBACK
// =====================================================
app.get("/login", (req, res) => {
  const verifier = genVerifier();
  const challenge = toChallengeS256(verifier);
  const state = newState();
  req.session.pkce = { verifier, challenge };
  req.session.oauth_state = state;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: X_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params.toString()}`);
});

app.get("/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error)
      return res.status(400).send(`OAuth error: ${error} - ${error_description || ""}`);
    if (!code || !state) return res.status(400).send("Missing code/state");
    if (!req.session.oauth_state || state !== req.session.oauth_state)
      return res.status(400).send("Invalid state (CSRF check failed)");
    if (!req.session.pkce?.verifier) return res.status(400).send("Missing PKCE verifier");

    const tokenUrl = "https://api.twitter.com/2/oauth2/token";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: X_REDIRECT_URI,
      client_id: X_CLIENT_ID,
      code_verifier: req.session.pkce.verifier
    });

    const tokenResp = await axios.post(tokenUrl, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    req.session.tokens = tokenResp.data;

    const me = await axios.get(
      "https://api.twitter.com/2/users/me?user.fields=profile_image_url",
      { headers: { Authorization: `Bearer ${req.session.tokens.access_token}` } }
    );
    req.session.user = me.data?.data || null;

    delete req.session.oauth_state;
    delete req.session.pkce;

    res.redirect("/dashboard");
  } catch (e) {
    console.error("Callback error:", e.response?.data || e.message);
    res
      .status(500)
      .send(
        `Callback error: ${
          e.response?.data ? JSON.stringify(e.response.data) : e.message
        }`
      );
  }
});

// =====================================================
// ✉️ POST TWEET (opsional)
// =====================================================
app.post("/tweet", ensureAuth, async (req, res) => {
  try {
    const text = req.body?.text || "Hello from X PKCE demo!";
    const r = await axios.post(
      "https://api.twitter.com/2/tweets",
      { text },
      { headers: { Authorization: `Bearer ${req.session.tokens.access_token}` } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// =====================================================
// 🧭 API: LIST TWEETS (paged) untuk DataTables
// =====================================================
app.get("/tweets/list", ensureAuth, async (req, res) => {
  try {
    const access_token = req.session.tokens?.access_token;
    const userId = req.session.user?.id;
    if (!access_token || !userId)
      return res.status(401).json({ error: "Not authenticated" });

    const { cursor = "", max = "100" } = req.query;
    const url = new URL(`https://api.twitter.com/2/users/${userId}/tweets`);
    url.searchParams.set("max_results", String(Math.min(parseInt(max, 10) || 100, 100)));
    url.searchParams.set(
      "tweet.fields",
      "created_at,public_metrics,possibly_sensitive,source"
    );
    if (cursor) url.searchParams.set("pagination_token", cursor);

    const r = await axios.get(url.toString(), {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const data = r.data?.data || [];
    const meta = r.data?.meta || {};

    res.json({
      ok: true,
      tweets: data,
      next_token: meta.next_token || null,
      result_count: meta.result_count || 0
    });
  } catch (e) {
    console.error("❌ /tweets/list error:", e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// =====================================================
// 🗑 API: DELETE PER TWEET
// =====================================================
app.post("/tweets/:id/delete", ensureAuth, async (req, res) => {
  try {
    const access_token = req.session.tokens?.access_token;
    const { id } = req.params;
    if (!access_token) return res.status(401).json({ error: "Not authenticated" });

    await axios.delete(`https://api.twitter.com/2/tweets/${id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    res.json({ ok: true, id });
  } catch (e) {
    const status = e.response?.status;
    const payload = e.response?.data || e.message;
    console.error("❌ Delete tweet error:", payload);
    res.status(status || 500).json({ ok: false, error: payload });
  }
});

// =====================================================
// 🔒 LOGOUT
// =====================================================
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// =====================================================
// START
// =====================================================
app.listen(PORT, () =>
  console.log(`✅ Server running at ${BASE_URL} (PORT ${PORT})`)
);
