import { readFileSync, writeFileSync } from 'node:fs';

const names = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_USER_ID', 'TELEGRAM_WEBHOOK_SECRET', 'STRAVA_WEBHOOK_SECRET', 'STRAVA_VERIFY_TOKEN', 'STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'PUBLIC_URL'];
for (const name of [...names, 'CLOUDFLARE_D1_DATABASE_ID']) {
  if (!process.env[name]) throw new Error(`Missing deployment setting: ${name}`);
}
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
config.d1_databases[0].database_id = process.env.CLOUDFLARE_D1_DATABASE_ID;
writeFileSync('.deploy-config.json', JSON.stringify(config, null, 2));
writeFileSync('.deploy-secrets.json', JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))), { mode: 0o600 });
