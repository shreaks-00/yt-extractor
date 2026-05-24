import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '1mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait 15 minutes before trying again.' },
});
app.use('/extract', limiter);

// ─── Input sanitizer ──────────────────────────────────────────────────────────
function sanitizeChannelInput(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  // Allow safe chars: letters, digits, spaces, and URL characters (@, /, ., -, _, :, ?, =, &, %, +)
  const safe = /^[a-zA-Z0-9@\/\.\-\_\:\?=\&\%\+\s]+$/;
  if (!safe.test(trimmed)) return null;
  return trimmed;
}

// ─── Channel URL resolver ─────────────────────────────────────────────────────
function resolveChannelUrl(input) {
  let normalizedInput = input;
  if (/^(www\.)?youtube\.com/i.test(normalizedInput)) {
    normalizedInput = 'https://' + normalizedInput;
  }

  // Already a full URL
  if (normalizedInput.startsWith('https://') || normalizedInput.startsWith('http://')) {
    // Ensure it points to /videos
    const url = new URL(normalizedInput);
    if (!url.hostname.includes('youtube.com')) {
      throw new Error('Only YouTube URLs are supported.');
    }
    const path = url.pathname.endsWith('/videos')
      ? url.pathname
      : url.pathname.replace(/\/$/, '') + '/videos';
    return `https://www.youtube.com${path}`;
  }

  // Handle @handle format
  if (normalizedInput.startsWith('@')) {
    return `https://www.youtube.com/${normalizedInput}/videos`;
  }

  // Plain channel name → @channel/videos
  return `https://www.youtube.com/@${normalizedInput}/videos`;
}

// ─── POST /extract ────────────────────────────────────────────────────────────
app.post('/extract', async (req, res) => {
  const rawChannel = req.body?.channel;
  const sanitized = sanitizeChannelInput(rawChannel);

  if (!sanitized) {
    return res.status(400).json({ error: 'Invalid channel name or URL provided.' });
  }

  let channelUrl;
  try {
    channelUrl = resolveChannelUrl(sanitized);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const videos = [];
  let stderrOutput = '';

  const ytdlp = spawn('yt-dlp', [
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--socket-timeout', '30',
    channelUrl,
  ], {
    timeout: 120000, // 2 minute hard kill
    shell: false,   // NEVER use shell: true (prevents injection)
  });

  // Buffer stdout line-by-line and parse JSON
  let buffer = '';
  ytdlp.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const videoId = parsed.id || parsed.url || '';
        videos.push({
          title: parsed.title || 'Untitled',
          videoId: videoId,
          url: videoId.startsWith('http')
            ? videoId
            : `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail:
            parsed.thumbnail ||
            (videoId && !videoId.startsWith('http')
              ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
              : ''),
          duration: parsed.duration || null,
          uploadDate: parsed.upload_date || null,
          viewCount: parsed.view_count || null,
          description: parsed.description || '',
        });
      } catch (_) {
        // Skip non-JSON lines
      }
    }
  });

  ytdlp.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  ytdlp.on('error', (err) => {
    if (err.code === 'ENOENT') {
      return res.status(500).json({
        error: 'yt-dlp is not installed or not in PATH. Please install yt-dlp first.',
        docs: 'https://github.com/yt-dlp/yt-dlp#installation',
      });
    }
    return res.status(500).json({ error: `Process error: ${err.message}` });
  });

  ytdlp.on('close', (code) => {
    if (videos.length === 0) {
      const errMsg = stderrOutput.toLowerCase();
      if (errMsg.includes('http error 404') || errMsg.includes('not found')) {
        return res.status(404).json({ error: 'Channel not found. Please check the channel name.' });
      }
      if (errMsg.includes('rate') || errMsg.includes('too many')) {
        return res.status(429).json({ error: 'YouTube rate limit hit. Please try again later.' });
      }
      if (errMsg.includes('private') || errMsg.includes('unavailable')) {
        return res.status(403).json({ error: 'This channel is private or unavailable.' });
      }
      return res.status(404).json({
        error: 'No videos found for this channel.',
        detail: stderrOutput.slice(0, 500),
      });
    }

    return res.json({
      success: true,
      channel: sanitized,
      channelUrl,
      count: videos.length,
      extractedAt: new Date().toISOString(),
      videos,
    });
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 YT Extractor API running at http://localhost:${PORT}`);
  console.log(`📡 POST /extract  — extract videos from a channel`);
  console.log(`💚 GET  /health   — health check\n`);
});
