import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { publicRouter } from './public.js';
import { commerceRouter } from './commerce.js';
import { authRouter } from './auth.js';
import { ordersRouter } from './orders.js';
import { adminAuthRouter } from './admin-auth.js';
import { adminContentRouter } from './admin-content.js';
import { adminCatalogRouter } from './admin-catalog.js';
import { adminMediaRouter } from './admin-media.js';
import { adminAccessRouter } from './admin-access.js';
import { realtimeRouter } from './realtime.js';
import { ApiError } from './http.js';
import { allowedOrigins } from './config.js';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.locals.requestId = randomUUID();
  res.setHeader('X-Request-Id', res.locals.requestId);
  next();
});
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Accept-Language');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (origin && !allowedOrigins.has(origin) && ['POST','PUT','PATCH','DELETE','OPTIONS'].includes(req.method)) { res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: 'Origin is not allowed', requestId: res.locals.requestId } }); return; }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
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
app.use('/v1', publicRouter);
app.use('/v1', commerceRouter);
app.use('/v1', authRouter);
app.use('/v1', ordersRouter);
app.use('/v1', realtimeRouter);
app.use('/v1/admin', adminAuthRouter);
app.use('/v1/admin', adminContentRouter);
app.use('/v1/admin', adminCatalogRouter);
app.use('/v1/admin', adminMediaRouter);
app.use('/v1/admin', adminAccessRouter);

app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: res.locals.requestId } }));

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
  const invalidJson = error instanceof SyntaxError && 'body' in error;
  const expected = error instanceof ApiError ? error : undefined;
  const dbCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const conflict = dbCode === '23505' || dbCode === '23503';
  const badInput = dbCode === '22P02';
  const status = expected?.status ?? (invalidJson || badInput ? 400 : conflict ? 409 : 500);
  if (status >= 500) console.error(JSON.stringify({ level: 'error', requestId: res.locals.requestId, message: 'Unhandled request error', error: String(error) }));
  res.status(status).json({ error: { code: expected?.code ?? (invalidJson || badInput ? 'VALIDATION_FAILED' : conflict ? 'CONFLICT' : 'INTERNAL_ERROR'), message: expected?.message ?? (invalidJson || badInput ? 'Invalid request' : conflict ? 'Record conflicts with existing data' : 'Internal server error'), ...(expected?.details === undefined ? {} : { details: expected.details }), requestId: res.locals.requestId } });
};
app.use(errors);
