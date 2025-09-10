// src/index.js — Nalu API (Básico + Profesional con personas sintéticas)
// Requisitos: OPENAI_API_KEY, ASSISTANT_ID (env)
// Run: node index.js

const express = require('express');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

/* ─────────────────────────────────────────────────────────
   CORS sencillo (origins propios + lovable previews)
   ───────────────────────────────────────────────────────── */
const allowedOrigins = new Set([
  'https://naluinsights.lovable.app',
  'https://preview-naluinsights.lovable.app',
  'https://nalua.com',
  'https://www.nalua.com',
  'https://naluia.com',
  'https://www.naluia.com'
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

app.use(express.json({ limit: '2mb' }));

/* ─────────────────────────────────────────────────────────
   Health
   ───────────────────────────────────────────────────────── */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'API running',
    ts: new Date().toISOString(),
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    hasAssistant: Boolean(process.env.ASSISTANT_ID),
  });
});

/* ─────────────────────────────────────────────────────────
   OpenAI client
   ───────────────────────────────────────────────────────── */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;

/* ─────────────────────────────────────────────────────────
   Helpers (mínimos, foco en formato para la web)
   ───────────────────────────────────────────────────────── */
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice','single-choice','single','yes-no','yesno','boolean','scale','rating','likert'
]);

function clampInt(n, min, max) {
  n = Math.round(Number(n) || 0);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

function sum(arr) {
  return arr.reduce((s, x) => s + (Number(x) || 0), 0);
}

function normalizePercentagesTo100(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return answers;
  const clamped = answers.map(a => ({
    text: String(a?.text ?? ''),
    percentage: clampInt(a?.percentage ?? 0, 0, 100),
  }));
  const total = sum(clamped.map(a => a.percentage));
  if (total === 100) return clamped;
  if (total <= 0) {
    return clamped.map((a, i) => ({ ...a, percentage: i === 0 ? 100 : 0 }));
  }
  const scaled = clamped.map(a => ({ ...a, percentage: Math.round((a.percentage * 100) / total) }));
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

/* ─────────────────────────────────────────────────────────
   Normalización de ENTRADA desde la web
   ───────────────────────────────────────────────────────── */
function normalizePayload(body) {
  const typeRaw = (body?.type || body?.form_data?.type || '').toString().toLowerCase();
  const type = typeRaw === 'entrevista' ? 'entrevista' : 'encuesta';

  const audBlock = body?.audience_data || body?.audience || {};
  const form = body?.form_data || {};
  const rawQuestions = Array.isArray(form?.questions)
    ? form.questions
    : (Array.isArray(body?.questions) ? body.questions : []);

  const normQuestions = rawQuestions.map(q => {
    const base = {
      id: String(q?.id ?? ''),
      question: String(q?.question ?? ''),
      type: String(q?.type ?? '').toLowerCase(),
      required: Boolean(q?.required),
    };
    if ((base.type === 'yes-no' || base.type === 'yesno' || base.type === 'boolean') && !Array.isArray(q?.options)) {
      base.type = 'yes-no';
      base.options = ['Sí','No'];
    } else if (Array.isArray(q?.options) && q.options.length > 0) {
      base.options = q.options.map(o => String(o ?? '').trim()).filter(Boolean);
    } else {
      base.options = [];
    }
    return base;
  });

  const demographics = audBlock?.demographics || {};
  const psychographics = audBlock?.psychographics || {};
  const contextData = form?.contextData || {};
  const audienceContext = String(contextData?.audienceContext ?? '').trim();
  const userInsights = String(contextData?.userInsights ?? '').trim();

  const surveyType = String(audBlock?.surveyType || '').toLowerCase(); // "basic" | "professional"
  let responses = Number(
    audBlock?.responseCount ??
    body?.responsesToSimulate ??
    body?.response_count ??
    100
  );
  if (!Number.isFinite(responses) || responses <= 0) responses = 100;
  if (type === 'entrevista') responses = Math.min(5, Math.max(1, Math.round(responses)));
  else responses = Math.round(responses);

  return {
    type, // encuesta | entrevista
    mode: surveyType === 'professional' ? 'professional' : 'basic',
    responsesToSimulate: responses,
    audience: {
      surveyType: surveyType || undefined,
      name: audBlock?.name || '',
      description: audBlock?.description || '',
      demographics,
      psychographics,
      context: { audienceContext, userInsights }
    },
    questions: normQuestions,
  };
}

/* ─────────────────────────────────────────────────────────
   Prompts (básico y profesional)
   ───────────────────────────────────────────────────────── */
// Básico: IA devuelve porcentajes directamente
function buildSurveyPromptBasic(input) {
  return [
    'Eres un simulador de encuestas. Devuelve SOLO JSON válido.',
    'Formato exacto:',
    '{"status":"completed","results":[{"question":"...","answers":[{"text":"...","percentage":0-100}],"rationale":"..."}]}',
    'Reglas:',
    '- Usa estrictamente demographics, psychographics y context si existen.',
    '- Si hay opciones, usa EXACTAMENTE esos textos; no inventes opciones.',
    '- Si es elección única, porcentajes suman exactamente 100.',
    '',
    `Público: ${JSON.stringify(input.audience)}`,
    `Respuestas a simular: ${input.responsesToSimulate}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

// Profesional: IA crea N personas y sus selecciones individuales
function buildSurveyPromptProfessional(input) {
  const n = input.responsesToSimulate;
  return [
    'Eres un generador de “personas sintéticas” que responden encuestas. Devuelve SOLO JSON válido.',
    'Primero genera N personas coherentes con el público y luego sus respuestas individuales.',
    'Formato exacto:',
    '{',
    '  "status":"completed",',
    '  "mode":"professional",',
    '  "rawRespondents":[',
    '    { "respondentId":"r0001", "answers":[ { "questionId":"...", "selected":["Texto exacto de Opción"] } ] }',
    '  ],',
    '  "results":[ { "question":"...", "answers":[{"text":"...","percentage":0-100}], "rationale":"..." } ]',
    '}',
    'Reglas:',
    '- N = número de personas (usa exactamente N).',
    '- Usa EXACTAMENTE los textos de opciones. No inventes opciones.',
    '- Cada persona elige 1 opción en preguntas de elección única.',
    '- Construye "results" agregando el conteo de rawRespondents.',
    '- Incluye breve "rationale" por pregunta.',
    '',
    `N (personas): ${n}`,
    `Público: ${JSON.stringify(input.audience)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────
   Llamado Assistant (Threads + Runs)
   ───────────────────────────────────────────────────────── */
async function runAssistant(prompt, timeoutMs = 60_000) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente');
  if (!ASSISTANT_ID) throw new Error('ASSISTANT_ID ausente');

  const thread = await client.beta.threads.create();
  const threadId = thread?.id;
  if (!threadId) throw new Error('No llegó threadId');

  await client.beta.threads.messages.create(threadId, { role: 'user', content: prompt });

  const run = await client.beta.threads.runs.create(threadId, { assistant_id: ASSISTANT_ID });
  const runId = run?.id;
  if (!runId) throw new Error('No llegó runId');

  const start = Date.now();
  while (true) {
    const r = await client.beta.threads.runs.retrieve(threadId, runId);
    if (r.status === 'completed') break;
    if (['failed','cancelled','expired','requires_action'].includes(r.status)) {
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
      if (p.type === 'text' && p.text?.value) { text = p.text.value.trim(); break; }
    }
    if (text) break;
  }
  if (!text) throw new Error('Assistant no devolvió texto');

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error('Respuesta del Assistant no es JSON válido');
    return JSON.parse(match[0]);
  }
}

/* ─────────────────────────────────────────────────────────
   Adaptadores → formato que espera la web (Lovable)
   ───────────────────────────────────────────────────────── */
// Profesional: asegurar meta.n, results con questionId y answers %, y rawRespondents
function adaptProfessional({ input, assistantPayload }) {
  const n = Number(input.responsesToSimulate || 0);
  const raw = Array.isArray(assistantPayload?.rawRespondents)
    ? assistantPayload.rawRespondents
    : Array.isArray(assistantPayload?.raw_respondents)
      ? assistantPayload.raw_respondents
      : [];

  // Asegurar respondentId y shape simple
  const rawRespondents = raw.map((r, i) => {
    const rid = String(r?.respondentId || `r${String(i+1).padStart(4, '0')}`);
    const answers = Array.isArray(r?.answers) ? r.answers.map(a => ({
      questionId: String(a?.questionId || ''),
      selected: Array.isArray(a?.selected) ? a.selected.map(x => String(x)) : []
    })) : [];
    return { respondentId: rid, answers };
  });

  // Agregar: si la IA no devolvió "results", los calculamos desde rawRespondents
  let results = [];
  if (Array.isArray(assistantPayload?.results) && assistantPayload.results.length > 0) {
    results = assistantPayload.results;
  } else {
    results = computeAggregatesFromRaw(input.questions, rawRespondents);
  }

  // Normalizar results → garantizar questionId, answers[{text,percentage}], rationale
  const normalized = results.map((r, idx) => {
    const q = input.questions[idx] || {};
    let answers = Array.isArray(r?.answers) ? r.answers : [];
    if (!answers.length && Array.isArray(r?.aggregates)) {
      answers = r.aggregates.map(a => ({ text: String(a.text||''), percentage: Number(a.percentage||0) }));
    }
    // Filtrar opciones desconocidas
    if (Array.isArray(q?.options) && q.options.length > 0) {
      const set = new Set(q.options.map(o => o.toLowerCase().trim()));
      answers = answers.filter(a => set.has(String(a.text).toLowerCase().trim()));
    }
    if (isSingleChoice(q)) answers = normalizePercentagesTo100(answers);

    return {
      questionId: String(r?.questionId || q?.id || `q_${idx+1}`),
      question: String(r?.question || q?.question || `Pregunta ${idx+1}`),
      answers,
      rationale: String(r?.rationale || ''),
      // opcional: options original
      options: Array.isArray(q?.options) ? q.options : undefined
    };
  });

  return {
    success: true,
    status: assistantPayload?.status || 'completed',
    mode: 'professional',
    meta: { n },
    results: normalized,
    rawRespondents
  };
}

// Básico: garantizar questionId y answers
function adaptBasic({ input, assistantPayload }) {
  const rawResults = Array.isArray(assistantPayload?.results) ? assistantPayload.results : [];
  const normalized = rawResults.map((r, idx) => {
    const q = input.questions[idx] || {};
    let answers = Array.isArray(r?.answers) ? r.answers : [];
    if (!answers.length && Array.isArray(r?.aggregates)) {
      answers = r.aggregates.map(a => ({ text: String(a.text||''), percentage: Number(a.percentage||0) }));
    }
    if (Array.isArray(q?.options) && q.options.length > 0) {
      const set = new Set(q.options.map(o => o.toLowerCase().trim()));
      answers = answers.filter(a => set.has(String(a.text).toLowerCase().trim()));
    }
    if (isSingleChoice(q)) answers = normalizePercentagesTo100(answers);

    return {
      questionId: String(r?.questionId || q?.id || `q_${idx+1}`),
      question: String(r?.question || q?.question || `Pregunta ${idx+1}`),
      answers,
      rationale: String(r?.rationale || '')
    };
  });

  return {
    success: true,
    status: assistantPayload?.status || 'completed',
    mode: 'basic',
    results: normalized
  };
}

// Genera agregados a partir de rawRespondents
function computeAggregatesFromRaw(questions, rawRespondents) {
  return questions.map((q, idx) => {
    const qid = String(q?.id || `q_${idx+1}`);
    const opts = Array.isArray(q?.options) ? q.options.map(String) : [];
    const counts = new Map(opts.map(o => [o, 0]));
    let total = 0;

    for (const r of rawRespondents) {
      const ans = (r.answers || []).find(a => String(a.questionId) === qid);
      if (!ans) continue;
      const sel = Array.isArray(ans.selected) ? ans.selected.map(String) : [];
      if (isSingleChoice(q)) {
        const pick = sel[0];
        if (pick && counts.has(pick)) {
          counts.set(pick, counts.get(pick) + 1);
          total += 1;
        }
      } else {
        // multi-select
        let any = false;
        for (const pick of sel) {
          if (counts.has(pick)) {
            counts.set(pick, counts.get(pick) + 1);
            any = true;
          }
        }
        if (any) total += 1;
      }
    }

    let answers = opts.map(o => ({
      text: o,
      percentage: total > 0 ? Math.round((counts.get(o) * 100) / total) : 0
    }));
    if (isSingleChoice(q)) answers = normalizePercentagesTo100(answers);

    return {
      questionId: qid,
      question: String(q?.question || `Pregunta ${idx+1}`),
      answers,
      rationale: '' // la IA puede proveer; si no, lo dejamos vacío
    };
  });
}

/* ─────────────────────────────────────────────────────────
   Endpoint principal
   ───────────────────────────────────────────────────────── */
app.post('/api/simulations/run', async (req, res) => {
  try {
    const input = normalizePayload(req.body);
    if (!input.questions || input.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
    }
    if (input.mode === 'professional') {
      // límites sanos
      if (input.responsesToSimulate < 10 || input.responsesToSimulate > 1000) {
        return res.status(400).json({ success: false, error: 'responseCount debe estar entre 10 y 1000.' });
      }
    }

    // Construir prompt según modo
    const prompt = input.mode === 'professional'
      ? buildSurveyPromptProfessional(input)
      : buildSurveyPromptBasic(input);

    // Llamar al assistant
    const assistant = await runAssistant(prompt);

    // Adaptar respuesta al formato de la web
    const output = input.mode === 'professional'
      ? adaptProfessional({ input, assistantPayload: assistant })
      : adaptBasic({ input, assistantPayload: assistant });

    // Validación final mínima
    if (!output || !Array.isArray(output.results)) {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del Assistant (sin results).' });
    }

    return res.json(output);

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    res.status(500).json({
      success: false,
      error: 'Error interno al simular con OpenAI Assistant.',
      message: err?.message || 'Error desconocido'
    });
  }
});

/* ─────────────────────────────────────────────────────────
   Start
   ───────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 API Nalu en puerto ${PORT}`);
});