import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const PORT = process.env.PORT || 3000;
const app = express();

// Enable CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "X-Requested-With,content-type,Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

const binaryPath = path.join(__dirname, "yt-dlp");

async function ensureYtdl() {
  if (!fs.existsSync(binaryPath)) {
    try {
      const response = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux");
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(binaryPath, Buffer.from(buffer));
        fs.chmodSync(binaryPath, "755");
      }
    } catch (err) {}
  }
  return binaryPath;
}

async function fetchCobaltFormats(url) {
  const endpoints = ["https://api.cobalt.tools/", "https://co.wuk.sh/"];
  const callCobalt = async (isAudioOnly) => {
    const payload = isAudioOnly ? { url, downloadMode: "audio" } : { url, downloadMode: "video" };
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const json = await res.json();
          if (json.url) return json.url;
        }
      } catch (err) {}
    }
    return null;
  };
  const [videoUrl, audioUrl] = await Promise.all([callCobalt(false), callCobalt(true)]);
  return { videoUrl, audioUrl };
}

app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "الرابط مطلوب" });
  
  let targetUrl = url.trim();

  try {
    const ytdlExecutable = await ensureYtdl();
    const { stdout } = await execAsync(`"${ytdlExecutable}" -j "${targetUrl}"`, { timeout: 15000 });
    if (stdout.trim()) {
      const info = JSON.parse(stdout);
      return res.json({
        title: info.title || "فيديو",
        thumbnail: info.thumbnail || "",
        duration: info.duration || 0,
        uploader: info.uploader || "مجهول",
        platform: info.extractor || "YouTube",
        directUrl: info.url || "",
        formats: info.formats?.map(f => ({ url: f.url, ext: f.ext, resolution: f.resolution })) || [],
        originalUrl: targetUrl
      });
    }
  } catch (err) {}

  const cobalt = await fetchCobaltFormats(targetUrl);
  if (cobalt.videoUrl) {
    return res.json({
      title: "فيديو تواصل اجتماعي",
      thumbnail: "",
      directUrl: cobalt.videoUrl,
      formats: [{ url: cobalt.videoUrl, ext: "mp4", resolution: "HD" }],
      originalUrl: targetUrl
    });
  }

  return res.status(500).json({ error: "تعذر استخراج بيانات الفيديو" });
});

app.get("/", (req, res) => {
  res.json({ status: "online", message: "Video Downloader Server API is running smoothly!" });
});

// Local listen support
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, "0.0.0.0", async () => {
    await ensureYtdl();
    console.log(`Server running on port ${PORT}`);
  });
}

export default app;
