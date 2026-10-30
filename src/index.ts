import { ApiError, Tokens, send, tokenExchange } from './api';
import { Event, Update, activityEvent, handleUpdate, isOwner } from './bot';
import { DAY, get, put } from './store';

export type Job = { kind: 'telegram'; payload: Update } | { kind: 'strava'; payload: Event };

async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 64_000) throw new Error('Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 64_000) { await reader.cancel(); throw new Error('Body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function processTelegramUpdate(env: Env, update: Update, ctx?: ExecutionContext) {
  const id = `tg:${update.update_id}`;
  if (await get(env, id)) return;
  try {
    await handleUpdate(env, update, ctx);
  } catch (error) {
    if (!(error instanceof ApiError) || !error.service.startsWith('Strava') || ![400, 401, 403, 404].includes(error.status)) throw error;
    await send(env, error.status === 401 || error.status === 403
      ? 'Strava authorization failed. Use /connect to authorize again with all requested permissions.'
      : 'Strava could not apply this edit. The activity may be unavailable or the gear invalid. Use /cancel and try again.');
  }
  await put(env, id, true, DAY * 7);
}

export async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true });
  if (url.pathname === '/webhooks/telegram' && request.method === 'POST') {
    if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Forbidden', { status: 403 });
    const update = await body(request) as Update;
    if (!Number.isSafeInteger(update?.update_id)) return new Response('Invalid update', { status: 400 });
    // Telegram is configured with max_connections=1, serializing conversation turns.
    // Complete before acknowledging so failed requests are retried by Telegram.
    if (isOwner(env, update)) await processTelegramUpdate(env, update, ctx);
    return new Response('OK');
  }
  if (env.STRAVA_WEBHOOK_SECRET && url.pathname === `/webhooks/strava/${env.STRAVA_WEBHOOK_SECRET}`) {
    if (request.method === 'GET') {
      if (url.searchParams.get('hub.mode') !== 'subscribe' || url.searchParams.get('hub.verify_token') !== env.STRAVA_VERIFY_TOKEN) return new Response('Forbidden', { status: 403 });
      return Response.json({ 'hub.challenge': url.searchParams.get('hub.challenge') });
    }
    if (request.method === 'POST') {
      const event = await body(request) as Event;
      if (!event || !['activity', 'athlete'].includes(event.object_type) || !['create', 'update', 'delete'].includes(event.aspect_type) || !Number.isSafeInteger(event.object_id) || !Number.isSafeInteger(event.owner_id) || !Number.isSafeInteger(event.event_time)) return new Response('Invalid event', { status: 400 });
      await env.EVENTS.send({ kind: 'strava', payload: event });
      return new Response('OK');
    }
  }
  if (url.pathname === '/oauth/callback' && request.method === 'GET') {
    const state = url.searchParams.get('state');
    const scopes = new Set((url.searchParams.get('scope') ?? '').split(','));
    if (!state || !await get(env, `oauth:${state}`)) return new Response('Invalid or expired authorization. Use /connect again.', { status: 400 });
    if (url.searchParams.has('error') || !url.searchParams.get('code') || !['read', 'profile:read_all', 'activity:read_all', 'activity:write'].every(s => scopes.has(s))) return new Response('Please use /connect and approve all requested permissions.', { status: 400 });
    const consumed = await env.DB.prepare('DELETE FROM records WHERE key = ? AND expires > ? RETURNING key').bind(`oauth:${state}`, Date.now()).first();
    if (!consumed) return new Response('Authorization already used.', { status: 400 });
    const tokens: Tokens = await tokenExchange(env, { grant_type: 'authorization_code', code: url.searchParams.get('code')! });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM records'),
      env.DB.prepare('INSERT INTO records(key, value) VALUES (?, ?)').bind('tokens', JSON.stringify(tokens)),
    ]);
    return new Response('Strava connected. Return to Telegram. New activities will now trigger notifications.', { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    try { return await route(request, env, ctx); }
    catch { return new Response('Request failed. Please retry.', { status: 500 }); }
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const job = message.body as Job;
      const id = job.kind === 'telegram' ? `tg:${job.payload.update_id}` : `sv:${job.payload.object_type}:${job.payload.object_id}:${job.payload.aspect_type}:${job.payload.event_time}`;
      try {
        if (!await get(env, id)) {
          // Support Telegram jobs already queued before the direct-handler update.
          if (job.kind === 'telegram') await processTelegramUpdate(env, job.payload, ctx);
          else await activityEvent(env, job.payload);
          await put(env, id, true, DAY * 7);
        }
        message.ack();
      } catch (error) {
        // Do not log webhook bodies, OAuth codes, tokens or Telegram API URLs.
        console.error(JSON.stringify({ event: 'job_failed', kind: job.kind, status: error instanceof ApiError ? error.status : 500 }));
        message.retry({ delaySeconds: error instanceof ApiError ? error.retryAfter : 30 });
      }
    }
  },
  async scheduled(_controller, env) {
    await env.DB.prepare('DELETE FROM records WHERE expires IS NOT NULL AND expires <= ?').bind(Date.now()).run();
  },
} satisfies ExportedHandler<Env, Job>;
