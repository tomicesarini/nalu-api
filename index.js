
// src/index.js — Nalu API (basic + professional + entrevistas con personas sintéticas)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 10000;

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
app.use(express.json({ limit: '4mb' }));
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
const ASSISTANT_ID = process.env.ASSISTANT_ID;

// ===== Utils comunes
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice','single-choice','single','yes-no','yesno','boolean','scale','rating','likert'
]);
const MULTI_CHOICE_TYPES = new Set(['multi-select','checkbox','multiple-select']);

const clampInt = (n, min, max) => {
  n = Math.round(Number(n) || 0);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
};
const sum = arr => arr.reduce((s, x) => s + (Number(x) || 0), 0);

function isSingleChoice(q) {
  const t = (q?.type || '').toLowerCase();
  if (SINGLE_CHOICE_TYPES.has(t)) return true;
  if (Array.isArray(q?.options) && q.options.length > 0 && !MULTI_CHOICE_TYPES.has(t)) return true;
  return false;
}

function normalizePercentagesTo100(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return answers;
  const clamped = answers.map(a => ({
    text: (a?.text ?? '').toString(),
    percentage: clampInt(a?.percentage ?? 0, 0, 100),
  }));
  const total = sum(clamped.map(a => a.percentage));
  if (total === 100) return clamped;
  if (total <= 0) return clamped.map((a,i)=>({ ...a, percentage: i===0?100:0 }));
  const scaled = clamped.map(a => ({
    ...a, percentage: Math.round((a.percentage * 100) / total),
  }));
  const diff = 100 - sum(scaled.map(a => a.percentage));
  if (scaled[0]) scaled[0].percentage += diff;
  return scaled;
}

/* ============================
   Normalización de payload
   ============================ */
function normalizePayload(body) {
  const typeRaw = (body?.type || body?.form_data?.type || '').toString().toLowerCase();
  const type = typeRaw === 'entrevista' ? 'entrevista' : 'encuesta';

  const form = body?.form_data || {};
  const audBlock = body?.audience_data || body?.audience || {};

  const rawQuestions = Array.isArray(form?.questions)
    ? form.questions
    : (Array.isArray(body?.questions) ? body.questions : []);

  const normQuestions = rawQuestions.map(q => {
    const base = {
      id: (q?.id || '').toString(),
      question: (q?.question || '').toString(),
      required: Boolean(q?.required),
      type: (q?.type || '').toString().toLowerCase(),
    };
    if ((base.type === 'yes-no' || base.type === 'yesno' || base.type === 'boolean') && !Array.isArray(q?.options)) {
      base.type = 'yes-no';
      base.options = ['Sí','No'];
    } else if (Array.isArray(q?.options) && q.options.length > 0) {
      base.options = q.options.map(o => (o ?? '').toString().trim()).filter(Boolean);
    } else {
      base.options = [];
    }
    return base;
  });

  const demographics = audBlock?.demographics || {};
  const psychographics = audBlock?.psychographics || {};

  // Contexto nuevo
  const contextData = form?.contextData || {};
  const audienceContext = (contextData?.audienceContext || '').toString().trim();
  const userInsights = (contextData?.userInsights || '').toString().trim();

  // Modo y cantidad
  const surveyType = (audBlock?.surveyType || '').toString().toLowerCase(); // "basic" | "professional"
  const mode = surveyType === 'professional' ? 'professional' : 'basic';

  let responses = Number(audBlock?.responseCount ?? body?.responsesToSimulate ?? (mode==='professional'?100:0));
  if (mode === 'professional') {
    if (!Number.isFinite(responses)) responses = 100;
    responses = clampInt(responses, 10, 1000); // rango acordado
  } else {
    responses = 0; // basic no usa cantidad
  }

  // Para entrevistas: limitar 1..5
  if (type === 'entrevista') {
    responses = clampInt(Number(body?.responsesToSimulate ?? 3), 1, 5);
  }

  return {
    type,                    // 'encuesta' | 'entrevista'
    mode,                    // 'basic' | 'professional'
    responsesToSimulate: responses,
    audience: {
      name: audBlock?.name || '',
      description: audBlock?.description || '',
      demographics,
      psychographics,
      context: { audienceContext, userInsights },
    },
    questions: normQuestions,
  };
}

/* ============================
   Prompts
   ============================ */
function buildBasicSurveyPrompt(input) {
  return [
    'Eres un simulador de resultados de encuestas para investigación de mercado.',
    'Devuelve SOLO JSON válido, sin texto extra, con este formato EXACTO:',
    '{"status":"completed","results":[{"questionId":"...","question":"...","type":"multiple-choice","options":["..."],"aggregates":[{"text":"...","percentage":0-100}], "rationale":"breve"}]}',
    'Reglas:',
    '- Usa ESTRICTAMENTE demographics, psychographics y context; si existen, no digas que faltan.',
    '- Si la pregunta trae options, usa EXACTAMENTE esos textos.',
    '- En elección única, los porcentajes deben sumar 100.',
    '- En multi-select, cada opción puede ser 0–100 y la suma puede superar 100.',
    '- No “premies” una opción sólo por estar preguntada: sé realista.',
    '',
    `Público: ${JSON.stringify(input.audience)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

function buildProfessionalSurveyPrompt(input) {
  return [
    'Eres un simulador que genera PERSONAS SINTÉTICAS y sus respuestas para investigación de mercado.',
    `Debes generar EXACTAMENTE ${input.responsesToSimulate} personas sintéticas que respondan TODAS las preguntas.`,
    'Salida: SOLO JSON válido, sin texto extra, con este formato EXACTO:',
    '{"status":"completed","raw_respondents":[{"respondentId":"r1","answers":[{"questionId":"...","choice":"texto-opcion"},{"questionId":"...","choices":["texto-opcion","texto-opcion"]}]}], "rationales":[{"questionId":"...","rationale":"breve por qué quedó esa distribución"}]}',
    'Reglas IMPORTANTES:',
    '- Todas las respuestas deben usar SOLAMENTE opciones provistas en cada pregunta (texto EXACTO).',
    '- Si la pregunta es de elección única, usa "choice". Si es multi-select, usa "choices" (array, puede estar vacío).',
    '- Integra demographics, psychographics y context para variar respuestas de forma realista.',
    '- No agregues campos que no estén en el esquema.',
    '',
    `Público: ${JSON.stringify(input.audience)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

function buildInterviewPrompt(input) {
  return [
    'Eres un entrevistador virtual que genera respuestas textuales auténticas.',
    `Para CADA pregunta, genera EXACTAMENTE ${input.responsesToSimulate} respuestas únicas.`,
    'Cada respuesta debe ser un texto completo (2–3 oraciones), natural y realista.',
    'Salida: SOLO JSON válido:',
    '{"status":"completed","results":[{"question":"...","answers":[{"text":"..."},{"text":"..."}]}]}',
    '',
    `Público: ${JSON.stringify(input.audience)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

/* ============================
   OpenAI — Helpers
   ============================ */
async function runAssistantWithPrompt(prompt, timeoutMs = 60_000) {
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
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error('Respuesta del Assistant no es JSON válido');
    parsed = JSON.parse(match[0]);
  }
  return parsed;
}

/* ============================
   Agregación y validación PRO
   ============================ */
function aggregateFromRespondents(questions, raw) {
  // Map preguntas por id
  const qById = new Map(questions.map(q => [q.id, q]));
  const n = raw.length || 0;

  const results = questions.map(q => {
    const base = {
      questionId: q.id,
      question: q.question,
      type: q.type,
      options: q.options || [],
      aggregates: [],
      rationale: '', // se completa más abajo si vino en rationales
    };
    if (!Array.isArray(q.options) || q.options.length === 0) return { ...base, aggregates: [] };

    const counts = new Map(q.options.map(o => [o, 0]));
    for (const r of raw) {
      const ans = (r.answers || []).find(a => a.questionId === q.id);
      if (!ans) continue;

      if (isSingleChoice(q)) {
        const choice = (ans.choice ?? '').toString();
        if (counts.has(choice)) counts.set(choice, counts.get(choice) + 1);
      } else {
        const choices = Array.isArray(ans.choices) ? ans.choices : [];
        // en multi-select cuenta 1 por opción marcada
        const seen = new Set();
        for (const c of choices) {
          const key = (c ?? '').toString();
          if (counts.has(key) && !seen.has(key)) {
            counts.set(key, counts.get(key) + 1);
            seen.add(key);
          }
        }
      }
    }

    // a porcentajes
    const agg = q.options.map(o => {
      const c = counts.get(o) || 0;
      const denom = isSingleChoice(q) ? (n || 1) : (n || 1); // porcentaje sobre total de personas
      const pct = Math.round((c * 100) / denom);
      return { text: o, percentage: pct };
    });

    const finalAgg = isSingleChoice(q) ? normalizePercentagesTo100(agg) : agg;
    return { ...base, aggregates: finalAgg };
  });

  return results;
}

function filterToAllowedOptions(questions, raw) {
  const qById = new Map(questions.map(q => [q.id, q]));
  const clean = [];

  for (const r of raw || []) {
    const answers = [];
    for (const a of (r.answers || [])) {
      const q = qById.get(a.questionId);
      if (!q) continue;

      if (isSingleChoice(q)) {
        const choice = (a.choice ?? '').toString().trim();
        if (q.options.map(o=>o.toLowerCase()).includes(choice.toLowerCase())) {
          // normalizamos al texto original exacto (case-insensitive match)
          const exact = q.options.find(o => o.toLowerCase() === choice.toLowerCase()) || choice;
          answers.push({ questionId: q.id, choice: exact });
        }
      } else {
        const choices = Array.isArray(a.choices) ? a.choices : [];
        const allowed = new Set(q.options.map(o => o.toLowerCase()));
        const norm = [];
        for (const c of choices) {
          const key = (c ?? '').toString().trim().toLowerCase();
          if (allowed.has(key)) {
            const exact = q.options.find(o => o.toLowerCase() === key) || c;
            norm.push(exact);
          }
        }
        answers.push({ questionId: q.id, choices: Array.from(new Set(norm)) });
      }
    }
    clean.push({ respondentId: r.respondentId || '', answers });
  }
  return clean;
}

/* ============================
   Ruta principal
   ============================ */
app.post('/api/simulations/run', async (req, res) => {
  const input = normalizePayload(req.body);

  if (!input.questions || input.questions.length === 0) {
    return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
  }

  try {
    // ENTREVISTAS (igual)
    if (input.type === 'entrevista') {
      const prompt = buildInterviewPrompt(input);
      const ai = await runAssistantWithPrompt(prompt, 90_000);
      const results = Array.isArray(ai?.results) ? ai.results.map((r,i)=>({
        question: r.question || input.questions[i]?.question || `Pregunta ${i+1}`,
        answers: Array.isArray(r.answers) ? r.answers.map(a=>({ text: (a?.text ?? '').toString() })) : [],
      })) : [];
      return res.json({
        success: true,
        source: 'assistant',
        simulationId: `sim_${Date.now()}`,
        status: ai?.status || 'completed',
        mode: 'interview',
        results
      });
    }

    // ENCUESTA — BASIC
    if (input.mode === 'basic') {
      const prompt = buildBasicSurveyPrompt(input);
      const ai = await runAssistantWithPrompt(prompt, 90_000);

      // normalizar salida
      const results = Array.isArray(ai?.results) ? ai.results.map((r,i) => {
        const q = input.questions[i] || input.questions.find(qq => qq.id === r.questionId) || {};
        let aggregates = Array.isArray(r.aggregates) ? r.aggregates.map(a => ({
          text: (a?.text ?? '').toString(),
          percentage: clampInt(a?.percentage ?? 0, 0, 100),
        })) : [];
        // filtrar a opciones reales si las hay
        if (Array.isArray(q.options) && q.options.length > 0) {
          const allowed = new Set(q.options.map(o => o.toLowerCase()));
          aggregates = aggregates.filter(a => allowed.has((a.text||'').toLowerCase()));
        }
        if (isSingleChoice(q)) aggregates = normalizePercentagesTo100(aggregates);

        return {
          questionId: q.id || r.questionId || `q_${i+1}`,
          question: r.question || q.question || `Pregunta ${i+1}`,
          type: q.type || r.type || 'multiple-choice',
          options: q.options || [],
          aggregates,
          rationale: (r.rationale || '').toString().trim(),
        };
      }) : [];

      return res.json({
        success: true,
        source: 'assistant',
        simulationId: `sim_${Date.now()}`,
        status: ai?.status || 'completed',
        mode: 'basic',
        raw_respondents: null,
        results
      });
    }

    // ENCUESTA — PROFESSIONAL (personas sintéticas)
    if (input.mode === 'professional') {
      const prompt = buildProfessionalSurveyPrompt(input);
      const ai = await runAssistantWithPrompt(prompt, 120_000);

      const raw = Array.isArray(ai?.raw_respondents) ? ai.raw_respondents : [];
      // 1) Filtrar a opciones válidas y normalizar casing a EXACTO
      const cleaned = filterToAllowedOptions(input.questions, raw);
      // 2) Agregar
      const results = aggregateFromRespondents(input.questions, cleaned);

      // 3) Mapear rationales por questionId si vinieron
      const rMap = new Map();
      if (Array.isArray(ai?.rationales)) {
        for (const r of ai.rationales) {
          if (r?.questionId && r?.rationale) rMap.set(r.questionId, (r.rationale || '').toString().trim());
        }
      }
      for (const r of results) {
        if (rMap.has(r.questionId)) r.rationale = rMap.get(r.questionId);
      }

      return res.json({
        success: true,
        source: 'assistant',
        simulationId: `sim_${Date.now()}`,
        status: ai?.status || 'completed',
        mode: 'professional',
        raw_respondents: cleaned,   // <-- Lovable: guardar esto para análisis bivariado
        results
      });
    }

    // fallback imposible
    return res.status(400).json({ success:false, error:'Modo desconocido.' });

  } catch (err) {
    console.error('Error /api/simulations/run:', err?.message, err?.stack);
    const message = err?.message || 'Error desconocido';
    return res.status(500).json({
      success: false,
      error: 'Error interno al simular.',
      message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT} (basic + professional listos)`);
});
