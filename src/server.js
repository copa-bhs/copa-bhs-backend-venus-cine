/**
 * Ponto de entrada do servidor.
 * Apenas inicializa o Express, aplica middlewares e carrega as rotas.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middlewares globais
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Log de requisições
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`
    );
  });
  next();
});

// Rota raiz
app.get('/', (_req, res) => {
  res.json({
    name: 'Vênus Cine Backend',
    version: '1.0.0',
    docs: '/api/health',
  });
});

// Rotas da API
app.use('/api', apiRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Error handler global
app.use((err, _req, res, _next) => {
  console.error('[erro global]', err?.message || err);
  res.status(500).json({ error: err?.message || 'Erro interno' });
});

// Boot
app.listen(PORT, () => {
  console.log(`\n🎬 Vênus Cine Backend`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   → Health: http://localhost:${PORT}/api/health`);
  console.log(`   → Home:   http://localhost:${PORT}/api/home\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Encerrando servidor...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n👋 Encerrando servidor...');
  process.exit(0);
});