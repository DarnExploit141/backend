const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// تفعيل الـ CORS للسماح لموقعك على GitHub Pages بالاتصال بالسيرفر بأمان
app.use(cors());

app.get('/api/transcript', async (req, res) => {
    const videoId = req.query.v;
    if (!videoId) {
        return res.status(400).json({ error: 'معرّف الفيديو (Video ID) مطلوب.' });
    }

    try {
        // 1. جلب صفحة الفيديو من يوتيوب مع إرسال وكيل مستخدم (User-Agent) حديث لتبدو كطلب طبيعي
        const ytRes = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8'
            }
        });
        const html = ytRes.data;

        // 2. استخراج عنوان الفيديو
        let title = null;
        const tm = html.match(/<title>(.+?)<\/title>/);
        if (tm) title = tm[1].replace(' - YouTube', '').trim();

        // 3. استخراج مسارات الترجمة (Caption Tracks)
        const tm2 = html.match(/"captionTracks":(\[[\s\S]*?\])/);
        if (!tm2) {
            return res.status(440).json({ error: 'لا توجد ترجمة متاحة لهذا الفيديو علنياً.\nتأكد أن الفيديو يحتوي على ترجمة يدوية أو تلقائية.' });
        }

        const tracks = JSON.parse(tm2[1]);
        if (!tracks || tracks.length === 0) {
            return res.status(440).json({ error: 'لا توجد ترجمة لهذا الفيديو.' });
        }

        // تحديد أفضل ترجمة متوفرة (العربية أولاً، ثم الإنجليزية، ثم أول خيار متاح)
        const track = tracks.find(t => t.languageCode === 'ar') ||
                      tracks.find(t => t.languageCode && t.languageCode.startsWith('ar')) ||
                      tracks.find(t => t.languageCode === 'en') ||
                      tracks[0];

        // 4. جلب ملف الترجمة الفعلي (XML) من رابط يوتيوب المباشر
        const xmlRes = await axios.get(track.baseUrl);
        const xml = xmlRes.data;

        // 5. معالجة الـ XML واستخراج النصوص البرمجية وتنظيفها
        let raw = '';
        const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
        let match;
        while ((match = regex.exec(xml)) !== null) {
            let t = match[1]
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
                .replace(/<[^>]+>/g, '').replace(/\[.*?\]/g, '').trim();
            if (t) raw += t + ' ';
        }

        if (!raw.trim()) {
            return res.status(440).json({ error: 'ملف الترجمة موجود ولكنه فارغ.' });
        }

        // إرجاع النتيجة النهائية متوافقة تماماً مع ما يتوقعه موقعك
        res.json({
            raw: raw.trim(),
            title,
            lang: track.languageCode || 'und',
            langName: track.name?.simpleText || track.languageCode || '?'
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'تعذّر الاتصال بيوتيوب عبر السيرفر الخارجي. يرجى المحاولة لاحقاً.' });
    }
});

// تشغيل السيرفر على المنفذ الموفر من Railway تلقائياً
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
