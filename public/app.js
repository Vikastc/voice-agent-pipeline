// ============================================================
// Voice Agent — frontend
// Same state machine as the prototype (barge-in, acknowledgments,
// echo guard, heard-based deferral). The OpenAI key stays server-side:
// LLM + TTS go through the /api/* serverless proxies.
// ============================================================

const state = {
  currentAudioObj: null,         // the audio element currently playing
  pendingClips: {},              // seq -> TTS blob (filled out of order)
  nextToPlay: 0,                 // ordering cursor
  isPlaying: false,              // single-flight drain lock
  playbackSession: 0,            // bumped on interrupt; kills stale async work
  tentativePause: false,         // agent paused on a user sound, awaiting verdict
  sentenceTexts: {},             // seq -> sentence text of the current response
  playedUpTo: -1,                // highest seq fully played back ("heard frontier")
  responseFullyGenerated: false, // LLM stream done → drainQueue may skip gaps
  lastLoudAt: 0,                 // last mic-loud frame timestamp
  pendingDeferred: '',           // interrupted point the agent still owes the user
};

const BARGE_IN = {
  rmsThreshold: 0.04,     // mic level considered "loud". User speech reads
                          // 0.10-0.15, the agent's own TTS ~0.006 — 0.04 keeps
                          // soft/normal-pace speech detected without the agent
                          // barge-in on itself.
  consecutiveFrames: 3,   // ~50ms of loudness = a real sound → pause
  interruptAfterMs: 2500, // continuous speech past this = real interruption
  gapToleranceMs: 600,    // word gaps don't reset the burst clock
  silentResumeMs: 3000,   // while paused: hold and listen until the user has
                          // been quiet this long (no voice = truly done)
  resumeQuietMs: 400,     // never resume until the mic has been quiet this long
};

// ---------------- UI helpers ----------------
const isBrowser = typeof window !== 'undefined';
const micBtn = isBrowser ? document.getElementById('micBtn') : null;
const statusEl = isBrowser ? document.getElementById('status') : null;
const messagesEl = isBrowser ? document.getElementById('messages') : null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function addMessage(role, text) {
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addEvent(text) {
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.className = 'event';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------------- acknowledgments (back-channels) ----------------
const PRIORITY_ACK_PHRASES = new Set([
  'okay', 'ok', 'okay okay', 'ok ok', 'got it', 'gotcha', 'right', 'uh huh',
  'mm hm', 'mhm', 'hm', 'hmm', 'yeah', 'yes', 'sure', 'understood', 'i see',
  'makes sense', 'thanks', 'thank you', 'no problem', 'alright', 'all right',
  'nice', 'great',
]);

// Very short utterances (<= 3 words) where EVERY word is a filler/ack word.
const ACK_MAX_WORDS = 3;
const ACK_WORDS = new Set([
  'hmm', 'hm', 'mhm', 'mm', 'uh', 'um', 'ok', 'okay', 'k', 'ya', 'yeah', 'yea',
  'yes', 'yep', 'right', 'got', 'it', 'gotcha', 'sure', 'thanks', 'thank',
  'you', 'thx', 'no', 'problem', 'uhhuh', 'aha', 'ah', 'oh',
]);

function normalizeText(text = '') {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isAcknowledgment(text = '') {
  const t = normalizeText(text);
  if (!t) return true;

  if (PRIORITY_ACK_PHRASES.has(t)) return true;

  const words = t.split(' ');
  if (words.length <= ACK_MAX_WORDS) {
    return words.every((w) => ACK_WORDS.has(w));
  }
  return false;
}

// ---------------- LLM (streaming through the serverless proxy) ----------------
async function* llmStreaming(userText = '', interruptedContext = '', mode = 'answer') {
  let response;
  try {
    response = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText, interruptedContext, mode }),
    });
  } catch (err) {
    addEvent('⚠️ Could not reach the LLM');
    return;
  }
  if (!response.ok || !response.body) {
    addEvent(`⚠️ LLM error (${response.status})`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textContent = '';
  let sentenceBuffer = '';

  function takeSentences(text) {
    const sentences = [];
    let rest = text;

    while (true) {
      const end = rest.search(/[.?!]/);
      if (end === -1) break;
      const sentence = rest.slice(0, end + 1).trim();
      rest = rest.slice(end + 1);
      if (sentence) sentences.push(sentence);
    }

    return { sentences, rest };
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const payload = event
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');

      if (!payload || payload === '[DONE]') continue;

      const parsed = JSON.parse(payload);

      if (parsed.type === 'response.output_text.delta') {
        textContent += parsed.delta;
        sentenceBuffer += parsed.delta;

        const { sentences, rest } = takeSentences(sentenceBuffer);
        sentenceBuffer = rest;

        for (const sentence of sentences) {
          yield { textContent, isFinal: false, delta: sentence };
        }
      }

      if (parsed.type === 'response.output_text.done') {
        textContent = parsed.text ?? textContent;
      }
    }
  }

  const leftover = sentenceBuffer.trim();
  if (leftover) {
    yield { textContent, isFinal: true, delta: leftover };
  }
}

// ---------------- TTS (through the serverless proxy) ----------------
async function speak(text = '', seq = 0) {
  const session = state.playbackSession;
  // Record the sentence text so an interruption can reconstruct what the user
  // has actually heard (see playedUpTo / onresult).
  state.sentenceTexts[seq] = text;

  // Wait for a free TTS slot (concurrency limiter).
  while (activeTtsRequests >= MAX_CONCURRENT_TTS) {
    if (session !== state.playbackSession) return; // interrupted while waiting
    await new Promise((r) => setTimeout(r, 200));
  }
  if (session !== state.playbackSession) return;
  activeTtsRequests++;

  let response = null;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        console.warn('🔇 TTS request failed for seq', seq, err);
        return;
      }
      if (response.ok) break;
      if (response.status === 429) {
        // Exponential backoff: 1s, 2s, 4s — then give up.
        const backoff = 1000 * Math.pow(2, attempt);
        console.log(`🔇 TTS 429 on seq ${seq}, backing off ${backoff}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      break; // non-429 error — don't retry
    }
  } finally {
    activeTtsRequests--;
  }

  if (!response || !response.ok) {
    console.warn('🔇 TTS rejected for seq', seq, response && response.status);
    return;
  }

  let audioBlob;
  try {
    audioBlob = await response.blob();
  } catch (err) {
    console.warn('🔇 TTS blob failed for seq', seq, err);
    return;
  }

  // If the user interrupted while we were synthesizing this sentence, discard it.
  if (session !== state.playbackSession) return;

  state.pendingClips[seq] = audioBlob;
  drainQueue(session);
}

async function drainQueue(session) {
  if (state.isPlaying) return; // another drain loop is already running
  state.isPlaying = true;

  try {
    while (session === state.playbackSession) {
      // Paused on a user sound → freeze the queue. A later speak() re-enters
      // drainQueue, but resumeForAcknowledgment re-kicks it once unpaused.
      // Without this, a clip synthesized during a pause would start playing
      // over the user's question.
      if (state.tentativePause) break;

      if (Object.prototype.hasOwnProperty.call(state.pendingClips, state.nextToPlay)) {
        const seq = state.nextToPlay;
        const audioBlob = state.pendingClips[seq];
        delete state.pendingClips[seq];
        state.nextToPlay += 1;

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        try {
          await new Promise((resolve, reject) => {
            const clearCurrent = () => {
              if (state.currentAudioObj?.audio === audio) {
                state.currentAudioObj = null;
              }
              URL.revokeObjectURL(audioUrl);
            };

            state.currentAudioObj = { audio, audioUrl, resolve, reject };

            audio.onended = () => {
              clearCurrent();
              resolve();
            };
            audio.onerror = () => {
              clearCurrent();
              reject(audio.error ?? new Error('Audio playback failed'));
            };
            audio.play().catch(reject);
          });
          // Fully played back to the user — this is the heard frontier.
          state.playedUpTo = seq;
        } catch (err) {
          // One bad clip must not kill the whole queue.
          console.warn('🔇 Clip playback failed for seq', seq, err);
        }
      } else if (state.responseFullyGenerated) {
        // Generation is finished, so a missing seq means its TTS failed.
        // Skip ahead to whatever clips exist instead of stalling forever.
        const remaining = Object.keys(state.pendingClips)
          .map(Number)
          .sort((a, b) => a - b);
        if (!remaining.length) break;
        console.log('⏭ Skipping failed clip seq', state.nextToPlay, '→', remaining[0]);
        state.nextToPlay = remaining[0];
      } else {
        // Next clip is still synthesizing; a later speak() re-enters drainQueue.
        break;
      }
    }
  } finally {
    state.isPlaying = false;
  }
}

function interruptPlayback() {
  state.playbackSession += 1;
  state.tentativePause = false;

  if (state.currentAudioObj) {
    const { audio, audioUrl, resolve } = state.currentAudioObj;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.src = '';
    URL.revokeObjectURL(audioUrl);
    state.currentAudioObj = null;
    resolve?.();
  }

  // Drop all pending clips and reset the ordering back to the start.
  state.pendingClips = {};
  state.nextToPlay = 0;
}

function pauseForBargeIn() {
  // Pause whenever the agent has ANY active or pending audio — not only while a
  // clip element is mid-playback. Responses are sequences of sentence clips with
  // gaps between them; an interruption landing in a gap previously caused NO
  // pause, so the echo guard then ate the user's real question. This was the
  // main source of flaky interrupt behavior.
  if (state.tentativePause || !isAgentSpeaking()) return;
  state.tentativePause = true;
  lastBargeInAt = Date.now(); // see echo guard in onresult
  if (state.currentAudioObj) {
    state.currentAudioObj.audio.pause();
  }
  addEvent('⏸ Paused — listening to you…');
  setStatus('Paused — listening…');
}

function resumeForAcknowledgment() {
  if (!state.tentativePause) return;
  // HARD RULE: stay paused until the user has finished speaking.
  if (Date.now() - state.lastLoudAt < BARGE_IN.resumeQuietMs) {
    console.log('⏳ Holding pause — user is still speaking');
    return;
  }
  state.tentativePause = false;
  addEvent('▶ Resuming');
  setStatus('Agent speaking…');
  if (state.currentAudioObj) {
    // Paused mid-clip → unpause the element; the drain loop's await resumes it.
    state.currentAudioObj.audio.play().catch(() => {});
  } else {
    // Paused during a clip gap (no element exists) → re-kick the queue so the
    // next already-synthesized clip plays.
    drainQueue(state.playbackSession);
  }
}

// Pure timing rules (unit-tested in bargeIn.test.js).
// Returns 'none' | 'interrupt' | 'resume'.
function bargeInTimingAction({ loud, paused, now, lastLoudAt, burstStart, cfg }) {
  if (loud) {
    const burstActive = burstStart > 0 && now - lastLoudAt <= cfg.gapToleranceMs;
    const start = burstActive ? burstStart : now;
    if (paused && now - start >= cfg.interruptAfterMs) return 'interrupt';
    return 'none';
  }
  if (paused && now - lastLoudAt >= cfg.silentResumeMs) return 'resume';
  return 'none';
}

function isAgentSpeaking() {
  return (
    Boolean(state.currentAudioObj) ||
    state.isPlaying ||
    Object.keys(state.pendingClips).length > 0
  );
}

function getMicRms(analyser, samples) {
  analyser.getByteTimeDomainData(samples);

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const normalized = (samples[i] - 128) / 128;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / samples.length);
}

// ---------------- barge-in monitor ----------------
let monitorActive = false;

async function startBargeInMonitor() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const samples = new Uint8Array(analyser.fftSize);
  let loudFrames = 0;
  // When the current continuous speech burst began (0 = not speaking). Survives
  // word gaps up to gapToleranceMs so real interruptions actually accumulate.
  let burstStart = 0;

  // Quick mic sanity check so a silent/blocked mic is obvious in the console.
  let diagCount = 0;
  const diagTimer = setInterval(() => {
    const r = getMicRms(analyser, samples);
    console.log(`🎙 mic RMS: ${r.toFixed(3)}${r >= BARGE_IN.rmsThreshold ? ' (loud)' : ''}`);
    if (++diagCount >= 5) clearInterval(diagTimer);
  }, 500);

  function tick() {
    if (!monitorActive) return; // agent stopped

    const now = Date.now();
    const rms = getMicRms(analyser, samples);
    const loudEnough = rms >= BARGE_IN.rmsThreshold;
    const prevLoudAt = state.lastLoudAt;

    if (loudEnough) {
      // Long gap since the last loud frame → this is a NEW burst of speech.
      if (!burstStart || now - prevLoudAt > BARGE_IN.gapToleranceMs) burstStart = now;
      state.lastLoudAt = now;

      // First sound while the agent is speaking → pause it immediately.
      if (!state.tentativePause && isAgentSpeaking()) {
        loudFrames += 1;
        if (loudFrames >= BARGE_IN.consecutiveFrames) {
          console.log('⏸ Barge-in from mic level', rms.toFixed(3));
          pauseForBargeIn();
          loudFrames = 0;
        }
      }

      // Sustained speech (word gaps tolerated) → hard-stop and clear everything.
      if (
        bargeInTimingAction({
          loud: true,
          paused: state.tentativePause,
          now,
          lastLoudAt: state.lastLoudAt,
          burstStart,
          cfg: BARGE_IN,
        }) === 'interrupt'
      ) {
        console.log('🛑 Long interruption — clearing agent');
        addEvent('🛑 Interrupted — clearing my queue');
        interruptPlayback();
        burstStart = 0;
      }
    } else {
      loudFrames = 0;
      // Only a real gap (longer than a word pause) ends the burst.
      if (burstStart && now - prevLoudAt > BARGE_IN.gapToleranceMs) burstStart = 0;

      // Paused on a sound recognition never transcribed (cough/noise) → resume
      // once the user has truly been quiet for silentResumeMs.
      if (
        bargeInTimingAction({
          loud: false,
          paused: state.tentativePause,
          now,
          lastLoudAt: state.lastLoudAt,
          burstStart,
          cfg: BARGE_IN,
        }) === 'resume'
      ) {
        console.log('▶ Resuming (no result after silence)');
        resumeForAcknowledgment();
      }
    }

    requestAnimationFrame(tick);
  }

  monitorActive = true;
  requestAnimationFrame(tick);
}

// ---------------- speech recognition + turn handling ----------------
let recognition = null;
let running = false;
// Tracks the last time recognition produced a result or restarted — used by the
// watchdog to detect a recognizer that has silently died.
let lastRecognitionActivity = Date.now();
// Watchdog interval handle — cleared in stopAgent().
let recognitionWatchdog = null;
// Timestamp of the most recent barge-in pause. After a barge-in, the recognizer
// may take a moment to finalize the transcript — any result that arrives within
// WINDOW ms is the user's speech, NOT the agent's echo (see echo guard below).
let lastBargeInAt = 0;
const BARGE_IN_ECHO_GRACE_MS = 10000;
// Serializes recognition restarts between the watchdog and the onend handler so
// they don't both call start() → InvalidStateError.
let recognitionRestartPending = false;
// TTS concurrency limiter — OpenAI audio/speech has tight rate limits. Without
// this, every sentence fires a request simultaneously and most get 429'd.
let activeTtsRequests = 0;
const MAX_CONCURRENT_TTS = 2;

async function startAgent() {
  if (running) return;
  running = true;
  lastBargeInAt = 0; // fresh session — no prior barge-in
  micBtn.classList.add('listening');
  setStatus('Listening… tap the mic to stop');
  addEvent('🎤 Session started');

  try {
    await startBargeInMonitor();
  } catch (err) {
    addEvent('⚠️ Microphone access denied — allow it and tap again');
    setStatus('Microphone blocked');
    running = false;
    micBtn.classList.remove('listening');
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addEvent('⚠️ This browser does not support speech recognition (try Chrome)');
    setStatus('Unsupported browser');
    running = false;
    micBtn.classList.remove('listening');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  // onresult is kept SYNCHRONOUS on purpose: the full LLM/TTS round-trip can
  // take 10-20s, and Chrome may not fire the next onresult until the current
  // handler returns. We extract the transcript, run the echo guard, then hand
  // off to handleTurn() without awaiting — so the handler returns immediately
  // and the recognizer stays responsive to the next thing the user says.
  recognition.onresult = function (event) {
    lastRecognitionActivity = Date.now();

    // Only take the NEW results (from resultIndex) — stale fragments otherwise.
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    transcript = transcript.trim();
    if (!transcript) return;

    console.log('User:', transcript);

    // Echo guard: the agent's own TTS (through the speakers) can be transcribed
    // by the recognizer even when echo cancellation keeps our RMS gate quiet —
    // e.g. "Nia followed the melody" came back as "follow the memory". A real
    // user turn ALWAYS trips the barge-in pause first; a transcript that arrives
    // while the agent is talking and no pause ever happened is echo.
    //
    // BUG FIX: after a barge-in, there's a race between the silence-resume timer
    // (which clears tentativePause) and onresult firing with the user's transcript.
    // If onresult fires after the resume, the naive guard above would wrongly treat
    // the user's speech as echo. To prevent this, we skip the guard entirely for a
    // grace window after any barge-in pause — the recognizer is finalizing the
    // user's speech, not transcribing the agent's TTS.
    const recentlyBargedIn = Date.now() - lastBargeInAt < BARGE_IN_ECHO_GRACE_MS;
    if (isAgentSpeaking() && !state.tentativePause && !recentlyBargedIn) {
      console.log('🔇 Ignoring likely echo of agent speech:', transcript);
      addEvent('🔇 (ignored my own voice)');
      return;
    }

    // Offload the async work (don't await — see note above).
    handleTurn(transcript);
  };

  // Async part of turn handling — separated from onresult so the recognizer
  // event handler returns immediately and stays responsive.
  async function handleTurn(transcript) {
    addMessage('user', transcript);

    // Acknowledgment → continue the agent; real question → stop + answer.
    if (isAcknowledgment(transcript)) {
      console.log('🙂 Acknowledgment — agent continues speaking');
      addEvent('🙂 — continuing');
      resumeForAcknowledgment();
      return;
    }

    // A real question/sentence: hard-stop the agent, clear everything, respond.
    console.log('🗣 Real interruption — answering');
    addEvent('🛑 Interrupted — answering you');
    setStatus('Answering…');

    // Snapshot BEFORE interruptPlayback() (it resets nextToPlay to 0). The
    // deferred point is what the user has actually HEARD — played sentences —
    // not what the LLM generated, which always runs ahead of playback.
    const playedUpTo = state.playedUpTo;
    const oldSentences = { ...state.sentenceTexts };

    interruptPlayback();

    const heard = [];
    for (let i = 0; i <= playedUpTo; i++) {
      if (oldSentences[i]) heard.push(oldSentences[i]);
    }
    // What the agent still owes the user: an earlier deferral that was never
    // continued (survives multiple rapid interrupts), or what was just heard.
    const interruptedContext = state.pendingDeferred || heard.join(' ');
    state.pendingDeferred = interruptedContext; // cleared once it's been continued
    state.sentenceTexts = {}; // fresh for the new response
    if (interruptedContext) {
      addEvent('📝 Will finish my earlier point after this');
      console.log('📝 Deferred context:', interruptedContext.slice(0, 160));
    }

    let seq = 0;
    const session = state.playbackSession;
    state.responseFullyGenerated = false;
    try {
      // Phase 1 — answer the interruption ONLY (server prompt forbids
      // resuming the earlier point here).
      for await (const chunk of llmStreaming(transcript, interruptedContext)) {
        // A newer turn took over → stop consuming this abandoned stream.
        if (session !== state.playbackSession) break;
        addMessage('agent', chunk.delta);
        speak(chunk.delta, seq++);
      }
      // Phase 2 — DETERMINISTICALLY continue the deferred point, appended to
      // the same playback queue. This is the guarantee the deferral works:
      // it no longer depends on the model doing both parts in one response.
      if (interruptedContext && session === state.playbackSession) {
        addEvent('📝 Continuing my earlier point');
        for await (const chunk of llmStreaming(
          '(Continue exactly where you left off before my interruption.)',
          interruptedContext,
          'continue'
        )) {
          if (session !== state.playbackSession) break;
          addMessage('agent', chunk.delta);
          speak(chunk.delta, seq++);
        }
      }
      // Generation finished. The drain loop may have exited while the last clips
      // were still synthesizing — restart it so the tail always plays.
      if (session === state.playbackSession) {
        state.responseFullyGenerated = true;
        drainQueue(session);
        state.pendingDeferred = ''; // deferral delivered
      }
    } catch (err) {
      // A dead stream (network drop, malformed SSE) must never leave the agent
      // stuck in "Answering…" with no recovery path.
      console.error('Turn handling error:', err);
      if (session === state.playbackSession) {
        addEvent('⚠️ Something went wrong — try again');
        setStatus('Ready — tap the mic and talk');
        state.responseFullyGenerated = true;
        drainQueue(session);
      }
    }
    setStatus('Agent speaking…');
  }

  // Chrome ends the recognition session after long silence — restart it.
  // This is the critical keepalive: if start() throws (e.g. the previous
  // session hasn't fully torn down after rapid restart cycles), retry after a
  // short delay instead of letting recognition die silently.
  //
  // The watchdog below may also try to restart. To avoid both paths calling
  // start() → InvalidStateError, whichever path is pending sets
  // recognitionRestartPending and the other path skips.
  recognition.onend = function () {
    lastRecognitionActivity = Date.now();
    if (!running) return;
    if (recognitionRestartPending) return; // watchdog owns the restart
    try {
      recognition.start();
      console.log('🔄 Recognition restarted');
    } catch {
      // start() can throw if the previous session hasn't fully torn down.
      // Retry after a short delay instead of giving up.
      console.log('🔄 Recognition restart delayed, retrying…');
      recognitionRestartPending = true;
      setTimeout(() => {
        recognitionRestartPending = false;
        if (!running) return;
        try {
          recognition.start();
          lastRecognitionActivity = Date.now();
          console.log('🔄 Recognition restarted on retry');
        } catch (err) {
          console.error('❌ Failed to restart recognition:', err);
          addEvent('⚠️ Mic stopped listening — tap the mic to restart');
          stopAgent();
        }
      }, 500);
    }
  };

  recognition.onerror = function (e) {
    lastRecognitionActivity = Date.now();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addEvent('⚠️ Speech recognition blocked — allow mic access');
      stopAgent();
    }
    // Other errors (e.g. 'no-speech', 'aborted') are transient — onend will
    // fire next and trigger a restart, so we don't need to handle them here.
  };

  recognition.start();
  lastRecognitionActivity = Date.now();

  // Watchdog: if recognition has been silent for a while (no onresult, no onend
  // restart) and the agent isn't speaking, the recognizer may have died without
  // firing onerror. Force a restart.
  //
  // Uses recognitionRestartPending to avoid racing with the onend handler's
  // own restart — only one path may own the restart at a time.
  recognitionWatchdog = setInterval(() => {
    if (!running) return;
    if (recognitionRestartPending) return; // onend owns the restart
    const idle = Date.now() - lastRecognitionActivity;
    // Only act when the agent is not speaking — during a long response it's
    // normal for the recognizer to be quiet.
    if (idle > 25000 && !isAgentSpeaking()) {
      console.log(`🔄 Watchdog: recognition idle for ${(idle / 1000).toFixed(0)}s, restarting`);
      recognitionRestartPending = true;
      try {
        recognition.stop();
      } catch {
        /* not running */
      }
      setTimeout(() => {
        recognitionRestartPending = false;
        if (!running) return;
        try {
          recognition.start();
          lastRecognitionActivity = Date.now();
        } catch (err) {
          console.error('Watchdog restart failed:', err);
          // onend will fire from the failed start and handle the retry.
        }
      }, 300);
    }
  }, 10000);
}

function stopAgent() {
  running = false;
  monitorActive = false;
  if (recognitionWatchdog) {
    clearInterval(recognitionWatchdog);
    recognitionWatchdog = null;
  }
  interruptPlayback();
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  }
  micBtn.classList.remove('listening');
  setStatus('Stopped — tap the mic to start again');
  addEvent('⏹ Session stopped');
}

// ---------------- wiring ----------------
if (isBrowser) {
  micBtn.addEventListener('click', () => {
    if (running) {
      stopAgent();
    } else {
      startAgent();
    }
  });
}

// Exports let bargeIn.test.js exercise the pure timing rules in Node.
if (typeof module !== 'undefined') {
  module.exports = { bargeInTimingAction, BARGE_IN };
}



