// src/index.js — Nalu API (Básico + Profesional por lotes con personas sintéticas)
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
  'https://naluia.com',
  'https://www.nalua.com'
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
   Sanitizado / parseo robusto de JSON del assistant
   ───────────────────────────────────────────────────────── */
function sanitizeJsonString(s) {
  return String(s || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .replace(/[\u201C\u201D]/g, '"')   // comillas curvas dobles
    .replace(/[\u2018\u2019]/g, "'")   // comillas curvas simples
    .replace(/\u00A0/g, ' ')           // NBSP
    .replace(/,\s*([}\]])/g, '$1');    // comas colgantes
}

async function safeParseAssistantJson(text, retryFn) {
  let cleaned = sanitizeJsonString(text).trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}$/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    if (retryFn) {
      const retry = await retryFn();
      const cleaned2 = sanitizeJsonString(retry).trim();
      return JSON.parse(cleaned2);
    }
    throw new Error('JSON inválido tras sanitizar');
  }
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

// Profesional por LOTES: solo raw_respondents para un rango de IDs
function buildProfessionalBatchPrompt({ audience, questions, batchStart, batchSize }) {
  return [
    'Eres un generador de personas sintéticas para encuestas.',
    'Devuelve SOLO JSON válido con este formato EXACTO:',
    '{"status":"ok","raw_respondents":[{"respondentId":"r0001","answers":[{"questionId":"<ID>","selected":["<opción EXACTA>"]}]}]}',
    'Reglas:',
    `- Debes generar EXACTAMENTE ${batchSize} personas con IDs consecutivos empezando en r${String(batchStart).padStart(4,'0')}.`,
    '- Usa EXCLUSIVAMENTE las opciones provistas (texto EXACTO).',
    '- Si la pregunta es yes-no, las opciones son "Sí" y "No".',
    '- No incluyas análisis, ni rationale, ni texto fuera del JSON.',
    '',
    `Público: ${JSON.stringify(audience)}`,
    `Preguntas: ${JSON.stringify(questions)}`
  ].join('\n');
}

/* 🔹 NUEVO: pedir racionales sobre agregados ya calculados (payload liviano) */
function buildRationalesPrompt(input, aggregates) {
  return [
    'Eres un analista de investigación de mercados.',
    'Devuelve SOLO JSON válido con este formato EXACTO:',
    '{"status":"ok","rationales":[{"questionId":"...","rationale":"2–3 frases, claras y concretas"}]}',
    'Instrucciones:',
    '- Usa la audiencia y los porcentajes agregados provistos.',
    '- No repitas opciones ni porcentajes; sintetiza el insight (“por qué dio así”).',
    '- Máx. 2–3 frases por pregunta, tono profesional breve.',
    '',
    `Audiencia: ${JSON.stringify(input.audience)}`,
    `Agregados: ${JSON.stringify(aggregates)}`
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────
   OpenAI — ejecución texto y por lotes
   ───────────────────────────────────────────────────────── */
async function runAssistantText(prompt, timeoutMs) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY ausente');
  if (!ASSISTANT_ID) throw new Error('ASSISTANT_ID ausente');

  const thread = await client.beta.threads.create();
  await client.beta.threads.messages.create(thread.id, { role: 'user', content: prompt });

  const run = await client.beta.threads.runs.create(thread.id, { assistant_id: ASSISTANT_ID });
  const start = Date.now();
  while (true) {
    const r = await client.beta.threads.runs.retrieve(thread.id, run.id);
    if (r.status === 'completed') break;
    if (['failed','cancelled','expired','requires_action'].includes(r.status)) {
      const reason = r?.last_error?.message || r.status;
      throw new Error(`Run status: ${reason}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('Run timeout');
    await new Promise(res => setTimeout(res, 900));
  }

  const messages = await client.beta.threads.messages.list(thread.id, { order: 'desc', limit: 10 });
  for (const m of messages.data) {
    if (m.role !== 'assistant') continue;
    for (const p of m.content || []) {
      if (p.type === 'text' && p.text?.value) {
        return p.text.value;
      }
    }
  }
  throw new Error('Assistant no devolvió texto');
}

// Ejecuta PRO en lotes y concatena
async function runProfessionalInBatches({ audience, questions, totalN, batchSize = 100, baseTimeoutMs = 1_200_000 }) {
  const batches = Math.ceil(totalN / batchSize);
  const all = [];
  for (let b = 0; b < batches; b++) {
    const startIndex = b * batchSize + 1;
    const size = Math.min(batchSize, totalN - b * batchSize);

    const prompt = buildProfessionalBatchPrompt({
      audience, questions, batchStart: startIndex, batchSize: size
    });

    // Timeout dinámico por lote (base alta + depende de tamaño y preguntas)
    const perPersonMs = 600;     // ajustable
    const perQuestionMs = 6000;  // ajustable
    const timeoutMs = baseTimeoutMs + size * perPersonMs + questions.length * perQuestionMs;

    const rawText = await runAssistantText(prompt, timeoutMs);

    const parsed = await safeParseAssistantJson(
      rawText,
      async () => {
        // Reintento: re-emite SOLO JSON válido
        const retryPrompt = 'Repite SOLO el JSON válido anterior, sin markdown ni comentarios.';
        const retryText = await runAssistantText(retryPrompt, 60_000);
        return retryText;
      }
    );

    const chunk = Array.isArray(parsed?.raw_respondents) ? parsed.raw_respondents
                : Array.isArray(parsed?.rawRespondents) ? parsed.rawRespondents
                : [];

    const norm = chunk.map((r, i) => ({
      respondentId: String(r?.respondentId || `r${String(startIndex + i).padStart(4,'0')}`),
      answers: (Array.isArray(r?.answers) ? r.answers : []).map(a => ({
        questionId: String(a?.questionId || ''),
        selected: Array.isArray(a?.selected) ? a.selected.map(String)
                 : Array.isArray(a?.choices) ? a.choices.map(String)
                 : (a?.choice != null ? [String(a.choice)] : [])
      }))
    }));

    all.push(...norm);
  }
  return all;
}

/* ─────────────────────────────────────────────────────────
   Agregación PRO desde rawRespondents
   ───────────────────────────────────────────────────────── */
function computeAggregatesFromRaw(questions, rawRespondents) {
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

/* 🔹 NUEVO: pedir racionales a la IA en base a agregados ya calculados */
async function getRationalesForAggregates(input, aggregates) {
  const prompt = buildRationalesPrompt(input, aggregates);
  const raw = await runAssistantText(prompt, 180_000); // corto y liviano
  const parsed = await safeParseAssistantJson(raw);
  const rationales = Array.isArray(parsed?.rationales) ? parsed.rationales : [];
  // normalizar shape
  return rationales.map(r => ({
    questionId: String(r?.questionId || ''),
    rationale: String(r?.rationale || '').trim()
  }));
}

/* ─────────────────────────────────────────────────────────
   Adaptadores → formato web (Lovable)
   ───────────────────────────────────────────────────────── */
function adaptProfessionalOutput({ input, rawRespondents, rationales }) {
  const results = computeAggregatesFromRaw(input.questions, rawRespondents);

  const rMap = new Map();
  if (Array.isArray(rationales)) {
    for (const r of rationales) {
      const qid = String(r?.questionId || '');
      const txt = String(r?.rationale || '').trim();
      if (qid && txt) rMap.set(qid, txt);
    }
  }
  for (const r of results) {
    r.rationale = rMap.get(r.questionId) || '';
  }

  return {
    success: true,
    status: 'completed',
    mode: 'professional',
    meta: { n: Number(input.responsesToSimulate || 0) },
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
      if (input.responsesToSimulate < 1 || input.responsesToSimulate > 1000) {
        return res.status(400).json({ success: false, error: 'responseCount debe estar entre 1 y 1000.' });
      }
    }

    // ENTREVISTAS: (si las usaran aquí) se podrían tratar aparte. Mantengo solo encuestas.
    if (input.mode === 'professional') {
      // 1) Ejecutar por lotes y traer TODAS las respuestas individuales
      const rawRespondents = await runProfessionalInBatches({
        audience: input.audience,
        questions: input.questions,
        totalN: input.responsesToSimulate,
        batchSize: 100,          // seguro
        baseTimeoutMs: 1_200_000 // base alta; el per-lote se ajusta
      });

      // 2) Agregar localmente (porcentajes) — lo de siempre
      const aggregates = computeAggregatesFromRaw(input.questions, rawRespondents);

      // 3) Pedir racionales cortos por pregunta (payload liviano)
      const rationales = await getRationalesForAggregates(input, aggregates);

      // 4) Armar salida final con racionales
      const out = adaptProfessionalOutput({ input, rawRespondents, rationales });
      return res.json(out);
    }

    // MODO BÁSICO (como estaba): IA devuelve agregados y nosotros normalizamos
    const prompt = buildSurveyPromptBasic(input);
    const rawText = await runAssistantText(prompt, 1_200_000);
    const assistantPayload = await safeParseAssistantJson(rawText);
    const output = adaptBasic({ input, assistantPayload });

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