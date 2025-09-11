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
   Helpers
   ───────────────────────────────────────────────────────── */
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice','single-choice','single','yes-no','yesno','boolean','scale','rating','likert'
]);
const MULTI_CHOICE_TYPES = new Set(['multi-select','multiple-select','checkbox','multiple-selection']);

function clampInt(n, min, max) {
  n = Math.round(Number(n) || 0);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}
const sum = arr => arr.reduce((s, x) => s + (Number(x) || 0), 0);

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
  if (Array.isArray(q?.options) && q.options.length > 0 && !MULTI_CHOICE_TYPES.has(t)) return true;
  return false;
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  const set = new Set();
  const out = [];
  for (const o of options) {
    const v = String(o ?? '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (!set.has(key)) {
      set.add(key);
      out.push(v);
    }
  }
  return out;
}

function canonChoice(qOptions, v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const opt of qOptions) {
    if (opt.toLowerCase() === lower) return opt; // devolver texto EXACTO del formulario
  }
  return null;
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
    let qtype = String(q?.type ?? '').toLowerCase();
    const base = {
      id: String(q?.id ?? ''),
      question: String(q?.question ?? ''),
      type: qtype,
      required: Boolean(q?.required),
    };
    let opts = Array.isArray(q?.options) ? q.options : [];

    // Normalizaciones de tipo y opciones
    if ((qtype === 'yes-no' || qtype === 'yesno' || qtype === 'boolean') && (!opts || opts.length === 0)) {
      base.type = 'yes-no';
      opts = ['Sí','No'];
    }
    base.options = normalizeOptions(opts);
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
  if (type === 'entrevista') responses = clampInt(responses, 1, 5);
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
    '  "rationales":[{"questionId":"...","rationale":"..."}]',
    '}',
    'Reglas:',
    '- N = número de personas (usa exactamente N).',
    '- Usa EXACTAMENTE los textos de opciones. No inventes opciones.',
    '- Cada persona elige 1 opción en preguntas de elección única.',
    '- NO devuelvas "results" agregados; nosotros los calculamos.',
    '',
    `N (personas): ${n}`,
    `Público: ${JSON.stringify(input.audience)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────
   Llamado Assistant (Threads + Runs)
   ───────────────────────────────────────────────────────── */
async function runAssistant(prompt, timeoutMs = 1_200_000) {
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
   Agregación PRO desde rawRespondents
   ───────────────────────────────────────────────────────── */
function computeAggregatesFromRaw(questions, rawRespondents) {
  // Canonizar opciones por pregunta
  const qList = questions.map(q => ({
    id: String(q?.id || ''),
    question: String(q?.question || ''),
    type: String(q?.type || '').toLowerCase(),
    options: normalizeOptions(q?.options || []),
  }));

  const n = rawRespondents.length;

  return qList.map((q, idx) => {
    const isSingle = isSingleChoice(q);
    const counts = new Map(q.options.map(o => [o, 0]));

    for (const r of rawRespondents) {
      // aceptar choice | selected | choices
      const rawAns = (r?.answers || []).find(a => String(a?.questionId) === q.id);
      if (!rawAns) continue;

      let picks = [];
      if (Array.isArray(rawAns?.selected)) picks = rawAns.selected;
      else if (Array.isArray(rawAns?.choices)) picks = rawAns.choices;
      else if (rawAns?.choice != null) picks = [rawAns.choice];

      if (isSingle) {
        const exact = canonChoice(q.options, picks[0]);
        if (exact) counts.set(exact, counts.get(exact) + 1);
      } else {
        // multi: contar por persona; duplicados por persona no suman extra
        const seen = new Set();
        for (const p of picks || []) {
          const exact = canonChoice(q.options, p);
          if (exact && !seen.has(exact)) {
            counts.set(exact, counts.get(exact) + 1);
            seen.add(exact);
          }
        }
      }
    }

    // porcentajes
    let answers = q.options.map(o => ({
      text: o,
      percentage: n > 0 ? Math.round((counts.get(o) * 100) / n) : 0
    }));
    if (isSingle) answers = normalizePercentagesTo100(answers);

    return {
      questionId: q.id || `q_${idx+1}`,
      question: q.question || `Pregunta ${idx+1}`,
      answers,
      options: q.options
    };
  });
}

/* ─────────────────────────────────────────────────────────
   Adaptadores → formato web (Lovable)
   ───────────────────────────────────────────────────────── */
function adaptProfessional({ input, assistantPayload }) {
  const n = Number(input.responsesToSimulate || 0);

  // Aceptar rawRespondents en diferentes keys y normalizar shape
  const rawIn = Array.isArray(assistantPayload?.rawRespondents)
    ? assistantPayload.rawRespondents
    : Array.isArray(assistantPayload?.raw_respondents)
      ? assistantPayload.raw_respondents
      : [];

  const rawRespondents = rawIn.map((r, i) => {
    const rid = String(r?.respondentId || `r${String(i+1).padStart(4, '0')}`);
    // convertir a {questionId, selected:[]}
    const answers = Array.isArray(r?.answers) ? r.answers.map(a => {
      const qid = String(a?.questionId || '');
      let selected = [];
      if (Array.isArray(a?.selected)) selected = a.selected;
      else if (Array.isArray(a?.choices)) selected = a.choices;
      else if (a?.choice != null) selected = [a.choice];
      selected = selected.map(x => String(x ?? '')).filter(Boolean);
      return { questionId: qid, selected };
    }) : [];
    return { respondentId: rid, answers };
  });

  // Siempre recalcular agregados desde la muestra cruda
  const results = computeAggregatesFromRaw(input.questions, rawRespondents);

  // Mapear racionales si vinieron
  const rMap = new Map();
  if (Array.isArray(assistantPayload?.rationales)) {
    for (const r of assistantPayload.rationales) {
      const qid = String(r?.questionId || '');
      const txt = String(r?.rationale || '').trim();
      if (qid && txt) rMap.set(qid, txt);
    }
  }
  for (const r of results) {
    if (rMap.has(r.questionId)) r.rationale = rMap.get(r.questionId);
    else r.rationale = r.rationale || '';
  }

  return {
    success: true,
    status: assistantPayload?.status || 'completed',
    mode: 'professional',
    meta: { n },
    results,
    rawRespondents
  };
}

function adaptBasic({ input, assistantPayload }) {
  const rawResults = Array.isArray(assistantPayload?.results) ? assistantPayload.results : [];
  const normalized = rawResults.map((r, idx) => {
    const q = input.questions[idx] || {};
    const qOpts = normalizeOptions(q?.options || []);
    let answers = Array.isArray(r?.answers) ? r.answers : [];
    if (!answers.length && Array.isArray(r?.aggregates)) {
      answers = r.aggregates.map(a => ({ text: String(a.text||''), percentage: Number(a.percentage||0) }));
    }
    if (qOpts.length > 0) {
      const set = new Set(qOpts.map(o => o.toLowerCase()));
      answers = answers
        .map(a => ({ text: String(a?.text || '').trim(), percentage: clampInt(a?.percentage ?? 0, 0, 100) }))
        .filter(a => set.has(a.text.toLowerCase()));
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

/* ─────────────────────────────────────────────────────────
   Endpoint principal
   ───────────────────────────────────────────────────────── */
app.post('/api/simulations/run', async (req, res) => {
  try {
    const input = normalizePayload(req.body);
    if (!input.questions || input.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
    }
    if (input.type !== 'entrevista' && input.mode === 'professional') {
      if (input.responsesToSimulate < 10 || input.responsesToSimulate > 1000) {
        return res.status(400).json({ success: false, error: 'responseCount debe estar entre 10 y 1000.' });
      }
    }

    // Elegir prompt
    let prompt;
    if (input.type === 'entrevista') {
      // Reusamos prompt básico de texto libre (si hicieran entrevistas acá)
      prompt = [
        'Eres un entrevistador virtual que genera respuestas textuales auténticas.',
        `Para CADA pregunta, genera EXACTAMENTE ${clampInt(input.responsesToSimulate || 3,1,5)} respuestas únicas.`,
        'Cada respuesta debe ser un texto completo (2–3 oraciones), natural y realista.',
        'Salida: SOLO JSON válido:',
        '{"status":"completed","results":[{"question":"...","answers":[{"text":"..."},{"text":"..."}]}]}',
        '',
        `Público: ${JSON.stringify(input.audience)}`,
        `Preguntas: ${JSON.stringify(input.questions)}`
      ].join('\n');
    } else {
      prompt = input.mode === 'professional'
        ? buildSurveyPromptProfessional(input)
        : buildSurveyPromptBasic(input);
    }

    // Llamar al assistant
    const assistant = await runAssistant(prompt);

    // Adaptar salida para el frontend
    const output = (input.type !== 'entrevista' && input.mode === 'professional')
      ? adaptProfessional({ input, assistantPayload: assistant })
      : adaptBasic({ input, assistantPayload: assistant });

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