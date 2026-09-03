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
};

const BARGE_IN = {
  rmsThreshold: 0.1,      // mic level considered "loud"
  consecutiveFrames: 3,   // ~50ms of loudness = a real sound → pause
  interruptAfterMs: 2500, // continuous speech past this = real interruption
  gapToleranceMs: 600,    // word gaps don't reset the burst clock
  silentResumeMs: 2000,   // untranscribed noise → resume after this silence
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
async function* llmStreaming(userText = '', interruptedContext = '') {
  let response;
  try {
    response = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText, interruptedContext }),
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
      const end = rest.search(/[.?]/);
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

  let response = null;
  for (let attempt = 0; attempt < 2; attempt++) {
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
    if (response.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 800)); // one gentle retry on rate limit
      continue;
    }
    break;
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
  if (state.tentativePause || !state.currentAudioObj) return;
  state.tentativePause = true;
  state.currentAudioObj.audio.pause();
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
    state.currentAudioObj.audio.play().catch(() => {});
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

async function startAgent() {
  if (running) return;
  running = true;
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

  recognition.onresult = async function (event) {
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
    if (isAgentSpeaking() && !state.tentativePause) {
      console.log('🔇 Ignoring likely echo of agent speech:', transcript);
      addEvent('🔇 (ignored my own voice)');
      return;
    }

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
    const interruptedContext = heard.join(' ');
    state.sentenceTexts = {}; // fresh for the new response
    if (interruptedContext) {
      addEvent('📝 Will finish my earlier point after this');
    }

    let seq = 0;
    const session = state.playbackSession;
    state.responseFullyGenerated = false;
    for await (const chunk of llmStreaming(transcript, interruptedContext)) {
      // A newer turn took over → stop consuming this abandoned stream.
      if (session !== state.playbackSession) break;
      addMessage('agent', chunk.delta);
      speak(chunk.delta, seq++);
    }
    // Generation finished. The drain loop may have exited while the last clips
    // were still synthesizing — restart it so the tail always plays.
    if (session === state.playbackSession) {
      state.responseFullyGenerated = true;
      drainQueue(session);
    }
    setStatus('Agent speaking…');
  };

  // Chrome ends the recognition session after long silence — restart it.
  recognition.onend = function () {
    if (!running) return;
    try {
      recognition.start();
    } catch {
      /* already starting */
    }
  };

  recognition.onerror = function (e) {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addEvent('⚠️ Speech recognition blocked — allow mic access');
      stopAgent();
    }
  };

  recognition.start();

  // Greet immediately so the user hears the pipeline working (and can barge in).
  const greeting = "Hi! I'm listening — ask me anything, and feel free to interrupt me.";
  addMessage('agent', greeting);
  setStatus('Agent speaking…');
  speak(greeting, 0);
}

function stopAgent() {
  running = false;
  monitorActive = false;
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



