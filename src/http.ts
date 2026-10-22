import type { Request, Response } from 'express';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export const send = (res: Response, data: unknown, meta?: unknown): void => {
  res.json({ data, ...(meta === undefined ? {} : { meta }) });
};

export const asText = (value: unknown, max = 200): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const asObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const positiveInt = (value: unknown, fallback: number, max = 1000): number => {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid positive integer');
  return number;
};
export const moneyInt = (value: unknown, fallback?: number): number => {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ApiError(400, 'VALIDATION_FAILED', 'Money amount is required');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid money amount');
  return number;
};
export const localeOf = (req: Request): 'ar' | 'en' => req.query['locale'] === 'en' || (!req.query['locale'] && req.header('accept-language')?.startsWith('en')) ? 'en' : 'ar';
export const siteOrigin = (): string => process.env['PUBLIC_SITE_URL']?.replace(/\/$/, '') || 'http://localhost:4200';
