// src/index.js — Nalu API (encuestas + entrevistas)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
const allowedOrigins = new Set([
  'https://naluinsights.lovable.app',
  'https://preview-naluinsights.lovable.app',
  'https://nalua.com',
  'https://www.nalua.com',
  'https://naluia.com',
  'https://www.naluia.com',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.has(origin) || origin.endsWith('.lovableproject.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// JSON + Health
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'API running',
    ts: new Date().toISOString(),
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    hasAssistant: Boolean(process.env.ASSISTANT_ID),
  });
});

// OpenAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID; // no hardcode

// Utils
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice', 'single-choice', 'single',
  'yes-no', 'yesno', 'boolean', 'scale', 'rating', 'likert'
]);
const clampInt = (n, min, max) => {
  n = Math.round(Number(n) || 0);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
};
const sum = arr => arr.reduce((s, x) => s + (Number(x) || 0), 0);

function normalizePercentagesTo100(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return answers;
  const clamped = answers.map(a => ({
    text: (a?.text ?? '').toString(),
    percentage: clampInt(a?.percentage ?? 0, 0, 100),
  }));
  const total = sum(clamped.map(a => a.percentage));
  if (total === 100) return clamped;
  if (total <= 0) {
    return clamped.map((a, i) => ({ ...a, percentage: i === 0 ? 100 : 0 }));
  }
  const scaled = clamped.map(a => ({
    ...a,
    percentage: Math.round((a.percentage * 100) / total),
  }));
  const diff = 100 - sum(scaled.map(a => a.percentage));
  if (scaled[0]) scaled[0].percentage += diff;
  return scaled;
}

function isSingleChoice(q) {
  const t = (q?.type || '').toLowerCase();
  if (SINGLE_CHOICE_TYPES.has(t)) return true;
  if (Array.isArray(q?.options) && q.options.length > 0 && t !== 'multi-select') return true;
  return false;
}

// Normalización de entrada (desde Lovable)
function normalizePayload(body) {
  const type = (body?.type || '').toString().toLowerCase();
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  const normQuestions = questions.map(q => {
    const base = {
      question: (q?.question || '').toString(),
      required: Boolean(q?.required),
      type: (q?.type || '').toString().toLowerCase(),
    };
    if ((base.type === 'yes-no' || base.type === 'yesno' || base.type === 'boolean') && !Array.isArray(q?.options)) {
      base.type = 'yes-no';
      base.options = ['Sí', 'No'];
    } else if (Array.isArray(q?.options) && q.options.length > 0) {
      base.options = q.options.map(o => (o ?? '').toString().trim()).filter(Boolean);
    }
    return base;
  });

  return {
    type: type === 'entrevista' ? 'entrevista' : 'encuesta',
    audience: body?.audience || {},
    psychographics: body?.psychographics || {},
    responsesToSimulate: Number(body?.responsesToSimulate || 100),
    questions: normQuestions,
  };
}

// Prompt para encuestas
function buildSurveyPrompt(input) {
  return [
    'Eres un analista que simula resultados de encuestas.',
    'Devuelve SOLO un JSON válido, sin texto extra, con este formato exacto:',
    '{"status":"completed","results":[{"question":"...","answers":[{"text":"...","percentage":0-100}, ...], "rationale":"opcional breve"}]}',
    'Las sumas de "percentage" en cada pregunta deben ser EXACTAMENTE 100.',
    '',
    `Contexto del público: ${JSON.stringify(input.audience)}`,
    `Psicográficos: ${JSON.stringify(input.psychographics)}`,
    `Respuestas a simular: ${input.responsesToSimulate}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

// Prompt para entrevistas
function buildInterviewPrompt(input) {
  return [
    'Eres un entrevistador virtual que genera respuestas textuales auténticas e individuales.',
    `Debes generar EXACTAMENTE ${input.responsesToSimulate} respuestas únicas para cada pregunta.`,
    'Cada respuesta debe ser un texto completo (2-3 oraciones), personal y realista.',
    'Varía el tono y la perspectiva entre respuestas.',
    'Refleja la demografía y psicografía de la audiencia.',
    '',
    'Formato de salida (SOLO JSON válido):',
    '{"status":"completed","results":[{"question":"...","answers":[{"text":"respuesta 1","type":"text_response"}, {"text":"respuesta 2","type":"text_response"}]}]}',
    '',
    `Audiencia: ${JSON.stringify(input.audience)}`,
    `Psicográficos: ${JSON.stringify(input.psychographics)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

// Llamado al Assistant (Threads + Runs)
async function runAssistant(input, timeoutMs = 60_000) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente');
  if (!ASSISTANT_ID) throw new Error('ASSISTANT_ID ausente');

  const thread = await client.beta.threads.create();
  const threadId = thread?.id;
  if (!threadId) throw new Error('No llegó threadId');

  const prompt = input.type === 'entrevista'
    ? buildInterviewPrompt(input)
    : buildSurveyPrompt(input);

  await client.beta.threads.messages.create(threadId, {
    role: 'user',
    content: prompt,
  });

  const run = await client.beta.threads.runs.create(threadId, { assistant_id: ASSISTANT_ID });
  const runId = run?.id;
  if (!runId) throw new Error('No llegó runId');

  const start = Date.now();
  while (true) {
    const r = await client.beta.threads.runs.retrieve(threadId, runId);
    if (r.status === 'completed') break;
    if (['failed', 'cancelled', 'expired', 'requires_action'].includes(r.status)) {
      const reason = r?.last_error?.message || r.status;
      throw new Error(`Run status: ${reason}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('Run timeout');
    await new Promise(res => setTimeout(res, 900));
  }

  const messages = await client.beta.threads.messages.list(threadId, { order: 'desc', limit: 10 });

  let text = '';
  for (const m of messages.data) {
    if (m.role !== 'assistant') continue;
    for (const p of m.content || []) {
      if (p.type === 'text' && p.text?.value) {
        text = p.text.value.trim();
        break;
      }
    }
    if (text) break;
  }
  if (!text) throw new Error('Assistant no devolvió texto');

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error('Respuesta del Assistant no es JSON válido');
    parsed = JSON.parse(match[0]);
  }
  return parsed;
}

// Ruta principal
app.post('/api/simulations/run', async (req, res) => {
  const input = normalizePayload(req.body);
  if (!input.questions || input.questions.length === 0) {
    return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
  }

  try {
    const assistant = await runAssistant(input);

    if (!assistant || !Array.isArray(assistant.results)) {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del Assistant (sin results).' });
    }

    const results = assistant.results.map((r, i) => {
      const q = input.questions[i] || {};

      // Flujo de ENTREVISTA
      if (input.type === 'entrevista') {
        return {
          question: r.question || q.question || `Pregunta ${i + 1}`,
          answers: Array.isArray(r.answers)
            ? r.answers.map(a => ({ text: (a?.text ?? '').toString(), type: 'text_response' }))
            : [],
        };
      }

      // Flujo de ENCUESTA (igual que antes)
      let answers = Array.isArray(r.answers)
        ? r.answers.map(a => ({
            text: (a?.text ?? '').toString(),
            percentage: clampInt(a?.percentage ?? 0, 0, 100),
          }))
        : [];
      if (isSingleChoice(q)) answers = normalizePercentagesTo100(answers);
      return {
        question: r.question || q.question || `Pregunta ${i + 1}`,
        answers,
        rationale: (r.rationale || '').toString().slice(0, 400),
      };
    });

    return res.json({
      success: true,
      source: 'assistant',
      simulationId: `sim_${Date.now()}`,
      status: assistant.status || 'completed',
      results
    });

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    const message = err?.message || 'Error desconocido';
    return res.status(500).json({
      success: false,
      error: 'Error interno al simular con OpenAI Assistant.',
      message
    });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT} AMARILLO`);
});