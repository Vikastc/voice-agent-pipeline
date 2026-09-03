# 🎙️ Voice Agent

A hands-free voice assistant you can **interrupt like a human**: click the mic, talk, and
the agent pauses when you speak, answers your question, then finishes what it was saying.

A plain **Express** app — no framework-specific config. Works locally and deploys to
Vercel (or any Node host) as-is.

## Try it

1. Open the app, tap the mic, allow microphone access.
2. Talk. While the agent is speaking you can:
   - **Say "okay" / "got it"** → it pauses, then continues.
   - **Ask a question** (keep talking ~2.5s) → it stops, answers, then finishes its point.
   - **Cough / make noise** → it pauses briefly and carries on.

> 🎧 Headphones recommended: on speakers the agent can occasionally hear its own voice.

## How it works

```
Browser                     Express server (server.js)          OpenAI
───────                     ──────────────────────────          ──────
Web Speech API (STT)  ──┐
mic RMS monitor (VAD) ──┼──►  POST /api/llm  →  Responses API (SSE stream)
Audio playback queue  ──┘     POST /api/tts  →  Speech API (mp3)
```

- `server.js` — Express app: static files + two proxy routes. The OpenAI key lives in
  `process.env.OPENAI_API_KEY` and never reaches the browser.
- `public/` — `index.html`, `app.js`, `style.css`: the whole agent (speech-to-text,
  loudness monitor, sentence-ordered playback queue, interruption state machine).
- `api/index.js` + `vercel.json` — Vercel glue: runs this same Express app as a
  serverless function and serves `public/` statically.

## Run locally

```bash
npm install
echo 'OPENAI_API_KEY=sk-your-key' > .env
npm start          # → http://localhost:3000
```

(`.env` is git-ignored; on Vercel the key comes from the dashboard instead.)

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In [Vercel](https://vercel.com) → **Add New → Project** → import the repo.
   It's a plain Node/Express project — no build step needed.
3. Add the environment variable **`OPENAI_API_KEY`** = your OpenAI key
   (Settings → Environment Variables).
4. Deploy and share the URL.

Or straight from the CLI:

```bash
vercel env add OPENAI_API_KEY production
vercel --prod
```

## The interruption rules

| You do | The agent does |
|---|---|
| Make any sound while it talks | Pauses immediately |
| Say an acknowledgment ("okay", "got it") | Continues where it paused |
| Keep talking > 2.5s (word gaps tolerated) | Hard-stops, answers you, then finishes its earlier point |
| Stop mid-pause without saying anything recognizable | Resumes after 2s of silence |

## Tuning knobs

All in `public/app.js` → `BARGE_IN`:

| Knob | Meaning |
|---|---|
| `rmsThreshold` | mic level considered "loud" |
| `interruptAfterMs` | how long you must keep talking before it hard-stops |
| `gapToleranceMs` | word pauses that don't reset the interrupt clock |
| `silentResumeMs` | silence after which an untranscribed noise gets ignored |
| `resumeQuietMs` | minimum quiet time before it resumes (won't talk over you) |

## Checks

```bash
npm test   # runs bargeIn.test.js — the interruption timing rules
```

## Known limitations

- Per-sentence TTS means many rapid API calls — heavy sessions can hit rate limits
  (a failed sentence is skipped, the rest still plays).
- Web Speech API (STT) is Chrome/Edge only, and recognizer quality varies by device.
- Hands-free echo: the agent can occasionally hear its own voice — headphones fix it,
  and an echo guard already filters most of it.
