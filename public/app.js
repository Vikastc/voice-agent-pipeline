// ============================================================
// Voice Agent — frontend
// Same state machine as the prototype (barge-in, acknowledgments,
// echo guard, heard-based deferral). The OpenAI key stays server-side:
// LLM + TTS go through the /api/* serverless proxies with token quota tracking.
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
  rmsThreshold: 0.06,     // mic level considered "loud"
  consecutiveFrames: 3,   // ~50ms of loudness = a real sound → pause
  interruptAfterMs: 2500, // continuous speech past this = real interruption
  gapToleranceMs: 600,    // word gaps don't reset the burst clock
  silentResumeMs: 3000,   // while paused: hold and listen until user is quiet
  resumeQuietMs: 400,     // never resume until mic has been quiet this long
};

// ---------------- UI helpers & Auth State ----------------
const isBrowser = typeof window !== 'undefined';
let authToken = isBrowser ? localStorage.getItem('va_token') : null;
let currentUserId = null;
let tokensUsed = 0;
let maxTokens = 20000;

const micBtn = isBrowser ? document.getElementById('micBtn') : null;
const statusEl = isBrowser ? document.getElementById('status') : null;
const messagesEl = isBrowser ? document.getElementById('messages') : null;

// Auth & Quota Elements
const authBar = isBrowser ? document.getElementById('authBar') : null;
const userNameEl = isBrowser ? document.getElementById('userName') : null;
const tokensRemainingEl = isBrowser ? document.getElementById('tokensRemaining') : null;
const quotaProgressEl = isBrowser ? document.getElementById('quotaProgress') : null;
const logoutBtn = isBrowser ? document.getElementById('logoutBtn') : null;

const authModal = isBrowser ? document.getElementById('authModal') : null;
const loginForm = isBrowser ? document.getElementById('loginForm') : null;
const accessKeyInput = isBrowser ? document.getElementById('accessKeyInput') : null;
const loginError = isBrowser ? document.getElementById('loginError') : null;

const quotaModal = isBrowser ? document.getElementById('quotaModal') : null;
const switchKeyBtn = isBrowser ? document.getElementById('switchKeyBtn') : null;

const textForm = isBrowser ? document.getElementById('textForm') : null;
const textInput = isBrowser ? document.getElementById('textInput') : null;

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

// ---------------- Quota & Modal Management ----------------
function updateQuotaUI(used, max) {
  tokensUsed = typeof used === 'number' ? used : tokensUsed;
  maxTokens = typeof max === 'number' ? max : maxTokens;

  const remaining = Math.max(0, maxTokens - tokensUsed);
  if (tokensRemainingEl) {
    tokensRemainingEl.textContent = remaining.toLocaleString();
  }

  const pct = Math.max(0, Math.min(100, (remaining / maxTokens) * 100));
  if (quotaProgressEl) {
    quotaProgressEl.style.width = `${pct}%`;
    if (pct <= 10) {
      quotaProgressEl.style.backgroundColor = '#ef4444'; // Red
    } else if (pct <= 25) {
      quotaProgressEl.style.backgroundColor = '#f59e0b'; // Amber
    } else {
      quotaProgressEl.style.backgroundColor = '#10b981'; // Green
    }
  }

  if (remaining === 0) {
    showQuotaModal();
  }
}

function showAuthModal() {
  if (authModal) {
    authModal.style.display = 'flex';
    if (accessKeyInput) accessKeyInput.focus();
  }
}

function hideAuthModal() {
  if (authModal) authModal.style.display = 'none';
  if (loginError) loginError.style.display = 'none';
}

function showQuotaModal() {
  stopAgent();
  if (quotaModal) quotaModal.style.display = 'flex';
  setStatus('Token quota exhausted (20,000 / 20,000)');
}

function hideQuotaModal() {
  if (quotaModal) quotaModal.style.display = 'none';
}

async function verifyAuthSession() {
  if (!authToken) {
    showAuthModal();
    return false;
  }
  try {
    const res = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) {
      localStorage.removeItem('va_token');
      authToken = null;
      showAuthModal();
      return false;
    }
    const data = await res.json();
    currentUserId = data.user;
    if (userNameEl) userNameEl.textContent = currentUserId;
    if (authBar) authBar.style.display = 'flex';
    updateQuotaUI(data.tokensUsed, data.maxTokens);
    hideAuthModal();
    return true;
  } catch (err) {
    console.warn('Auth check warning:', err);
    return false;
  }
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
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ userText, interruptedContext, mode }),
    });
  } catch (err) {
    addEvent('⚠️ Could not reach the LLM');
    return;
  }

  if (response.status === 401) {
    addEvent('⚠️ Session expired — please sign in with an access key');
    showAuthModal();
    return;
  }

  if (response.status === 403) {
    addEvent('⛔ Token quota reached (20,000 / 20,000 used)');
    showQuotaModal();
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
      // Check for token usage update event
      if (event.includes('event: token_usage')) {
        const dataLine = event
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (dataLine) {
          try {
            const usageInfo = JSON.parse(dataLine.slice(6));
            if (usageInfo.tokensUsed !== undefined) {
              updateQuotaUI(usageInfo.tokensUsed, usageInfo.maxTokens);
              if (usageInfo.token) {
                authToken = usageInfo.token;
                localStorage.setItem('va_token', usageInfo.token);
              }
            }
          } catch {}
        }
        continue;
      }

      const payload = event
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');

      if (!payload || payload === '[DONE]') continue;

      try {
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
      } catch {}
    }
  }

  const leftover = sentenceBuffer.trim();
  if (leftover) {
    yield { textContent, isFinal: true, delta: leftover };
  }
}

// ---------------- TTS (through the serverless proxy) ----------------
let activeTtsRequests = 0;
const MAX_CONCURRENT_TTS = 2;

async function speak(text = '', seq = 0) {
  const session = state.playbackSession;
  state.sentenceTexts[seq] = text;

  // Wait for a free TTS slot (concurrency limiter).
  while (activeTtsRequests >= MAX_CONCURRENT_TTS) {
    if (session !== state.playbackSession) return;
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
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ text }),
        });
      } catch (err) {
        console.warn('🔇 TTS request failed for seq', seq, err);
        return;
      }
      if (response.ok) break;
      if (response.status === 401) {
        showAuthModal();
        return;
      }
      if (response.status === 403) {
        showQuotaModal();
        return;
      }
      if (response.status === 429) {
        const backoff = 1000 * Math.pow(2, attempt);
        console.log(`🔇 TTS 429 on seq ${seq}, backing off ${backoff}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      break;
    }

    if (!response || !response.ok) {
      console.warn('🔇 TTS rejected for seq', seq, response && response.status);
      return;
    }

    // Read updated tokens from headers if present
    const updatedTokens = response.headers.get('X-Tokens-Used');
    const updatedToken = response.headers.get('X-New-Token');
    if (updatedTokens !== null) {
      updateQuotaUI(Number(updatedTokens), maxTokens);
    }
    if (updatedToken) {
      authToken = updatedToken;
      localStorage.setItem('va_token', updatedToken);
    }

    let audioBlob;
    try {
      audioBlob = await response.blob();
    } catch (err) {
      console.warn('🔇 TTS blob failed for seq', seq, err);
      return;
    }

    if (session !== state.playbackSession) return;

    state.pendingClips[seq] = audioBlob;
    drainQueue(session);
  } finally {
    activeTtsRequests--;
  }
}

async function drainQueue(session) {
  if (state.isPlaying) return;
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
          state.playedUpTo = seq;
        } catch (err) {
          console.warn('🔇 Clip playback failed for seq', seq, err);
        }
      } else if (state.responseFullyGenerated) {
        const remaining = Object.keys(state.pendingClips)
          .map(Number)
          .sort((a, b) => a - b);
        if (!remaining.length) break;
        console.log('⏭ Skipping failed clip seq', state.nextToPlay, '→', remaining[0]);
        state.nextToPlay = remaining[0];
      } else {
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

  state.pendingClips = {};
  state.nextToPlay = 0;
}

let lastBargeInAt = 0;
const BARGE_IN_ECHO_GRACE_MS = 10000;

function pauseForBargeIn() {
  if (state.tentativePause || !state.currentAudioObj) return;
  state.tentativePause = true;
  lastBargeInAt = Date.now();
  state.currentAudioObj.audio.pause();
  addEvent('⏸ Paused — listening to you…');
  setStatus('Paused — listening…');
}

function resumeForAcknowledgment() {
  if (!state.tentativePause) return;
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
let bargeStream = null;
let bargeAudioCtx = null;

function stopBargeInMonitor() {
  monitorActive = false;
  try { bargeAudioCtx?.close(); } catch {}
  bargeAudioCtx = null;
  try { bargeStream?.getTracks().forEach((t) => t.stop()); } catch {}
  bargeStream = null;
}

async function startBargeInMonitor() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  bargeStream = stream;
  const audioContext = new AudioContext();
  bargeAudioCtx = audioContext;
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
  let burstStart = 0;

  function tick() {
    if (!monitorActive) return;

    const now = Date.now();
    const rms = getMicRms(analyser, samples);
    const loudEnough = rms >= BARGE_IN.rmsThreshold;
    const prevLoudAt = state.lastLoudAt;

    if (loudEnough) {
      if (!burstStart || now - prevLoudAt > BARGE_IN.gapToleranceMs) burstStart = now;
      state.lastLoudAt = now;

      if (!state.tentativePause && isAgentSpeaking()) {
        loudFrames += 1;
        if (loudFrames >= BARGE_IN.consecutiveFrames) {
          console.log('⏸ Barge-in from mic level', rms.toFixed(3));
          pauseForBargeIn();
          loudFrames = 0;
        }
      }

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
      if (burstStart && now - prevLoudAt > BARGE_IN.gapToleranceMs) burstStart = 0;

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
let lastRecognitionActivity = Date.now();
let recognitionWatchdog = null;
let recognitionRestartPending = false;
let consecutiveDeadRestarts = 0; // resultless restarts → engine went deaf (Chrome bug)
let rebuildsSinceResult = 0;     // fresh engines built since the last successful transcript

function createRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.lang = 'en-US';

  rec.onresult = function (event) {
    lastRecognitionActivity = Date.now();
    consecutiveDeadRestarts = 0;
    rebuildsSinceResult = 0;
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
    transcript = transcript.trim();
    if (!transcript) return;

    console.log('User:', transcript);

    const recentlyBargedIn = Date.now() - lastBargeInAt < BARGE_IN_ECHO_GRACE_MS;
    if (isAgentSpeaking() && !state.tentativePause && !recentlyBargedIn) {
      console.log('🔇 Ignoring likely echo of agent speech:', transcript);
      addEvent('🔇 (ignored my own voice)');
      return;
    }

    handleTurn(transcript);
  };

  rec.onend = function () {
    lastRecognitionActivity = Date.now();
    if (!running) return;
    if (recognitionRestartPending) return;

    // Chrome bug: a long-lived SpeechRecognition instance can stop yielding
    // results but keep firing onend. Restarting the same deaf instance in a
    // tight loop never recovers — count dead restarts and rebuild the engine.
    consecutiveDeadRestarts += 1;
    const engineDeaf = consecutiveDeadRestarts >= 4;

    // Escalation: if even freshly built engines hear nothing, the mic capture
    // itself is starving the speech service (AudioContext + SpeechRecognition
    // fighting over the mic). Tear down the whole mic stack and re-acquire it.
    if (engineDeaf && rebuildsSinceResult >= 2) {
      recognitionRestartPending = true;
      fullMicRestart('fresh engines still get no results');
      return;
    }

    recognitionRestartPending = true;
    setTimeout(() => {
      recognitionRestartPending = false;
      if (!running) return;

      if (engineDeaf) {
        consecutiveDeadRestarts = 0;
        rebuildsSinceResult += 1;
        console.log('♻️ Recognition went silent — rebuilding engine');
        addEvent('♻️ Rebuilding listener…');
        try { recognition.abort(); } catch {}
        recognition = createRecognition();
      }

      try {
        recognition.start();
        lastRecognitionActivity = Date.now();
        console.log('🔄 Recognition restarted');
      } catch (err) {
        console.error('❌ Failed to restart recognition:', err);
      }
    }, engineDeaf ? 750 : 250);
  };

  rec.onerror = function (e) {
    lastRecognitionActivity = Date.now();
    console.warn('⚠️ Recognition error:', e.error);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addEvent('⚠️ Speech recognition blocked — allow mic access');
      stopAgent();
    }
    // 'no-speech', 'audio-capture', 'network', 'aborted' are recoverable — onend restarts us
  };

  // Diagnostics: make Chrome's internal recognition lifecycle visible in the console.
  rec.onstart = () => console.log('🎤 Recognition started');
  rec.onaudiostart = () => console.log('🔊 Recognition audio capture started');
  rec.onspeechstart = () => console.log('🗣️ Recognition hears speech');
  rec.onspeechend = () => console.log('🤫 Recognition speech window ended');

  return rec;
}

// Full teardown + rebuild of the getUserMedia stream, AudioContext and engine.
async function fullMicRestart(reason) {
  console.log('🧊 Full mic-stack restart —', reason);
  addEvent('🧊 Restarting microphone pipeline…');

  try { recognition?.abort(); } catch {}
  recognition = null;
  stopBargeInMonitor();

  await new Promise((r) => setTimeout(r, 900));
  if (!running) {
    recognitionRestartPending = false;
    return;
  }

  try {
    await startBargeInMonitor();
  } catch (err) {
    console.error('❌ Could not re-acquire microphone:', err);
    addEvent('⚠️ Mic lost — tap the mic to restart');
    stopAgent();
    return;
  }

  recognition = createRecognition();
  try {
    recognition.start();
    consecutiveDeadRestarts = 0;
    rebuildsSinceResult = 0;
    lastRecognitionActivity = Date.now();
    console.log('🔄 Recognition restarted (cold)');
  } catch (err) {
    console.error('❌ Cold restart failed:', err);
  } finally {
    recognitionRestartPending = false;
  }
}

// Async part of turn handling
async function handleTurn(transcript) {
  if (!transcript || !transcript.trim()) return;
  transcript = transcript.trim();

  if (!authToken) {
    showAuthModal();
    return;
  }
  if (tokensUsed >= maxTokens) {
    showQuotaModal();
    return;
  }

  addMessage('user', transcript);

  if (isAcknowledgment(transcript)) {
    console.log('🙂 Acknowledgment — agent continues speaking');
    addEvent('🙂 — continuing');
    resumeForAcknowledgment();
    return;
  }

  console.log('🗣 Answering:', transcript);
  addEvent('🛑 Answering you…');
  setStatus('Answering…');

  const playedUpTo = state.playedUpTo;
  const oldSentences = { ...state.sentenceTexts };

  interruptPlayback();

  const heard = [];
  for (let i = 0; i <= playedUpTo; i++) {
    if (oldSentences[i]) heard.push(oldSentences[i]);
  }
  const interruptedContext = state.pendingDeferred || heard.join(' ');
  state.pendingDeferred = interruptedContext;
  state.sentenceTexts = {};
  if (interruptedContext) {
    addEvent('📝 Will finish my earlier point after this');
  }

  let seq = 0;
  const session = state.playbackSession;
  state.responseFullyGenerated = false;

  try {
    for await (const chunk of llmStreaming(transcript, interruptedContext)) {
      if (session !== state.playbackSession) break;
      addMessage('agent', chunk.delta);
      speak(chunk.delta, seq++);
    }

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

    if (session === state.playbackSession) {
      state.responseFullyGenerated = true;
      drainQueue(session);
      state.pendingDeferred = '';
    }
  } catch (err) {
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

async function startAgent() {
  if (running) return;

  if (!authToken) {
    showAuthModal();
    return;
  }
  if (tokensUsed >= maxTokens) {
    showQuotaModal();
    return;
  }

  running = true;
  micBtn.classList.add('listening');
  setStatus('Listening… tap the mic to stop');
  addEvent('🎤 Session started');

  stopBargeInMonitor();
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
    addEvent('⚠️ This browser does not support speech recognition (try Chrome or type below)');
    setStatus('Unsupported browser — use text input');
    return;
  }

  // Fresh session: reset lifecycle counters and build a new engine.
  consecutiveDeadRestarts = 0;
  rebuildsSinceResult = 0;
  recognition = createRecognition();

  try {
    recognition.start();
  } catch {}
  lastRecognitionActivity = Date.now();

  recognitionWatchdog = setInterval(() => {
    if (!running) return;
    if (recognitionRestartPending) return;
    const idle = Date.now() - lastRecognitionActivity;
    if (idle > 25000 && !isAgentSpeaking()) {
      console.log(`🔄 Watchdog: recognition idle for ${(idle / 1000).toFixed(0)}s — forcing rebuild`);
      consecutiveDeadRestarts = 4; // next onend rebuilds a fresh engine
      try {
        recognition.stop();
      } catch {}
    }
  }, 10000);

  // Greet immediately
  const greeting = "Hi! I'm listening — ask me anything, and feel free to interrupt me.";
  addMessage('agent', greeting);
  setStatus('Agent speaking…');
  speak(greeting, 0);
}

function stopAgent() {
  running = false;
  stopBargeInMonitor();
  if (recognitionWatchdog) {
    clearInterval(recognitionWatchdog);
    recognitionWatchdog = null;
  }
  interruptPlayback();
  if (recognition) {
    try {
      recognition.stop();
    } catch {}
  }
  if (micBtn) micBtn.classList.remove('listening');
  setStatus('Stopped — tap the mic to start again');
  addEvent('⏹ Session stopped');
}

// ---------------- wiring & initialization ----------------
if (isBrowser) {
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      if (running) {
        stopAgent();
      } else {
        startAgent();
      }
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = (accessKeyInput?.value || '').trim();
      if (!key) return;

      const submitBtn = document.getElementById('loginSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      if (loginError) loginError.style.display = 'none';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (loginError) {
            loginError.textContent = data.error || 'Invalid key';
            loginError.style.display = 'block';
          }
          return;
        }

        authToken = data.token;
        localStorage.setItem('va_token', data.token);
        currentUserId = data.user;
        if (userNameEl) userNameEl.textContent = currentUserId;
        if (authBar) authBar.style.display = 'flex';
        updateQuotaUI(data.tokensUsed, data.maxTokens);
        hideAuthModal();
        addEvent(`🔓 Signed in as ${currentUserId}`);

        // Greet on first login
        const greeting = "Hi! I'm listening — ask me anything, and feel free to interrupt me.";
        addMessage('agent', greeting);
        setStatus('Agent speaking…');
        speak(greeting, 0);
      } catch (err) {
        if (loginError) {
          loginError.textContent = `Login failed: ${err.message}`;
          loginError.style.display = 'block';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      stopAgent();
      authToken = null;
      currentUserId = null;
      localStorage.removeItem('va_token');
      if (authBar) authBar.style.display = 'none';
      showAuthModal();
      setStatus('Signed out — enter access key to start');
      addEvent('🔒 Signed out');
    });
  }

  if (switchKeyBtn) {
    switchKeyBtn.addEventListener('click', () => {
      hideQuotaModal();
      authToken = null;
      currentUserId = null;
      localStorage.removeItem('va_token');
      if (authBar) authBar.style.display = 'none';
      showAuthModal();
    });
  }

  if (textForm && textInput) {
    textForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = textInput.value.trim();
      if (!val) return;
      if (!authToken) {
        showAuthModal();
        return;
      }
      if (tokensUsed >= maxTokens) {
        showQuotaModal();
        return;
      }
      textInput.value = '';
      handleTurn(val);
    });
  }

  verifyAuthSession();
}

// Exports let bargeIn.test.js exercise the pure timing rules in Node.
if (typeof module !== 'undefined') {
  module.exports = { bargeInTimingAction, BARGE_IN };
}
