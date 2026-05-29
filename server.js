'use strict';

const express = require('express');
const cors    = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();

/* ═══════════════════════════════════════════════════════════════════════════
   SECURITY HARDENING — server.js
   ─────────────────────────────────────────────────────────────────────────
   FIX-S01  Security headers (X-Frame-Options, X-Content-Type-Options, etc.)
   FIX-S02  CORS origin restricted to known frontend origins
   FIX-S03  Input validation & length limits on req.query.v
   FIX-S04  Video ID strict allowlist regex before any outbound URL use
   FIX-S05  SSRF mitigation: caption track baseUrl validated to youtube.com
   FIX-S06  Sensitive console.log output removed (subtitle content)
   FIX-S07  Rate limiting on /api/transcript (simple in-memory)
   FIX-S08  Normalised, non-leaking error responses
   FIX-S09  Health endpoint does not expose process.version
   FIX-S10  Request body size cap (belt-and-suspenders)
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── FIX-S01: Security response headers middleware ─────────────────────────
app.use((req, res, next) => {
  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Clickjacking protection
  res.setHeader('X-Frame-Options', 'DENY');
  // Disable browser sniff of powered-by
  res.removeHeader('X-Powered-By');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions policy — restrict what browser features the response may use
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // Basic CSP for API responses (belt-and-suspenders for JSON endpoints)
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
});

// ─── FIX-S02: CORS — restrict to known frontend origins ───────────────────
// Original: origin: '*' allows any website to call this API and potentially
// use it as a proxy to YouTube, burning Railway bandwidth.
// Change to explicit list. Add your production domain here.
const ALLOWED_ORIGINS = [
  'https://darnexploit141.github.io',
  'https://nassas1.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no Origin (curl, Postman, direct API calls)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'OPTIONS'],          // FIX-S02: POST removed — not used
  allowedHeaders: ['Content-Type', 'Accept', 'user-token'],
  optionsSuccessStatus: 204
}));

// ─── FIX-S10: Request body limit ──────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));

// ─── FIX-S04: Strict video ID validation ──────────────────────────────────
// YouTube video IDs are exactly 11 characters from [A-Za-z0-9_-].
// Enforced as the sole allowed format — no raw URL parsing on the server
// (the frontend already sends only the ID).
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function extractVideoId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();

  // FIX-S04: strict 11-char ID check first
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  // Fallback: extract from a YouTube URL (only youtube.com / youtu.be)
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(trimmed)) return null;

  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
    /shorts\/([A-Za-z0-9_-]{11})/,
    /live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = trimmed.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─── FIX-S05: Safe baseUrl validator ─────────────────────────────────────
// captionTracks[].baseUrl comes from YouTube's own page; however we validate
// it before fetching to prevent SSRF if the page were somehow tampered with.
const YOUTUBE_CAPTION_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+\.youtube\.com\//;
function isSafeBaseUrl(url) {
  if (typeof url !== 'string') return false;
  // Must be HTTPS and on a youtube.com subdomain
  return YOUTUBE_CAPTION_ORIGIN_RE.test(url);
}

// ─── FIX-S07: Simple in-memory rate limiter ───────────────────────────────
// Limits each IP to MAX_REQUESTS per WINDOW_MS.
// For production, replace with redis-backed rate limiter (e.g. express-rate-limit).
const RATE_WINDOW_MS  = 60 * 1000; // 1 minute
const MAX_REQUESTS    = 20;         // per IP per window
const _rateBuckets    = new Map();

function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);
  if (!bucket || now - bucket.ts > RATE_WINDOW_MS) {
    bucket = { ts: now, count: 0 };
    _rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > MAX_REQUESTS) {
    return res.status(429).json({ error: 'طلبات كثيرة — حاول بعد دقيقة.' });
  }
  next();
}

// Purge stale buckets every 5 minutes (prevent memory growth)
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, b] of _rateBuckets) {
    if (b.ts < cutoff) _rateBuckets.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── fetchTitle ───────────────────────────────────────────────────────────
// FIX-S04: videoId already validated before this is called.
async function fetchTitle(videoId) {
  try {
    const res  = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      // 8-second timeout for title fetch
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return videoId;
    const html = await res.text();
    const m    = html.match(/<title>(.+?)<\/title>/);
    // Limit title length and strip HTML entities manually (no library needed)
    return m
      ? m[1]
          .replace(' - YouTube', '')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
          .trim()
          .slice(0, 500)
      : videoId;
  } catch {
    return videoId;
  }
}

// ─── decodeXmlText ────────────────────────────────────────────────────────
function decodeXmlText(str) {
  return str
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&#39;/g,  "'").replace(/&quot;/g, '"').replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── parseXML ─────────────────────────────────────────────────────────────
function parseXML(xml) {
  let raw = '', match;

  const r1 = /<text[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = r1.exec(xml)) !== null) {
    const t = decodeXmlText(match[1]);
    if (t) raw += t + ' ';
  }
  if (raw.trim()) return raw.trim();

  const r2 = /<p[^>]*>([\s\S]*?)<\/p>/g;
  while ((match = r2.exec(xml)) !== null) {
    const t = decodeXmlText(match[1]);
    if (t) raw += t + ' ';
  }
  if (raw.trim()) return raw.trim();

  try {
    const j = JSON.parse(xml);
    if (j && Array.isArray(j.events)) {
      return j.events
        .filter(e => e && Array.isArray(e.segs))
        .flatMap(e => e.segs.map(s => (s && typeof s.utf8 === 'string' ? s.utf8 : '')))
        .filter(t => t.trim() && t !== '\n')
        .join(' ').trim();
    }
  } catch { /* not JSON3 format */ }

  return '';
}

// ─── fetchViaHTML ─────────────────────────────────────────────────────────
// FIX-S05: validates baseUrl before fetching
async function fetchViaHTML(videoId) {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept':          'text/html,application/xhtml+xml',
  };

  const pageRes = await fetch(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    { headers, signal: AbortSignal.timeout(15000) }
  );
  if (!pageRes.ok) throw new Error(`YouTube HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  const capMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!capMatch) throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.');

  let captions;
  try { captions = JSON.parse(capMatch[1]); }
  catch { throw new Error('تعذّر قراءة مسارات الترجمة.'); }

  if (!Array.isArray(captions) || !captions.length)
    throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.');

  const track =
    captions.find(t => t.languageCode === 'ar') ||
    captions.find(t => t.languageCode?.startsWith('ar')) ||
    captions.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    captions.find(t => t.languageCode === 'en') ||
    captions[0];

  if (!track || typeof track.baseUrl !== 'string') {
    throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.');
  }

  // FIX-S05: SSRF guard — baseUrl must be on youtube.com
  if (!isSafeBaseUrl(track.baseUrl)) {
    throw new Error('تعذّر التحقق من مصدر الترجمة.');
  }

  const xmlRes = await fetch(track.baseUrl, {
    headers,
    signal: AbortSignal.timeout(15000)
  });
  if (!xmlRes.ok) throw new Error(`فشل تحميل الترجمة HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();

  // FIX-S06: do NOT log xml content (may contain subtitle text / user data)
  // Only log metadata
  console.log(`[INFO] XML length: ${xml.length} chars, track: ${track.languageCode}`);

  const raw = parseXML(xml);
  if (!raw) throw new Error('تعذّر قراءة محتوى الترجمة. جرب فيديو آخر.');

  return {
    raw,
    lang:     typeof track.languageCode === 'string' ? track.languageCode.slice(0, 10) : 'und',
    langName: typeof track.name?.simpleText === 'string' ? track.name.simpleText.slice(0, 50) : '؟'
  };
}

// ─── fetchTranscript ──────────────────────────────────────────────────────
async function fetchTranscript(videoId) {
  const title = await fetchTitle(videoId);

  // Method 1: youtube-transcript package
  try {
    console.log('[INFO] Method 1: youtube-transcript package...');
    const list = await YoutubeTranscript.fetchTranscript(videoId);

    if (list && list.length > 0) {
      const raw = list
        .map(item => typeof item.text === 'string' ? item.text.replace(/\[.*?\]/g, '').trim() : '')
        .filter(t => t)
        .join(' ')
        .trim();

      if (raw) {
        console.log(`[OK] Method 1 succeeded — ${raw.split(' ').length} words`);
        return { raw, title, lang: 'und', langName: '؟' };
      }
    }
  } catch (e) {
    console.warn('[WARN] Method 1 failed:', e.message);
  }

  // Method 2: HTML scraping fallback
  console.log('[INFO] Method 2: HTML scraping...');
  const { raw, lang, langName } = await fetchViaHTML(videoId);
  console.log(`[OK] Method 2 succeeded — ${raw.split(' ').length} words`);
  return { raw, title, lang, langName };
}

// ─── Routes ───────────────────────────────────────────────────────────────
app.get('/api/transcript', rateLimit, async (req, res) => {
  // FIX-S03: enforce input presence and length
  const rawInput = req.query.v;
  if (!rawInput || typeof rawInput !== 'string') {
    return res.status(400).json({ error: 'معرّف الفيديو مطلوب.' });
  }
  if (rawInput.length > 512) {
    return res.status(400).json({ error: 'المدخل طويل جداً.' });
  }

  // FIX-S04: validate to a safe video ID before any outbound request
  const videoId = extractVideoId(rawInput);
  if (!videoId) {
    return res.status(400).json({ error: 'معرّف الفيديو غير صالح.' });
  }

  console.log(`\n[REQ] === ${videoId} ===`);

  try {
    const data = await fetchTranscript(videoId);
    console.log(`[OK] Total: ${data.raw.split(' ').length} words`);

    // FIX-S08: return only the expected fields — no raw internal data
    res.json({
      raw:      data.raw,
      title:    data.title,
      lang:     data.lang,
      langName: data.langName
    });
  } catch (err) {
    console.error(`[ERR] ${err.message}`);

    // FIX-S08: map errors to safe user-facing messages
    // Do not expose internal error details (stack traces, paths, etc.)
    if (err.message.includes('لا توجد ترجمة')) {
      return res.status(404).json({ error: 'لا توجد ترجمة متاحة لهذا الفيديو.' });
    }
    if (err.message.includes('مقيّد') || err.message.includes('403')) {
      return res.status(403).json({ error: 'الفيديو مقيّد أو يتطلب تسجيل دخول.' });
    }
    if (err.message.includes('SSRF') || err.message.includes('مصدر')) {
      return res.status(502).json({ error: 'تعذّر التحقق من مصدر الترجمة.' });
    }
    // Generic 500 — FIX-S08: no internal message leakage
    return res.status(500).json({ error: 'خطأ داخلي في الخادم. حاول مجدداً.' });
  }
});

// FIX-S09: health endpoint — no version/runtime info exposure
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'المسار غير موجود.' });
});

// Global error handler — prevents unhandled errors from leaking stack traces
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED]', err.message);
  res.status(500).json({ error: 'خطأ داخلي في الخادم.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Nassas Backend — port ${PORT}`));
