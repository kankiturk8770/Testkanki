// Database access (raw SQL with bound values).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { now } from './util.js';

const one = async (q) => (await db.get(q)) || null;

export async function getSetting(k) {
  return (await one(sql`SELECT v FROM settings WHERE k = ${k}`))?.v ?? null;
}
export async function setSetting(k, v) {
  if (v === null || v === undefined || v === '') await db.run(sql`DELETE FROM settings WHERE k = ${k}`);
  else await db.run(sql`INSERT INTO settings (k, v) VALUES (${k}, ${String(v)}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
}

/** The user's row (created on first contact; the first user becomes the bot's owner). */
export async function user(from) {
  const id = from.id ?? from;
  let u = await one(sql`SELECT * FROM users WHERE id = ${id}`);
  if (!u) {
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
    await db.run(sql`INSERT INTO users (id, name, pin, count, created) VALUES (${id}, ${name}, 1, 0, ${now()}) ON CONFLICT(id) DO NOTHING`);
    if (!(await getSetting('owner'))) await setSetting('owner', id);
    u = await one(sql`SELECT * FROM users WHERE id = ${id}`);
  }
  u.spons = u.spons ? JSON.parse(u.spons) : [];
  u.channels = await db.all(sql`SELECT chat_id AS id, title FROM channels WHERE user_id = ${id} ORDER BY id`);
  return u;
}
export const isOwner = async (id) => String(await getSetting('owner')) === String(id);

export const setUserPin = (id, pin) => db.run(sql`UPDATE users SET pin = ${pin ? 1 : 0} WHERE id = ${id}`);
export const setUserSpons = (id, list) => db.run(sql`UPDATE users SET spons = ${JSON.stringify(list)} WHERE id = ${id}`);
export const bumpCount = (id) => db.run(sql`UPDATE users SET count = count + 1 WHERE id = ${id}`);

export async function addChannel(userId, chatId, title) {
  const r = await one(sql`SELECT id FROM channels WHERE user_id = ${userId} AND chat_id = ${chatId}`);
  if (r) return false;
  await db.run(sql`INSERT INTO channels (user_id, chat_id, title) VALUES (${userId}, ${chatId}, ${title})`);
  return true;
}
export const removeChannel = (userId, chatId) => db.run(sql`DELETE FROM channels WHERE user_id = ${userId} AND chat_id = ${chatId}`);

// ---------- session: { s: post being built | null, w: what we wait for | null } ----------
export async function getSession(userId) {
  const r = await one(sql`SELECT v FROM sessions WHERE user_id = ${userId}`);
  return r?.v ? JSON.parse(r.v) : { s: null, w: null };
}
export async function saveSession(userId, st) {
  if (!st.s && !st.w) await db.run(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
  else await db.run(sql`INSERT INTO sessions (user_id, v) VALUES (${userId}, ${JSON.stringify(st)}) ON CONFLICT(user_id) DO UPDATE SET v = excluded.v`);
}

// ---------- time (the bot's clock is set with /tz; Iran = +3:30) ----------
export async function tz() {
  return Number(await getSetting('tz') ?? 210);
}

export async function localStr(ts) {
  const off = (await tz()) * 60;
  const t = new Date((ts + off) * 1000);
  const dd = Math.floor((ts + off) / 86400) - Math.floor((now() + off) / 86400);
  const p = (n) => String(n).padStart(2, '0');
  const lab = { 0: 'امروز', 1: 'فردا' }[dd] || `${t.getUTCMonth() + 1}/${p(t.getUTCDate())}`;
  return `${lab} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}
