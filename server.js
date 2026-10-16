const express = require("express");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");
const https = require("https");
const http = require("http");

const execAsync = promisify(exec);
const PORT = process.env.PORT || 3000;
const app = express();

// Enable CORS for cross-origin frontend requests from Hostinger / direct API access
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

// Lazy downloader for yt-dlp compiled standalone Linux binary
async function ensureYtdl() {
  if (!fs.existsSync(binaryPath)) {
    console.log("[Server] yt-dlp binary not found. Downloading standalone Linux ELF binary...");
    try {
      const response = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux");
      if (!response.ok) {
        throw new Error(`Failed to download yt-dlp: ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      fs.writeFileSync(binaryPath, Buffer.from(buffer));
      fs.chmodSync(binaryPath, "755");
      console.log("[Server] yt-dlp native binary successfully downloaded and configured.");
    } catch (err) {
      console.error("[Server] Error downloading yt-dlp stand-alone binary:", err.message || err);
    }
  }
  return binaryPath;
}

// Function to resolve short URL redirects using native Node fetch
async function resolveUrl(inputUrl) {
  let currentUrl = inputUrl;
  const maxRedirects = 6;
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  
  for (let i = 0; i < maxRedirects; i++) {
    try {
      const response = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        }
      });
      
      const location = response.headers.get("location");
      if (location) {
        if (location.startsWith("/")) {
          const parsedUrl = new URL(currentUrl);
          currentUrl = `${parsedUrl.protocol}//${parsedUrl.host}${location}`;
        } else {
          currentUrl = location;
        }
        console.log(`[Redirect Resolver] Step ${i + 1}: -> ${currentUrl}`);
      } else {
        break;
      }
    } catch (err) {
      console.error(`[Redirect Resolver] Error at step ${i + 1}:`, err);
      break;
    }
  }
  return currentUrl;
}

// Fallback Extractors for TikTok / Douyin
async function fetchTikwmFallback(url) {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (res.ok) {
      const json = await res.json();
      if (json.code === 0 && json.data) {
        const d = json.data;
        return {
          title: d.title || "فيديو تيك توك / دوين",
          duration: d.duration || 0,
          thumbnail: d.cover || "",
          uploader: d.author?.nickname || d.author?.unique_id || "مستخدم تيك توك",
          platform: url.toLowerCase().includes("douyin") ? "Douyin" : "TikTok",
          directUrl: d.play || d.wmplay || "",
          formats: [
            {
              ext: "mp4",
              resolution: "أصلي (بدون علامة مائية)",
              filesize: d.size || null,
              format_id: "no-watermark",
              url: d.play || "",
              has_video: true,
              has_audio: true,
              format_note: "فيديو عالي الدقة"
            },
            {
              ext: "mp3",
              resolution: "صوت فقط",
              filesize: null,
              format_id: "audio-only",
              url: d.music || "",
              has_video: false,
              has_audio: true,
              format_note: "صوت MP3"
            }
          ]
        };
      }
    }
  } catch (err) {
    console.warn("[Fallback API] Tikwm failure:", err.message || err);
  }
  return null;
}

async function fetchTiklydownFallback(url) {
  try {
    const res = await fetch(`https://api.tiklydown.eu.org/v1/api/download?url=${encodeURIComponent(url)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.status === 200 && data.result) {
        const result = data.result;
        return {
          title: result.title || "فيديو تيك توك",
          duration: result.video?.duration || 0,
          thumbnail: result.video?.cover || result.video?.origin_cover || "",
          uploader: result.author?.nickname || "@tiktok",
          platform: "TikTok",
          directUrl: result.video?.noWatermark || result.video?.playAddr || "",
          formats: [
            {
              ext: "mp4",
              resolution: "أصلي بدون علامة مائية",
              filesize: null,
              format_id: "no-watermark",
              url: result.video?.noWatermark || result.video?.playAddr || "",
              has_video: true,
              has_audio: true,
              format_note: "فيديو بجودة عالية"
            }
          ]
        };
      }
    }
  } catch (err) {
    console.warn("[Fallback API] Tiklydown failure:", err.message || err);
  }
  return null;
}

async function searchYouTubeFallback(query) {
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": userAgent,
        "Accept-Language": "ar,en;q=0.9"
      }
    });
    
    if (res.ok) {
      const html = await res.text();
      const matches = html.matchAll(/\/watch\?v=([a-zA-Z0-9_-]{11})/g);
      for (const match of matches) {
        if (match && match[1]) {
          return `https://www.youtube.com/watch?v=${match[1]}`;
        }
      }
    }
  } catch (err) {
    console.error(`[YouTube Search Fallback] Exception:`, err.message || err);
  }
  return null;
}

async function fetchYouTubeOEmbed(url) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl);
    if (res.ok) {
      const data = await res.json();
      return {
        title: data.title || "فيديو يوتيوب",
        uploader: data.author_name || "مستخدم يوتيوب",
        thumbnail: data.thumbnail_url || "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600",
        platform: "YouTube"
      };
    }
  } catch (err) {
    console.warn("[OEmbed Fallback] YouTube metadata failed:", err.message || err);
  }
  return null;
}

async function fetchCobaltFormats(url) {
  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const endpoints = [
    "https://api.cobalt.tools/",
    "https://co.wuk.sh/",
    "https://cobalt.kwiatuszek.dev/",
    "https://cobalt-api.kwiatuszek.dev/",
    "https://co.v99.xyz/"
  ];

  const callCobalt = async (isAudioOnly) => {
    const payloads = [];
    if (isAudio
