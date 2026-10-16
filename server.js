const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function fetchCobaltFormats(url) {
  const endpoints = ["https://api.cobalt.tools/", "https://co.wuk.sh/"];
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
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
  if (!url) {
    return res.status(400).json({ error: "الرابط مطلوب" });
  }

  const targetUrl = url.trim();
  const directUrl = await fetchCobaltFormats(targetUrl);

  if (directUrl) {
    return res.json({
      title: "فيديو تواصل اجتماعي",
      thumbnail: "",
      directUrl: directUrl,
      formats: [{ url: directUrl, ext: "mp4", resolution: "HD" }],
      originalUrl: targetUrl
    });
  }

  return res.status(500).json({ error: "تعذر استخراج بيانات الفيديو، يرجى المحاولة لاحقاً." });
});

app.get("/", (req, res) => {
  res.status(200).json({ status: "online", message: "Video Downloader API is running smoothly on Vercel!" });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
