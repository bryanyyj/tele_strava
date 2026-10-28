import { get, put } from './store';

export interface Tokens { access_token: string; refresh_token: string; expires_at: number; athlete: { id: number } }
export interface Activity { id: number; name: string; description: string | null; sport_type: string; athlete: { id: number } }
export interface Gear { id: string; name: string }
export interface Athlete { id: number; shoes: Gear[]; bikes: Gear[] }
export type Button = { text: string; callback_data?: string; url?: string };

export class ApiError extends Error {
  constructor(public service: string, public status: number, public retryAfter = 30) {
    super(`${service} request failed (${status})`);
  }
}

export async function tokenExchange(env: Env, fields: Record<string, string>): Promise<Tokens> {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...fields }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ApiError('Strava OAuth', response.status);
  return response.json();
}

export async function strava<T>(env: Env, path: string, patch?: Record<string, string>): Promise<T> {
  let tokens = await get<Tokens>(env, 'tokens');
  if (!tokens) throw new ApiError('Strava disconnected; use /connect', 401);
  if (tokens.expires_at * 1000 < Date.now() + 60_000) {
    const fresh = await tokenExchange(env, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    tokens = { ...fresh, athlete: tokens.athlete };
    await put(env, 'tokens', tokens);
  }
  const response = await fetch(`https://www.strava.com/api/v3${path}`, {
    method: patch ? 'PUT' : 'GET',
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    body: patch ? new URLSearchParams(patch) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new ApiError('Strava', response.status, response.status === 429 ? 900 : 30);
  return response.json();
}

export async function telegram<T = unknown>(env: Env, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as { ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number } };
  if (!response.ok || !data.ok) throw new ApiError('Telegram', data.error_code ?? response.status, data.parameters?.retry_after);
  return data.result;
}

export function send(env: Env, text: string, buttons?: Button[][]) {
  return telegram<{ message_id: number }>(env, 'sendMessage', {
    chat_id: env.TELEGRAM_USER_ID, text,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}
