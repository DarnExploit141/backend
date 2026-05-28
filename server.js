const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ─── استخراج JSON من HTML بعد بالعد اليدوي للأقواس (أثبت من regex) ───
function extractJSONObject(html, key) {
  const marker = `"${key}"`;
  let idx = html.indexOf(marker);
  if (idx === -1) {
    // جرب بدون quotes
    const marker2 = `${key} =`;
    idx = html.indexOf(marker2);
    if (idx === -1) return null;
  }
  const start = html.indexOf('{', idx);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escape = false;

  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ─── معرف الفيديو ───
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

// ─── جلب الترجمة ───
async function fetchTranscript(videoId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
  if (!pageRes.ok) throw new Error(`YouTube رفض الطلب: ${pageRes.status}`);
  const html = await pageRes.text();

  // عنوان الفيديو
  let title = null;
  const tm = html.match(/<title>(.+?)<\/title>/);
  if (tm) title = tm[1].replace(' - YouTube', '').trim();

  // استخراج بيانات اللاعب بطريقتين
  let playerData = extractJSONObject(html, 'ytInitialPlayerResponse');

  // طريقة بديلة لو الأولى فشلت
  if (!playerData) {
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{)/);
    if (m) {
      const startIdx = html.indexOf(m[0]) + m[0].length - 1;
      let depth = 0, inStr = false, escape = false;
      for (let i = startIdx; i < html.length; i++) {
        const c = html[i];
        if (escape) { escape = false; continue; }
        if (c === '\\' && inStr) { escape = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            try { playerData = JSON.parse(html.slice(startIdx, i + 1)); } catch {}
            break;
          }
        }
      }
    }
  }

  if (!playerData) {
    // تحقق إن الفيديو موجود أصلاً
    if (html.includes('"playabilityStatus"')) {
      throw new Error('تعذر قراءة بيانات الفيديو — قد يكون خاصاً أو محظوراً في منطقتك.');
    }
    throw new Error('تعذر استخراج بيانات الفيديو من يوتيوب. جرب مرة أخرى.');
  }

  // استخراج مسارات الترجمة
  const captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    // هل الفيديو ممتاز أو مقيّد؟
    const status = playerData?.playabilityStatus?.status;
    if (status === 'LOGIN_REQUIRED' || status === 'UNPLAYABLE') {
      throw new Error('هذا الفيديو مقيّد أو يتطلب تسجيل دخول ولا يمكن استخراج ترجمته.');
    }
    throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.\nتأكد أن الفيديو يحتوي على ترجمة يدوية أو تلقائية.');
  }

  // أفضل ترجمة: عربي → إنجليزي → يدوي → أول واحد
  const track =
    captions.find(t => t.languageCode === 'ar') ||
    captions.find(t => t.languageCode?.startsWith('ar')) ||
    captions.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    captions.find(t => t.languageCode === 'en') ||
    captions.find(t => t.kind !== 'asr') ||
    captions[0];

  // جلب XML الترجمة
  const xmlRes = await fetch(track.baseUrl, { headers });
  if (!xmlRes.ok) throw new Error('فشل تحميل ملف الترجمة من يوتيوب.');
  const xml = await xmlRes.text();

  // استخراج النصوص
  let raw = '';
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const t = match[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').trim();
    if (t) raw += t + ' ';
  }

  if (!raw.trim()) throw new Error('ملف الترجمة موجود لكنه فارغ.');

  return {
    raw: raw.trim(),
    title,
    lang: track.languageCode || 'und',
    langName: track.name?.simpleText || track.languageCode || '؟'
  };
}

// ─── Routes ───
app.get('/api/transcript', async (req, res) => {
  const input = req.query.v;
  if (!input) return res.status(400).json({ error: 'معرّف الفيديو مطلوب.' });

  const videoId = extractVideoId(input) || input;

  try {
    const data = await fetchTranscript(videoId);
    res.json(data);
  } catch (err) {
    console.error('[Error]', videoId, err.message);
    const status = err.message.includes('لا توجد ترجمة') || err.message.includes('مقيّد') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
