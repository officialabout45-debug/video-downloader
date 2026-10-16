const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Fallback Extractors for TikTok / Social Media
async function fetchTikwmFallback(url) {
    try {
        const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (res.ok) {
            const data = await res.json();
            if (data && data.code === 0 && data.data) {
                return {
                    title: data.data.title || 'TikTok Video',
                    duration: data.data.duration || 0,
                    thumbnail: data.data.cover || '',
                    downloads: [
                        { quality: 'HD (No Watermark)', url: data.data.play, format: 'mp4', extension: 'mp4', should_download: true },
                        { quality: 'Watermarked', url: data.data.wmplay, format: 'mp4', extension: 'mp4', should_download: true },
                        { quality: 'Audio (MP3)', url: data.data.music, format: 'mp3', extension: 'mp3', should_download: true }
                    ]
                };
            }
        }
    } catch (e) {
        console.error('Tikwm fallback error:', e.message);
    }
    return null;
}

// Main Download Endpoint
app.post('/api/download', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'الرجاء إدخال رابط الفيديو' });
    }

    try {
        // محاولة جلب البيانات عبر التابع الاحتياطي
        let result = await fetchTikwmFallback(url);
        
        if (!result) {
            return res.status(500).json({ error: 'عذراً، لم نتمكن من جلب روابط التحميل لهذا الفيديو حالياً.' });
        }

        res.json(result);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500.0).json({ error: 'حدث خطأ أثناء معالجة الطلب' });
    }
});

app.get('/', (req, res) => {
    res.send('Video Downloader API is running successfully!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
