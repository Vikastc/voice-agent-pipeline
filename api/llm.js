// Vercel Edge Function: streaming LLM proxy.
// Keeps OPENAI_API_KEY server-side — the browser only ever calls /api/*.

export const config = { runtime: 'edge' };

const MODEL = 'gpt-5.6-luna';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Basic input validation at the trust boundary.
  const userText = typeof body.userText === 'string' ? body.userText.slice(0, 2000) : '';
  const interruptedContext =
    typeof body.interruptedContext === 'string' ? body.interruptedContext.slice(0, 8000) : '';
  if (!userText) return new Response('Missing userText', { status: 400 });

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

  const upstream = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input, stream: true }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`LLM upstream error (${upstream.status})`, { status: 502 });
  }

  // Pass the SSE stream straight through to the browser.
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
    },
  });
}
