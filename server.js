const express = require('express');
const cors    = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'user-token']
}));

// ─── معرّف الفيديو ───
function extractVideoId(input) {
  const patterns = [
    /[?&]v=([^&#]{11})/,
    /youtu\.be\/([^?&#]{11})/,
    /embed\/([^?&#]{11})/,
    /shorts\/([^?&#]{11})/,
  ];
  for (const p of patterns) {
    const m = input.match(p);
    if (m) return m[1];
  }
  return input.length === 11 ? input : null;
}

// ─── جلب عنوان الفيديو فقط ───
async function fetchTitle(videoId) {
  try {
    const res  = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await res.text();
    const m    = html.match(/<title>(.+?)<\/title>/);
    return m ? m[1].replace(' - YouTube', '').trim() : videoId;
  } catch {
    return videoId;
  }
}

// ─── تنظيف نص XML (للـ fallback) ───
function decodeXmlText(str) {
  return str
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&#39;/g,  "'").replace(/&quot;/g, '"').replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── تحليل XML (للـ fallback) ───
function parseXML(xml) {
  let raw = '', match;

  // صيغة ١: <text start="..." dur="...">نص</text>
  const r1 = /<text[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = r1.exec(xml)) !== null) {
    const t = decodeXmlText(match[1]);
    if (t) raw += t + ' ';
  }
  if (raw.trim()) return raw.trim();

  // صيغة ٢: <p t="...">نص</p>
  console.log('[INFO] جرب صيغة <p>...');
  const r2 = /<p[^>]*>([\s\S]*?)<\/p>/g;
  while ((match = r2.exec(xml)) !== null) {
    const t = decodeXmlText(match[1]);
    if (t) raw += t + ' ';
  }
  if (raw.trim()) return raw.trim();

  // صيغة ٣: JSON3
  try {
    const j = JSON.parse(xml);
    if (j.events) {
      return j.events
        .filter(e => e.segs)
        .flatMap(e => e.segs.map(s => s.utf8 || ''))
        .filter(t => t.trim() && t !== '\n')
        .join(' ').trim();
    }
  } catch {}

  return '';
}

// ─── Fallback يدوي: HTML scraping ───
async function fetchViaHTML(videoId) {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept':          'text/html,application/xhtml+xml',
  };

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
  if (!pageRes.ok) throw new Error(`YouTube HTTP ${pageRes.status}`);
  const html    = await pageRes.text();

  // استخراج captionTracks من الصفحة
  const capMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!capMatch) throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.');

  let captions;
  try { captions = JSON.parse(capMatch[1]); }
  catch { throw new Error('تعذّر قراءة مسارات الترجمة.'); }

  if (!captions.length) throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.');

  console.log(`[INFO] وُجد ${captions.length} مسار — ${captions.map(c => c.languageCode).join(', ')}`);

  const track =
    captions.find(t => t.languageCode === 'ar') ||
    captions.find(t => t.languageCode?.startsWith('ar')) ||
    captions.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    captions.find(t => t.languageCode === 'en') ||
    captions[0];

  console.log(`[INFO] مسار مختار: ${track.languageCode} kind=${track.kind || 'manual'}`);

  // جلب XML
  const xmlRes = await fetch(track.baseUrl, { headers });
  if (!xmlRes.ok) throw new Error(`فشل تحميل الترجمة HTTP ${xmlRes.status}`);
  const xml    = await xmlRes.text();
  console.log(`[INFO] حجم XML: ${xml.length} — أول 200 حرف: ${xml.slice(0, 200)}`);

  const raw = parseXML(xml);
  if (!raw) throw new Error('تعذّر قراءة محتوى الترجمة. جرب فيديو آخر.');

  return { raw, lang: track.languageCode || 'und', langName: track.name?.simpleText || '؟' };
}

// ─── الدالة الرئيسية ───
async function fetchTranscript(videoId) {
  const title = await fetchTitle(videoId);

  // ── المحاولة الأولى: youtube-transcript package ──
  // أسرع وأكثر استقراراً من HTML scraping
  try {
    console.log('[INFO] Method 1: youtube-transcript package...');
    const list = await YoutubeTranscript.fetchTranscript(videoId);

    if (list && list.length > 0) {
      const raw = list
        .map(item => item.text.replace(/\[.*?\]/g, '').trim())
        .filter(t => t)
        .join(' ')
        .trim();

      if (raw) {
        console.log(`[OK] Method 1 نجح — ${raw.split(' ').length} كلمة`);
        return { raw, title, lang: 'und', langName: '؟' };
      }
    }
  } catch (e) {
    console.warn('[WARN] Method 1 فشل:', e.message);
  }

  // ── المحاولة الثانية: HTML scraping يدوي ──
  console.log('[INFO] Method 2: HTML scraping...');
  const { raw, lang, langName } = await fetchViaHTML(videoId);
  console.log(`[OK] Method 2 نجح — ${raw.split(' ').length} كلمة`);
  return { raw, title, lang, langName };
}

// ─── Routes ───
app.get('/api/transcript', async (req, res) => {
  const input = req.query.v;
  if (!input) return res.status(400).json({ error: 'معرّف الفيديو مطلوب.' });

  const videoId = extractVideoId(input) || input;
  console.log(`\n[REQ] === ${videoId} ===`);

  try {
    const data = await fetchTranscript(videoId);
    console.log(`[OK] الإجمالي: ${data.raw.split(' ').length} كلمة`);
    res.json(data);
  } catch (err) {
    console.error(`[ERR] ${err.message}`);
    const status = err.message.includes('لا توجد ترجمة') ? 404
                 : err.message.includes('مقيّد')          ? 403
                 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), node: process.version });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ نصّص Backend — بورت ${PORT}`));
