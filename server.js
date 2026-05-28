const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// ─── استخراج معرف الفيديو من الرابط ───
function extractVideoId(url) {
  const patterns = [
    /[?&]v=([^&#]{11})/,
    /youtu\.be\/([^?&#]{11})/,
    /embed\/([^?&#]{11})/,
    /shorts\/([^?&#]{11})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return url.length === 11 ? url : null;
}

// ─── جلب الترجمة مباشرة عبر Innertube API (غير رسمي لكن أثبت) ───
async function fetchTranscriptViaInnertube(videoId) {
  // الخطوة 1: جلب صفحة الفيديو لاستخراج API key وبيانات الجلسة
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });

  if (!pageRes.ok) throw new Error('تعذر الوصول إلى يوتيوب');
  const html = await pageRes.text();

  // استخراج عنوان الفيديو
  let title = null;
  const titleMatch = html.match(/<title>(.+?)<\/title>/);
  if (titleMatch) title = titleMatch[1].replace(' - YouTube', '').trim();

  // استخراج ytInitialPlayerResponse
  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:\s*var\s|\s*<\/script>)/);
  if (!playerMatch) throw new Error('تعذر استخراج بيانات الفيديو من يوتيوب');

  let playerData;
  try {
    playerData = JSON.parse(playerMatch[1]);
  } catch (e) {
    throw new Error('تعذر قراءة بيانات الفيديو');
  }

  // استخراج مسارات الترجمة
  const captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.\nتأكد أن الفيديو يحتوي على ترجمة يدوية أو تلقائية.');
  }

  // اختيار أفضل ترجمة: عربي → إنجليزي → أول واحد
  const track =
    captions.find(t => t.languageCode === 'ar') ||
    captions.find(t => t.languageCode?.startsWith('ar')) ||
    captions.find(t => t.languageCode === 'en') ||
    captions.find(t => t.kind !== 'asr') ||
    captions[0];

  // جلب ملف XML للترجمة
  const xmlRes = await fetch(track.baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  });

  if (!xmlRes.ok) throw new Error('فشل تحميل ملف الترجمة');
  const xml = await xmlRes.text();

  // استخراج النصوص من XML
  let raw = '';
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    let t = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\[.*?\]/g, '')
      .trim();
    if (t) raw += t + ' ';
  }

  if (!raw.trim()) throw new Error('ملف الترجمة موجود ولكنه فارغ.');

  return {
    raw: raw.trim(),
    title,
    lang: track.languageCode || 'und',
    langName: track.name?.simpleText || track.languageCode || '?'
  };
}

// ─── Route الرئيسي ───
app.get('/api/transcript', async (req, res) => {
  const input = req.query.v;
  if (!input) {
    return res.status(400).json({ error: 'معرّف الفيديو (Video ID) مطلوب.' });
  }

  const videoId = extractVideoId(input) || input;

  try {
    const data = await fetchTranscriptViaInnertube(videoId);
    res.json(data);
  } catch (error) {
    console.error('[Transcript Error]', error.message);

    const msg = error.message || 'خطأ غير معروف';

    if (msg.includes('ترجمة')) {
      return res.status(404).json({ error: msg });
    }
    res.status(500).json({
      error: `تعذّر استخراج الترجمة: ${msg}`
    });
  }
});

// ─── Health check ───
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── تشغيل السيرفر ───
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
