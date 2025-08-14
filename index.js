// index.js — Nalu API (OpenAI only, sin aleatorio)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// CORS: tus dominios + cualquier subdominio de lovableproject.com
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
// JSON & Health
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'API is running', ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI client (usa la API key de Render: OPENAI_API_KEY)
// ─────────────────────────────────────────────────────────────────────────────
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizePayload(body) {
  const type = (body?.type || '').toString().toLowerCase(); // 'encuesta' | 'entrevista'
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  const normQuestions = questions.map((q) => {
    const base = {
      question: (q?.question || '').toString(),
      required: Boolean(q?.required),
    };

    // yes/no sin options -> forzamos ['Sí','No']
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

const SINGLE_CHOICE_TYPES = new Set([
  'multiple-choice', 'single-choice', 'single', 'yes-no', 'yesno', 'boolean',
  'scale', 'rating', 'likert'
]);

function normalizePercentagesTo100(answers) {
  if (!Array.isArray(answers) || answers.length === 0) return answers;
  let total = answers.reduce((s, a) => s + (Number(a.percentage) || 0), 0);
  if (total === 100) return answers;

  if (total > 0) {
    let scaled = answers.map(a => ({
      ...a,
      percentage: Math.round((Number(a.percentage) || 0) * 100 / total)
    }));
    const diff = 100 - scaled.reduce((s, a) => s + a.percentage, 0);
    if (scaled[0]) scaled[0].percentage += diff;
    return scaled;
  }

  return answers.map((a, i) => ({ ...a, percentage: i === 0 ? 100 : 0 }));
}

// Prompt de sistema (instrucciones fijas para el modelo)
function systemPrompt() {
  return `
SOS UN ROBOT, UN SIMULADOR DE RESULTADOS DE ENCUESTAS EXPERTO y EXCELENTEMENTE CALIBRADO. 
Simulás con criterio de investigación actualizado, hiperprofesional y sesgo por audiencia/psicográficos. 
Tus resultados deben parecerse a cómo respondería el público real.

Tené en cuenta: hechos recientes, percepción pública, exposición del target al tema, escenario temporal,
polarización, nivel educativo, estado emocional, referencias culturales/regionales y supuestos clave.

REGLAS TÉCNICAS:
- DEVOLVÉ SOLO JSON VÁLIDO (sin explicación fuera del JSON).
- Para SINGLE-CHOICE (multiple-choice, yes-no, escala/likert/rating) las sumas deben dar 100 exacto (podés redondear).
- Si no hay "options" (abierta), devolvé 3–5 temas agregados con porcentajes que sumen 100.
- Agregá "rationale" corto (1–2 frases) por pregunta justificando la distribución según el target.

FORMATO:
{
  "success": true,
  "status": "completed",
  "results": [
    {
      "question": "texto de la pregunta",
      "answers": [
        { "text": "opción A", "percentage": 42 },
        { "text": "opción B", "percentage": 58 }
      ],
      "rationale": "breve justificación"
    }
  ]
}
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruta principal: SIEMPRE OpenAI (sin aleatorio)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/simulations/run', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error('OPENAI_API_KEY no configurada.');
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
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify(userContent) }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('Respuesta no-JSON de OpenAI:', raw);
      return res.status(502).json({ success: false, error: 'Respuesta inválida del modelo.' });
    }

    if (!parsed || !Array.isArray(parsed.results)) {
      console.error('OpenAI sin "results":', parsed);
      return res.status(502).json({ success: false, error: 'Faltan resultados en la respuesta del modelo.' });
    }

    const normalizedResults = parsed.results.map((r, idx) => {
      const originalQ = input.questions[idx] || {};
      const isSingle =
        SINGLE_CHOICE_TYPES.has((originalQ.type || '').toLowerCase()) ||
        (Array.isArray(originalQ.options) && originalQ.options.length > 0 && originalQ.type !== 'multi-select');

      const answers = Array.isArray(r.answers) ? r.answers.map(a => ({
        text: (a?.text ?? '').toString(),
        percentage: Number(a?.percentage ?? 0)
      })) : [];

      return {
        question: r.question || originalQ.question || `Pregunta ${idx + 1}`,
        answers: isSingle ? normalizePercentagesTo100(answers) : answers,
        rationale: (r.rationale || '').toString().slice(0, 300)
      };
    });

    return res.json({
      success: true,
      source: 'openai',               // ← indicador explícito
      usage: completion.usage || null,
      simulationId: `sim_${Date.now()}`,
      status: parsed.status || 'completed',
      estimatedTime: 'unos segundos',
      results: normalizedResults
    });

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    // SIN fallback: si falla, devolvemos 500 para que nos enteremos
    return res.status(500).json({ success: false, error: 'Error interno al simular (OpenAI).' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT}`);
});