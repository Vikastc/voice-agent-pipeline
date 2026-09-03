// ============================================================
// Voice Agent — Express server
// Serves the frontend and proxies LLM/TTS to OpenAI so the API key
// never reaches the browser. Runs locally (npm start) and on Vercel
// (api/index.js exports this same app).
// ============================================================

const path = require('path');
const fs = require('fs');
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

const LLM_MODEL = 'gpt-5.6-luna';
const TTS_MODEL = 'gpt-4o-mini-tts';
const VOICE = 'coral';

function requireKey(res) {
  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not set' });
    return false;
  }
  return true;
}

// LLM proxy: streams the response (SSE) straight to the browser.
app.post('/api/llm', async (req, res) => {
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
      return res.status(502).send(`LLM upstream error (${upstream.status})`);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('LLM proxy error:', err);
    if (!res.headersSent) res.status(502).send('LLM upstream error');
    else res.end();
  }
});

// TTS proxy: streams the mp3 straight to the browser.
app.post('/api/tts', async (req, res) => {
  if (!requireKey(res)) return;

  const text = typeof req.body.text === 'string' ? req.body.text.slice(0, 1000) : '';
  if (!text) return res.status(400).json({ error: 'Missing text' });

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
      return res.status(502).send(`TTS upstream error (${upstream.status})`);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error('TTS proxy error:', err);
    if (!res.headersSent) res.status(502).send('TTS upstream error');
    else res.end();
  }
});


app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`🎙 Voice agent running at http://localhost:${port}`);
  });
}

module.exports = app;
