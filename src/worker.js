const MODEL = '@cf/openai/gpt-oss-120b';
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

  const languageCode = String(payload.analysis_language || 'en').toLowerCase();
  const languageName = LANGUAGE_NAMES[languageCode] || LANGUAGE_NAMES.en;

  const systemPrompt = `You are FIT2CSV Workout Analyst. Analyze one endurance workout from compact, deterministic metrics derived in the user's browser from a FIT file.

Rules:
- Base every claim only on the supplied data. Never invent missing values.
- This is workout analysis, not medical diagnosis.
- If heart-rate behavior looks unusual, describe the data pattern neutrally.
- Distinguish intentional workload increases from heart-rate drift.
- Use lap and window trends when available.
- Comment on cadence, power, and running form only when those fields are present.
- Keep the tone concise, practical, and coach-like.
- next_session must be a conservative general suggestion based only on this single workout.
- data_notes should state important limitations or missing fields that affect confidence.
- Write every human-facing string value in ${languageName}.
- Keep JSON property names exactly as defined by the schema.
- Return only JSON matching the requested schema.`;

  const userPrompt = `Analyze this workout. Values retain the units shown in the JSON. The payload intentionally excludes filename, serial number, GPS coordinates, and raw second-by-second records.

${JSON.stringify(payload)}`;

  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content: `${systemPrompt}

Return exactly one valid JSON object and nothing else.
Use this exact top-level structure:
{
  "headline": "string",
  "overall_assessment": "string",
  "pacing_and_effort": "string",
  "heart_rate": "string",
  "running_form": "string",
  "positives": ["string"],
  "cautions": ["string"],
  "next_session": "string",
  "data_notes": ["string"]
}

Do not wrap the JSON in Markdown or code fences.`
        },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 1400,
      temperature: 0.2
    });

    const analysis = normalizeAnalysisResponse(result);

    if (!analysis) {
      console.error('Unexpected gpt-oss response:', JSON.stringify(result));
      throw new Error('AI returned an unsupported response format.');
    }

    const schemaError = validateAnalysisShape(analysis);
    if (schemaError) {
      console.error('Invalid AI analysis shape:', schemaError, JSON.stringify(analysis));
      throw new Error('AI returned an invalid analysis structure.');
    }

    return json({
      analysis,
      usage: result?.usage ?? null
    }, 200, {
      'Cache-Control': 'no-store'
    });
  } catch (error) {
    console.error('Cloudflare Workers AI analysis failed:', error);

    const errorText = String(error?.message || error || '').toLowerCase();

    if (errorText.includes('quota') || errorText.includes('usage limit') || errorText.includes('neurons')) {
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


function normalizeAnalysisResponse(result) {
  if (result?.response && typeof result.response === 'object' && !Array.isArray(result.response)) {
    return result.response;
  }

  if (typeof result?.response === 'string') {
    return parseJsonLike(result.response);
  }

  if (typeof result === 'string') {
    return parseJsonLike(result);
  }

  if (Array.isArray(result?.output)) {
    for (const item of result.output) {
      for (const content of item?.content || []) {
        if (content?.type === 'output_text' && typeof content.text === 'string') {
          const parsed = parseJsonLike(content.text);
          if (parsed) return parsed;
        }
      }
    }
  }

  return null;
}

function parseJsonLike(value) {
  if (typeof value !== 'string') return null;

  let text = value.trim();

  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {}

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {}
  }

  return null;
}

function validateAnalysisShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Analysis must be an object.';
  }

  const stringFields = [
    'headline',
    'overall_assessment',
    'pacing_and_effort',
    'heart_rate',
    'running_form',
    'next_session'
  ];

  for (const key of stringFields) {
    if (typeof value[key] !== 'string') {
      return `${key} must be a string.`;
    }
  }

  for (const key of ['positives', 'cautions', 'data_notes']) {
    if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === 'string')) {
      return `${key} must be an array of strings.`;
    }
  }

  return null;
}


function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'Workout payload is required.';
  }

  if (!payload.session || typeof payload.session !== 'object') {
    return 'Session summary is required.';
  }

  if (!Array.isArray(payload.laps) || payload.laps.length > 40) {
    return 'Invalid lap data.';
  }

  if (!Array.isArray(payload.windows) || payload.windows.length > 20) {
    return 'Invalid record-window data.';
  }

  if (
    payload.analysis_language !== undefined &&
    !LANGUAGE_NAMES[String(payload.analysis_language).toLowerCase()]
  ) {
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
      ...extraHeaders
    }
  });
}
