import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  DATABASE_URL: z.string().url(),
  STOREFRONT_ORIGIN: z.string().url().optional(),
  DASHBOARD_ORIGIN: z.string().url().optional(),
  BUSINESS_TIMEZONE: z.string().default('Africa/Cairo'),
});

export const config = schema.parse(process.env);
export const allowedOrigins = new Set([config.STOREFRONT_ORIGIN, config.DASHBOARD_ORIGIN].filter((origin): origin is string => Boolean(origin)).map(origin => new URL(origin).origin));
