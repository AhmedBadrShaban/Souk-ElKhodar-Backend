import { randomInt } from 'node:crypto';
import { ApiError } from './http.js';

function isProdLike(): boolean {
  return ['production', 'staging'].includes(process.env['NODE_ENV'] ?? '');
}

function allowedPhones(): string[] {
  return (process.env['OTP_TWILIO_ALLOWED_PHONES'] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean); // an empty env var gives [] instead of ['']
}

export function otpMode(): 'fixed' | 'twilio_whatsapp' {
  const mode = process.env['OTP_MODE'];
  if (mode === 'twilio_whatsapp' || mode === 'fixed') return mode;
  if (!mode && !isProdLike()) return 'fixed';
  throw new ApiError(503, 'OTP_PROVIDER_UNAVAILABLE', 'OTP provider is not configured');
}

export async function deliverOtp(phone: string): Promise<string> {
  const allowed = allowedPhones();

  if (otpMode() === 'fixed') {
    if (isProdLike()) {
      const fixedCode = process.env['OTP_FIXED_CODE'];
      if (!allowed.length || !fixedCode) {
        throw new ApiError(503, 'OTP_PROVIDER_UNAVAILABLE', 'OTP provider is not configured');
      }
      if (!allowed.includes(phone)) {
        throw new ApiError(403, 'OTP_TEST_ONLY', 'Fixed verification is available to approved test numbers only');
      }
      return fixedCode;
    }
    return process.env['OTP_FIXED_CODE'] || '123456';
  }

  if (!allowed.includes(phone)) throw new ApiError(403, 'OTP_TEST_ONLY', 'WhatsApp verification is available to approved test numbers only');

  const accountSid = process.env['TWILIO_ACCOUNT_SID'] ?? '';
  const authToken = process.env['TWILIO_AUTH_TOKEN'] ?? '';
  const sender = process.env['TWILIO_WHATSAPP_FROM'] ?? '';
  const contentSid = process.env['TWILIO_OTP_CONTENT_SID'] ?? '';
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid) || !authToken || !/^\+[1-9]\d{7,14}$/.test(sender) || !/^HX[0-9a-f]{32}$/i.test(contentSid)) {
    throw new ApiError(503, 'OTP_PROVIDER_UNAVAILABLE', 'WhatsApp verification is not configured');
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const body = new URLSearchParams({
    To: `whatsapp:${phone}`,
    From: `whatsapp:${sender}`,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify({ '1': 'Souk El Khodar', '2': code }),
  });
  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Twilio rejected OTP request: ${response.status}`);
    return code;
  } catch {
    throw new ApiError(503, 'OTP_DELIVERY_FAILED', 'Could not send the WhatsApp code. Please try again');
  }
}