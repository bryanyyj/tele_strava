import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import worker, { route } from '../src/index';
import { activityEvent, gearForActivity, handleUpdate, isOwner } from '../src/bot';
import { ApiError, strava } from '../src/api';
import { DAY, get, put } from '../src/store';

let mf: Miniflare;
let env: Env;
let calls: { url: string; payload: any }[];
const activity = { id: 123, name: 'Morning run', sport_type: 'Run', description: 'Old', athlete: { id: 42 } };
const athlete = { id: 42, shoes: [{ id: 'g1', name: 'Daily shoes' }, { id: 'g2', name: 'Race shoes' }], bikes: [{ id: 'b1', name: 'Road bike' }] };
const tokens = { access_token: 'access', refresh_token: 'refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, athlete: { id: 42 } };
const message = (id: number, text: string) => ({ update_id: id, message: { from: { id: 7 }, chat: { id: 7, type: 'private' }, text } });
const callback = (id: number, data: string) => ({ update_id: id, callback_query: { id: String(id), from: { id: 7 }, message: { chat: { id: 7, type: 'private' } }, data } });
const event = { object_type: 'activity', aspect_type: 'create', object_id: 123, owner_id: 42, event_time: 100 };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch() { return new Response("ok") }}', compatibilityDate: '2026-10-28', d1Databases: ['DB'] }));
  const DB = await mf.getD1Database('DB');
  await DB.exec((await readFile('migrations/0001_initial.sql', 'utf8')).replace(/\r?\n/g, ' '));
  env = { DB, EVENTS: { send: vi.fn() }, TELEGRAM_USER_ID: '7', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 'tg-secret', STRAVA_WEBHOOK_SECRET: 'strava-secret', STRAVA_VERIFY_TOKEN: 'verify', STRAVA_CLIENT_ID: 'client', STRAVA_CLIENT_SECRET: 'secret', PUBLIC_URL: 'https://example.com' } as unknown as Env;
});
afterAll(async () => { vi.unstubAllGlobals(); await mf?.dispose(); });
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM records').run();
  await put(env, 'tokens', tokens);
  calls = [];
  vi.mocked(env.EVENTS.send).mockClear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const payload = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries((init.body as URLSearchParams | undefined) ?? []);
    calls.push({ url, payload });
    if (url.includes('api.telegram.org')) return Response.json({ ok: true, result: { message_id: calls.length } });
    if (url.includes('/oauth/token')) return Response.json({ ...tokens, access_token: 'fresh', refresh_token: 'rotated' });
    if (url.endsWith('/athlete')) return Response.json(athlete);
    return Response.json(activity);
  }));
});

describe('security and webhook admission', () => {
  it('accepts only the configured owner in a private chat', () => {
    expect(isOwner(env, message(1, '/start'))).toBe(true);
    expect(isOwner(env, { ...message(1, 'hello'), message: { from: { id: 8 }, chat: { id: 7, type: 'private' } } })).toBe(false);
    expect(isOwner(env, { ...message(1, 'hello'), message: { from: { id: 7 }, chat: { id: 7, type: 'group' } } })).toBe(false);
  });
  it('rejects unsigned Telegram updates before enqueueing', async () => {
    const response = await route(new Request('https://example.com/webhooks/telegram', { method: 'POST', body: JSON.stringify(message(1, '/start')) }), env);
    expect(response.status).toBe(403);
    expect(env.EVENTS.send).not.toHaveBeenCalled();
  });
  it('durably queues accepted Telegram updates', async () => {
    const response = await route(new Request('https://example.com/webhooks/telegram', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'tg-secret' }, body: JSON.stringify(message(1, '/start')) }), env);
    expect(response.status).toBe(200);
    expect(env.EVENTS.send).toHaveBeenCalledWith({ kind: 'telegram', payload: message(1, '/start') });
    expect(calls).toHaveLength(0);
  });
  it('validates Strava challenge and secret path', async () => {
    expect((await route(new Request('https://example.com/webhooks/strava/wrong'), env)).status).toBe(404);
    expect((await route(new Request('https://example.com/webhooks/strava/strava-secret?hub.mode=subscribe&hub.verify_token=wrong'), env)).status).toBe(403);
    const response = await route(new Request('https://example.com/webhooks/strava/strava-secret?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=abc'), env);
    expect(await response.json()).toEqual({ 'hub.challenge': 'abc' });
  });
  it('requires unexpired, single-use OAuth state and all scopes', async () => {
    await put(env, 'oauth:state', true, DAY);
    const url = 'https://example.com/oauth/callback?state=state&code=code&scope=read,profile:read_all,activity:read_all,activity:write';
    expect((await route(new Request(url.replace(',activity:write', '')), env)).status).toBe(400);
    expect((await route(new Request(url), env)).status).toBe(200);
    expect((await route(new Request(url), env)).status).toBe(400);
    expect((await get<any>(env, 'tokens')).athlete.id).toBe(42);
  });
});

describe('activity editing', () => {
  it('lists the last five activities and opens a historical activity in the full edit flow', async () => {
    const summaries = Array.from({ length: 5 }, (_, index) => ({ ...activity, id: 123 + index, name: `Run ${index + 1}`, start_date_local: '2026-10-28T08:00:00Z' }));
    vi.mocked(fetch).mockImplementationOnce(async (url) => {
      calls.push({ url: String(url), payload: {} });
      return Response.json(summaries);
    });
    await handleUpdate(env, message(1, '/activities'));
    expect(calls[0].url).toBe('https://www.strava.com/api/v3/athlete/activities?page=1&per_page=5');
    const cards = calls.filter(c => c.payload.reply_markup);
    expect(cards).toHaveLength(5);
    expect(cards[0].payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('edit:123');
    expect(cards[4].payload.reply_markup.inline_keyboard[1][0].callback_data).toBe('gear:127');
    expect(await get(env, 'notified:123')).toBeNull();
    await handleUpdate(env, callback(2, 'edit:123'));
    expect((await get<any>(env, 'session')).step).toBe('name');
    await handleUpdate(env, message(3, 'Updated historical run'));
    await handleUpdate(env, message(4, 'Updated description'));
    const session = await get<any>(env, 'session');
    await handleUpdate(env, callback(5, `pick:${session.nonce}:1`));
    expect(calls.find(c => c.payload.gear_id)?.payload).toEqual({ name: 'Updated historical run', description: 'Updated description', gear_id: 'g2' });
  });
  it('handles an empty history and a disconnected account', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([]));
    await handleUpdate(env, message(1, '/activities'));
    expect(calls.at(-1)?.payload.text).toBe('No Strava activities found yet.');
    await env.DB.prepare('DELETE FROM records').run();
    calls = [];
    await handleUpdate(env, message(2, '/activities'));
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.text).toContain('/connect');
  });
  it('preserves a pending edit when listing activities and rejects other users', async () => {
    await activityEvent(env, event);
    await handleUpdate(env, callback(1, 'edit:123'));
    await handleUpdate(env, message(2, 'Pending name'));
    const session = await get(env, 'session');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([activity]));
    await handleUpdate(env, message(3, '/activities'));
    expect(await get(env, 'session')).toEqual(session);
    calls = [];
    await handleUpdate(env, { update_id: 4, message: { from: { id: 8 }, chat: { id: 8, type: 'private' }, text: '/activities' } });
    expect(calls).toHaveLength(0);
  });
  it('notifies once for a linked owner and ignores update loops', async () => {
    await activityEvent(env, { ...event, owner_id: 999 });
    await activityEvent(env, { ...event, aspect_type: 'update' });
    expect(calls).toHaveLength(0);
    await activityEvent(env, event);
    await activityEvent(env, event);
    expect(calls.filter(c => c.url.endsWith('/sendMessage'))).toHaveLength(1);
  });
  it('stages name, then description, then saves only selected compatible gear', async () => {
    await activityEvent(env, event);
    await handleUpdate(env, callback(1, 'edit:123'));
    expect((await get<any>(env, 'session')).step).toBe('name');
    await handleUpdate(env, message(2, 'Race day'));
    expect((await get<any>(env, 'session')).step).toBe('description');
    await handleUpdate(env, message(3, 'A new PB'));
    const session = await get<any>(env, 'session');
    expect(session.step).toBe('gear');
    expect(session.gears).toEqual(athlete.shoes);
    expect(calls.filter(c => c.payload.name)).toHaveLength(0);
    await handleUpdate(env, callback(4, `pick:${session.nonce}:1`));
    expect(calls.find(c => c.payload.gear_id)?.payload).toEqual({ name: 'Race day', description: 'A new PB', gear_id: 'g2' });
    expect(await get(env, 'session')).toBeNull();
  });
  it('does not reinterpret retried name input as a description', async () => {
    await activityEvent(env, event);
    await handleUpdate(env, callback(1, 'edit:123'));
    await handleUpdate(env, message(2, 'New name'));
    await handleUpdate(env, message(2, 'New name'));
    const session = await get<any>(env, 'session');
    expect(session.step).toBe('description');
    expect(session.patch).toEqual({ name: 'New name' });
  });
  it('supports gear-only and refuses stale or forged gear callbacks', async () => {
    await activityEvent(env, event);
    await handleUpdate(env, callback(1, 'gear:123'));
    const session = await get<any>(env, 'session');
    await handleUpdate(env, callback(2, 'pick:wrong:1'));
    await handleUpdate(env, callback(3, `pick:${session.nonce}:999`));
    expect(calls.some(c => c.payload.gear_id)).toBe(false);
    await handleUpdate(env, callback(4, `pick:${session.nonce}:0`));
    expect(calls.find(c => c.payload.gear_id)?.payload).toEqual({ gear_id: 'g1' });
  });
  it('supports skip, clear, and cancellation without writing to Strava', async () => {
    await activityEvent(env, event);
    await handleUpdate(env, callback(1, 'edit:123'));
    await handleUpdate(env, message(2, '/skip'));
    await handleUpdate(env, message(3, '/clear'));
    expect((await get<any>(env, 'session')).patch).toEqual({ description: '' });
    await handleUpdate(env, message(4, '/cancel'));
    expect(await get(env, 'session')).toBeNull();
    expect(calls.some(c => 'gear_id' in c.payload || 'description' in c.payload)).toBe(false);
  });
  it('offers bikes for rides and no unsupported gear for swims', () => {
    expect(gearForActivity(athlete, 'VirtualRide')).toEqual(athlete.bikes);
    expect(gearForActivity(athlete, 'Swim')).toEqual([]);
  });
  it('clears tokens and sessions on deauthorization', async () => {
    await put(env, 'session', { private: 'data' });
    await activityEvent(env, { ...event, object_type: 'athlete', aspect_type: 'update', updates: { authorized: 'false' } });
    expect(await get(env, 'tokens')).toBeNull();
    expect(await get(env, 'session')).toBeNull();
  });
});

describe('API and queue retries', () => {
  it('persists rotated refresh tokens before API access', async () => {
    await put(env, 'tokens', { ...tokens, expires_at: 0 });
    await strava(env, '/athlete');
    expect((await get<any>(env, 'tokens')).refresh_token).toBe('rotated');
    expect(calls[0].payload.grant_type).toBe('refresh_token');
  });
  it('deduplicates successful queue deliveries', async () => {
    const msg = { body: { kind: 'telegram', payload: message(50, '/help') }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue!({ messages: [msg] } as any, env, {} as any);
    await worker.queue!({ messages: [msg] } as any, env, {} as any);
    expect(calls.filter(c => c.url.endsWith('/sendMessage'))).toHaveLength(1);
    expect(msg.ack).toHaveBeenCalledTimes(2);
  });
  it('retries a transient failed delivery without marking it complete', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new ApiError('Telegram', 429, 60));
    const msg = { body: { kind: 'telegram', payload: message(51, '/help') }, ack: vi.fn(), retry: vi.fn() };
    await worker.queue!({ messages: [msg] } as any, env, {} as any);
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(await get(env, 'tg:51')).toBeNull();
    expect(msg.ack).not.toHaveBeenCalled();
  });
});
