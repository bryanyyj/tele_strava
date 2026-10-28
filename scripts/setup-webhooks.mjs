// Run only after an approved deployment, with credentials in the ignored .env.
const required = ['PUBLIC_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_VERIFY_TOKEN', 'STRAVA_WEBHOOK_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);
const env = process.env;
const origin = new URL(env.PUBLIC_URL);
if (origin.protocol !== 'https:' || origin.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin');
if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) throw new Error('Use 32–256 URL-safe characters for TELEGRAM_WEBHOOK_SECRET');
if (!/^[A-Za-z0-9_-]{32,128}$/.test(env.STRAVA_WEBHOOK_SECRET)) throw new Error('Use 32–128 URL-safe characters for STRAVA_WEBHOOK_SECRET');
const callback = `${origin.origin}/webhooks/strava/${env.STRAVA_WEBHOOK_SECRET}`;
async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Webhook setup failed (${response.status}); response omitted to protect secrets`);
  return response.json();
}
const credentials = new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET });
const subscriptions = await request(`https://www.strava.com/api/v3/push_subscriptions?${credentials}`);
if (subscriptions.length && !subscriptions.some(subscription => subscription.callback_url === callback)) {
  throw new Error('This Strava app already has a different subscription. Review it manually; no subscription was deleted.');
}
if (!subscriptions.length) {
  await request('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST', body: new URLSearchParams({ ...Object.fromEntries(credentials), callback_url: callback, verify_token: env.STRAVA_VERIFY_TOKEN }),
  });
}
const telegram = await request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: `${origin.origin}/webhooks/telegram`, secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 1 }),
});
if (!telegram.ok) throw new Error('Telegram rejected webhook setup');
console.log('Strava and Telegram webhooks registered. Send /connect to your bot.');
