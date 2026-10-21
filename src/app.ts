import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader('X-Request-Id', res.locals.requestId);
  next();
});

app.get('/v1/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ data: { status: 'ok', database: 'ok' } });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, message: 'Database health check failed', error: String(error) }));
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Database unavailable', requestId: res.locals.requestId } });
  }
});

app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: res.locals.requestId } }));

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, message: 'Unhandled request error', error: String(error) }));
  if (res.headersSent) return;
  const invalidJson = error instanceof SyntaxError && 'body' in error;
  res.status(invalidJson ? 400 : 500).json({ error: { code: invalidJson ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', message: invalidJson ? 'Invalid JSON body' : 'Internal server error', requestId: res.locals.requestId } });
};
app.use(errors);
