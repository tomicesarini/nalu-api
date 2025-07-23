const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Lista blanca de dominios permitidos
const allowedOrigins = [
  'https://naluinsights.lovable.app',
  'https://preview-naluinsights.lovable.app',
  'https://nalua.com'
];

// Middleware de CORS (sin errores)
app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origen (por ejemplo desde curl o Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  methods: 'GET,POST,OPTIONS',
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware para parsear JSON
app.use(express.json());

// Ruta de prueba simple (opcional)
app.get('/', (req, res) => {
  res.send('API corriendo correctamente');
});

// Ruta principal: POST para correr simulaciones
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

// Arranca el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});