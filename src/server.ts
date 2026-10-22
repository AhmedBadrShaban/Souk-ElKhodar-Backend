import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

export default app;

if (process.env['VERCEL'] !== '1') {
  const server = app.listen(config.PORT, () => console.log(JSON.stringify({ level: 'info', message: 'API listening', port: config.PORT })));
  async function shutdown(): Promise<void> {
    server.close();
    await pool.end();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
