import { Activity, Athlete, Button, Gear, SummaryActivity, Tokens, send, strava, telegram } from './api';
import { DAY, get, put, remove } from './store';

export interface Update {
  update_id: number;
  message?: { from?: { id: number }; chat: { id: number; type: string }; text?: string; photo?: unknown; video?: unknown; document?: unknown };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number; type: string } } };
}
export interface Event { object_type: string; aspect_type: string; object_id: number; owner_id: number; event_time: number; updates?: { authorized?: string } }
interface Session { activity: Activity; step: 'name' | 'description' | 'gear'; mode: 'edit' | 'gear'; nonce: string; patch: Record<string, string>; gears?: Gear[]; lastUpdate?: number }

export function isOwner(env: Env, update: Update) {
  const source = update.callback_query ?? update.message;
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  return String(source?.from?.id) === env.TELEGRAM_USER_ID && String(chat?.id) === env.TELEGRAM_USER_ID && chat?.type === 'private';
}

export function gearForActivity(athlete: Athlete, sport: string): Gear[] {
  if (/ride|cycl|velomobile/i.test(sport)) return athlete.bikes ?? [];
  if (/run|walk|hik|snowshoe/i.test(sport)) return athlete.shoes ?? [];
  return [];
}

function activityButtons(id: number): Button[][] {
  return [[{ text: 'Yes, edit activity', callback_data: `edit:${id}` }, { text: 'No', callback_data: `no:${id}` }],
    [{ text: 'Change gear only', callback_data: `gear:${id}` }],
    [{ text: 'Open in Strava / add media', url: `https://www.strava.com/activities/${id}` }]];
}

export async function activityEvent(env: Env, event: Event) {
  const tokens = await get<Tokens>(env, 'tokens');
  if (!tokens || tokens.athlete.id !== event.owner_id) return;
  if (event.object_type === 'athlete' && event.updates?.authorized === 'false') {
    await env.DB.prepare('DELETE FROM records').run();
    await send(env, 'Strava access was revoked. Stored account data has been removed. Use /connect to reconnect.');
    return;
  }
  if (event.object_type !== 'activity') return;
  if (event.aspect_type === 'delete') {
    await remove(env, `activity:${event.object_id}`);
    const session = await get<Session>(env, 'session');
    if (session?.activity.id === event.object_id) await remove(env, 'session');
    return;
  }
  if (event.aspect_type !== 'create' || await get(env, `notified:${event.object_id}`)) return;
  const activity = await strava<Activity>(env, `/activities/${event.object_id}`);
  if (activity.athlete.id !== tokens.athlete.id) return;
  await put(env, `activity:${activity.id}`, activity, DAY * 7);
  await send(env, `New activity: ${activity.name}\nWould you like to edit its name, description and gear?`, activityButtons(activity.id));
  await put(env, `notified:${activity.id}`, true, DAY * 30);
}

async function chooseGear(env: Env, session: Session) {
  const athlete = await strava<Athlete>(env, '/athlete');
  session.gears = gearForActivity(athlete, session.activity.sport_type);
  session.step = 'gear';
  await put(env, 'session', session, DAY);
  await promptSession(env, session);
}

async function promptSession(env: Env, session: Session) {
  if (session.step === 'name') {
    await send(env, `Editing: ${session.activity.name}\n1/3: Send the new activity name, or /skip to keep it. /cancel discards this edit.`); return;
  }
  if (session.step === 'description') {
    await send(env, '2/3: Send the description, /skip to keep it, or /clear to remove it.'); return;
  }
  // Index callbacks keep Telegram callback_data under its 64-byte limit.
  const buttons: Button[][] = (session.gears ?? []).map((gear, index) => [{ text: gear.name.slice(0, 60), callback_data: `pick:${session.nonce}:${index}` }]);
  buttons.push([{ text: 'Keep current gear', callback_data: `pick:${session.nonce}:keep` }]);
  buttons.push([{ text: 'Remove gear', callback_data: `pick:${session.nonce}:none` }]);
  await send(env, session.gears?.length ? 'Choose your gear. This saves your changes.' : 'No compatible gear found. Keep or remove the current gear to save.', buttons);
}

export async function handleUpdate(env: Env, update: Update) {
  if (!isOwner(env, update)) return;
  const pending = await get<Session>(env, 'session');
  if (pending?.lastUpdate === update.update_id) { await promptSession(env, pending); return; }
  const query = update.callback_query;
  if (query) {
    // Old callbacks may exceed Telegram's response window; editing can still proceed.
    await telegram(env, 'answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined);
    const data = query.data ?? '';
    if (data.startsWith('pick:')) {
      const [, nonce, choice] = data.split(':');
      const session = await get<Session>(env, 'session');
      if (!session || session.nonce !== nonce || session.step !== 'gear') {
        await send(env, 'That gear menu has expired. Start again from the activity notification.'); return;
      }
      const patch = { ...session.patch };
      if (choice === 'none') patch.gear_id = 'none';
      else if (choice !== 'keep') {
        const gear = /^\d+$/.test(choice) ? session.gears?.[Number(choice)] : undefined;
        if (!gear) { await send(env, 'Invalid gear selection. Please use the current buttons.'); return; }
        patch.gear_id = gear.id;
      }
      if (Object.keys(patch).length) await strava(env, `/activities/${session.activity.id}`, patch);
      await send(env, 'Activity saved. Add photos or videos directly in Strava.', [[{ text: 'Open activity', url: `https://www.strava.com/activities/${session.activity.id}` }]]);
      await remove(env, 'session');
      return;
    }
    const match = /^(edit|gear|no):(\d+)$/.exec(data);
    if (!match) return;
    const [, action, id] = match;
    const known = await get<Activity>(env, `activity:${id}`);
    if (!known) { await send(env, 'This activity notification has expired or the activity was deleted.'); return; }
    if (action === 'no') { await send(env, 'Okay. You can use the notification buttons later.'); return; }
    const activity = await strava<Activity>(env, `/activities/${id}`);
    const tokens = await get<Tokens>(env, 'tokens');
    if (activity.athlete.id !== tokens?.athlete.id) return;
    const existing = await get<Session>(env, 'session');
    if (existing) { await send(env, 'Finish your current edit or use /cancel before starting another.'); return; }
    const session: Session = { activity, step: 'name', mode: action === 'gear' ? 'gear' : 'edit', nonce: crypto.randomUUID().slice(0, 8), patch: {}, lastUpdate: update.update_id };
    if (action === 'gear') await chooseGear(env, session);
    else {
      await put(env, 'session', session, DAY);
      await promptSession(env, session);
    }
    return;
  }
  const message = update.message;
  if (!message) return;
  if (message.photo || message.video || message.document) {
    await send(env, 'Strava’s public API does not support attaching photos or videos. Open the activity in Strava to add media. No files have been downloaded or stored.'); return;
  }
  const text = message.text?.trim();
  if (!text) return;
  if (text === '/start' || text === '/help') {
    await send(env, 'Use /connect to authorize Strava. New activities will appear here automatically. /activities shows your last 5 activities with edit buttons. Choose Yes to edit name → description → gear, or change gear only. /skip keeps a field; /clear clears the description; /cancel discards an edit. /disconnect revokes access.'); return;
  }
  if (text === '/activities') {
    if (!await get<Tokens>(env, 'tokens')) {
      await send(env, 'Use /connect to link your Strava account before listing activities.'); return;
    }
    const activities = await strava<SummaryActivity[]>(env, '/athlete/activities?page=1&per_page=5');
    const tokens = await get<Tokens>(env, 'tokens');
    const recent = activities.slice(0, 5).filter(activity => activity.athlete.id === tokens?.athlete.id);
    if (!recent.length) { await send(env, 'No Strava activities found yet.'); return; }
    await send(env, `Your ${recent.length} most recent Strava ${recent.length === 1 ? 'activity' : 'activities'}. Choose Edit activity to change name, description and gear, or change gear only.`);
    for (const activity of recent) {
      // The list returns summaries; the edit callback fetches fresh activity details.
      await put(env, `activity:${activity.id}`, activity, DAY * 7);
      const date = activity.start_date_local?.slice(0, 10);
      await send(env, `${activity.name}\n${activity.sport_type}${date ? ` · ${date}` : ''}`, [
        [{ text: 'Edit activity', callback_data: `edit:${activity.id}` }],
        [{ text: 'Change gear only', callback_data: `gear:${activity.id}` }],
        [{ text: 'Open in Strava / add media', url: `https://www.strava.com/activities/${activity.id}` }],
      ]);
    }
    return;
  }
  if (text === '/connect') {
    const state = crypto.randomUUID();
    await put(env, `oauth:${state}`, true, 10 * 60_000);
    const url = new URL('https://www.strava.com/oauth/authorize');
    url.search = new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, redirect_uri: `${env.PUBLIC_URL}/oauth/callback`, response_type: 'code', approval_prompt: 'force', scope: 'read,profile:read_all,activity:read_all,activity:write', state }).toString();
    await send(env, 'Connect your Strava account. Approve all requested permissions. This link expires in 10 minutes.', [[{ text: 'Connect with Strava', url: url.toString() }]]); return;
  }
  if (text === '/cancel') { await remove(env, 'session'); await send(env, 'Edit cancelled.'); return; }
  if (text === '/disconnect') {
    const tokens = await get<Tokens>(env, 'tokens');
    if (tokens) {
      const response = await fetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', body: new URLSearchParams({ access_token: tokens.access_token }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok && response.status !== 401) throw new Error('Deauthorization failed');
    }
    await env.DB.prepare('DELETE FROM records').run();
    await send(env, 'Disconnected. Stored account data and pending edits were removed.'); return;
  }
  const session = await get<Session>(env, 'session');
  if (!session) { await send(env, 'Use /connect to get started, or choose an activity notification to edit.'); return; }
  if (session.step === 'gear') { await send(env, 'Choose a gear button above, or /cancel.'); return; }
  if (text.startsWith('/') && text !== '/skip' && !(text === '/clear' && session.step === 'description')) {
    await send(env, 'Use /skip to keep this field, /clear to clear a description, or /cancel.'); return;
  }
  if (session.step === 'name') {
    if (text.length > 200) { await send(env, 'Please use a name of 200 characters or fewer.'); return; }
    if (text !== '/skip') session.patch.name = text;
    session.step = 'description';
    session.lastUpdate = update.update_id;
    await put(env, 'session', session, DAY);
    await send(env, '2/3: Send the description, /skip to keep it, or /clear to remove it.');
  } else {
    if (text.length > 4000) { await send(env, 'Please keep the description within 4,000 characters.'); return; }
    if (text !== '/skip') session.patch.description = text === '/clear' ? '' : text;
    session.lastUpdate = update.update_id;
    await chooseGear(env, session);
  }
}
