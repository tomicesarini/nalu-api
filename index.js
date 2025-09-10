// src/index.js — Nalu API (encuestas + entrevistas) — modos basic & professional (personas sintéticas)

const express = require('express');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS sencillo y seguro para tus dominios
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
const ASSISTANT_ID = process.env.ASSISTANT_ID; // seguimos usando Assistant para compat

// ===================== Utils =====================
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice', 'single-choice', 'single',
  'yes-no', 'yesno', 'boolean', 'scale', 'rating', 'likert'
]);

const MULTI_SELECT_TYPES = new Set(['multi-select', 'multiple-select', 'checkbox']);

const clampInt = (n, min, max) => {
  n = Math.round(Number(n) || 0);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
};
const sum = arr => arr.reduce((s, x) => s + (Number(x) || 0), 0);

function normalizePercentagesTo100(pairs) {
  // pairs: [{text, percentage}]
  if (!Array.isArray(pairs) || pairs.length === 0) return pairs;
  const clamped = pairs.map(a => ({
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
  if (Array.isArray(q?.options) && q.options.length > 0 && !MULTI_SELECT_TYPES.has(t)) return true;
  return false;
}
function isMultiSelect(q) {
  const t = (q?.type || '').toLowerCase();
  return MULTI_SELECT_TYPES.has(t);
}

// ===================== Normalización de entrada =====================
function normalizePayload(body) {
  // tipo
  const typeRaw = (body?.type || body?.form_data?.type || '').toString().toLowerCase();
  const type = typeRaw === 'entrevista' ? 'entrevista' : 'encuesta';

  // bloques
  const form = body?.form_data || {};
  const audBlock = body?.audience_data || body?.audience || {};

  // preguntas (preferimos form_data.questions)
  const rawQuestions = Array.isArray(form?.questions) ? form.questions : (Array.isArray(body?.questions) ? body.questions : []);
  const normQuestions = rawQuestions.map(q => {
    const base = {
      id: (q?.id || '').toString(),
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

  const demographics = audBlock?.demographics || {};
  const psychographics = audBlock?.psychographics || {};
  const surveyType = (audBlock?.surveyType || '').toString().toLowerCase(); // "basic" | "professional" (nuevo)

  // contexto nuevo
  const contextData = form?.contextData || {};
  const audienceContext = (contextData?.audienceContext || '').toString().trim();
  const userInsights = (contextData?.userInsights || '').toString().trim();

  // respuestas a simular
  let responses = Number(audBlock?.responseCount ?? body?.responsesToSimulate ?? 100);
  if (!Number.isFinite(responses) || responses <= 0) responses = 100;

  // entrevistas siguen con tope 5
  if (type === 'entrevista') {
    responses = Math.min(5, Math.max(1, Math.round(responses)));
  } else {
    responses = Math.round(responses);
  }

  return {
    type,
    surveyType: surveyType === 'professional' ? 'professional' : 'basic',
    audience: {
      name: audBlock?.name || '',
      description: audBlock?.description || '',
      demographics,
      psychographics,
      context: { audienceContext, userInsights },
    },
    responsesToSimulate: responses,
    questions: normQuestions,
  };
}

// ===================== Prompts =====================

// (Básico) — igual espíritu de siempre
function buildSurveyPromptBasic(input) {
  return [
    'Eres un simulador de resultados de encuestas para investigación de mercado.',
    'Devuelve SOLO un JSON válido, sin texto extra, con este formato exacto:',
    '{"status":"completed","results":[{"question":"...","answers":[{"text":"...","percentage":0-100}], "rationale":"breve"}]}',
    'Reglas:',
    '- Usa ESTRICTAMENTE demographics, psychographics y context si existen; NO digas que faltan si están.',
    '- Si la pregunta tiene opciones, usa EXACTAMENTE esas opciones (mismo texto).',
    '- Si es de elección única, los porcentajes deben sumar EXACTAMENTE 100.',
    '- Si es multi-select, los porcentajes pueden sumar >100.',
    '- No “premies” una opción solo porque fue preguntada: pondera con realismo según el público y el contexto.',
    '',
    `Público: ${JSON.stringify(input.audience)}`,
    `Respuestas a simular (estimación): ${input.responsesToSimulate}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

// (Profesional) — prompt para UN respondente que contesta TODAS las preguntas
function buildRespondentPrompt(input, personaSeed) {
  return [
    'Actúa como UNA persona realista perteneciente al público objetivo. Contesta TODAS las preguntas.',
    'Devuelve SOLO un JSON válido, sin texto extra, con este formato exacto:',
    '{"status":"ok","answers":[{"questionId":"...","type":"multiple-choice|multi-select|yes-no|...","selected":["opcion exacta","..."]}]}\n',
    'Reglas:',
    '- Usa tu perfil (seed) + el público objetivo provisto.',
    '- Para cada pregunta, si hay "options", elige SOLO entre esas opciones (texto EXACTO).',
    '- Responde multi-select con una o varias opciones (puede ser 0 si aplica, pero usualmente ≥1).',
    '- No inventes opciones ni renombres.',
    '',
    `Público objetivo: ${JSON.stringify(input.audience)}`,
    `Seed de persona (demografía/psicografía ejemplo): ${JSON.stringify(personaSeed)}`,
    `Preguntas: ${JSON.stringify(input.questions)}`
  ].join('\n');
}

// (Profesional) — prompt para rationale global por pregunta, basado en público + agregados
function buildRationalePrompt(audience, question, aggregates) {
  return [
    'Eres un analista de investigación de mercado.',
    'Con el siguiente público y los resultados agregados de una pregunta, redacta UNA justificación breve y clara (2–4 oraciones) explicando por qué pudo darse esa distribución.',
    'Devuelve SOLO texto llano, sin JSON, sin encabezados.',
    '',
    `Público: ${JSON.stringify(audience)}`,
    `Pregunta: ${JSON.stringify(question)}`,
    `Agregados: ${JSON.stringify(aggregates)}`
  ].join('\n');
}

// ===================== OpenAI (Assistants) helpers =====================
async function runAssistantPrompt(prompt, timeoutMs = 90_000) {
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
  return text;
}

async function runAssistantJSON(prompt, timeoutMs = 90_000) {
  const raw = await runAssistantPrompt(prompt, timeoutMs);
  const cleaned = raw
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

// ===================== Personas sintéticas (sampleo simple) =====================

function sampleValue(v) {
  if (Array.isArray(v) && v.length > 0) {
    return v[Math.floor(Math.random() * v.length)];
  }
  return v;
}
function buildPersonaSeed(audience) {
  // Sampleo muy simple desde demographics/psychographics/context para dar variación individuo a individuo.
  const d = audience?.demographics || {};
  const p = audience?.psychographics || {};
  return {
    age: Array.isArray(d.ageRange) ? Math.round(d.ageRange[0] + Math.random() * (d.ageRange[1] - d.ageRange[0])) : d.ageRange,
    gender: d.gender || null,
    location: d.location || null,
    income: sampleValue(d.income),
    education: d.education || null,
    occupation: d.occupation || null,
    maritalStatus: d.maritalStatus || null,
    employmentStatus: d.employmentStatus || null,
    interests: Array.isArray(p.interests) ? sampleValue(p.interests) : p.interests,
    values: Array.isArray(p.values) ? sampleValue(p.values) : p.values,
    personality: Array.isArray(p.personality) ? sampleValue(p.personality) : p.personality,
    motivations: Array.isArray(p.motivations) ? sampleValue(p.motivations) : p.motivations,
    innovationLevel: p.innovationLevel || null,
    riskPerception: p.riskPerception || null,
    priceSensitivity: p.priceSensitivity || null,
    politicalOpinion: Array.isArray(p.politicalOpinion) ? sampleValue(p.politicalOpinion) : p.politicalOpinion,
    contextHint: audience?.context?.audienceContext || null,
    userInsightsHint: audience?.context?.userInsights || null,
  };
}

// ===================== Professional mode core =====================

async function simulateOneRespondent(input) {
  const personaSeed = buildPersonaSeed(input.audience);
  const prompt = buildRespondentPrompt(input, personaSeed);
  const data = await runAssistantJSON(prompt, 90_000);
  // Esperamos {status:"ok", answers:[{questionId, type, selected:[...]}]}
  const answers = Array.isArray(data?.answers) ? data.answers : [];
  // Sanitizar: asegurar que selecciona dentro de opciones cuando existan
  const answersClean = input.questions.map(q => {
    const found = answers.find(a => a?.questionId?.toString() === q.id?.toString());
    let selected = Array.isArray(found?.selected) ? found.selected.map(s => (s ?? '').toString().trim()) : [];
    if (Array.isArray(q.options) && q.options.length > 0) {
      const allowed = new Set(q.options.map(o => o.toString().trim()));
      selected = selected.filter(s => allowed.has(s));
      // si es single-choice y no eligió nada válido, forzamos una al azar para evitar vacíos sesgados
      if (isSingleChoice(q) && selected.length !== 1) {
        const pick = q.options[Math.floor(Math.random() * q.options.length)];
        selected = [pick];
      }
      // si es multi-select y quedó vacío, permitimos vacío (pero es raro); no forzamos
    }
    return {
      questionId: q.id || '',
      type: q.type,
      selected,
    };
  });

  return {
    respondent_id: `r_${Math.random().toString(36).slice(2, 10)}`,
    persona_seed: personaSeed,
    answers: answersClean,
  };
}

async function simulateRespondentsInBatches(input, requestedCount, batchSize = 5) {
  const individuals = [];
  let produced = 0;

  while (produced < requestedCount) {
    const remaining = requestedCount - produced;
    const n = Math.min(batchSize, remaining);
    const batch = Array.from({ length: n }, () => simulateOneRespondent(input));
    const results = await Promise.all(batch);
    individuals.push(...results);
    produced += results.length;
  }
  return individuals;
}

function aggregateFromIndividuals(input, individuals) {
  // Construimos agregados por pregunta
  const results = input.questions.map(q => {
    const options = Array.isArray(q.options) ? q.options : [];
    const counts = new Map(); // opcion -> conteo
    options.forEach(o => counts.set(o, 0));

    if (options.length === 0) {
      // si no hay opciones declaradas, no agregamos nada especial
      return {
        questionId: q.id || '',
        question: q.question || '',
        type: q.type,
        options: [],
        aggregates: [],
        rationale: '', // se completa luego con el modelo
      };
    }

    // contar selecciones
    for (const ind of individuals) {
      const ans = (ind.answers || []).find(a => a.questionId === q.id);
      const selected = Array.isArray(ans?.selected) ? ans.selected : [];
      if (isSingleChoice(q)) {
        // esperamos exactamente 1
        const sel = selected[0];
        if (sel && counts.has(sel)) counts.set(sel, counts.get(sel) + 1);
      } else if (isMultiSelect(q)) {
        // sumar 1 a cada seleccionada
        for (const sel of selected) {
          if (counts.has(sel)) counts.set(sel, counts.get(sel) + 1);
        }
      } else {
        // por defecto, tratamos como single
        const sel = selected[0];
        if (sel && counts.has(sel)) counts.set(sel, counts.get(sel) + 1);
      }
    }

    // a porcentajes
    let aggregates = [];
    if (isSingleChoice(q)) {
      const total = individuals.length || 1;
      aggregates = options.map(o => ({
        text: o,
        percentage: Math.round((counts.get(o) * 100) / total),
      }));
      // normalizamos a 100 por redondeo
      aggregates = normalizePercentagesTo100(aggregates);
    } else {
      // multi-select: porcentaje de respondentes que marcaron cada opción (puede sumar >100)
      const total = individuals.length || 1;
      aggregates = options.map(o => ({
        text: o,
        percentage: Math.round((counts.get(o) * 100) / total),
      }));
      // no normalizamos en multi
    }

    return {
      questionId: q.id || '',
      question: q.question || '',
      type: q.type,
      options,
      aggregates,
      rationale: '', // se completa luego
    };
  });

  return results;
}

async function buildRationalesForResults(audience, results) {
  // Un rationale por pregunta (breve), basado en agregados.
  const withRat = [];
  for (const r of results) {
    const prompt = buildRationalePrompt(audience, { question: r.question, type: r.type, options: r.options }, r.aggregates);
    let rationale = '';
    try {
      const txt = await runAssistantPrompt(prompt, 60_000);
      rationale = (txt || '').toString().trim();
    } catch (e) {
      rationale = ''; // si falla la justificación, no frenamos todo
    }
    withRat.push({ ...r, rationale });
  }
  return withRat;
}

// ===================== Rutas =====================
app.post('/api/simulations/run', async (req, res) => {
  const input = normalizePayload(req.body);

  if (!input.questions || input.questions.length === 0) {
    return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
  }

  try {
    // ENTREVISTAS (se mantienen)
    if (input.type === 'entrevista') {
      // 1 run con prompt de entrevistas como antes (máx 5)
      const prompt = [
        'Eres un entrevistador virtual que genera respuestas textuales auténticas e individuales.',
        `Para CADA pregunta, genera EXACTAMENTE ${input.responsesToSimulate} respuestas únicas.`,
        'Cada respuesta debe ser un texto completo (2–3 oraciones), natural, personal y realista, como hablaría una persona típica de la audiencia.',
        'No generes porcentajes ni opciones múltiples. Sólo respuestas de texto.',
        'Usa ESTRICTAMENTE demographics, psychographics y context si están presentes; intégralos en el tono y el contenido.',
        '',
        'Formato de salida (SOLO JSON válido, sin texto extra):',
        '{"status":"completed","results":[{"question":"...","answers":[{"text":"respuesta 1"}, {"text":"respuesta 2"}]}]}',
        '',
        `Público (usa este contexto): ${JSON.stringify(input.audience)}`,
        `Preguntas: ${JSON.stringify(input.questions)}`
      ].join('\n');

      const parsed = await runAssistantJSON(prompt, 90_000);
      const results = (parsed?.results || []).map((r, i) => {
        const q = input.questions[i] || {};
        let texts = Array.isArray(r.answers)
          ? r.answers.map(a => ({ text: (a?.text ?? '').toString() }))
          : [];
        if (texts.length > input.responsesToSimulate) texts = texts.slice(0, input.responsesToSimulate);
        return {
          question: r.question || q.question || `Pregunta ${i + 1}`,
          answers: texts,
        };
      });

      return res.json({
        success: true,
        source: 'assistant',
        mode: 'interview',
        simulationId: `sim_${Date.now()}`,
        status: 'completed',
        results
      });
    }

    // ENCUESTAS
    if (input.surveyType === 'professional') {
      // Validación de N
      const requested = clampInt(input.responsesToSimulate, 10, 1000);
      if (requested !== input.responsesToSimulate) {
        console.warn(`requestedCount fuera de rango (${input.responsesToSimulate}) -> usando ${requested}`);
      }

      // 1) Generar individuos en batch
      const individuals = await simulateRespondentsInBatches(input, requested, 5);

      // 2) Agregar
      let aggregated = aggregateFromIndividuals(input, individuals);

      // 3) Rationale (1 por pregunta)
      aggregated = await buildRationalesForResults(input.audience, aggregated);

      // 4) Entregar
      return res.json({
        success: true,
        source: 'assistant',
        mode: 'professional',
        requestedCount: requested,
        generatedCount: individuals.length,
        simulationId: `sim_${Date.now()}`,
        status: 'completed',
        results: aggregated,
        individuals // SIN rationale individual
      });
    } else {
      // BASIC (estimación directa, igual que antes)
      const prompt = buildSurveyPromptBasic(input);
      const parsed = await runAssistantJSON(prompt, 90_000);
      if (!parsed || !Array.isArray(parsed.results)) {
        return res.status(502).json({ success: false, error: 'Respuesta inválida del Assistant (sin results).' });
      }

      const results = parsed.results.map((r, i) => {
        const q = input.questions[i] || {};
        let answers = Array.isArray(r.answers)
          ? r.answers.map(a => ({
              text: (a?.text ?? '').toString(),
              percentage: clampInt(a?.percentage ?? 0, 0, 100),
            }))
          : [];
        // Filtrar opciones inventadas si hay options
        if (Array.isArray(q?.options) && q.options.length > 0) {
          const allowed = new Set(q.options.map(o => o.toString().trim().toLowerCase()));
          const filtered = answers.filter(a => allowed.has(a.text.toLowerCase().trim()));
          if (filtered.length > 0) answers = filtered;
        }
        if (isSingleChoice(q)) answers = normalizePercentagesTo100(answers);
        return {
          question: r.question || q.question || `Pregunta ${i + 1}`,
          answers,
          rationale: (r.rationale || '').toString().trim(),
        };
      });

      return res.json({
        success: true,
        source: 'assistant',
        mode: 'basic',
        simulationId: `sim_${Date.now()}`,
        status: 'completed',
        results
      });
    }

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
  console.log(`🚀 API Nalu corriendo en puerto ${PORT} (basic + professional listos)`);
});

