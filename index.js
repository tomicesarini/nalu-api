// index.js — Nalu API (OpenAI-powered, robust realism)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

/* ──────────────────────────────────────────────────────────────────────────
   CORS: permitimos tus dominios + cualquier subdominio de lovableproject.com
   ────────────────────────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────────────────────
   JSON & Health
   ────────────────────────────────────────────────────────────────────────── */
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'API is running', ts: new Date().toISOString() });
});

/* ──────────────────────────────────────────────────────────────────────────
   OpenAI client (requiere OPENAI_API_KEY en Render)
   ────────────────────────────────────────────────────────────────────────── */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ──────────────────────────────────────────────────────────────────────────
   Helpers: normalización de payload
   ────────────────────────────────────────────────────────────────────────── */
const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice', 'single-choice', 'single', 'yes-no', 'yesno', 'boolean',
  'scale', 'rating', 'likert'
]);

function normalizePayload(body) {
  const type = (body?.type || '').toString().toLowerCase(); // 'encuesta' | 'entrevista'
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  const normQuestions = questions.map((q) => {
    const base = {
      question: (q?.question || '').toString(),
      required: Boolean(q?.required),
    };

    const qType = (q?.type || '').toString().toLowerCase();
    if ((qType === 'yes-no' || qType === 'yesno' || qType === 'boolean') && !Array.isArray(q?.options)) {
      base.type = 'yes-no';
      base.options = ['Sí', 'No'];
    } else if (Array.isArray(q?.options) && q.options.length > 0) {
      base.options = q.options
        .map(o => (o ?? '').toString().trim())
        .filter(Boolean);
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

function isSingleChoice(q) {
  const t = (q?.type || '').toLowerCase();
  if (SINGLE_CHOICE_TYPES.has(t)) return true;
  // si tiene opciones y no es "multi-select", tratamos como single
  if (Array.isArray(q?.options) && q.options.length > 0 && t !== 'multi-select') return true;
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────
   Normalización de porcentajes & utilidades
   ────────────────────────────────────────────────────────────────────────── */
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
  // answers: [{ text, percentage }]
  if (!Array.isArray(answers) || answers.length === 0) return answers;

  // clamp [0..100] y enteros
  let clamped = answers.map(a => ({
    text: (a?.text ?? '').toString(),
    percentage: clampInt(a?.percentage ?? 0, 0, 100),
  }));

  let total = sum(clamped.map(a => a.percentage));
  if (total === 100) return clamped;

  if (total <= 0) {
    // todo 0 -> 100 al primero
    clamped = clamped.map((a, i) => ({ ...a, percentage: i === 0 ? 100 : 0 }));
    return clamped;
  }

  // re-escala y ajusta redondeo
  let scaled = clamped.map(a => ({
    ...a,
    percentage: Math.round((a.percentage * 100) / total)
  }));
  const diff = 100 - sum(scaled.map(a => a.percentage));
  if (scaled[0]) scaled[0].percentage += diff;
  return scaled;
}

function allMultiplesOf10(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return false;
  return answers.every(a => a.percentage % 10 === 0);
}

function tooFlat(answers) {
  if (!Array.isArray(answers) || answers.length < 3) return false;
  // si todas están dentro de un rango muy estrecho (ej: max-min <= 5) penalizamos
  const vals = answers.map(a => a.percentage).sort((a, b) => a - b);
  return (vals[vals.length - 1] - vals[0]) <= 5;
}

/* ──────────────────────────────────────────────────────────────────────────
   Prompt de sistema (robusto, realista, generalista)
   ────────────────────────────────────────────────────────────────────────── */
function systemPrompt() {
  return `
Eres un simulador profesional de resultados de encuestas para investigación de mercados.
Tu misión: estimar cómo **respondería un público real**, dados su target/psicografía y el contexto actual.

CÓMO TRABAJAS (de forma interna, sin imprimir tu razonamiento):
- Identificas objetivos de la pregunta, el tipo (elección única / multi-select / abierta) y las opciones.
- Lees el target y psicográficos para inferir sesgos, preferencias, nivel de exposición, región, demografía y lealtad.
- Consideras contexto/actualidad (reciente y general) a nivel de tendencias, disponibilidad, pricing, cultura, etc.
- Propones una distribución **realista**, verosímil y explicable para ese público.
- Antes de devolver, te auto-verificas: ¿suma correcta? ¿números plausibles (no patrones artificiales)? ¿coherencia con el target?

REGLAS DE SALIDA:
- Devuelve **SOLO JSON válido** con este esquema:
{
  "success": true,
  "status": "completed",
  "results": [
    {
      "question": "texto",
      "answers": [
        { "text": "opción", "percentage": 0-100 }
      ],
      "rationale": "1–2 frases: por qué esa distribución (menciona target/psicografía y contexto)"
    }
  ]
}
- Si la pregunta es de **elección única** (multiple-choice, yes-no, escala/likert/rating): la suma debe ser **exactamente 100**.
  Evita patrones artificiales (p.ej., todos múltiplos de 5) salvo que tengas una razón sólida.
- Si **no** hay options (abierta), sintetiza 2–5 alternativas plausibles con porcentajes que sumen 100.
- No imprimas nada fuera del JSON. Revisa consistencia antes de responder.
`;
}
function criticPrompt() {
  return `
Eres un auditor de calidad de simulaciones de encuestas. Recibirás:
- "userContent": contexto (tipo, audience, psicográficos, preguntas)
- "draft": salida en el esquema { success, status, results[] }

Tu tarea:
1) Verificar coherencia con el target/psicográficos y realismo de la distribución.
2) Corregir cualquier fallo: sumas≠100 en single-choice, números artificiales, opciones sin sentido, racionales vacíos.
3) Mantener el MISMO esquema y devolver **SOLO JSON** corregido. No imprimas texto fuera del JSON.

Si el borrador ya es correcto, devuélvelo igual (pero validado).
`;
}
/* ──────────────────────────────────────────────────────────────────────────
   Elección del mejor candidato entre n=2
   ────────────────────────────────────────────────────────────────────────── */
function scoreCandidate(parsed, input) {
  // parsed = { results: [...] }
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== input.questions.length) return -1;

  let score = 100;

  for (let i = 0; i < parsed.results.length; i++) {
    const r = parsed.results[i];
    const q = input.questions[i];

    if (!r || !Array.isArray(r.answers) || r.answers.length === 0) return -1;

    // penalizamos out-of-range
    for (const a of r.answers) {
      const p = Number(a?.percentage ?? -1);
      if (isNaN(p) || p < 0 || p > 100) score -= 20;
    }

    // si es single-choice, deberían sumar ~100 (nosotros igual normalizamos luego)
    if (isSingleChoice(q)) {
      const total = sum(r.answers.map(a => a.percentage));
      const deviation = Math.abs(100 - total);
      if (deviation > 3) score -= Math.min(30, deviation); // más desviación, más penalidad
    }

    // penalizamos “todos múltiplos de 10”
    if (allMultiplesOf10(r.answers)) score -= 10;

    // penalizamos distribución demasiado plana con 3+ opciones
    if (tooFlat(r.answers)) score -= 10;

    // pequeño bonus por tener rationale breve
    if (typeof r.rationale === 'string' && r.rationale.trim().length > 0) score += 2;
  }

  return score;
}

function coerceAndNormalize(parsed, input) {
  // normalizamos, clamp, enteros, y sumas=100 para single-choice
  const out = [];
  for (let i = 0; i < parsed.results.length; i++) {
    const r = parsed.results[i];
    const q = input.questions[i];

    let answers = Array.isArray(r.answers)
      ? r.answers.map(a => ({
          text: (a?.text ?? '').toString(),
          percentage: clampInt(a?.percentage ?? 0, 0, 100),
        }))
      : [];

    if (isSingleChoice(q)) {
      answers = normalizePercentagesTo100(answers);
      // si quedaron todos múltiplos de 10, hacemos minidesempate sutil (+/-1) para romper patrón
      if (allMultiplesOf10(answers) && answers.length >= 2) {
        answers[0].percentage = clampInt(answers[0].percentage + 1, 0, 100);
        answers[answers.length - 1].percentage = clampInt(answers[answers.length - 1].percentage - 1, 0, 100);
        answers = normalizePercentagesTo100(answers);
      }
    }

    out.push({
      question: r.question || q.question || `Pregunta ${i + 1}`,
      answers,
      rationale: (r.rationale || '').toString().slice(0, 300),
    });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Ruta principal: SIEMPRE OpenAI (sin fallback random)
   ────────────────────────────────────────────────────────────────────────── */
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

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.35,         // estable pero con variación natural
      top_p: 0.9,
      n: 2,                      // pedimos 2 candidatos y elegimos el mejor
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify(userContent) }
      ]
    });

    // parseamos y elegimos mejor candidato
    const candidates = (completion.choices || [])
      .map(c => {
        try {
          return JSON.parse(c?.message?.content || '{}');
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (candidates.length === 0) {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del modelo.' });
    }

    let best = null, bestScore = -Infinity;
    for (const cand of candidates) {
      const sc = scoreCandidate(cand, input);
      if (sc > bestScore) { bestScore = sc; best = cand; }
    }

    if (!best || !Array.isArray(best.results)) {
      return res.status(502).json({ success: false, error: 'Faltan resultados en la respuesta del modelo.' });
    }

    const normalizedResults = coerceAndNormalize(best, input);

    return res.json({
      success: true,
      source: 'openai',
      usage: completion.usage || null,
      simulationId: `sim_${Date.now()}`,
      status: best.status || 'completed',
      estimatedTime: 'unos segundos',
      results: normalizedResults
    });

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    // SIN fallback random: devolvemos error como pediste
    return res.status(500).json({ success: false, error: 'Error interno al simular con OpenAI.' });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   Start
   ────────────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT}`);
});