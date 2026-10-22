# Temporary WhatsApp OTP with Twilio

> **Egypt account limitation:** Twilio currently shows "Trials are unavailable in Egypt" for this project account. The steps below cannot be completed on that account without upgrading to Full access. Do not set `OTP_MODE=twilio_whatsapp` or deploy this option until an eligible Twilio account and its approved verification template are available. Twilio's [trial policy](https://www.twilio.com/docs/usage/trials) also states that trials are available only in selected countries. Meta's [developer test numbers](https://whatsappbusiness.com/developers/developer-hub/) are the next no-cost option to evaluate.

The backend generates a fresh six-digit code, stores only its hash in `otp_challenges`, and asks Twilio to deliver it. Existing registration and phone-login screens continue to use `/v1/auth/otp/request` and `/v1/auth/otp/verify`. No Twilio credentials go to either portal. The fixed code remains available only when `OTP_MODE=fixed` in local development or tests.

## Set up the test sender

1. Create a Twilio trial account. In the Console, open **Messaging → Try out WhatsApp**. Activate the testing environment. The legacy Console calls this the **WhatsApp Sandbox**.
2. Add and verify each tester's phone number in Twilio. Each tester must also scan the Sandbox QR code or send its `join <sandbox code>` message from the same WhatsApp number. Sandbox membership expires after three days; testers must then join again.
3. Send Twilio's sample WhatsApp message from the Console first. Find the preapproved **Verification Codes** template and copy its `HX...` Content SID. It has two variables: `{{1}}` for the service name and `{{2}}` for the code. If your Console's trial flow does not offer that template or an `HX...` SID, stop here; the backend cannot send arbitrary business-initiated OTP text through the trial.
4. Set these **backend-only** environment variables locally or in your test deployment:

   ```dotenv
   OTP_MODE=twilio_whatsapp
   OTP_TWILIO_ALLOWED_PHONES=+201XXXXXXXXX,+201YYYYYYYYY
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=your-private-auth-token
   TWILIO_WHATSAPP_FROM=+14155238886
   TWILIO_OTP_CONTENT_SID=HX...
   ```

   Use the sender shown in **your** Twilio Console if it differs from the example. Keep the phone allowlist to joined, verified testers. Never copy the token into a portal, a committed file, or a screenshot.

5. Restart or redeploy the backend. Request a code from the existing signup screen using an allowed, unregistered Egyptian mobile number. Check that the WhatsApp message arrives, then enter the code. To test phone login, register that number first. The API returns an error if Twilio rejects the send; it does not return a usable request ID on delivery failure.

## Limits and later migration

Twilio's [Sandbox documentation](https://www.twilio.com/docs/whatsapp/sandbox) limits recipients to members of the Sandbox and provides the preapproved verification template. Twilio's [trial documentation](https://www.twilio.com/docs/usage/trials) currently describes a 30-day trial, up to five verified recipients, and predefined message content. Check the Console's remaining trial units before testing. The Sandbox is for testing, not public customer registration. For public launch, register a WhatsApp sender and review its approved authentication template and messaging charges. The backend OTP endpoints can remain the same while the delivery provider changes.
