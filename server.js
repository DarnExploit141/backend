const express = require('express');
const cors    = require('cors');
const https   = require('https');

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
  return (input && input.length === 11) ? input : null;
}

// ─── تنظيف نص XML ───
function decodeXmlText(str) {
  return str
    .replace(/&amp;/g,  '&').replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&#39;/g,  "'").replace(/&quot;/g, '"').replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── تحليل XML ───
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

// ─── Method 1: InnerTube API (بدون مكتبات خارجية) ───
async function fetchViaInnerTube(videoId) {
  console.log('[INFO] Method 1: InnerTube API...');

  // جلب player page للحصول على transcript list
  const playerRes = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://www.youtube.com',
      'Referer': `https://www.youtube.com/watch?v=${videoId}`,
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20240101.00.00',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'en',
          gl: 'US',
        }
      },
      videoId,
      params: btoa(`\n\x0b${videoId}`)
    })
  });

  if (!playerRes.ok) throw new Error(`InnerTube HTTP ${playerRes.status}`);
  const data = await playerRes.json();

  // استخراج النصوص من الرد
  const actions = data?.actions?.[0]?.updateEngagementPanelAction?.content
    ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer
    ?.body?.transcriptSegmentListRenderer?.initialSegments;

  if (!actions || !actions.length) throw new Error('InnerTube: لا توجد بيانات ترجمة');

  const raw = actions
    .map(seg => seg?.transcriptSegmentRenderer?.snippet?.runs?.[0]?.text || '')
    .filter(t => t.trim())
    .join(' ')
    .trim();

  if (!raw) throw new Error('InnerTube: النص فارغ');
  return raw;
}

// ─── Method 2: HTML scraping ───
async function fetchViaHTML(videoId) {
  console.log('[INFO] Method 2: HTML scraping...');

  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept':          'text/html,application/xhtml+xml',
    'Cookie':          'CONSENT=YES+cb; PREF=hl=en&gl=US',
  };

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { headers });
  if (!pageRes.ok) throw new Error(`YouTube HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  // استخراج captionTracks
  const capMatch = html.match(/"captionTracks":(\[.*?\])/);
  if (!capMatch) {
    // تحقق هل الفيديو موجود أصلاً
    if (html.includes('"playabilityStatus":{"status":"ERROR"')) throw new Error('الفيديو غير موجود أو محذوف.');
    if (html.includes('LOGIN_REQUIRED')) throw new Error('هذا الفيديو يتطلب تسجيل دخول على يوتيوب.');
    throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.');
  }

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

  const xmlRes = await fetch(track.baseUrl, { headers });
  if (!xmlRes.ok) throw new Error(`فشل تحميل الترجمة HTTP ${xmlRes.status}`);
  const xml = await xmlRes.text();
  console.log(`[INFO] حجم XML: ${xml.length} حرف — أول 150: ${xml.slice(0, 150)}`);

  const raw = parseXML(xml);
  if (!raw) throw new Error('تعذّر قراءة محتوى الترجمة.');

  return { raw, lang: track.languageCode || 'und', langName: track.name?.simpleText || '؟' };
}

// ─── Method 3: youtube-transcript package ───
async function fetchViaPackage(videoId) {
  console.log('[INFO] Method 3: youtube-transcript package...');
  const { YoutubeTranscript } = require('youtube-transcript');
  const list = await YoutubeTranscript.fetchTranscript(videoId);
  if (!list || !list.length) throw new Error('Package: قائمة فارغة');
  const raw = list
    .map(item => item.text.replace(/\[.*?\]/g, '').trim())
    .filter(t => t)
    .join(' ')
    .trim();
  if (!raw) throw new Error('Package: النص فارغ');
  return { raw, lang: 'und', langName: '؟' };
}

// ─── جلب العنوان ───
async function fetchTitle(videoId) {
  try {
    const res  = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const html = await res.text();
    const m    = html.match(/<title>(.+?)<\/title>/);
    return m ? m[1].replace(' - YouTube', '').trim() : videoId;
  } catch { return videoId; }
}

// ─── الدالة الرئيسية — 3 محاولات ───
async function fetchTranscript(videoId) {
  const title = await fetchTitle(videoId);
  const errors = [];

  // Method 3 أولاً (الأكثر استقراراً مع IPs الـ datacenter)
  try {
    const result = await fetchViaPackage(videoId);
    return { ...result, title };
  } catch(e) {
    console.warn('[WARN] Method 3 فشل:', e.message);
    errors.push('Package: ' + e.message);
  }

  // Method 2
  try {
    const result = await fetchViaHTML(videoId);
    return { ...result, title };
  } catch(e) {
    console.warn('[WARN] Method 2 فشل:', e.message);
    errors.push('HTML: ' + e.message);
    // إذا الخطأ واضح — لا داعي للمحاولة الثالثة
    if (e.message.includes('لا توجد ترجمة') || e.message.includes('LOGIN_REQUIRED') || e.message.includes('غير موجود')) {
      throw e;
    }
  }

  // Method 1 أخيراً
  try {
    const raw = await fetchViaInnerTube(videoId);
    return { raw, title, lang: 'und', langName: '؟' };
  } catch(e) {
    console.warn('[WARN] Method 1 فشل:', e.message);
    errors.push('InnerTube: ' + e.message);
  }

  throw new Error('فشلت جميع طرق الاستخراج:\n' + errors.join('\n'));
}

// ─── Routes ───
app.get('/api/transcript', async (req, res) => {
  const input = req.query.v;
  if (!input) return res.status(400).json({ error: 'معرّف الفيديو مطلوب.' });

  const videoId = extractVideoId(input) || input.slice(0, 11);
  console.log(`\n[REQ] ===== ${videoId} =====`);

  try {
    const data = await fetchTranscript(videoId);
    console.log(`[OK] ✅ ${data.raw.split(' ').length} كلمة — ${data.lang}`);
    res.json(data);
  } catch (err) {
    console.error(`[ERR] ❌ ${err.message}`);
    const msg    = err.message || '';
    const status = (msg.includes('لا توجد ترجمة') || msg.includes('لا توجد بيانات')) ? 404
                 : msg.includes('LOGIN_REQUIRED')  ? 403
                 : msg.includes('غير موجود')        ? 404
                 : 500;
    res.status(status).json({ error: msg.split('\n')[0] });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), node: process.version });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ نصّص Backend — بورت ${PORT}`));
