// ============================================================
// Voice Agent — Express server
// Serves the frontend and proxies LLM/TTS/STT to OpenAI so the API key
// never reaches the browser. Features authentication and a strict
// 20,000 token quota per user.
// ============================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Readable } = require('stream');

// ponytail: 6-line .env loader instead of adding the dotenv dependency.
// Vercel injects env vars natively, so this only matters for local runs.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  /* no .env file — fine (e.g. on Vercel) */
}

const app = express();
app.use(express.json({ limit: '100kb' }));
// Defensive: if a request arrives without the JSON body parser firing
// (wrong Content-Type), treat it as an empty body instead of undefined → 500.
app.use((req, _res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

const LLM_MODEL = process.env.LLM_MODEL || 'gpt-5.6-luna';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const VOICE = process.env.VOICE || 'coral';
const TOKEN_LIMIT_PER_USER = Number(process.env.TOKEN_LIMIT_PER_USER) || 20000;

// Deterministic secret for signing HMAC tokens (stable across serverless cold starts)
const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  crypto
    .createHash('sha256')
    .update(process.env.OPENAI_API_KEY || 'voice-agent-auth-default-salt')
    .digest('hex');

// In-memory + file-backed persistent usage cache
const USAGE_FILE = path.join(__dirname, '.usage.json');
let userUsageCache = {};
try {
  if (fs.existsSync(USAGE_FILE)) {
    userUsageCache = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  }
} catch {
  userUsageCache = {};
}

function saveUsage(userId, tokensUsed) {
  userUsageCache[userId] = Math.max(userUsageCache[userId] || 0, tokensUsed);
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(userUsageCache, null, 2));
  } catch {
    /* ignore write errors on read-only environments */
  }
}

function getUsage(userId) {
  return userUsageCache[userId] || 0;
}

// ---------------- Token Signing & Verification ----------------
function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(`${header}.${body}`).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Middleware: verifies authentication and checks token quota
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : req.query.token || req.headers['x-access-token'];

  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: Please sign in with a valid Access Key' });
  }

  // Check persisted usage against token usage (enforce highest)
  const cachedTokens = getUsage(user.sub);
  const currentTokensUsed = Math.max(user.tokensUsed || 0, cachedTokens);

  if (currentTokensUsed >= user.maxTokens) {
    return res.status(403).json({
      error: `Token limit reached (${currentTokensUsed} / ${user.maxTokens} tokens used).`,
      tokensUsed: currentTokensUsed,
      maxTokens: user.maxTokens,
      tokensRemaining: 0,
    });
  }

  req.user = {
    ...user,
    tokensUsed: currentTokensUsed,
  };
  req.sessionToken = token;
  next();
}

function requireKey(res) {
  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not set in environment variables' });
    return false;
  }
  return true;
}

// ---------------- Health & Diagnostics ----------------
app.get(['/api', '/api/health', '/health'], (_req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-agent',
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    authRequired: true,
    tokenLimitPerUser: TOKEN_LIMIT_PER_USER,
    llmModel: LLM_MODEL,
    ttsModel: TTS_MODEL,
  });
});

app.get(['/api/test-llm'], async (req, res) => {
  if (!requireKey(res)) return;
  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        input: 'Say "Hello, OpenAI LLM connection is working!" in one sentence.',
        stream: false,
      }),
    });
    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    res.status(upstream.status).json({
      ok: upstream.ok,
      status: upstream.status,
      model: LLM_MODEL,
      response: data,
    });
  } catch (err) {
    res.status(502).json({ error: `Diagnostic fetch failed: ${err.message}` });
  }
});

// ---------------- Authentication Endpoints ----------------
app.post(['/api/auth/login', '/auth/login'], (req, res) => {
  const key = (req.body.key || req.body.accessKey || '').trim().toLowerCase();
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();

  const allowedKeys = (process.env.ACCESS_KEYS || 'demo-2026,vip-2026,guest-2026,team-2026')
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

  let validUser = null;

  if (key && allowedKeys.includes(key)) {
    validUser = key;
  } else if (process.env.APP_PASSWORD && password === process.env.APP_PASSWORD && username) {
    validUser = username;
  } else if (!process.env.ACCESS_KEYS && !process.env.APP_PASSWORD && key) {
    // Fallback: accept default keys
    if (allowedKeys.includes(key)) validUser = key;
  }

  if (!validUser) {
    return res.status(401).json({
      error: 'Invalid Access Key. Please check and try again.',
      hint: process.env.ACCESS_KEYS ? 'Use one of your configured ACCESS_KEYS' : 'Try default key: demo-2026',
    });
  }

  const existingUsage = getUsage(validUser);
  const payload = {
    sub: validUser,
    tokensUsed: existingUsage,
    maxTokens: TOKEN_LIMIT_PER_USER,
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };

  const token = signToken(payload);

  res.json({
    ok: true,
    user: validUser,
    tokensUsed: existingUsage,
    maxTokens: TOKEN_LIMIT_PER_USER,
    tokensRemaining: Math.max(0, TOKEN_LIMIT_PER_USER - existingUsage),
    token,
  });
});

app.get(['/api/auth/me', '/auth/me'], (req, res) => {
  const authHeader = req.headers.authorization;
  const token =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : req.query.token || req.headers['x-access-token'];

  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Session invalid or expired' });
  }

  const currentUsage = Math.max(user.tokensUsed || 0, getUsage(user.sub));
  const remaining = Math.max(0, user.maxTokens - currentUsage);

  // Return a refreshed token if stored count updated
  let refreshedToken = token;
  if (currentUsage !== user.tokensUsed) {
    refreshedToken = signToken({ ...user, tokensUsed: currentUsage });
  }

  res.json({
    ok: true,
    user: user.sub,
    tokensUsed: currentUsage,
    maxTokens: user.maxTokens,
    tokensRemaining: remaining,
    token: refreshedToken,
  });
});

app.post(['/api/auth/logout', '/auth/logout'], (_req, res) => {
  res.json({ ok: true, message: 'Logged out' });
});

// ---------------- LLM Proxy (Streaming + Token Accounting) ----------------
app.post(['/api/llm', '/llm'], requireAuth, async (req, res) => {
  if (!requireKey(res)) return;

  const userText = typeof req.body.userText === 'string' ? req.body.userText.slice(0, 2000) : '';
  const interruptedContext =
    typeof req.body.interruptedContext === 'string' ? req.body.interruptedContext.slice(0, 8000) : '';
  if (!userText) return res.status(400).json({ error: 'Missing userText' });

  const contextBlock = interruptedContext
    ? `You were in the middle of telling the user the following when they interrupted you. This is what they have heard so far:
"${interruptedContext}"
Respond naturally like a person: address the user's interruption first, then continue your original point from where you left off — do NOT repeat sentences the user already heard. Bridge naturally when you resume (e.g. "as I was saying...", "anyway, to finish what I started..."). If your point was already complete before the interruption, simply answer the interruption.
`
    : '';

  const input = `You are a part of Speech To Text and Text To Speech Pipeline.
Always answer in complete sentences so they can be converted to speech as soon as each one finishes.
${contextBlock}
User Query:
${userText}`;

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: LLM_MODEL, input, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      console.error(`LLM upstream error (${upstream.status}):`, errText);
      return res.status(502).send(`LLM upstream error (${upstream.status}): ${errText}`);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const reader = upstream.body.getReader();
    let buffer = '';
    let tokensAccounted = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      res.write(value);

      // Parse SSE chunks to catch response.completed event with token usage
      const chunkText = Buffer.from(value).toString('utf8');
      buffer += chunkText;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (part.includes('response.completed')) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try {
              const data = JSON.parse(line.slice(6));
              const totalTokens = data.response?.usage?.total_tokens;
              if (typeof totalTokens === 'number' && totalTokens > 0) {
                tokensAccounted = totalTokens;
              }
            } catch {
              /* ignore parse errors on partial chunks */
            }
          }
        }
      }
    }

    // If response.completed didn't specify or was cut short, estimate from text length
    if (tokensAccounted === 0) {
      tokensAccounted = Math.max(10, Math.ceil((userText.length + 300) / 4));
    }

    // Update user token quota
    const newTokensUsed = Math.min(req.user.maxTokens, req.user.tokensUsed + tokensAccounted);
    saveUsage(req.user.sub, newTokensUsed);

    const updatedToken = signToken({
      ...req.user,
      tokensUsed: newTokensUsed,
    });

    // Send the token_usage event to the client so UI updates immediately
    res.write(
      `event: token_usage\ndata: ${JSON.stringify({
        tokensUsed: newTokensUsed,
        maxTokens: req.user.maxTokens,
        tokensAdded: tokensAccounted,
        tokensRemaining: Math.max(0, req.user.maxTokens - newTokensUsed),
        token: updatedToken,
      })}\n\n`
    );

    res.end();
  } catch (err) {
    console.error('LLM proxy error:', err);
    if (!res.headersSent) res.status(502).send(`LLM proxy error: ${err.message}`);
    else res.end();
  }
});

// ---------------- TTS Proxy ----------------
app.post(['/api/tts', '/tts'], requireAuth, async (req, res) => {
  if (!requireKey(res)) return;

  const text = typeof req.body.text === 'string' ? req.body.text.slice(0, 1000) : '';
  if (!text) return res.status(400).json({ error: 'Missing text' });

  // Deduct small estimated token count for TTS (1 token per 4 chars)
  const estimatedTtsTokens = Math.max(1, Math.ceil(text.length / 4));
  const newTokensUsed = Math.min(req.user.maxTokens, req.user.tokensUsed + estimatedTtsTokens);
  saveUsage(req.user.sub, newTokensUsed);

  const updatedToken = signToken({
    ...req.user,
    tokensUsed: newTokensUsed,
  });

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: VOICE,
        input: text,
        instructions: 'Speak in a cheerful, warm and natural tone.',
        response_format: 'mp3',
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      console.error(`TTS upstream error (${upstream.status}):`, errText);
      return res.status(502).send(`TTS upstream error (${upstream.status}): ${errText}`);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Tokens-Used', String(newTokensUsed));
    res.setHeader('X-New-Token', updatedToken);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('TTS proxy error:', err);
    if (!res.headersSent) res.status(502).send(`TTS proxy error: ${err.message}`);
    else res.end();
  }
});

// ---------------- STT Proxy (OpenAI Whisper) ----------------
app.post(
  ['/api/stt', '/stt'],
  requireAuth,
  express.raw({ type: ['audio/*', 'application/octet-stream', 'multipart/form-data'], limit: '15mb' }),
  async (req, res) => {
    if (!requireKey(res)) return;

    const audioBuffer = req.body;
    if (!audioBuffer || !audioBuffer.length) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    try {
      const contentType = req.headers['content-type'] || 'audio/webm';
      const ext = contentType.includes('wav') ? 'wav' : contentType.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob([audioBuffer], { type: contentType });
      const formData = new FormData();
      formData.append('file', blob, `speech.${ext}`);
      formData.append('model', 'whisper-1');

      const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: formData,
      });

      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        console.error(`Whisper error (${upstream.status}):`, errText);
        return res.status(502).json({ error: `STT error (${upstream.status}): ${errText}` });
      }

      const data = await upstream.json();
      res.json({ text: data.text || '' });
    } catch (err) {
      console.error('STT proxy error:', err);
      res.status(502).json({ error: err.message });
    }
  }
);

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🎙 Voice agent running at http://localhost:${port}`);
    console.log(`🔐 Quota limit: ${TOKEN_LIMIT_PER_USER} tokens per user`);
    console.log(`🔑 Access keys active: ${process.env.ACCESS_KEYS || 'demo-2026,vip-2026,guest-2026,team-2026'}`);
  });
}

module.exports = app;
