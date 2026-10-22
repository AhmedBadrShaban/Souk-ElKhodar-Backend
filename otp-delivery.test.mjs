import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { deliverOtp, otpMode } from './dist/otp-delivery.js';

const names = ['NODE_ENV','OTP_MODE','OTP_FIXED_CODE','OTP_TWILIO_ALLOWED_PHONES','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_WHATSAPP_FROM','TWILIO_OTP_CONTENT_SID'];
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
after(() => {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  globalThis.fetch = originalFetch;
});

test('fixed code stays limited to development', async () => {
  process.env.NODE_ENV = 'development';
  process.env.OTP_MODE = 'fixed';
  process.env.OTP_FIXED_CODE = '123456';
  assert.equal(await deliverOtp('+201000000000'), '123456');
  process.env.NODE_ENV = 'production';
  assert.throws(() => otpMode(), { code: 'OTP_PROVIDER_UNAVAILABLE' });
});

test('Twilio receives the code only for an allowed phone', async () => {
  process.env.NODE_ENV = 'production';
  process.env.OTP_MODE = 'twilio_whatsapp';
  process.env.OTP_TWILIO_ALLOWED_PHONES = '+201000000000';
  process.env.TWILIO_ACCOUNT_SID = `AC${'a'.repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
  process.env.TWILIO_OTP_CONTENT_SID = `HX${'b'.repeat(32)}`;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = options.body;
    assert.equal(body.get('To'), 'whatsapp:+201000000000');
    assert.equal(body.get('From'), 'whatsapp:+14155238886');
    assert.equal(body.get('ContentSid'), process.env.TWILIO_OTP_CONTENT_SID);
    assert.equal(JSON.parse(body.get('ContentVariables'))['2'].length, 6);
    return { ok: true };
  };
  const code = await deliverOtp('+201000000000');
  assert.match(code, /^\d{6}$/);
  assert.equal(calls, 1);
  await assert.rejects(deliverOtp('+201111111111'), { code: 'OTP_TEST_ONLY' });
  assert.equal(calls, 1);
  globalThis.fetch = async () => ({ ok: false, status: 400 });
  await assert.rejects(deliverOtp('+201000000000'), { code: 'OTP_DELIVERY_FAILED' });
});
