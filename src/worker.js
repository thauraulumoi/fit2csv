const MODEL = 'openai/gpt-5.6-terra';
const MAX_BODY_BYTES = 96 * 1024;
const DAILY_LIMIT = 3;

const LANGUAGE_NAMES = {
  en: 'English',
  vi: 'Vietnamese',
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese'
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    overall_assessment: { type: 'string' },
    pacing_and_effort: { type: 'string' },
    heart_rate: { type: 'string' },
    running_form: { type: 'string' },
    positives: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    cautions: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    next_session: { type: 'string' },
    data_notes: { type: 'array', items: { type: 'string' }, maxItems: 4 }
  },
  required: [
    'headline',
    'overall_assessment',
    'pacing_and_effort',
    'heart_rate',
    'running_form',
    'positives',
    'cautions',
    'next_session',
    'data_notes'
  ],
  additionalProperties: false
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/analyze') {
      return handleAnalyze(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleAnalyze(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
  }

  if (!env.AI || !env.AI_LIMITER) {
    return json({
      code: 'AI_SERVICE_UNAVAILABLE',
      error: 'AI analysis is temporarily unavailable.'
    }, 503);
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return json({ error: 'Content-Type must be application/json.' }, 415);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: 'Analysis payload is too large.' }, 413);
  }

  let payload;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'Analysis payload is too large.' }, 413);
    }
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON payload.' }, 400);
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    return json({ error: validationError }, 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) {
    return json({
      code: 'AI_SERVICE_UNAVAILABLE',
      error: 'AI analysis is temporarily unavailable.'
    }, 503);
  }

  const ipHash = await sha256Hex(ip);
  const limiterId = env.AI_LIMITER.idFromName(ipHash);
  const limiter = env.AI_LIMITER.get(limiterId);

  const claimResponse = await limiter.fetch('https://limiter/claim', { method: 'POST' });
  const claim = await claimResponse.json();

  if (!claim.allowed) {
    return json({
      code: 'DAILY_LIMIT_REACHED',
      error: 'Daily AI analysis limit reached.',
      limit: DAILY_LIMIT,
      remaining: 0,
      resets_at: claim.resets_at
    }, 429, {
      'Retry-After': String(claim.retry_after_seconds || secondsUntilNextUtcDay())
    });
  }

  const languageCode = String(payload.analysis_language || 'en').toLowerCase();
  const languageName = LANGUAGE_NAMES[languageCode] || LANGUAGE_NAMES.en;

  const instructions = `You are FIT2CSV Workout Analyst. Analyze one endurance workout from compact, deterministic metrics derived in the user's browser from a FIT file.

Rules:
- Base every claim only on the supplied data. Never invent missing values.
- This is workout analysis, not medical diagnosis. Do not diagnose disease, injury, arrhythmia, or other health conditions.
- If heart-rate behavior looks unusual, describe the data pattern neutrally and suggest reducing effort or seeking professional advice only when appropriate; do not make a diagnosis.
- Distinguish intentional workload increases from heart-rate drift. If speed or power also rises, do not label the HR rise as drift without evidence.
- Use lap and window trends when available.
- Comment on cadence, power, and running form only when those fields are present.
- Keep the tone concise, practical, and coach-like. Avoid hype.
- next_session must be a conservative general suggestion based only on this single workout; do not pretend to know the athlete's full training history.
- data_notes should state important limitations or missing fields that affect confidence.
- Write every human-facing string value in ${languageName}. Keep JSON property names exactly as defined by the schema.
- Return only JSON matching the requested schema.`;

  const input = `Analyze this workout. Values retain the units shown in the JSON. The payload intentionally excludes filename, serial number, GPS coordinates, and raw second-by-second records.

${JSON.stringify(payload)}`;

  try {
    const result = await env.AI.run(MODEL, {
      input,
      instructions,
      reasoning: {
        effort: 'low'
      },
      text: {
        format: {
          type: 'json_schema',
          name: 'fit2csv_workout_analysis',
          strict: true,
          schema: ANALYSIS_SCHEMA
        }
      },
      max_output_tokens: 1400,
      store: false
    });

    const outputText = extractOutputText(result);
    if (!outputText) {
      await refundClaim(limiter);
      throw new Error('AI returned no structured output.');
    }

    let analysis;
    try {
      analysis = JSON.parse(outputText);
    } catch {
      await refundClaim(limiter);
      throw new Error('AI returned invalid structured output.');
    }

    return json({
      analysis,
      remaining: Math.max(0, Number(claim.remaining ?? 0)),
      limit: DAILY_LIMIT,
      resets_at: claim.resets_at
    }, 200, {
      'Cache-Control': 'no-store'
    });
  } catch (error) {
    console.error('Cloudflare AI analysis failed:', error);
    await refundClaim(limiter);

    const errorText = String(error?.message || error || '').toLowerCase();

    if (errorText.includes('quota') || errorText.includes('usage limit')) {
      return json({
        code: 'AI_SERVICE_QUOTA_EXCEEDED',
        error: 'AI analysis is temporarily unavailable because the service usage limit has been reached.'
      }, 503);
    }

    if (errorText.includes('rate limit') || errorText.includes('too many')) {
      return json({
        code: 'AI_SERVICE_BUSY',
        error: 'AI is busy right now. Please try again shortly.'
      }, 429, { 'Retry-After': '30' });
    }

    return json({
      code: 'AI_SERVICE_UNAVAILABLE',
      error: 'AI analysis is temporarily unavailable. Please try again later.'
    }, 502);
  }
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text) {
    return response.output_text;
  }

  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }

  if (typeof response?.response === 'string' && response.response) {
    return response.response;
  }

  return null;
}

async function refundClaim(limiter) {
  try {
    await limiter.fetch('https://limiter/refund', { method: 'POST' });
  } catch (error) {
    console.error('Failed to refund AI quota claim:', error);
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Workout payload is required.';
  if (!payload.session || typeof payload.session !== 'object') return 'Session summary is required.';
  if (!Array.isArray(payload.laps) || payload.laps.length > 40) return 'Invalid lap data.';
  if (!Array.isArray(payload.windows) || payload.windows.length > 20) return 'Invalid record-window data.';
  if (payload.analysis_language !== undefined && !LANGUAGE_NAMES[String(payload.analysis_language).toLowerCase()]) {
    return 'Unsupported analysis language.';
  }
  return null;
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function nextUtcDayIso(now = new Date()) {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return next.toISOString();
}

function secondsUntilNextUtcDay(now = new Date()) {
  return Math.max(1, Math.ceil((Date.parse(nextUtcDayIso(now)) - now.getTime()) / 1000));
}

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

/**
 * One Durable Object instance is used per hashed client IP.
 * Each IP can successfully analyze at most 3 activities per UTC day.
 */
export class AiDailyLimit {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    }

    const now = new Date();
    const today = utcDateKey(now);
    const resetsAt = nextUtcDayIso(now);

    const stored = await this.state.storage.get('usage');
    let usage = stored && stored.date === today
      ? stored
      : { date: today, count: 0 };

    if (url.pathname === '/claim') {
      if (usage.count >= DAILY_LIMIT) {
        return Response.json({
          allowed: false,
          remaining: 0,
          resets_at: resetsAt,
          retry_after_seconds: secondsUntilNextUtcDay(now)
        });
      }

      usage.count += 1;
      await this.state.storage.put('usage', usage);

      return Response.json({
        allowed: true,
        remaining: Math.max(0, DAILY_LIMIT - usage.count),
        resets_at: resetsAt
      });
    }

    if (url.pathname === '/refund') {
      usage.count = Math.max(0, usage.count - 1);
      await this.state.storage.put('usage', usage);

      return Response.json({
        ok: true,
        remaining: Math.max(0, DAILY_LIMIT - usage.count),
        resets_at: resetsAt
      });
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
}
