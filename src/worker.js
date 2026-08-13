const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_BODY_BYTES = 96 * 1024;

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

  if (!env.AI) {
    return json({ error: 'Workers AI binding is not configured.' }, 503);
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

  const languageCode = String(payload.analysis_language || 'en').toLowerCase();
  const languageName = LANGUAGE_NAMES[languageCode] || LANGUAGE_NAMES.en;

  const system = `You are FIT2CSV Workout Analyst. Analyze one endurance workout from compact, deterministic metrics derived in the user's browser from a FIT file.

Rules:
- Base every claim only on the supplied data. Never invent missing values.
- This is workout analysis, not medical diagnosis. Do not diagnose disease, injury, arrhythmia, or other health conditions.
- If heart-rate behavior looks unusual, describe the data pattern neutrally and suggest reducing effort or seeking professional advice only when appropriate; do not make a diagnosis.
- Distinguish intentional workload increases from heart-rate drift. If speed/power also rises, do not label the HR rise as drift without evidence.
- Use lap and window trends when available. Comment on cadence/power/form only when those fields are present.
- Keep the tone concise, practical, and coach-like. Avoid hype.
- next_session must be a conservative general suggestion based only on this single workout; do not pretend to know the athlete's full training history.
- data_notes should state important limitations or missing fields that affect confidence.
- Write every human-facing string value in ${languageName}. Keep JSON property names exactly as defined by the schema.
- Return only the requested JSON schema.`;

  const user = `Analyze this workout. Values retain the parser/application units shown in the JSON. The payload intentionally excludes filename, serial number, GPS coordinates, and raw second-by-second records.\n\n${JSON.stringify(payload)}`;

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: ANALYSIS_SCHEMA,
      },
      temperature: 0.2,
      max_tokens: 1000,
    });

    const analysis = normalizeAiResponse(result?.response ?? result);
    if (!analysis || typeof analysis !== 'object') {
      throw new Error('Workers AI returned an unexpected response.');
    }

    return json({
      analysis,
      model: MODEL,
      privacy: 'Only compact workout metrics were submitted to AI; the FIT file itself was not uploaded.',
    }, 200, {
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    console.error('Workers AI analysis failed:', error);
    return json({ error: 'AI analysis is temporarily unavailable. Please try again later.' }, 502);
  }
}

function normalizeAiResponse(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
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

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
