export async function get<T>(env: Env, key: string): Promise<T | null> {
  const row = await env.DB.prepare('SELECT value FROM records WHERE key = ? AND (expires IS NULL OR expires > ?)')
    .bind(key, Date.now()).first<{ value: string }>();
  return row ? JSON.parse(row.value) as T : null;
}

export async function put(env: Env, key: string, value: unknown, ttl?: number) {
  await env.DB.prepare('INSERT INTO records(key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires')
    .bind(key, JSON.stringify(value), ttl ? Date.now() + ttl : null).run();
}

export async function remove(env: Env, key: string) {
  await env.DB.prepare('DELETE FROM records WHERE key = ?').bind(key).run();
}

export const DAY = 86_400_000;
