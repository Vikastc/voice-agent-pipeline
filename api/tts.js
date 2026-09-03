// Vercel Edge Function: text-to-speech proxy.
// Keeps OPENAI_API_KEY server-side — the browser only ever calls /api/*.

export const config = { runtime: 'edge' };

const MODEL = 'gpt-4o-mini-tts';
const VOICE = 'coral';

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

  const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : '';
  if (!text) return new Response('Missing text', { status: 400 });

  const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: text,
      instructions: 'Speak in a cheerful, warm and natural tone.',
      response_format: 'mp3',
    }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(`TTS upstream error (${upstream.status})`, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
    },
  });
}
