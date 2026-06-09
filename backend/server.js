import express from 'express';
import cors from 'cors';
import { exec, spawn } from 'child_process';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const archiver = require('archiver');
const axios = require('axios');
// Restart trigger

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const PUBLIC_SITE_ORIGIN = (process.env.PUBLIC_SITE_ORIGIN || '').trim(); // e.g. https://example.com

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '2mb' }));

// ─── Paths (ESM-safe __dirname) ────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIST = path.resolve(__dirname, '..', 'frontend', 'dist');
const PUBLIC_DATA_DIR = path.resolve(__dirname, 'public-data');
const CHANNEL_DATA_DIR = path.join(PUBLIC_DATA_DIR, 'channels');
const PLAYLIST_DATA_DIR = path.join(PUBLIC_DATA_DIR, 'playlists');

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait 15 minutes.' },
});
app.use('/api', limiter);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(input) {
  if (!input || typeof input !== 'string') return null;
  const t = input.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return t.length === 0 || t.length > 500 ? null : t;
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function originFromReq(req) {
  if (PUBLIC_SITE_ORIGIN) return PUBLIC_SITE_ORIGIN.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0];
  return host ? `${proto}://${host}` : '';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractVideoId(url) {
  try {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|shorts\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  } catch (_) { return null; }
}

function resolveChannelUrl(input, suffix = '/videos') {
  if (/^(www\.)?youtube\.com/i.test(input) || /^youtu\.be/i.test(input)) {
    if (!input.startsWith('http')) input = 'https://' + input;
  }
  if (input.startsWith('http')) {
    try {
      const u = new URL(input);
      if (u.hostname === 'youtu.be' || u.pathname === '/watch' || u.pathname.startsWith('/embed') || u.pathname.match(/^\/(v|shorts)\//)) {
        throw new Error('Please provide a channel URL or handle, not a video URL.');
      }
      let p = u.pathname.replace(/\/(videos|shorts|streams)$/, '');
      return `https://www.youtube.com${p}${suffix}`;
    } catch (err) { 
      if (err.message.includes('channel URL')) throw err;
      throw new Error('Invalid URL'); 
    }
  }
  if (input.startsWith('@')) return `https://www.youtube.com/${input}${suffix}`;
  return `https://www.youtube.com/@${input}${suffix}`;
}

function extractChannelHandle(input) {
  if (!input || typeof input !== 'string') return null;
  const t = input.trim();
  const handleMatch = t.match(/@([a-zA-Z0-9._-]{3,})/);
  if (handleMatch) return handleMatch[1].toLowerCase();
  try {
    const u = new URL(t.startsWith('http') ? t : `https://www.youtube.com/${t.replace(/^\//, '')}`);
    const m = u.pathname.match(/\/@([a-zA-Z0-9._-]{3,})/);
    if (m) return m[1].toLowerCase();
  } catch (_) {}
  return null;
}

function extractPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  const t = input.trim();
  try {
    const u = new URL(t);
    const id = u.searchParams.get('list');
    return id ? id.trim() : null;
  } catch (_) {
    return null;
  }
}

// For playlists/channels: use spawn to stream line-by-line JSON entries
function ytdlpFlatList(url, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
      '--socket-timeout', '30',
      url,
    ]);

    const videos = [];
    let stderrBuf = '';
    let buf = '';
    let settled = false;

    // Hard kill if yt-dlp hangs beyond timeout
    const timer = setTimeout(() => {
      if (!settled) {
        proc.kill('SIGKILL');
        settled = true;
        if (videos.length > 0) {
          resolve(videos); // return partial results
        } else {
          reject(new Error('yt-dlp timed out. Try a smaller channel or playlist.'));
        }
      }
    }, timeout);

    proc.stdout.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t);
          const id = e.id || '';
          videos.push({
            videoId: id,
            title: e.title || 'Untitled',
            url: id.startsWith('http') ? id : `https://www.youtube.com/watch?v=${id}`,
            thumbnail: e.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''),
            duration: e.duration || null,
            uploadDate: e.upload_date || null,
            viewCount: e.view_count || null,
          });
        } catch (_) {}
      }
    });

    proc.stderr.on('data', c => { stderrBuf += c.toString(); });

    proc.on('error', err => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });

    proc.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (videos.length === 0 && stderrBuf) {
          return reject(new Error(stderrBuf.slice(0, 300)));
        }
        resolve(videos);
      }
    });
  });
}

async function scrapeVideoDetails(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract video ID');
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  const html = await res.text();
  if (!html.includes('ytInitialPlayerResponse')) {
    throw new Error('ytInitialPlayerResponse not found in HTML');
  }
  const part = html.split('ytInitialPlayerResponse = ')[1];
  if (!part) throw new Error('Failed to parse page data structure');
  
  let jsonStr = part.split(';</script>')[0];
  if (jsonStr.includes(';var ')) {
    jsonStr = jsonStr.split(';var ')[0];
  }
  const data = JSON.parse(jsonStr);
  const details = data.videoDetails;
  if (!details) throw new Error('Video details not found in page data');
  
  return {
    id: details.videoId,
    title: details.title,
    description: details.shortDescription || '',
    tags: details.keywords || [],
    thumbnail: details.thumbnail?.thumbnails?.[details.thumbnail.thumbnails.length - 1]?.url || '',
    view_count: details.viewCount ? parseInt(details.viewCount, 10) : 0,
    like_count: null,
    upload_date: null,
    uploader: details.author,
    duration: details.lengthSeconds ? parseInt(details.lengthSeconds, 10) : 0,
  };
}

async function ytdlpFullJSON(url, timeout = 120000) {
  try {
    const scraped = await scrapeVideoDetails(url);
    if (scraped) return scraped;
  } catch (err) {
    console.warn('Scraping fallback failed, trying yt-dlp:', err.message);
  }

  return new Promise((resolve, reject) => {
    // Use -J for full single-video metadata (description, tags, etc.)
    exec(`yt-dlp -J --no-warnings "${url}"`, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr?.slice(0, 300) || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch (_) {
        reject(new Error('Failed to parse video metadata'));
      }
    });
  });
}


function mapEntry(entry) {
  const id = entry.id || '';
  return {
    videoId: id,
    title: entry.title || 'Untitled',
    url: id.startsWith('http') ? id : `https://www.youtube.com/watch?v=${id}`,
    thumbnail: entry.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : ''),
    duration: entry.duration || null,
    uploadDate: entry.upload_date || null,
    viewCount: entry.view_count || null,
  };
}

// ─── API: Channel Extractor ───────────────────────────────────────────────────
// POST /api/channel   body: { url }
app.post('/api/channel', async (req, res) => {
  const raw = sanitize(req.body?.url);
  if (!raw) return res.status(400).json({ error: 'Invalid URL.' });

  let targetUrl;
  try { targetUrl = resolveChannelUrl(raw, '/videos'); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const videos = await ytdlpFlatList(targetUrl);
    const handle = extractChannelHandle(raw);
    if (handle) {
      ensureDir(CHANNEL_DATA_DIR);
      safeWriteJson(path.join(CHANNEL_DATA_DIR, `${handle}.json`), {
        type: 'channel',
        handle,
        sourceInput: raw,
        sourceUrl: targetUrl,
        updatedAt: new Date().toISOString(),
        count: videos.length,
        videos,
      });
    }
    return res.json({
      success: true,
      channel: raw,
      handle: handle ? `@${handle}` : null,
      count: videos.length,
      videos,
      publicUrl: handle ? `/channel/${handle}` : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── API: Playlist Extractor ──────────────────────────────────────────────────
// POST /api/playlist   body: { url }
app.post('/api/playlist', async (req, res) => {
  const raw = sanitize(req.body?.url);
  if (!raw) return res.status(400).json({ error: 'Invalid URL.' });

  let targetUrl;
  try {
    const u = new URL(raw);
    if (!u.searchParams.has('list')) return res.status(400).json({ error: 'URL must contain a playlist ID (?list=...).' });
    targetUrl = raw;
  } catch (_) {
    return res.status(400).json({ error: 'Please enter a valid YouTube playlist URL.' });
  }

  try {
    const videos = await ytdlpFlatList(targetUrl);
    const playlistId = extractPlaylistId(raw);
    if (playlistId) {
      ensureDir(PLAYLIST_DATA_DIR);
      safeWriteJson(path.join(PLAYLIST_DATA_DIR, `${playlistId}.json`), {
        type: 'playlist',
        playlistId,
        sourceUrl: targetUrl,
        updatedAt: new Date().toISOString(),
        count: videos.length,
        videos,
      });
    }
    return res.json({
      success: true,
      playlist: playlistId || 'Playlist',
      playlistId: playlistId || null,
      count: videos.length,
      videos,
      publicUrl: playlistId ? `/playlist/${playlistId}` : null,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── API: Shorts Extractor ────────────────────────────────────────────────────
// POST /api/shorts   body: { url }
app.post('/api/shorts', async (req, res) => {
  const raw = sanitize(req.body?.url);
  if (!raw) return res.status(400).json({ error: 'Invalid URL.' });

  let targetUrl;
  try { targetUrl = resolveChannelUrl(raw, '/shorts'); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const videos = await ytdlpFlatList(targetUrl);
    return res.json({ success: true, channel: raw, count: videos.length, videos });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── API: Video Details (Description + Tags) ──────────────────────────────────
// POST /api/video-details   body: { url }
app.post('/api/video-details', async (req, res) => {
  const raw = sanitize(req.body?.url);
  if (!raw) return res.status(400).json({ error: 'Invalid URL.' });

  try {
    const data = await ytdlpFullJSON(raw);
    if (!data) return res.status(500).json({ error: 'Failed to fetch video metadata: empty response.' });
    return res.json({
      success: true,
      videoId: data.id,
      title: data.title,
      description: data.description || '',
      tags: data.tags || [],
      thumbnail: data.thumbnail,
      viewCount: data.view_count,
      likeCount: data.like_count,
      uploadDate: data.upload_date,
      channel: data.uploader,
      duration: data.duration,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── API: Comments Exporter ───────────────────────────────────────────────────
// POST /api/comments   body: { url }
// Uses youtube-comment-downloader (more reliable than yt-dlp comments) with yt-dlp fallback
app.post('/api/comments', async (req, res) => {
  const raw = sanitize(req.body?.url);
  if (!raw) return res.status(400).json({ error: 'Invalid URL.' });

  const videoId = extractVideoId(raw);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL.' });

  try {
    const { YoutubeCommentDownloader, SORT_BY_TOP } = require('youtube-comment-downloader');
    const downloader = new YoutubeCommentDownloader();
    const generator = downloader.getComments(videoId, SORT_BY_TOP);

    const comments = [];
    const MAX = 200; // cap at 200 comments
    
    try {
      for await (const comment of generator) {
        comments.push({
          author: comment.author,
          text: comment.text,
          likeCount: comment.votes?.simpleText || comment.votes || '0',
          timeText: comment.time,
          isHearted: comment.heart || false,
        });
        if (comments.length >= MAX) break;
      }
    } catch (e) {
      console.error('youtube-comment-downloader error:', e);
    }

    // Fallback to yt-dlp if no comments were found
    if (comments.length === 0) {
      try {
        const fallbackData = await new Promise((resolve, reject) => {
          exec(`yt-dlp -J --write-comments --playlist-items 0 --extractor-args "youtube:max-comments=200,200,200,0;comment_sort=top" --no-warnings "https://www.youtube.com/watch?v=${videoId}"`, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err) return reject(err);
            try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
          });
        });
        if (fallbackData.comments && fallbackData.comments.length > 0) {
          for (const c of fallbackData.comments.slice(0, MAX)) {
            comments.push({
              author: c.author || 'Anonymous',
              text: c.text,
              likeCount: c.like_count || '0',
              timeText: c._time_text || c.time_text || '',
              isHearted: c.is_favorited || false,
            });
          }
        }
      } catch (e) {
        console.error('yt-dlp comment fallback failed:', e.message);
      }
    }

    // Get video title from yt-dlp quickly
    let title = raw;
    try {
      const meta = await ytdlpFullJSON(raw, 30000);
      title = meta.title;
    } catch (_) {}

    return res.json({ success: true, title, commentCount: comments.length, comments });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch comments: ' + e.message });
  }
});

// ─── API: Thumbnail Downloader (single video) ─────────────────────────────────
// POST /api/thumbnail   body: { url }
app.post('/api/thumbnail', async (req, res) => {
  const raw = sanitize(req.body?.url);
  if (!raw) return res.status(400).json({ error: 'Invalid URL.' });

  const videoId = extractVideoId(raw);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID from URL.' });

  // Try maxresdefault, fallback to hqdefault
  const maxRes = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  const hqDefault = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    let thumbUrl = maxRes;
    try {
      const check = await axios.head(maxRes, { timeout: 5000 });
      if (check.status !== 200) thumbUrl = hqDefault;
    } catch (_) {
      thumbUrl = hqDefault;
    }

    return res.json({ success: true, videoId, url: thumbUrl, maxres: maxRes, hq: hqDefault });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── API: Thumbnail ZIP Downloader ────────────────────────────────────────────
// POST /api/thumbnail-zip   body: { urls: string[] }
app.post('/api/thumbnail-zip', async (req, res) => {
  const urls = req.body?.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'An array of video URLs is required.' });
  }

  try {
    const archive = archiver('zip', { zlib: { level: 6 } });

    // Catch archiver errors before headers are sent
    archive.on('error', err => {
      console.error('Archiver error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'ZIP creation failed: ' + err.message });
      }
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=thumbnails.zip');
    archive.pipe(res);

    for (const urlStr of urls) {
      const videoId = extractVideoId(urlStr.trim());
      if (!videoId) continue;

      const candidates = [
        `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      ];

      for (const thumbUrl of candidates) {
        try {
          const response = await axios.get(thumbUrl, { responseType: 'arraybuffer', timeout: 10000 });
          if (response.status === 200 && response.data.byteLength > 5000) {
            archive.append(Buffer.from(response.data), { name: `${videoId}.jpg` });
            break;
          }
        } catch (_) { continue; }
      }
    }

    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// ─── API: Deleted Video Tracker ───────────────────────────────────────────────
// POST /api/channel (reuse for live scan, comparison done on frontend)
// No additional backend route needed — frontend compares uploaded JSON vs live scan

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── SEO: robots.txt + sitemap.xml ─────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const origin = originFromReq(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      '',
      origin ? `Sitemap: ${origin}/sitemap.xml` : 'Sitemap: /sitemap.xml',
      '',
    ].join('\n'),
  );
});

function listPublishedChannelHandles() {
  try {
    if (!fs.existsSync(CHANNEL_DATA_DIR)) return [];
    return fs
      .readdirSync(CHANNEL_DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function listPublishedPlaylistIds() {
  try {
    if (!fs.existsSync(PLAYLIST_DATA_DIR)) return [];
    return fs
      .readdirSync(PLAYLIST_DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function listPublishedVideoIds({ max = 50000 } = {}) {
  const ids = new Set();
  try {
    if (fs.existsSync(CHANNEL_DATA_DIR)) {
      for (const f of fs.readdirSync(CHANNEL_DATA_DIR)) {
        if (!f.endsWith('.json')) continue;
        const j = safeReadJson(path.join(CHANNEL_DATA_DIR, f));
        const vids = Array.isArray(j?.videos) ? j.videos : [];
        for (const v of vids) {
          const id = v?.videoId;
          if (typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id)) ids.add(id);
          if (ids.size >= max) return Array.from(ids);
        }
      }
    }
    if (fs.existsSync(PLAYLIST_DATA_DIR)) {
      for (const f of fs.readdirSync(PLAYLIST_DATA_DIR)) {
        if (!f.endsWith('.json')) continue;
        const j = safeReadJson(path.join(PLAYLIST_DATA_DIR, f));
        const vids = Array.isArray(j?.videos) ? j.videos : [];
        for (const v of vids) {
          const id = v?.videoId;
          if (typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id)) ids.add(id);
          if (ids.size >= max) return Array.from(ids);
        }
      }
    }
  } catch (_) {}
  return Array.from(ids);
}

app.get('/sitemap.xml', (req, res) => {
  const origin = originFromReq(req);
  const base = origin || '';

  const toolRoutes = [
    '/',
    '/channel-extractor',
    '/playlist-extractor',
    '/thumbnail-downloader',
    '/comments-exporter',
    '/shorts-extractor',
    '/deleted-video-tracker',
    '/description-exporter',
    '/tags-exporter',
    '/thumbnail-zip',
  ];

  const channelHandles = listPublishedChannelHandles().slice(0, 50000); // safety cap
  const channelRoutes = channelHandles.map(h => `/channel/${encodeURIComponent(h)}`);

  const playlistIds = listPublishedPlaylistIds().slice(0, 50000);
  const playlistRoutes = playlistIds.map(id => `/playlist/${encodeURIComponent(id)}`);

  const videoIds = listPublishedVideoIds({ max: 50000 });
  const videoRoutes = videoIds.map(id => `/video/${encodeURIComponent(id)}`);

  const urls = [...toolRoutes, ...channelRoutes, ...playlistRoutes, ...videoRoutes];
  const now = new Date().toISOString();

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(u => {
        const loc = base ? `${base}${u}` : u;
        return `  <url><loc>${escapeHtml(loc)}</loc><lastmod>${now}</lastmod></url>`;
      })
      .join('\n') +
    `\n</urlset>\n`,
  );
});

// ─── Serve frontend (pretty URLs) ──────────────────────────────────────────────
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST, { extensions: ['html'] }));
}

function sendDistHtml(res, fileName) {
  const fp = path.join(FRONTEND_DIST, fileName);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.type('text/html').send(fs.readFileSync(fp, 'utf8'));
}

// Pretty tool URLs
app.get('/', (_req, res) => sendDistHtml(res, 'index.html'));
app.get('/channel-extractor', (_req, res) => sendDistHtml(res, 'app.html'));
app.get('/playlist-extractor', (_req, res) => sendDistHtml(res, 'playlist-extractor.html'));
app.get('/thumbnail-downloader', (_req, res) => sendDistHtml(res, 'thumbnail.html'));
app.get('/comments-exporter', (_req, res) => sendDistHtml(res, 'comments-exporter.html'));
app.get('/shorts-extractor', (_req, res) => sendDistHtml(res, 'shorts-extractor.html'));
app.get('/deleted-video-tracker', (_req, res) => sendDistHtml(res, 'deleted-video-tracker.html'));
app.get('/description-exporter', (_req, res) => sendDistHtml(res, 'description-exporter.html'));
app.get('/tags-exporter', (_req, res) => sendDistHtml(res, 'tags-exporter.html'));
app.get('/thumbnail-zip', (_req, res) => sendDistHtml(res, 'thumbnail-zip.html'));

// Back-compat: .html redirects → pretty URL
app.get('/app.html', (_req, res) => res.redirect(301, '/channel-extractor'));
app.get('/thumbnail.html', (_req, res) => res.redirect(301, '/thumbnail-downloader'));
app.get('/shorts-extractor.html', (_req, res) => res.redirect(301, '/shorts-extractor'));
app.get('/deleted-video-tracker.html', (_req, res) => res.redirect(301, '/deleted-video-tracker'));
app.get('/description-exporter.html', (_req, res) => res.redirect(301, '/description-exporter'));
app.get('/tags-exporter.html', (_req, res) => res.redirect(301, '/tags-exporter'));
app.get('/thumbnail-zip.html', (_req, res) => res.redirect(301, '/thumbnail-zip'));

// ─── Programmatic SEO pages (HTML) ─────────────────────────────────────────────
function pageShell({ title, description, canonicalUrl, h1, bodyHtml, jsonLd }) {
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  ${canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />` : ''}
  ${ld}
  <style>
    :root{color-scheme:dark}
    body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#050505;color:#fff}
    main{max-width:1100px;margin:0 auto;padding:32px 16px}
    a{color:#e0aaff}
    .muted{color:#a0a0b0}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:18px}
    .card{border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden;background:rgba(20,20,25,.7)}
    .card img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#111;display:block}
    .card .p{padding:12px}
    h1{font-family:Outfit,system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:32px;margin:0 0 6px}
    h2{font-family:Outfit,system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:26px 0 10px}
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(h1)}</h1>
    ${bodyHtml}
  </main>
</body>
</html>`;
}

app.get('/channel/:handle', async (req, res) => {
  const handle = sanitize(req.params.handle)?.replace(/^@/, '').toLowerCase();
  if (!handle) return res.status(400).send('Invalid channel handle');

  ensureDir(CHANNEL_DATA_DIR);
  const cached = safeReadJson(path.join(CHANNEL_DATA_DIR, `${handle}.json`));
  const origin = originFromReq(req);
  const canonicalUrl = origin ? `${origin}/channel/${handle}` : `/channel/${handle}`;

  const title = `@${handle} YouTube Channel Statistics`;
  const description = `View latest uploads, thumbnails, and basic stats for @${handle}.`;

  const videos = Array.isArray(cached?.videos) ? cached.videos.slice(0, 48) : [];

  const bodyHtml = `
    <p class="muted">Public archive page. ${cached?.updatedAt ? `Last updated ${escapeHtml(cached.updatedAt)}.` : 'No cached data yet.'}</p>
    <p>Want the freshest data? Use the <a href="/channel-extractor">YouTube Channel Extractor</a> and extract <strong>@${escapeHtml(handle)}</strong> — this page updates automatically.</p>
    <h2>Latest videos</h2>
    ${videos.length === 0 ? `<p class="muted">No videos cached yet for this channel.</p>` : `
      <div class="grid">
        ${videos.map(v => {
          const vid = v.videoId || extractVideoId(v.url) || '';
          const href = vid ? `/video/${encodeURIComponent(vid)}` : (v.url || '#');
          return `<div class="card">
            ${v.thumbnail ? `<img loading="lazy" src="${escapeHtml(v.thumbnail)}" alt="${escapeHtml(v.title || 'YouTube video')}" />` : ''}
            <div class="p">
              <div style="font-weight:600;line-height:1.35">${escapeHtml(v.title || 'Untitled')}</div>
              <div class="muted" style="margin-top:6px;font-size:13px">
                <a href="${escapeHtml(href)}">Open details</a>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
    `}
    <h2>Related tools</h2>
    <ul>
      <li><a href="/playlist-extractor">Playlist Extractor</a></li>
      <li><a href="/thumbnail-downloader">Thumbnail Downloader</a></li>
      <li><a href="/comments-exporter">Comments Exporter</a></li>
    </ul>
  `;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    name: title,
    description,
    url: canonicalUrl,
  };

  res.type('text/html').send(pageShell({ title, description, canonicalUrl, h1: title, bodyHtml, jsonLd }));
});

app.get('/video/:id', async (req, res) => {
  const id = sanitize(req.params.id);
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).send('Invalid video id');

  const origin = originFromReq(req);
  const canonicalUrl = origin ? `${origin}/video/${id}` : `/video/${id}`;
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;

  try {
    const data = await ytdlpFullJSON(watchUrl, 90000);
    const title = `${data.title || id} — YouTube Video Data`;
    const description = (data.description || `View metadata, tags, and thumbnail for YouTube video ${id}.`).slice(0, 160);

    const thumb = data.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    const tags = Array.isArray(data.tags) ? data.tags.slice(0, 30) : [];

    const bodyHtml = `
      <p class="muted">Source: <a href="${escapeHtml(watchUrl)}" rel="noopener noreferrer" target="_blank">YouTube</a></p>
      <div class="card" style="max-width:900px">
        <img loading="lazy" src="${escapeHtml(thumb)}" alt="${escapeHtml(data.title || 'YouTube thumbnail')}" />
        <div class="p">
          <div style="font-size:14px" class="muted">Video ID: ${escapeHtml(id)}</div>
          ${tags.length ? `<h2 style="margin:18px 0 8px">Tags</h2><p class="muted">${escapeHtml(tags.join(', '))}</p>` : ''}
          ${data.description ? `<h2 style="margin:18px 0 8px">Description</h2><p class="muted" style="white-space:pre-wrap">${escapeHtml(String(data.description).slice(0, 2500))}</p>` : ''}
        </div>
      </div>
      <h2>Related tools</h2>
      <ul>
        <li><a href="/thumbnail-downloader">Thumbnail Downloader</a></li>
        <li><a href="/comments-exporter">Comments Exporter</a></li>
      </ul>
    `;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: data.title || id,
      description,
      thumbnailUrl: thumb,
      uploadDate: data.upload_date || undefined,
      duration: data.duration ? `PT${Math.max(0, Number(data.duration))}S` : undefined,
      url: canonicalUrl,
    };

    res.type('text/html').send(pageShell({ title, description, canonicalUrl, h1: data.title || id, bodyHtml, jsonLd }));
  } catch (e) {
    const title = `${id} — YouTube Video Data`;
    const description = `View metadata for YouTube video ${id}.`;
    const bodyHtml = `<p class="muted">We couldn’t fetch full metadata right now. Try again later, or open on YouTube.</p>
      <p><a href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer">Open on YouTube</a></p>`;
    res.status(200).type('text/html').send(pageShell({ title, description, canonicalUrl, h1: title, bodyHtml }));
  }
});

app.get('/playlist/:id', async (req, res) => {
  const id = sanitize(req.params.id);
  if (!id || !/^[a-zA-Z0-9_-]{10,}$/.test(id)) return res.status(400).send('Invalid playlist id');
  const origin = originFromReq(req);
  const canonicalUrl = origin ? `${origin}/playlist/${id}` : `/playlist/${id}`;

  const playlistUrl = `https://www.youtube.com/playlist?list=${encodeURIComponent(id)}`;
  const title = `${id} — YouTube Playlist Data`;
  const description = `View playlist videos, thumbnails, and count for playlist ${id}.`;

  try {
    const videos = await ytdlpFlatList(playlistUrl, 120000);
    const top = videos.slice(0, 48);
    const bodyHtml = `
      <p class="muted">Playlist ID: ${escapeHtml(id)} • ${videos.length} videos</p>
      <div class="grid">
        ${top.map(v => {
          const vid = v.videoId || extractVideoId(v.url) || '';
          const href = vid ? `/video/${encodeURIComponent(vid)}` : (v.url || '#');
          return `<div class="card">
            ${v.thumbnail ? `<img loading="lazy" src="${escapeHtml(v.thumbnail)}" alt="${escapeHtml(v.title || 'YouTube video')}" />` : ''}
            <div class="p">
              <div style="font-weight:600;line-height:1.35">${escapeHtml(v.title || 'Untitled')}</div>
              <div class="muted" style="margin-top:6px;font-size:13px">
                <a href="${escapeHtml(href)}">Open details</a>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <h2>Extract this playlist</h2>
      <p>Use the <a href="/playlist-extractor">Playlist Extractor</a> to export all videos as TXT/JSON.</p>
    `;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title,
      description,
      url: canonicalUrl,
    };

    res.type('text/html').send(pageShell({ title, description, canonicalUrl, h1: `Playlist ${id}`, bodyHtml, jsonLd }));
  } catch (_) {
    const bodyHtml = `<p class="muted">We couldn’t fetch this playlist right now.</p>
    <p><a href="${escapeHtml(playlistUrl)}" target="_blank" rel="noopener noreferrer">Open on YouTube</a></p>`;
    res.type('text/html').send(pageShell({ title, description, canonicalUrl, h1: `Playlist ${id}`, bodyHtml }));
  }
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  // If frontend dist exists, try falling back to index for static hosting-like behavior.
  if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
    return res.status(404).type('text/html').send(fs.readFileSync(path.join(FRONTEND_DIST, 'index.html'), 'utf8'));
  }
  res.status(404).json({ error: 'Route not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Keep server alive on unhandled errors ───────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Extractor API running at http://localhost:${PORT}`);
  console.log(`   POST /api/channel        — extract all channel videos`);
  console.log(`   POST /api/playlist       — extract playlist`);
  console.log(`   POST /api/shorts         — extract shorts`);
  console.log(`   POST /api/video-details  — get description + tags`);
  console.log(`   POST /api/comments       — get comments`);
  console.log(`   POST /api/thumbnail      — get thumbnail URL`);
  console.log(`   POST /api/thumbnail-zip  — download thumbnails as ZIP`);
  console.log(`   GET  /health             — health check\n`);
});
