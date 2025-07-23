const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para parsear JSON
app.use(express.json());

// Middleware para permitir CORS
const allowedOrigins = [
  'https://naluinsights.lovable.app',
  'https://preview-naluinsights.lovable.app',
  'https://nalua.com',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  methods: 'GET,POST,OPTIONS',
  allowedHeaders: 'Content-Type,Authorization',
}));

// Ruta POST para correr simulaciones
app.post('/api/simulations/run', (req, res) => {
  const { type, audience, questions } = req.body;

  const simulatedResults = {
    success: true,
    simulationId: 'abc123',
    status: 'completed',
    estimatedTime: '5 segundos',
    results: questions.map((q) => ({
      question: q.question,
      answers: q.options.map((opt) => ({
        text: opt,
        percentage: Math.floor(Math.random() * 100),
      })),
    })),
  };

  res.json(simulatedResults);
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});