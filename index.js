// index.js — Nalu API (Assistants estable, con poll correcto)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ───────────────────────────────── CORS ─────────────────────────────────
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

// ─────────────────────────────── JSON + Health ─────────────────────────
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'API is running', ts: new Date().toISOString() });
});

// ─────────────────────────────── OpenAI setup ──────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️  Falta OPENAI_API_KEY en variables de entorno.');
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ID del Assistant
const ASSISTANT_ID = process.env.ASSISTANT_ID || 'asst_be0LI9dHJ8Ub8HPjDqDOqPCr';

// ─────────────────────── Utilidades de normalización ───────────────────
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice', 'single-choice', 'single', 'yes-no', 'yesno', 'boolean', 'scale', 'rating', 'likert'
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
  let clamped = answers.map(a => ({
    text: (a?.text ?? '').toString(),
    percentage: clampInt(a?.percentage ?? 0, 0, 100),
  }));
  let total = sum(clamped.map(a => a.percentage));
  if (total === 100) return clamped;
  if (total <= 0) {
    return clamped.map((a, i) => ({ ...a, percentage: i === 0 ? 100 : 0 }));
  }
  let scaled = clamped.map(a => ({
    ...a,
    percentage: Math.round((a.percentage * 100) / total)
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

function normalizePayload(body) {
  const type = (body?.type || '').toString().toLowerCase();
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  const normQuestions = questions.map(q => {
    const base = {
      question: (q?.question || '').toString(),
      required: Boolean(q?.required),
    };
    const qType = (q?.type || '').toString().toLowerCase();
    if ((qType === 'yes-no' || qType === 'yesno' || qType === 'boolean') && !Array.isArray(q?.options)) {
      base.type = 'yes-no';
      base.options = ['Sí', 'No'];
    } else if (Array.isArray(q?.options) && q.options.length > 0) {
      base.options = q.options.map(o => (o ?? '').toString().trim()).filter(Boolean);
      if (q?.type) base.type = qType;
    } else {
      if (q?.type) base.type = qType;
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

// ───────────────────────── runAssistant (CORREGIDO) ────────────────────
async function runAssistant(userContent, timeoutMs = 60000) {
  // 1) Crear thread
  const thread = await client.beta.threads.create();
  if (!thread?.id) throw new Error('No se pudo crear el thread');
  const threadId = thread.id;
  console.log('[assistant] threadId:', threadId);

  // 2) Mensaje del usuario
  await client.beta.threads.messages.create(threadId, {
    role: 'user',
    content: JSON.stringify(userContent),
  });

  // 3) Crear run
  const run = await client.beta.threads.runs.create(threadId, {
    assistant_id: ASSISTANT_ID,
    // forzar JSON en las respuestas del asistente
    instructions: 'Devuelve SOLO JSON válido según el esquema acordado.',
  });
  if (!run?.id) throw new Error('No se pudo crear el run');
  const runId = run.id;
  console.log('[assistant] runId:', runId);

  // 4) Poll correcto: retrieve(threadId, runId)
  const started = Date.now();
  while (true) {
    console.log('[assistant] polling → retrieve(', threadId, ',', runId, ')');
    const r = await client.beta.threads.runs.retrieve(threadId, runId);

    if (r.status === 'completed') break;
    if (['failed', 'cancelled', 'expired', 'requires_action'].includes(r.status)) {
      console.error('[assistant] run terminó con estado:', r.status);
      throw new Error(`Run status: ${r.status}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error('Run timeout');

    await new Promise(res => setTimeout(res, 900));
  }

  // 5) Leer últimos mensajes
  const messages = await client.beta.threads.messages.list(threadId, { order: 'desc', limit: 10 });

  let text = '';
  outer: for (const m of messages.data) {
    for (const part of (m.content || [])) {
      if (part.type === 'text' && part.text?.value) {
        text = part.text.value;
        break outer;
      }
    }
  }
  if (!text) throw new Error('Assistant no devolvió texto');

  // 6) Parsear JSON
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}$/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Respuesta del Assistant no es JSON válido');
  }
  return parsed;
}

// ────────────────────────────── Endpoint API ───────────────────────────
app.post('/api/simulations/run', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY no configurada.' });
    }

    const input = normalizePayload(req.body);
    if (!input.questions || input.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
    }

    const userContent = {
      type: input.type,
      responsesToSimulate: input.responsesToSimulate,
      audience: input.audience,
      psychographics: input.psychographics,
      questions: input.questions
    };

    const raw = await runAssistant(userContent);

    if (!raw || !Array.isArray(raw.results)) {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del Assistant (sin results).' });
    }

    const normalizedResults = raw.results.map((r, i) => {
      const q = input.questions[i] || {};
      let answers = Array.isArray(r.answers)
        ? r.answers.map(a => ({
            text: (a?.text ?? '').toString(),
            percentage: clampInt(a?.percentage ?? 0, 0, 100),
          }))
        : [];
      if (isSingleChoice(q)) {
        answers = normalizePercentagesTo100(answers);
      }
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
      status: raw.status || 'completed',
      estimatedTime: 'unos segundos',
      results: normalizedResults
    });

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    return res.status(500).json({ success: false, error: 'Error interno al simular con OpenAI Assistant.' });
  }
});

// ──────────────────────────────── Start ────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT}`);
});