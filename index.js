// index.js — Nalu API (OpenAI, razonamiento doble + validador)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

/* ── CORS (tus dominios + subdominios lovable) ───────────────────────────── */
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

/* ── JSON + health ───────────────────────────────────────────────────────── */
app.use(express.json());
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'API is running', ts: new Date().toISOString() });
});

/* ── OpenAI ──────────────────────────────────────────────────────────────── */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ── Utils de normalización ──────────────────────────────────────────────── */
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
const allMultiplesOf10 = answers =>
  Array.isArray(answers) && answers.length > 0 && answers.every(a => a.percentage % 10 === 0);
const tooFlat = answers => {
  if (!Array.isArray(answers) || answers.length < 3) return false;
  const vals = answers.map(a => a.percentage).sort((a, b) => a - b);
  return (vals[vals.length - 1] - vals[0]) <= 5;
};
const isSingleChoice = q => {
  const t = (q?.type || '').toLowerCase();
  if (SINGLE_CHOICE_TYPES.has(t)) return true;
  if (Array.isArray(q?.options) && q.options.length > 0 && t !== 'multi-select') return true;
  return false;
};
function normalizePercentagesTo100(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return answers;
  let clamped = answers.map(a => ({
    text: (a?.text ?? '').toString(),
    percentage: clampInt(a?.percentage ?? 0, 0, 100),
  }));
  let total = sum(clamped.map(a => a.percentage));
  if (total === 100) return clamped;
  if (total <= 0) {
    clamped = clamped.map((a, i) => ({ ...a, percentage: i === 0 ? 100 : 0 }));
    return clamped;
  }
  let scaled = clamped.map(a => ({
    ...a,
    percentage: Math.round((a.percentage * 100) / total)
  }));
  const diff = 100 - sum(scaled.map(a => a.percentage));
  if (scaled[0]) scaled[0].percentage += diff;
  return scaled;
}

/* ── Normalización de payload de entrada ─────────────────────────────────── */
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

/* ── Prompts (generalistas, sin reglas por caso) ─────────────────────────── */
function systemPrompt() {
  return `
Eres un simulador profesional de resultados de encuestas para investigación de mercados.
Tu objetivo: estimar cómo respondería un público real, dados su target/psicografía y el contexto.

Cómo trabajas (interno, sin imprimir tu razonamiento):
- Identificas el tipo de pregunta (elección única / multi-select / abierta) y entiendes las opciones.
- Lees el target/psicográficos para inferir afinidades, sesgos, nivel de exposición, demografía y contexto cultural/regional.
- Consideras el contexto actual (tendencias, disponibilidad, precios, reputación, timing).
- Propones una distribución realista, verosímil y explicable para ese público.
- Te auto-verificas: ¿suma correcta?, ¿números plausibles (evita patrones artificiales)? ¿coherencia con el target?

Salida (SOLO JSON válido):
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

Reglas:
- En **elección única** (multiple-choice, yes-no, escala/likert/rating) la suma es **exactamente 100**.
- Evita patrones artificiales (p.ej., todos múltiplos de 5 o 10) salvo que haya una razón contundente.
- Si no hay options (abierta), sintetiza 2–5 alternativas plausibles con porcentajes que sumen 100.
- No escribas nada fuera del JSON. Revisa consistencia antes de responder.
`;
}

function criticPrompt() {
  return `
Eres un auditor de calidad de simulaciones de encuestas. Recibirás:
- "userContent": contexto de la simulación (tipo, audience, psicográficos, preguntas)
- "draft": salida en formato { success, status, results[] }

Tareas:
1) Evaluar coherencia con el target/psicográficos y realismo de la distribución.
2) Corregir fallos: sumas≠100 en single-choice, números artificiales, opciones incoherentes, racionales vacíos.
3) Mantener el MISMO esquema y devolver SOLO JSON corregido. Sin texto fuera del JSON.

Si el borrador ya es correcto, devuélvelo igual (validado).
`;
}

/* ── Scoring y normalización de un candidato ─────────────────────────────── */
function scoreCandidate(parsed, input) {
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== input.questions.length) return -1;
  let score = 100;
  for (let i = 0; i < parsed.results.length; i++) {
    const r = parsed.results[i];
    const q = input.questions[i];
    if (!r || !Array.isArray(r.answers) || r.answers.length === 0) return -1;

    for (const a of r.answers) {
      const p = Number(a?.percentage ?? -1);
      if (isNaN(p) || p < 0 || p > 100) score -= 25;
    }
    if (isSingleChoice(q)) {
      const total = sum(r.answers.map(a => a.percentage));
      const deviation = Math.abs(100 - total);
      if (deviation > 2) score -= Math.min(35, deviation);
    }
    if (allMultiplesOf10(r.answers)) score -= 12;
    if (tooFlat(r.answers)) score -= 10;
    if (typeof r.rationale === 'string' && r.rationale.trim().length > 0) score += 3;
  }
  return score;
}

function coerceAndNormalize(parsed, input) {
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

/* ── Ruta principal: siempre OpenAI (borrador n>1 + auditor) ─────────────── */
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

    // 1) Borradores (n candidatos) — “pensar” primero
    const drafts = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.25,
      top_p: 0.9,
      n: 4, // más candidatos = más pensamiento diverso
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify(userContent) }
      ]
    });

    const candidates = (drafts.choices || [])
      .map(c => {
        try { return JSON.parse(c?.message?.content || '{}'); } catch { return null; }
      })
      .filter(Boolean);

    if (candidates.length === 0) {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del modelo (sin candidatos).' });
    }

    // Elegimos el mejor borrador según heurística de calidad
    let best = null, bestScore = -Infinity;
    for (const cand of candidates) {
      const sc = scoreCandidate(cand, input);
      if (sc > bestScore) { bestScore = sc; best = cand; }
    }
    if (!best || !Array.isArray(best.results)) {
      return res.status(502).json({ success: false, error: 'Borrador sin resultados.' });
    }

    // 2) Auditor interno (self-critique): valida y corrige si hace falta
    const audited = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2, // aún más estable en la auditoría
      top_p: 0.9,
      n: 1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: criticPrompt() },
        { role: 'user', content: JSON.stringify({ userContent, draft: best }) }
      ]
    });

    let finalParsed;
    try {
      finalParsed = JSON.parse(audited.choices?.[0]?.message?.content || '{}');
    } catch {
      finalParsed = best; // si el auditor falla en JSON, usamos el mejor borrador
    }
    if (!finalParsed || !Array.isArray(finalParsed.results)) {
      finalParsed = best;
    }

    const normalizedResults = coerceAndNormalize(finalParsed, input);

    return res.json({
      success: true,
      source: 'openai',
      usage: {
        prompt_tokens: (drafts.usage?.prompt_tokens || 0) + (audited.usage?.prompt_tokens || 0),
        completion_tokens: (drafts.usage?.completion_tokens || 0) + (audited.usage?.completion_tokens || 0),
        total_tokens: (drafts.usage?.total_tokens || 0) + (audited.usage?.total_tokens || 0),
      },
      simulationId: `sim_${Date.now()}`,
      status: finalParsed.status || 'completed',
      estimatedTime: 'unos segundos',
      results: normalizedResults
    });

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    return res.status(500).json({ success: false, error: 'Error interno al simular con OpenAI.' });
  }
});

/* ── Start ───────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT}`);
});