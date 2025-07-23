const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Dominios permitidos
const allowedOrigins = [
  'https://naluinsights.lovable.app',
  'https://preview-naluinsights.lovable.app',
  'https://nalua.com',
  'https://www.nalua.com',
  'https://naluia.com',
  'https://www.naluia.com',
];

// Middleware para CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  console.log('Origen recibido:', origin); // Para verificar qué está llegando
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  next();
});

// Middleware para parsear JSON
app.use(express.json());

// Ruta POST simulación
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