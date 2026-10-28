# Tele Strava

A private Telegram bot that notifies you about new Strava activities and edits their name, description, and gear on Cloudflare Workers. **Nothing deploys on push. Deployment requires your approval and a manual GitHub Actions run.**

## Conversation

1. Send `/start`, then `/connect`, and authorize Strava.
2. A new Strava activity triggers a message with **Yes**, **No**, **Change gear only**, and **Open in Strava** buttons.
3. Choose Yes: enter a name → enter a description → tap a shoe/bike button. Selecting gear saves the staged changes together through `PUT /activities/{id}`.
4. `/skip` keeps a field, `/clear` clears a description, and `/cancel` discards the current edit. Only one edit is active at a time. `/disconnect` revokes Strava access and removes stored account data.
5. Send `/activities` anytime to fetch your five most recent activities, including activities recorded before connecting the bot. Each has **Edit activity**, **Change gear only**, and **Open in Strava** buttons. Editing follows the same name → description → gear flow. Listing activities preserves any unfinished edit; finish it or use `/cancel` before selecting another.

You can type `/activities` directly without changing webhook configuration. To show it in Telegram's slash-command menu, use **@BotFather → /setcommands** for your bot and include `activities - Show the last 5 Strava activities` with your existing commands.

Shoes are listed for runs/walks/hikes and bikes for cycling activities. Gear comes from your Strava athlete profile. You can keep or remove gear, including when no compatible gear is listed.

**Media limitation:** [Strava's public API](https://developers.strava.com/docs/reference/#api-Activities-updateActivityById) supports name, description and gear changes, but does not document a photo/video attachment endpoint. Media sent to this bot is not downloaded or stored. Use the activity link to attach it in Strava. The [uploads API](https://developers.strava.com/docs/uploads/) creates activities from FIT/TCX/GPX files; it is not a media upload API.

## Local setup

Requires Node.js 24 and npm. Create a bot with Telegram's **@BotFather** using `/newbot`. Register your application at [Strava API settings](https://www.strava.com/settings/api). Keep both credentials private.

```sh
npm ci
# .env already exists in the initial local workspace. For a fresh clone:
cp .env.example .env
npm run db:local
npm run dev
```

Fill `.env` with your BotFather token, numeric Telegram user ID, Strava client ID/secret, and public Worker origin. Generate each webhook/verification secret independently using `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Do not put keys into chat or tracked files. `.env` and `.dev.vars` are gitignored; use `.env` only to avoid Wrangler precedence conflicts. `PUBLIC_URL` is an HTTPS origin without a trailing slash. Telegram accepts only the configured user in a private chat.

Local endpoints: `GET /health`, `POST /webhooks/telegram`, `GET /oauth/callback`, and `GET/POST /webhooks/strava/{secret}`. Local development doesn't register webhooks. Real webhook/OAuth testing requires an explicitly configured public HTTPS endpoint and matching Strava authorization callback domain. A deployed Worker receives events in the background; no PC needs to stay on.

```sh
npm run typecheck
npm test
npm run build
```

## Deploy through GitHub — only after approval

The repository includes CI on pushes/PRs and a separate `workflow_dispatch` deployment. No cloud resources or webhooks have been created by this project setup.

After approving deployment:

1. Create a GitHub environment named `production`. Enable required reviewers if your GitHub plan supports it. Avoid connecting automatic Cloudflare Workers Builds until you explicitly want push-triggered deployments.
2. Create Cloudflare resources once, using the dashboard or authenticated Wrangler:
   ```sh
   npx wrangler d1 create tele-strava
   npx wrangler queues create tele-strava-events
   npx wrangler queues create tele-strava-dead
   ```
   Add the returned database ID as GitHub environment variable `CLOUDFLARE_D1_DATABASE_ID`. Set variable `PUBLIC_URL` to `https://tele-strava.<your-subdomain>.workers.dev` (or your chosen Worker domain). Enable the account's workers.dev subdomain first if needed.
3. Add environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus every credential/ID from `.env.example` other than `PUBLIC_URL`. The Cloudflare token needs access to deploy Workers, manage Worker secrets, apply D1 migrations, and configure Queues in your account. Keep credentials out of repository variables.
4. In GitHub Actions, run **Deploy approved Worker** on `main` with its approval checkbox selected. It checks the code, applies migrations, deploys the Worker, and installs its secrets. Until secret installation completes, webhook requests are rejected. Workflow logs must never print secret files.
5. Set the Strava **Authorization Callback Domain** to the Worker hostname (no scheme/path). Set the same origin in your local `.env`, then run `npm run setup:webhooks`. This registers both providers and refuses to replace an existing different Strava subscription. Strava permits one subscription per application.
6. Open the bot, send `/connect`, approve all requested scopes, and upload a new activity. Existing activities are not imported. Strava's initial application athlete limits apply; this version deliberately supports one Telegram owner and one linked Strava account.

Later deployments also require the manual workflow. D1 migrations must be backward compatible. The database and dead-letter queue persist across code deployments; inspect the dead-letter queue if repeated processing fails. Re-run webhook setup only if endpoints or webhook credentials change.

## Reliability and privacy

Incoming events are placed on Cloudflare Queues before acknowledgement. A single consumer processes them, refreshes Strava tokens, and uses D1 for deduplication and conversation state. Queues may redeliver messages; notifications can repeat if a process stops after Telegram accepts a send but before D1 records it. API edits are idempotent field assignments. Expired OAuth links, edit sessions (24 hours), activity references (7 days), and deduplication records are removed daily. Long-lived tokens remain until disconnect/revocation. Limit access to D1, which contains tokens and activity details; Cloudflare encrypts storage at rest, but this app does not add application-level encryption.

Strava webhooks lack a signed payload: a separate random URL path secret and linked athlete check protect the endpoint. Keep that URL private. For production, avoid logging full request URLs, which can contain OAuth codes or webhook path secrets. API request bodies and tokens are not logged by application code. Review your Cloudflare account's HTTP logging settings as well.

API references: [Strava OAuth](https://developers.strava.com/docs/authentication/), [Strava webhooks](https://developers.strava.com/docs/webhooks/), [Telegram Bot API](https://core.telegram.org/bots/api), [Cloudflare external CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/).
