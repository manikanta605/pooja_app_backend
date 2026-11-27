const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { dbPath } = require('./db');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: 'sqlite', dbPath, time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api', apiRoutes);

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PujaDiary API server listening on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
