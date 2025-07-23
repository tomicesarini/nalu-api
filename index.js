const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/api/simulations/run', (req, res) => {
  const { type, audience, questions } = req.body;

  const simulatedResults = {
    success: true,
    simulationId: 'abc123',
    status: 'completed',
    estimatedTime: '5 segundos',
    results: questions.map(q => ({
      question: q.question,
      answers: q.options.map(opt => ({
        option: opt,
        percentage: Math.floor(Math.random() * 100)
      }))
    }))
  };

  res.json(simulatedResults);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor API corriendo en puerto ${PORT}`);
});