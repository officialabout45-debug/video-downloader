import express from 'express';
import cors from 'cors';

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
      const json = await res.json();
      if (json.code === 0 && json.data) {
        const d = json.data;
        return {
          title: d.title || "فيديو تيك توك",
          duration: d.duration || 0,
          thumbnail: d.cover || "",
          uploader: d.author?.nickname || "مستخدم",
          platform: "TikTok",
          directUrl: d.play || d.wmplay || "",
          formats: [{ ext: "mp4", resolution: "HD", url: d.play || "" }]
        };
      }
    }
  } catch (err) {}
  return null;
}

async function fetchCobaltFormats(url) {
  const endpoints = ["https://api.cobalt.tools/", "https://co.wuk.sh/"];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ url, downloadMode: "video" })
      });
      if (res.ok) {
        const json = await res.json();
        if (json.url) return json.url;
      }
    } catch (err) {}
  }
  return null;
}

app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "الرابط مطلوب" });

  const targetUrl = url.trim();

  // فحص إذا كان الرابط يخص تيك توك
  if (targetUrl.includes("tiktok.com") || targetUrl.includes("douyin.com")) {
    const tiktokData = await fetchTikwmFallback(targetUrl);
    if (tiktokData) return res.json(tiktokData);
  }

  // الاستخراج العام عبر Cobalt
  const directUrl = await fetchCobaltFormats(targetUrl);
  if (directUrl) {
    return res.json({
      title: "فيديو مستخرج بنجاح",
      thumbnail: "",
      directUrl: directUrl,
      formats: [{ url: directUrl, ext: "mp4", resolution: "HD" }],
      originalUrl: targetUrl
    });
  }

  return res.status(500).json({ error: "تعذر استخراج بيانات الفيديو، يرجى التأكد من الرابط." });
});

app.get("/", (req, res) => {
  res.json({ status: "online", message: "Video Downloader Server API is running smoothly!" });
});

export default app;
