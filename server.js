import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const {
  PORT = 3000,
  BASE_URL = `http://localhost:3000`,
  X_CLIENT_ID,
  X_REDIRECT_URI = `${BASE_URL}/callback`,
  X_SCOPES = 'tweet.read users.read offline.access',
  SESSION_SECRET = 'change-me'
} = process.env;

if (!X_CLIENT_ID) {
  console.error('Missing X_CLIENT_ID in .env');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'xlogin.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: true // pastikan true di HTTPS (nginx reverse proxy)
    }
  })
);

/* ===========================
   Utils: PKCE & helpers
=========================== */

function b64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function genVerifier() { return b64url(crypto.randomBytes(32)); }
function sha256(str) { return crypto.createHash('sha256').update(str).digest(); }
function toChallengeS256(verifier) { return b64url(sha256(verifier)); }
function newState() { return b64url(crypto.randomBytes(16)); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ===========================
   In-memory Job Store
   jobs[jobId] = {
     userId, total, deleted, status: 'pending'|'running'|'done'|'error'|'canceled',
     startedAt, finishedAt, error, ids, cancel: false
   }
=========================== */

const jobs = new Map();

/* ===========================
   Routes: pages
=========================== */

app.get('/', (req, res) => {
  res.render('index', {
    isAuthed: Boolean(req.session.tokens?.access_token),
    user: req.session.user || null
  });
});

app.get('/dashboard', ensureAuth, (req, res) => {
  res.render('dashboard', {
    user: req.session.user,
    tokens: req.session.tokens
  });
});

/* ===========================
   OAuth2 PKCE Login
=========================== */

app.get('/login', (req, res) => {
  const verifier = genVerifier();
  const challenge = toChallengeS256(verifier);
  const state = newState();

  req.session.pkce = { verifier, challenge };
  req.session.oauth_state = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: X_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  const authorizeUrl = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
  res.redirect(authorizeUrl);
});

app.get('/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error} - ${error_description || ''}`);
    if (!code || !state) return res.status(400).send('Missing code/state');

    if (!req.session.oauth_state || state !== req.session.oauth_state) {
      return res.status(400).send('Invalid state (CSRF)');
    }
    if (!req.session.pkce?.verifier) return res.status(400).send('Missing PKCE verifier');

    // Exchange code -> tokens
    const tokenUrl = 'https://api.x.com/2/oauth2/token';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: X_REDIRECT_URI,
      client_id: X_CLIENT_ID,
      code_verifier: req.session.pkce.verifier
    });

    const tokenResp = await axios.post(tokenUrl, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    req.session.tokens = tokenResp.data; // contains access_token, refresh_token, etc.

    // Get user profile
    const me = await axios.get('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${req.session.tokens.access_token}` }
    });
    req.session.user = me.data?.data || null;

    delete req.session.oauth_state;
    delete req.session.pkce;

    res.redirect('/dashboard');
  } catch (e) {
    console.error('Callback error:', e.response?.data || e.message);
    res.status(500).send(`Callback error: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
  }
});

// Optional: post a tweet
app.post('/tweet', ensureAuth, async (req, res) => {
  try {
    const text = req.body?.text || 'Hello from PKCE demo!';
    const r = await axios.post(
      'https://api.x.com/2/tweets',
      { text },
      { headers: { Authorization: `Bearer ${req.session.tokens.access_token}` } }
    );
    res.json(r.data);
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Token refresh (needs offline.access)
app.post('/refresh', ensureAuth, async (req, res) => {
  try {
    if (!req.session.tokens?.refresh_token) {
      return res.status(400).json({ error: 'No refresh_token available' });
    }
    const tokenUrl = 'https://api.x.com/2/oauth2/token';
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: req.session.tokens.refresh_token,
      client_id: X_CLIENT_ID
    });
    const r = await axios.post(tokenUrl, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    req.session.tokens = r.data;
    res.json({ ok: true, tokens: r.data });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

/* ===========================
   DELETE ALL TWEETS (Job)
=========================== */

// Start job: collect tweet IDs (batched) and begin deletion in background
app.post('/delete/start', ensureAuth, async (req, res) => {
  try {
    const access_token = req.session.tokens?.access_token;
    const userId = req.session.user?.id;
    if (!access_token || !userId) return res.status(401).json({ error: 'Not authenticated' });

    // 1) Collect IDs (pagination)
    const ids = [];
    let nextToken = null;
    const MAX_PAGES = 10; // ~1000 tweets (10 x 100). Sesuaikan jika perlu.
    for (let i = 0; i < MAX_PAGES; i++) {
      const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
      url.searchParams.set('max_results', '100');
      if (nextToken) url.searchParams.set('pagination_token', nextToken);

      const tw = await axios.get(url.toString(), {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const chunk = tw.data?.data || [];
      ids.push(...chunk.map(t => t.id));

      nextToken = tw.data?.meta?.next_token || null;
      if (!nextToken) break;
    }

    if (ids.length === 0) {
      return res.json({ ok: true, jobId: null, message: 'No tweets to delete.' });
    }

    // 2) Create job
    const jobId = b64url(crypto.randomBytes(12));
    const job = {
      jobId,
      userId,
      total: ids.length,
      deleted: 0,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      ids,
      cancel: false
    };
    jobs.set(jobId, job);

    // 3) Run background worker (no queue lib; simple loop)
    (async () => {
      try {
        for (const id of job.ids) {
          if (job.cancel) {
            job.status = 'canceled';
            job.finishedAt = Date.now();
            break;
          }
          try {
            await axios.delete(`https://api.x.com/2/tweets/${id}`, {
              headers: { Authorization: `Bearer ${access_token}` }
            });
            job.deleted += 1;
          } catch (err) {
            // Simpan error ringan di console; lanjut
            console.log('Delete failed', id, err.response?.data || err.message);
          }
          // kecilkan rate; hindari limit
          await sleep(600);
        }
        if (!job.cancel && job.status !== 'error') {
          job.status = 'done';
          job.finishedAt = Date.now();
        }
      } catch (err) {
        job.status = 'error';
        job.error = err.response?.data || err.message;
        job.finishedAt = Date.now();
      }
    })();

    res.json({ ok: true, jobId, total: job.total });
  } catch (e) {
    console.error('delete/start error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// Poll status
app.get('/delete/status', ensureAuth, (req, res) => {
  const { jobId } = req.query;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    ok: true,
    jobId,
    status: job.status,
    total: job.total,
    deleted: job.deleted,
    error: job.error
  });
});

// Cancel job
app.post('/delete/cancel', ensureAuth, (req, res) => {
  const { jobId } = req.body;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.cancel = true;
  res.json({ ok: true });
});

/* ===========================
   Middleware
=========================== */

function ensureAuth(req, res, next) {
  if (req.session?.tokens?.access_token) return next();
  res.redirect('/');
}

/* ===========================
   Start server
=========================== */

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${BASE_URL} (PORT ${PORT})`);
});
