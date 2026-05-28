const express = require('express');
const cors    = require('cors');

const app = express();

// ─── CORS ───
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'user-token']
}));

// ─── استخراج JSON من HTML بالعد اليدوي للأقواس ───
function extractJSONObject(html, key) {
  const marker = `"${key}"`;
  let idx = html.indexOf(marker);
  if (idx === -1) {
    const marker2 = `${key} =`;
    idx = html.indexOf(marker2);
    if (idx === -1) return null;
  }
  const start = html.indexOf('{', idx);
  if (start === -1) return null;

  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape)          { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"')       { inStr = !inStr; continue; }
    if (inStr)           continue;
    if (c === '{')       depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

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

// ─── تنظيف نص XML (مشترك بين الصيغتين) ───
function decodeXmlText(str) {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&#39;/g,  "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, c => {
      const code = parseInt(c.slice(2, -1));
      return String.fromCharCode(code);
    })
    .replace(/<[^>]+>/g, '')   // إزالة أي tags متبقية
    .replace(/\[.*?\]/g, '')   // إزالة [Music] [Applause] إلخ
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── استخراج النصوص من XML — يدعم كلا صيغتي يوتيوب ───
function parseTranscriptXML(xml) {
  let raw = '';
  let match;

  // ─── الصيغة الأولى: <text start="..." dur="...">نص</text>
  //     (الأكثر شيوعاً في الترجمات اليدوية)
  const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  while ((match = textRegex.exec(xml)) !== null) {
    const t = decodeXmlText(match[1]);
    if (t) raw += t + ' ';
  }

  // ─── إذا فشلت الصيغة الأولى، جرب الصيغة الثانية:
  //     <p t="..." d="...">نص</p>
  //     (تستخدمها الترجمة التلقائية ASR في بعض الأحيان)
  if (!raw.trim()) {
    console.log('[INFO] Trying timedtext <p> format...');
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/g;
    while ((match = pRegex.exec(xml)) !== null) {
      const t = decodeXmlText(match[1]);
      if (t) raw += t + ' ';
    }
  }

  // ─── إذا فشلت الصيغتان، جرب أي span أو s tags داخل الـ XML
  if (!raw.trim()) {
    console.log('[INFO] Trying <s> / <span> fallback format...');
    // بعض الترجمات تستخدم <s p="...">text</s>
    const sRegex = /<s[^>]*>([\s\S]*?)<\/s>/g;
    while ((match = sRegex.exec(xml)) !== null) {
      const t = decodeXmlText(match[1]);
      if (t) raw += t + ' ';
    }
  }

  return raw.trim();
}

// ─── جلب الترجمة من يوتيوب ───
async function fetchTranscript(videoId, userToken) {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  // إضافة توكن Google إن وُجد
  if (userToken) {
    headers['Cookie'] = `access_token=${userToken}`;
  }

  // جلب صفحة الفيديو
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
  if (!pageRes.ok) throw new Error(`YouTube رفض الطلب: ${pageRes.status}`);
  const html = await pageRes.text();

  // عنوان الفيديو
  let title = null;
  const tm  = html.match(/<title>(.+?)<\/title>/);
  if (tm)   title = tm[1].replace(' - YouTube', '').trim();

  // بيانات اللاعب
  let playerData = extractJSONObject(html, 'ytInitialPlayerResponse');

  if (!playerData) {
    if (html.includes('"playabilityStatus"')) {
      throw new Error('تعذر قراءة بيانات الفيديو — قد يكون خاصاً أو مقيّداً في منطقتك.');
    }
    throw new Error('تعذر استخراج بيانات الفيديو من يوتيوب. جرب مرة أخرى.');
  }

  // التحقق من حالة التشغيل
  const playStatus = playerData?.playabilityStatus?.status;
  if (playStatus === 'LOGIN_REQUIRED' || playStatus === 'UNPLAYABLE') {
    throw new Error('هذا الفيديو مقيّد! سجّل دخولك بحساب Google في الموقع لتتمكن من استخراجه.');
  }

  // مسارات الترجمة
  const captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    throw new Error('لا توجد ترجمة متاحة لهذا الفيديو.\nتأكد أن الفيديو يحتوي على ترجمة يدوية أو تلقائية.');
  }

  console.log(`[INFO] وُجد ${captions.length} مسار ترجمة للفيديو ${videoId}`);
  captions.forEach((t, i) => console.log(`  [${i}] ${t.languageCode} — ${t.name?.simpleText} — kind: ${t.kind || 'manual'}`));

  // اختيار أفضل مسار: عربي → إنجليزي يدوي → إنجليزي → أول واحد
  const track =
    captions.find(t => t.languageCode === 'ar') ||
    captions.find(t => t.languageCode?.startsWith('ar')) ||
    captions.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
    captions.find(t => t.languageCode === 'en') ||
    captions.find(t => t.kind !== 'asr') ||
    captions[0];

  console.log(`[INFO] استخدام مسار: ${track.languageCode} — ${track.name?.simpleText}`);

  // جلب XML الترجمة
  // نجرب الرابط الأصلي أولاً، ثم نضيف fmt=json3 كبديل
  let xml = '';

  try {
    const xmlRes = await fetch(track.baseUrl, { headers });
    if (!xmlRes.ok) throw new Error(`HTTP ${xmlRes.status}`);
    xml = await xmlRes.text();
    console.log(`[INFO] حجم XML: ${xml.length} حرف`);
  } catch (e) {
    throw new Error(`فشل تحميل ملف الترجمة من يوتيوب: ${e.message}`);
  }

  // محاولة JSON3 إذا كان XML فارغاً أو مختلفاً
  if (!xml || xml.length < 50) {
    try {
      const jsonUrl  = track.baseUrl + '&fmt=json3';
      const jsonRes  = await fetch(jsonUrl, { headers });
      const jsonData = await jsonRes.json();
      // استخراج النصوص من صيغة JSON3
      if (jsonData.events) {
        xml = jsonData.events
          .filter(e => e.segs)
          .map(e => e.segs.map(s => s.utf8 || '').join(''))
          .filter(t => t.trim() && t !== '\n')
          .join(' ');
        console.log('[INFO] استُخدمت صيغة JSON3 بنجاح');
        return {
          raw:      xml.trim(),
          title,
          lang:     track.languageCode || 'und',
          langName: track.name?.simpleText || track.languageCode || '؟'
        };
      }
    } catch (e) {
      console.warn('[WARN] فشلت صيغة JSON3:', e.message);
    }
  }

  // تحليل XML
  const raw = parseTranscriptXML(xml);

  if (!raw) {
    // طباعة أول 500 حرف من XML لمساعدة التشخيص
    console.error('[DEBUG] XML preview:', xml.slice(0, 500));
    throw new Error('ملف الترجمة موجود لكن تعذّر قراءته — قد يكون بصيغة غير مدعومة. جرب فيديو آخر أو أبلغنا بالرابط.');
  }

  return {
    raw:      raw,
    title,
    lang:     track.languageCode || 'und',
    langName: track.name?.simpleText || track.languageCode || '؟'
  };
}

// ─── Routes ───
app.get('/api/transcript', async (req, res) => {
  const input     = req.query.v;
  const userToken = req.headers['user-token'];

  if (!input) return res.status(400).json({ error: 'معرّف الفيديو مطلوب.' });

  const videoId = extractVideoId(input) || input;
  console.log(`[REQ] استخراج ترجمة: ${videoId}`);

  try {
    const data = await fetchTranscript(videoId, userToken);
    console.log(`[OK] نجح الاستخراج — ${data.raw.split(' ').length} كلمة`);
    res.json(data);
  } catch (err) {
    console.error(`[ERR] ${videoId} — ${err.message}`);
    const status = (err.message.includes('مقيّد') || err.message.includes('تسجيل')) ? 403 :
                   (err.message.includes('لا توجد ترجمة'))                           ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ نصّص Backend — شغّال على بورت ${PORT}`));
