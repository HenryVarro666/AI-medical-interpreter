import { config } from './config.js';
import { logAudit } from './audit-logger.js';

export async function syncTwilioWebhook(webhookUrl) {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioPhoneNumber) {
    return { ok: false, error: 'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER in .env' };
  }

  const phoneNumber = config.twilioPhoneNumber.replace(/\s/g, '');
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');

  try {
    const listRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phoneNumber)}`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );
    if (!listRes.ok) {
      const body = await listRes.text();
      return { ok: false, error: `Twilio API error: ${listRes.status} ${body}` };
    }

    const listData = await listRes.json();
    const numbers = listData.incoming_phone_numbers || [];
    if (numbers.length === 0) {
      return { ok: false, error: `Phone number ${phoneNumber} not found in your Twilio account` };
    }

    const numberSid = numbers[0].sid;

    const updateRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/IncomingPhoneNumbers/${numberSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          VoiceUrl: webhookUrl,
          VoiceMethod: 'POST',
        }),
      }
    );

    if (!updateRes.ok) {
      const body = await updateRes.text();
      return { ok: false, error: `Failed to update: ${updateRes.status} ${body}` };
    }

    const updated = await updateRes.json();
    logAudit('twilio_webhook_synced', null, 'system', { webhookUrl, numberSid });
    console.log(`[twilio-sync] Webhook updated: ${webhookUrl}`);

    return {
      ok: true,
      phoneNumber: updated.phone_number,
      friendlyName: updated.friendly_name,
      voiceUrl: updated.voice_url,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
