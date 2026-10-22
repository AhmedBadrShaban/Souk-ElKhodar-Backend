import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { attachAnnouncements } from './realtime.js';

export default app;

if (process.env['VERCEL'] !== '1') {
  const server = app.listen(config.PORT, () => console.log(JSON.stringify({ level: 'info', message: 'API listening', port: config.PORT })));
  const stopAnnouncements = attachAnnouncements(server);
  async function shutdown(): Promise<void> {
    stopAnnouncements();
    server.close();
    await pool.end();
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
