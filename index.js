// index.js — Nalu API (OpenAI Assistants, threads+runs + JSON estricto)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// CORS (tus dominios + subdominios lovable)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// JSON + health
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'API is running', ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI (usa OPENAI_API_KEY en Render)
// ─────────────────────────────────────────────────────────────────────────────
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Usa ASSISTANT_ID de env si existe; si no, tu ID fijo:
const ASSISTANT_ID = process.env.ASSISTANT_ID || 'asst_be0LI9dHJ8Ub8HPjDqDOqPCr';

// ─────────────────────────────────────────────────────────────────────────────
// Utils de normalización/validación para la salida
// ─────────────────────────────────────────────────────────────────────────────
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
  // si hay opciones y no es multi-select, lo tratamos como single
  if (Array.isArray(q?.options) && q.options.length > 0 && t !== 'multi-select') return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalización de payload de ENTRADA (lo que nos manda Lovable)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Llamado al Assistant (Threads + Runs) y parseo de su respuesta JSON
// ─────────────────────────────────────────────────────────────────────────────
async function runAssistant(userContent, timeoutMs = 60000) {
  // 1) Crear thread
  const thread = await client.beta.threads.create();

  // 2) Mandar mensaje de usuario (nuestro JSON compacto)
  await client.beta.threads.messages.create(thread.id, {
    role: 'user',
    content: JSON.stringify(userContent),
  });

  // 3) Crear run con tu Assistant (forzamos JSON y sin herramientas)
  const run = await client.beta.threads.runs.create(thread.id, {
    assistant_id: ASSISTANT_ID,
    instructions: 'Devuelve SOLO JSON válido con el esquema acordado. No agregues texto fuera del JSON.',
    tool_choice: 'none',
  });

  // 4) Poll simple hasta completar o timeout
  const started = Date.now();
  while (true) {
    const r = await client.beta.threads.runs.retrieve(thread.id, run.id);
    if (r.status === 'completed') break;
    if (['requires_action', 'failed', 'cancelled', 'expired'].includes(r.status)) {
      throw new Error(`Run status: ${r.status}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error('Run timeout');
    await new Promise(res => setTimeout(res, 800));
  }

  // 5) Leer últimos mensajes del thread
  const messages = await client.beta.threads.messages.list(thread.id, { order: 'desc', limit: 10 });

  // Encontrar el primer contenido de texto
  let text = '';
  for (const m of messages.data) {
    const parts = m.content || [];
    for (const p of parts) {
      if (p.type === 'text' && p.text?.value) {
        text = p.text.value;
        break;
      }
    }
    if (text) break;
  }
  if (!text) throw new Error('Assistant no devolvió texto');

  // 6) Intentar parsear JSON
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Si vino code-fenced o con ruido, hacemos un fallback suave
    const match = text.match(/\{[\s\S]*\}$/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('Respuesta del Assistant no es JSON válido');
    }
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruta principal: SIEMPRE OpenAI Assistant
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/simulations/run', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY no configurada en el servidor.' });
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

    // Llamamos a TU Assistant ya configurado en la plataforma
    const assistantRaw = await runAssistant(userContent);

    if (!assistantRaw || !Array.isArray(assistantRaw.results)) {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del Assistant (sin results).' });
    }

    // Normalizamos salida: enteros, [0..100], y suma=100 si corresponde
    const normalizedResults = assistantRaw.results.map((r, i) => {
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
      status: assistantRaw.status || 'completed',
      estimatedTime: 'unos segundos',
      results: normalizedResults
    });

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    return res.status(500).json({ success: false, error: 'Error interno al simular con OpenAI Assistant.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT}`);
});