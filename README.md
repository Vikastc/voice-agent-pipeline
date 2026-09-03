# 🎙️ Voice Agent

A hands-free voice assistant you can **interrupt like a human**: click the mic, talk, and
the agent pauses when you speak, answers your question, then finishes what it was saying.

Built as a minimal, deployable demo — static frontend + two serverless proxies.

## Try it

1. Open the deployed URL (or run locally).
2. Tap the mic and allow microphone access.
3. Talk. While the agent is speaking you can:
   - **Say "okay" / "got it"** → it pauses, then continues.
   - **Ask a question** (keep talking ~2.5s) → it stops, answers, then finishes its point.
   - **Cough / make noise** → it pauses briefly and carries on.

> 🎧 Headphones recommended: on speakers the agent can occasionally hear its own voice.

## How it works

```
Browser                                Vercel (serverless)
───────                                ───────────────────
Web Speech API (STT)      ──┐
mic RMS analyser (VAD)    ──┼──►  /api/llm  →  OpenAI Responses API (SSE stream)
                            │      /api/tts  →  OpenAI Speech API (mp3)
Audio playback queue      ──┘
```

- **`index.html` / `app.js` / `style.css`** — the whole agent: speech-to-text, a mic
  loudness monitor, a sentence-ordered TTS playback queue, and the interruption
  state machine. The OpenAI key never touches the browser.
- **`api/llm.js`** — Edge function; streams the LLM response (SSE) straight through.
- **`api/tts.js`** — Edge function; synthesizes one sentence to mp3.

### The interruption rules

| You do | The agent does |
|---|---|
| Make any sound while it talks | Pauses immediately |
| Say an acknowledgment ("okay", "got it") | Continues where it paused |
| Keep talking > 2.5s (word gaps tolerated) | Hard-stops, answers you, then finishes its earlier point |
| Stop mid-pause without saying anything recognizable | Resumes after 2s of silence |
| Stay silent | Normal conversation |

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In [Vercel](https://vercel.com) → **Add New → Project** → import the repo
   (Framework Preset: *Other* — zero config needed).
3. Add the environment variable **`OPENAI_API_KEY`** = your OpenAI key
   (Project → Settings → Environment Variables).
4. Deploy. Share the URL — the key stays server-side; testers never see it.

## Run locally

```bash
npm i -g vercel   # once
vercel dev        # then open the printed localhost URL
```

(`vercel dev` runs the /api functions locally; a static server alone won't.)

## Tuning knobs

All in `app.js` → `BARGE_IN`:

| Knob | Meaning |
|---|---|
| `rmsThreshold` | mic level considered "loud" |
| `interruptAfterMs` | how long you must keep talking before it hard-stops |
| `gapToleranceMs` | word pauses that don't reset the interrupt clock |
| `silentResumeMs` | silence after which an untranscribed noise gets ignored |
| `resumeQuietMs` | minimum quiet time before it resumes (won't talk over you) |

## Known limitations

- Per-sentence TTS means many rapid API calls — heavy sessions can hit rate limits
  (a failed sentence is skipped, the rest still plays).
- Web Speech API (STT) is Chrome/Edge only, and the recognizer quality varies by device.
- Hands-free echo: the agent can occasionally hear its own voice — headphones fix it,
  and an echo guard already filters most of it.
