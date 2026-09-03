// Self-check for the barge-in timing rules in app.js (run: node bargeIn.test.js).
// Simulates mic loud/quiet frames over time and asserts the hard rules:
//   1. Short burst (ack / cough)  -> pause, then resume after silence. NEVER interrupt.
//   2. Sustained speech >= 2.5s   -> interrupt (word gaps do NOT reset the clock).
//   3. Cough now + noise 3s later -> still NO interrupt (not continuous speech).
const assert = require('assert');
const { bargeInTimingAction, BARGE_IN } = require('./app.js');

// Mirrors the burst bookkeeping in startBargeInMonitor's tick().
function simulate(frames) {
  // frames: array of { loud, dt } — dt is ms since the previous frame.
  let burstStart = 0;
  let lastLoudAt = 0;
  let now = 0;
  let paused = false;
  const actions = [];

  for (const { loud, dt } of frames) {
    now += dt;
    const prevLoudAt = lastLoudAt;

    if (loud) {
      if (!burstStart || now - prevLoudAt > BARGE_IN.gapToleranceMs) burstStart = now;
      lastLoudAt = now;
      // The caller pauses on the first sustained loud frames (frame-count gate);
      // for the timing test we model it as: pause happens on the 1st loud frame.
      if (!paused) paused = true;
    } else if (burstStart && now - prevLoudAt > BARGE_IN.gapToleranceMs) {
      burstStart = 0;
    }

    const action = bargeInTimingAction({
      loud,
      paused,
      now,
      lastLoudAt,
      burstStart,
      cfg: BARGE_IN,
    });

    if (action === 'interrupt') {
      actions.push('interrupt');
      paused = false;
      burstStart = 0;
    } else if (action === 'resume') {
      actions.push('resume');
      paused = false;
    }
  }
  return actions;
}

// 1. Short ack "okay" (~600ms of speech), then quiet. Must resume, never interrupt.
{
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push({ loud: true, dt: 50 }); // 600ms speech
  for (let i = 0; i < 60; i++) frames.push({ loud: false, dt: 50 }); // 3s silence
  const actions = simulate(frames);
  assert.deepStrictEqual(actions, ['resume'], `ack case got: ${actions}`);
  console.log('✓ ack: pause → resume after silence, no interrupt');
}

// 2. Sustained speech with natural word gaps for 3s total → must interrupt.
{
  const frames = [];
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) frames.push({ loud: true, dt: 50 });
    for (let j = 0; j < 4; j++) frames.push({ loud: false, dt: 50 });
  }
  const actions = simulate(frames);
  assert.ok(actions.includes('interrupt'), `sustained case got: ${actions}`);
  assert.ok(!actions.includes('resume'), `sustained case must not resume: ${actions}`);
  console.log('✓ sustained speech: interrupts (word gaps tolerated), never resumes');
}

// 3. Cough at t=0, silence, another cough 3s later → must NOT interrupt.
{
  const frames = [{ loud: true, dt: 0 }]; // cough
  for (let i = 0; i < 59; i++) frames.push({ loud: false, dt: 50 }); // ~3s quiet
  frames.push({ loud: true, dt: 50 }); // second cough ~3s later
  for (let i = 0; i < 50; i++) frames.push({ loud: false, dt: 50 });
  const actions = simulate(frames);
  assert.ok(!actions.includes('interrupt'), `cough case must not interrupt: ${actions}`);
  console.log('✓ isolated coughs never escalate to interrupt');
}

// 4. Long gap inside an utterance breaks the burst (user actually stopped).
{
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push({ loud: true, dt: 50 }); // 600ms
  frames.push({ loud: false, dt: 900 }); // 900ms gap > tolerance → new burst
  for (let i = 0; i < 12; i++) frames.push({ loud: true, dt: 50 }); // 600ms more
  for (let i = 0; i < 80; i++) frames.push({ loud: false, dt: 50 });
  const actions = simulate(frames);
  assert.ok(!actions.includes('interrupt'), `two short bursts got: ${actions}`);
  console.log('✓ two short bursts separated by a real gap do not interrupt');
}

// 5. Config sanity: thresholds ordered so both rules can fire.
assert.ok(BARGE_IN.gapToleranceMs < BARGE_IN.interruptAfterMs);
assert.ok(BARGE_IN.resumeQuietMs < BARGE_IN.silentResumeMs);
console.log('✓ config thresholds sane');

console.log('\nAll barge-in timing checks passed.');
