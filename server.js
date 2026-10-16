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
      // Keep going, other APIs might succeed even if yt-dlp fails
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

// Fallback Extractors for TikTok / Douyin (extremely reliable & avoids Cloud Run IP bans)
async function fetchTikwmFallback(url) {
  try {
    console.log(`[Fallback API] Trying Tikwm extraction for url: ${url}`);
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
    console.log(`[Fallback API] Trying Tiklydown extraction for url: ${url}`);
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

// Scrape YouTube search results from public web page to bypass yt-dlp search blocking
async function searchYouTubeFallback(query) {
  try {
    console.log(`[YouTube Search Fallback] Searching for: ${query}`);
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
          const videoId = match[1];
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
          console.log(`[YouTube Search Fallback] Found video URL: ${videoUrl}`);
          return videoUrl;
        }
      }
    }
  } catch (err) {
    console.error(`[YouTube Search Fallback] Exception:`, err.message || err);
  }
  return null;
}

// Fetch YouTube Metadata via oEmbed (unblocked and doesn't require API Keys)
async function fetchYouTubeOEmbed(url) {
  try {
    console.log(`[OEmbed Fallback] Fetching metadata for URL: ${url}`);
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

// Fetch high-speed bypass streaming downloads for YouTube and social links via Cobalt API (very reliable)
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
    if (isAudioOnly) {
      payloads.push({ url, downloadMode: "audio", audioFormat: "mp3", audioBitrate: "320" });
      payloads.push({ url, isAudioOnly: true, audioFormat: "mp3" });
      payloads.push({ url, downloadMode: "audio" });
      payloads.push({ url, isAudioOnly: true });
    } else {
      payloads.push({ url, downloadMode: "video", videoQuality: "1080" });
      payloads.push({ url, isAudioOnly: false, videoQuality: "1080" });
      payloads.push({ url });
    }

    for (const endpoint of endpoints) {
      for (let pIdx = 0; pIdx < payloads.length; pIdx++) {
        const payload = payloads[pIdx];
        try {
          console.log(`[Cobalt API] Querying endpoint: ${endpoint} for url: ${url} (Audio Only: ${isAudioOnly})`);
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Accept": "application/json",
              "Content-Type": "application/json",
              "User-Agent": userAgent,
              "Origin": "https://cobalt.tools",
              "Referer": "https://cobalt.tools/"
            },
            body: JSON.stringify(payload)
          });
          
          if (response.ok) {
            const json = await response.json();
            if (json.status === "stream" || json.status === "redirect") {
              return json.url;
            } else if (json.status === "picker" && Array.isArray(json.picker)) {
              return json.picker[0]?.url || "";
            } else if (json.url) {
              return json.url;
            }
          }
        } catch (err) {
          // Silent error handling to move to next endpoints
        }
      }
    }
    return null;
  };

  try {
    const [videoUrl, audioUrl] = await Promise.all([
      callCobalt(false),
      callCobalt(true)
    ]);
    return { videoUrl, audioUrl };
  } catch (err) {
    console.error("[Cobalt Fallback Engine] Cobalt query failed:", err);
    return { videoUrl: null, audioUrl: null };
  }
}

function normalizeBackendApiResponse(data, originalUrl) {
  if (!data) return null;
  
  const title = data.title || data.video_title || data.videoTitle || "فيديو تواصل اجتماعي";
  const thumbnail = data.thumbnail || data.video_thumbnail || data.thumb || data.picture || "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600";
  const duration = data.duration || data.video_duration || 0;
  const uploader = data.uploader || data.video_uploader || data.author || data.author_name || "مجهول";
  const platform = data.platform || data.site || data.source || "منصة تواصل";
  
  const directUrl = data.directUrl || data.direct_url || data.downloadUrl || data.download_url || data.url || "";
  
  let formats = data.formats || [];
  if (!Array.isArray(formats) && (data.links || data.download_links)) {
    const rawLinks = data.links || data.download_links;
    if (Array.isArray(rawLinks)) {
      formats = rawLinks.map((link) => ({
        url: link.url || link.link || link,
        ext: link.ext || link.extension || "mp4",
        resolution: link.resolution || link.quality || "720p",
        has_video: link.has_video !== undefined ? link.has_video : true,
        has_audio: link.has_audio !== undefined ? link.has_audio : true,
        format_note: link.note || link.format_note || "فيديو"
      }));
    } else if (typeof rawLinks === "object") {
      formats = Object.entries(rawLinks).map(([quality, linkUrl]) => ({
        url: typeof linkUrl === "string" ? linkUrl : (linkUrl.url || linkUrl.link || ""),
        ext: "mp4",
        resolution: quality,
        has_video: true,
        has_audio: true,
        format_note: `جودة ${quality}`
      }));
    }
  }

  if (formats.length === 0 && directUrl) {
    formats.push({
      url: directUrl,
      ext: "mp4",
      resolution: "720p",
      has_video: true,
      has_audio: true,
      format_note: "تحميل مباشر"
    });
  }

  const audioUrl = data.audioUrl || data.audioColor || data.audio || data.mp3 || "";
  if (audioUrl) {
    formats.push({
      url: audioUrl,
      ext: "mp3",
      resolution: "audio",
      has_video: false,
      has_audio: true,
      format_note: "صوت فقط"
    });
  }

  return {
    title,
    thumbnail,
    duration,
    uploader,
    platform,
    directUrl,
    formats,
    originalUrl
  };
}

// API Route: Extract metadata and video download links of a given url
app.post("/api/info", async (req, res) => {
  const { url } = req.body;
  
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "يرجى تزويدنا برابط فيديو صالح أو كلمة بحث." });
  }

  // A. Proxy directly to the live custom production API first
  try {
    // Resolve incoming credentials dynamically from client headers, falling back to server env secrets
    const authHeader = req.headers["authorization"];
    const incomingKey = typeof authHeader === "string" ? authHeader.replace(/^Bearer\s+/i, "") : "";
    const geminiApiKey = (typeof req.headers["x-goog-api-key"] === "string" ? req.headers["x-goog-api-key"] : "") || 
                         incomingKey || 
                         process.env.GEMINI_API_KEY || 
                         process.env.VITE_GOOGLE_API_KEY || 
                         "";

    const apiResponse = await fetch("https://downloader.mfastai.com/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${geminiApiKey}`,
      },
      body: JSON.stringify({ url: url.trim() })
    });

    if (apiResponse.ok) {
      const apiData = await apiResponse.json();
      const normalizedData = normalizeBackendApiResponse(apiData, url.trim());
      if (normalizedData) {
        return res.json(normalizedData);
      }
    }
  } catch (apiErr) {
    console.error(`[Server Proxy] Live production API extraction failed:`, apiErr.message || apiErr);
  }

  // 1. Resolve redirect to find final destination URL if shortened link
  let targetUrl = url.trim().replace(/\s+/g, "");
  let isSearch = false;
  const originalQuery = url.trim();

  let isUrl = false;
  if (/^https?:\/\//i.test(targetUrl)) {
    isUrl = true;
  } else {
    const hasDot = targetUrl.includes(".");
    const hasSpaces = /\s/.test(targetUrl);
    const hasMajorPlatform = /youtube\.com|youtu\.be|tiktok\.com|douyin\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|bilibili\.com|kuaishou\.com|weibo\.com/i.test(targetUrl);
    
    if ((hasDot && !hasSpaces) || hasMajorPlatform) {
      isUrl = true;
      targetUrl = `https://${targetUrl}`;
    }
  }

  if (!isUrl) {
    isSearch = true;
    const resolvedUrl = await searchYouTubeFallback(targetUrl);
    if (resolvedUrl) {
      targetUrl = resolvedUrl;
    } else {
      targetUrl = `ytsearch1:${targetUrl}`;
    }
  } else {
    const isMajorPlatform = /youtube\.com|youtu\.be|tiktok\.com|douyin\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|bilibili\.com|kuaishou\.com|weibo\.com/i.test(targetUrl);
    if (!isMajorPlatform) {
      try {
        targetUrl = await resolveUrl(targetUrl);
      } catch (err) {
        console.error(`[Server] Error resolving url redirects:`, err);
      }
    }
  }

  const lowerUrl = targetUrl.toLowerCase();
  const isYouTube = lowerUrl.includes("youtube.com") || lowerUrl.includes("youtu.be") || lowerUrl.includes("ytsearch");
  const isTikTokOrDouyin = lowerUrl.includes("tiktok.com") || lowerUrl.includes("douyin.com");
  const isInstagram = lowerUrl.includes("instagram.com");
  const isFacebook = lowerUrl.includes("facebook.com") || lowerUrl.includes("fb.watch");
  const isTwitter = lowerUrl.includes("twitter.com") || lowerUrl.includes("x.com");

  if (isTikTokOrDouyin) {
    let data = await fetchTikwmFallback(targetUrl);
    if (!data) {
      data = await fetchTiklydownFallback(targetUrl);
    }
    if (data) {
      return res.json(data);
    }
  }

  let finalTitle = isSearch ? originalQuery : "فيديو تواصل اجتماعي";
  let finalDuration = 0;
  let finalThumbnail = "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?q=80&w=600";
  let finalUploader = "مجهول";
  let finalPlatform = "منصة تواصل";
  let directUrl = "";
  let formats = [];

  let ytdlSuccess = false;
  let ytdlInfo = null;

  try {
    const ytdlExecutable = await ensureYtdl();
    const escapedUrl = targetUrl.replace(/"/g, '\\"');
    const cmd = `"${ytdlExecutable}" -j --no-playlist --no-warnings --no-check-certificates --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --referer "https://www.google.com/" "${escapedUrl}"`;
    
    const { stdout } = await execAsync(cmd, { timeout: 20000 });
    if (stdout.trim()) {
      ytdlInfo = JSON.parse(stdout);
      ytdlSuccess = true;
    }
  } catch (err) {
    console.warn(`[Server] yt-dlp metadata query failed or blocked:`, err.message || err);
  }

  let cobaltStreams = null;
  const targetIsQueryUrl = targetUrl.toLowerCase().startsWith("http://") || targetUrl.toLowerCase().startsWith("https://");
  if (targetIsQueryUrl && (isYouTube || isInstagram || isFacebook || isTwitter || !ytdlSuccess)) {
    cobaltStreams = await fetchCobaltFormats(targetUrl);
  }

  if (ytdlSuccess && ytdlInfo) {
    finalTitle = ytdlInfo.title || finalTitle;
    finalDuration = ytdlInfo.duration || 0;
    finalThumbnail = ytdlInfo.thumbnail || ytdlInfo.thumbnails?.[0]?.url || finalThumbnail;
    finalUploader = ytdlInfo.uploader || ytdlInfo.channel || ytdlInfo.creator || finalUploader;
    finalPlatform = ytdlInfo.extractor_key || ytdlInfo.extractor || finalPlatform;
    directUrl = ytdlInfo.url || "";

    if (Array.isArray(ytdlInfo.formats)) {
      formats = ytdlInfo.formats
        .filter((f) => f.url && (f.vcodec !== "none" || f.acodec !== "none"))
        .map((f) => {
          const resolution = f.resolution || (f.width && f.height ? `${f.width}x${f.height}` : null) || f.format_note || "?";
          const ext = f.ext || "mp4";
          const hasVideo = f.vcodec !== "none";
          const hasAudio = f.acodec !== "none";
          
          let formatNote = "";
          if (hasVideo && hasAudio) formatNote = "فيديو مع صوت";
          else if (hasVideo) formatNote = "فيديو فقط (بدون صوت)";
          else if (hasAudio) formatNote = "صوت فقط";
          
          return {
            ext,
            resolution,
            filesize: f.filesize || f.filesize_approx || null,
            format_id: f.format_id,
            url: f.url,
            has_video: hasVideo,
            has_audio: hasAudio,
            format_note: formatNote
          };
        });

      if (!directUrl) {
        const bestCombined = ytdlInfo.formats.find((f) => f.url && f.vcodec !== "none" && f.acodec !== "none");
        if (bestCombined) {
          directUrl = bestCombined.url;
        } else {
          const firstWithUrl = ytdlInfo.formats.find((f) => f.url);
          if (firstWithUrl) directUrl = firstWithUrl.url;
        }
      }
    }
  } else {
    if (isYouTube && targetIsQueryUrl) {
      const oembedMeta = await fetchYouTubeOEmbed(targetUrl);
      if (oembedMeta) {
        finalTitle = oembedMeta.title;
        finalUploader = oembedMeta.uploader;
        finalThumbnail = oembedMeta.thumbnail;
        finalPlatform = oembedMeta.platform;
      }
    } else {
      if (isInstagram) finalPlatform = "Instagram";
      else if (isFacebook) finalPlatform = "Facebook";
      else if (isTwitter) finalPlatform = "Twitter / X";
    }
  }

  if (cobaltStreams) {
    if (cobaltStreams.videoUrl) {
      directUrl = cobaltStreams.videoUrl;
      formats.unshift({
        ext: "mp4",
        resolution: "عالي الدقة (تحميل مباشر)",
        filesize: null,
        format_id: "cobalt-video",
        url: cobaltStreams.videoUrl,
        has_video: true,
        has_audio: true,
        format_note: "فيديو بجودة عالية كاملة (أفضل خيار وبث مباشر)"
      });
    }

    if (cobaltStreams.audioUrl) {
      formats.push({
        ext: "mp3",
        resolution: "صوت فقط (تحميل مباشر)",
        filesize: null,
        format_id: "cobalt-audio",
        url: cobaltStreams.audioUrl,
        has_video: false,
        has_audio: true,
        format_note: "صوت MP3 عالي الجودة"
      });
    }
  }

  if (!directUrl && formats.length === 0) {
    if (finalTitle || finalThumbnail) {
      let youtubeId = null;
      const ytMatch = targetUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|shorts\/|watch\?v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (ytMatch) {
         youtubeId = ytMatch[1];
      }
      
      return res.json({
        title: finalTitle,
        duration: finalDuration,
        thumbnail: finalThumbnail,
        uploader: finalUploader,
        platform: finalPlatform,
        directUrl: "",
        formats: [],
        requiresClientBypass: true,
        originalUrl: targetUrl,
        youtubeId
      });
    }

    return res.status(500).json({
      error: "تعذر الحصول على روابط تحميل مباشرة لهذه المنصة. الرجاء المحاولة مجدداً أو لصق رابط أخر."
    });
  }

  return res.json({
    title: finalTitle,
    duration: finalDuration,
    thumbnail: finalThumbnail,
    uploader: finalUploader,
    platform: finalPlatform,
    directUrl,
    formats,
    originalUrl: targetUrl
  });
});

// API Route: Trigger download processing server-side via Savenow.to (bypasses bot locks)
app.get("/api/trigger-download", async (req, res) => {
  const targetUrl = req.query.url;
  const format = req.query.format || "720";
  
  if (!targetUrl) {
    return res.status(400).json({ error: "الرابط مطلوب" });
  }

  const domains = ["p.savenow.to", "p.lbserver.xyz"];
  
  for (const domain of domains) {
    try {
      const triggerUrl = `https://${domain}/api/v2/download?button=1&start=1&end=1&format=${format}&iframe_source=direct-iframe&url=${encodeURIComponent(targetUrl)}`;
      console.log(`[Server] Triggering conversion on Savenow Domain [${domain}]: ${triggerUrl}`);
      
      const response = await fetch(triggerUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://loader.to/",
          "Origin": "https://loader.to"
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.id) {
          return res.json({
            id: data.id,
            progress_url: data.progress_url || `https://${domain}/api/progress?id=${data.id}`,
            text: data.text || "Preparing conversion",
            domain: domain
          });
        }
      }
    } catch (err) {
      console.error(`[Server] Trigger failed for domain ${domain}:`, err.message || err);
    }
  }

  return res.status(500).json({ error: "فشل التحميل المباشر. يرجى استخدام الخوادم البديلة بالأسفل." });
});

// API Route: Poll conversion status server-side (avoids client CORS errors)
app.get("/api/check-progress", async (req, res) => {
  const id = req.query.id;
  const progressUrl = req.query.progress_url;

  if (!id) {
    return res.status(400).json({ error: "معرف الطلب مطلوب" });
  }

  const targetCheckUrl = progressUrl || `https://p.savenow.to/api/progress?id=${id}`;

  try {
    const response = await fetch(targetCheckUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://loader.to/",
        "Origin": "https://loader.to"
      }
    });

    if (response.ok) {
      const data = await response.json();
      return res.json(data);
    } else {
      const otherCheckUrl = targetCheckUrl.includes("p.savenow.to") 
        ? `https://p.lbserver.xyz/api/progress?id=${id}` 
        : `https://p.savenow.to/api/progress?id=${id}`;
        
      const response2 = await fetch(otherCheckUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://loader.to/",
          "Origin": "https://loader.to"
        }
      });
      
      if (response2.ok) {
        const data = await response2.json();
        return res.json(data);
      }
    }
  } catch (err) {
    console.error("[Server] Check progress exception:", err.message || err);
  }

  return res.status(500).json({ error: "فشل في تحديث حالة التنزيل." });
});

// API Route: Stream video chunks directly to the client to avoid CORS and force saving
app.get("/api/stream-proxy", async (req, res) => {
  const videoUrl = req.query.url;
  const filename = req.query.filename || "video.mp4";
  
  if (!videoUrl) {
    return res.status(400).send("رابط الفيديو غير موجود");
  }
  
  try {
    const protocol = videoUrl.startsWith("https") ? https : http;
    const requestOptions = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    };

    protocol.get(videoUrl, requestOptions, (remoteResponse) => {
      const statusCode = remoteResponse.statusCode || 200;
      
      if (statusCode >= 300 && statusCode < 400 && remoteResponse.headers.location) {
        const redirectUrl = remoteResponse.headers.location;
        const redirectProtocol = redirectUrl.startsWith("https") ? https : http;
        
        redirectProtocol.get(redirectUrl, requestOptions, (redirRes) => {
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
          
          let resolvedContentType = "video/mp4";
          const lowerFilename = filename.toLowerCase();
          if (lowerFilename.endsWith(".mp3")) {
            resolvedContentType = "audio/mpeg";
          } else if (lowerFilename.endsWith(".m4a")) {
            resolvedContentType = "audio/mp4";
          } else if (lowerFilename.endsWith(".webm")) {
            resolvedContentType = redirRes.headers["content-type"]?.startsWith("video/") ? "video/webm" : "audio/webm";
          } else if (lowerFilename.endsWith(".wav")) {
            resolvedContentType = "audio/wav";
          }

          const remoteContentType = redirRes.headers["content-type"];
          if (remoteContentType && remoteContentType !== "application/octet-stream" && !(lowerFilename.endsWith(".mp3") && remoteContentType.startsWith("video/"))) {
            res.setHeader("Content-Type", remoteContentType);
          } else {
            res.setHeader("Content-Type", resolvedContentType);
          }

          if (redirRes.headers["content-length"]) {
            res.setHeader("Content-Length", redirRes.headers["content-length"]);
          }
          redirRes.pipe(res);
        }).on("error", (err) => {
          res.status(500).send("فشل في دفق محتوى الفيديو.");
        });
        return;
      }

      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
      
      let resolvedContentType = "video/mp4";
      const lowerFilename = filename.toLowerCase();
      if (lowerFilename.endsWith(".mp3")) {
        resolvedContentType = "audio/mpeg";
      } else if (lowerFilename.endsWith(".m4a")) {
        resolvedContentType = "audio/mp4";
      } else if (lowerFilename.endsWith(".webm")) {
        resolvedContentType = remoteResponse.headers["content-type"]?.startsWith("video/") ? "video/webm" : "audio/webm";
      } else if (lowerFilename.endsWith(".wav")) {
        resolvedContentType = "audio/wav";
      }

      const remoteContentType = remoteResponse.headers["content-type"];
      if (remoteContentType && remoteContentType !== "application/octet-stream" && !(lowerFilename.endsWith(".mp3") && remoteContentType.startsWith("video/"))) {
        res.setHeader("Content-Type", remoteContentType);
      } else {
        res.setHeader("Content-Type", resolvedContentType);
      }
      
      if (remoteResponse.headers["content-length"]) {
        res.setHeader("Content-Length", remoteResponse.headers["content-length"]);
      }
      
      remoteResponse.pipe(res);
    }).on("error", (err) => {
      res.status(500).send("خطأ أثناء تحويل دفق الفيديو.");
    });
  } catch (err) {
    res.status(500).send("حصل خطأ خارجي أثناء التحميل.");
  }
});

// Serve frontend static production files if raised directly
const distPath = path.join(__dirname, "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.json({ status: "online", message: "Social Media Video Downloader Server API is running with CORS enabled. Ready to serve!" });
  });
}

app.listen(PORT, "0.0.0.0", async () => {
  await ensureYtdl();
  console.log(`[Hostinger CJS Server] Running smoothly on port: ${PORT}`);
});
