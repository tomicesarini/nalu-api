// index.js — Nalu API (OpenAI-powered)

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai'); // SDK oficial; requiere `npm install openai`

const app = express();
const PORT = process.env.PORT || 3000;

// --- CORS (permitimos tus dominios + cualquier subdominio de lovableproject.com) ---
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
  if (
    !origin ||
    allowedOrigins.has(origin) ||
    origin.endsWith('.lovableproject.com')
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// --- JSON body ---
app.use(express.json());

// --- Healthcheck simple ---
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// --- Cliente OpenAI (usa la API key que ya cargaste en Render) ---
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Util: normalizar estructura de entrada
function normalizePayload(body) {
  const type = (body?.type || '').toString().toLowerCase(); // 'encuesta' | 'entrevista'
  const questions = Array.isArray(body?.questions) ? body.questions : [];

  return {
    type: type === 'entrevista' ? 'entrevista' : 'encuesta',
    audience: body?.audience || {},
    psychographics: body?.psychographics || {},
    responsesToSimulate: Number(body?.responsesToSimulate || 100),
    questions: questions.map(q => {
      const base = {
        question: q?.question || '',
        required: Boolean(q?.required),
      };
      if (Array.isArray(q?.options) && q.options.length > 0) {
        base.options = q.options.filter((o) => (o || '').toString().trim());
      }
      // si el builder usa tipos (multiple-choice, multi-select, yes-no, scale, etc)
      if (q?.type) base.type = q.type;
      return base;
    }),
  };
}

// --- Prompt de sistema para el modelo ---
function systemPrompt() {
  return `
Sos un analista de investigación de mercados. 
Devolvés SOLO JSON válido con este formato:

{
  "success": true,
  "status": "completed",
  "results": [
    {
      "question": "texto de la pregunta",
      "answers": [
        { "text": "opción A", "percentage": 42 },
        { "text": "opción B", "percentage": 58 }
      ]
    }
  ],
  "notes": "opcional, breve"
}

Reglas:
- Si la pregunta tiene "options": distribuir porcentajes por opción. 
  * Para single-choice (multiple-choice, yes-no, scale): la suma ≈ 100 (permití redondeo).
  * Para multi-select: cada opción tiene porcentaje independiente (pueden sumar >100).
- Si NO hay "options" (entrevista abierta): en "answers" devolvé objetos con "text" y "percentage" que represente prevalencia de temas, o devolvé 1–3 insights agregados como opciones sintéticas (ej: "Tema A", "Tema B") con sus porcentajes.
- No inventes campos. No incluyas explicación fuera del JSON.
- Usá criterio con la audiencia y psicográficos si están presentes para sesgar los porcentajes.
`;
}

// --- Ruta principal: corre la simulación con OpenAI ---
app.post('/api/simulations/run', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY no configurada en el servidor.' });
    }

    const input = normalizePayload(req.body);

    if (!input.questions || input.questions.length === 0) {
      return res.status(400).json({ success: false, error: 'Faltan preguntas.' });
    }

    // Armamos mensaje de usuario resumido (para mantener costo bajo)
    const userContent = {
      type: input.type, // 'encuesta' | 'entrevista'
      responsesToSimulate: input.responsesToSimulate,
      audience: input.audience,
      psychographics: input.psychographics,
      questions: input.questions
    };

    // Llamada a OpenAI — usamos chat completions con JSON estricto
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',          // económico y rápido
      temperature: 0.4,              // más estable
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: JSON.stringify(userContent) }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';

    // Parseo seguro
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ success: false, error: 'Respuesta inválida del modelo.' });
    }

    // Validación mínima de estructura
    if (!parsed || !Array.isArray(parsed.results)) {
      return res.status(502).json({ success: false, error: 'Faltan resultados en la respuesta del modelo.' });
    }

    // Armamos respuesta estándar para Lovable
    const response = {
      success: true,
      simulationId: `sim_${Date.now()}`,
      status: parsed.status || 'completed',
      estimatedTime: 'unos segundos',
      results: parsed.results
    };

    return res.json(response);

  } catch (err) {
    console.error('Error /api/simulations/run:', err);
    return res.status(500).json({ success: false, error: 'Error interno al simular.' });
  }
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🚀 API Nalu corriendo en puerto ${PORT}`);
});