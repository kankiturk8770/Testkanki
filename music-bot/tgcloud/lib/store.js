// Database access. Raw SQL with the `sql` tag keeps the queries readable; values are bound parameters.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { now } from './util.js';

const one = async (q) => (await db.get(q)) || null;

// ---------- users / settings / state ----------

export async function touchUser(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  await db.run(sql`INSERT INTO users (id, name, created) VALUES (${user.id}, ${name}, ${now()})
                   ON CONFLICT(id) DO UPDATE SET name = excluded.name`);
}

export async function getSetting(k) {
  return (await one(sql`SELECT v FROM settings WHERE k = ${k}`))?.v || null;
}

export async function setSetting(k, v) {
  if (v === null || v === '') await db.run(sql`DELETE FROM settings WHERE k = ${k}`);
  else await db.run(sql`INSERT INTO settings (k, v) VALUES (${k}, ${v}) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
}

export async function allSettings() {
  return db.all(sql`SELECT k, v FROM settings ORDER BY k`);
}

export async function getState(userId, k) {
  return (await one(sql`SELECT v FROM state WHERE user_id = ${userId} AND k = ${k}`))?.v || null;
}

export async function setState(userId, k, v) {
  if (v === null) await db.run(sql`DELETE FROM state WHERE user_id = ${userId} AND k = ${k}`);
  else await db.run(sql`INSERT INTO state (user_id, k, v) VALUES (${userId}, ${k}, ${String(v)})
                        ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v`);
}

// ---------- tracks ----------

export async function upsertTrack(t) {
  await db.run(sql`
    INSERT INTO tracks (key, url, title, artist, duration, thumb, source, created)
    VALUES (${t.key}, ${t.url}, ${t.title}, ${t.artist || null}, ${t.duration || null}, ${t.thumb || null}, ${t.source}, ${now()})
    ON CONFLICT(key) DO UPDATE SET
      title = COALESCE(excluded.title, title), artist = COALESCE(excluded.artist, artist),
      duration = COALESCE(excluded.duration, duration), thumb = COALESCE(excluded.thumb, thumb)`);
  return one(sql`SELECT * FROM tracks WHERE key = ${t.key}`);
}

export async function upsertTracks(list) {
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const row = await upsertTrack(t);
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

export async function getTrack(id) {
  return one(sql`SELECT * FROM tracks WHERE id = ${Number(id)}`);
}

export async function cachedFile(trackId, variant) {
  return one(sql`SELECT file_id AS fileId, size FROM file_cache WHERE track_id = ${trackId} AND variant = ${variant}`);
}

export async function anyCachedAudio(trackId) {
  return one(sql`SELECT file_id AS fileId, variant, size FROM file_cache
                 WHERE track_id = ${trackId} AND variant LIKE 'a%' ORDER BY size ASC LIMIT 1`);
}

export async function cacheFile(trackId, variant, fileId, size) {
  await db.run(sql`INSERT INTO file_cache (track_id, variant, file_id, size) VALUES (${trackId}, ${variant}, ${fileId}, ${size || null})
                   ON CONFLICT(track_id, variant) DO UPDATE SET file_id = excluded.file_id, size = excluded.size`);
}

// ---------- history ----------

export async function log(userId, kind, query = null, trackId = null) {
  await db.run(sql`INSERT INTO history (user_id, kind, query, track_id, ts) VALUES (${userId}, ${kind}, ${query}, ${trackId}, ${now()})`);
}

export async function history(userId, kind = null, limit = 300) {
  const filter = kind ? sql`AND h.kind = ${kind}` : sql``;
  return db.all(sql`
    SELECT h.id, h.kind, h.query, h.ts, t.id AS track_id, t.title, t.artist, t.duration, t.thumb, t.source, t.url
    FROM history h LEFT JOIN tracks t ON t.id = h.track_id
    WHERE h.user_id = ${userId} ${filter}
    ORDER BY h.ts DESC, h.id DESC LIMIT ${limit}`);
}

export async function clearHistory(userId) {
  await db.run(sql`DELETE FROM history WHERE user_id = ${userId}`);
}

// ---------- "best picks": an automatic playlist ----------

// How strongly each action says "the user likes this track". Old actions fade out.
const WEIGHTS = { download: 4, edit: 3, play: 2, recognize: 2, open: 1 };
const HALF_LIFE_DAYS = 21;

export async function smartPicks(userId, limit = 30) {
  const rows = await db.all(sql`SELECT track_id, kind, ts FROM history WHERE user_id = ${userId} AND track_id IS NOT NULL`);
  const t = now();
  const score = new Map();
  for (const r of rows) {
    const decay = 0.5 ** ((t - r.ts) / 86400 / HALF_LIFE_DAYS);
    score.set(r.track_id, (score.get(r.track_id) || 0) + (WEIGHTS[r.kind] ?? 0.5) * decay);
  }
  for (const r of await db.all(sql`SELECT track_id FROM likes WHERE user_id = ${userId}`)) {
    score.set(r.track_id, (score.get(r.track_id) || 0) + 6);
  }
  const best = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  const out = [];
  for (const id of best) {
    const tr = await getTrack(id);
    if (tr) out.push(tr);
  }
  return out;
}

// ---------- likes ----------

export async function toggleLike(userId, trackId) {
  const r = await db.run(sql`DELETE FROM likes WHERE user_id = ${userId} AND track_id = ${trackId}`);
  if (r.rowsAffected) return false;
  await db.run(sql`INSERT INTO likes (user_id, track_id, added) VALUES (${userId}, ${trackId}, ${now()})`);
  return true;
}

export async function likedIds(userId) {
  return new Set((await db.all(sql`SELECT track_id FROM likes WHERE user_id = ${userId}`)).map((r) => r.track_id));
}

export async function liked(userId) {
  return db.all(sql`SELECT t.* FROM likes l JOIN tracks t ON t.id = l.track_id
                    WHERE l.user_id = ${userId} ORDER BY l.added DESC, l.id DESC`);
}

// ---------- playlists ----------

export async function playlists(userId) {
  return db.all(sql`
    SELECT p.id, p.name, COUNT(i.track_id) AS count FROM playlists p
    LEFT JOIN playlist_items i ON i.playlist_id = p.id
    WHERE p.user_id = ${userId} GROUP BY p.id ORDER BY p.created DESC, p.id DESC`);
}

export async function createPlaylist(userId, name) {
  const r = await db.run(sql`INSERT INTO playlists (user_id, name, created) VALUES (${userId}, ${name.slice(0, 64)}, ${now()})`);
  return Number(r.lastInsertRowid);
}

export async function ownsPlaylist(userId, pid) {
  return !!(await one(sql`SELECT 1 AS ok FROM playlists WHERE id = ${Number(pid)} AND user_id = ${userId}`));
}

export async function renamePlaylist(pid, name) {
  await db.run(sql`UPDATE playlists SET name = ${name.slice(0, 64)} WHERE id = ${pid}`);
}

export async function deletePlaylist(pid) {
  // no foreign keys: children first
  await db.run(sql`DELETE FROM playlist_items WHERE playlist_id = ${pid}`);
  await db.run(sql`DELETE FROM playlists WHERE id = ${pid}`);
}

export async function playlistTracks(pid) {
  return db.all(sql`SELECT t.* FROM playlist_items i JOIN tracks t ON t.id = i.track_id
                    WHERE i.playlist_id = ${pid} ORDER BY i.added, i.id`);
}

export async function addToPlaylist(pid, trackId) {
  await db.run(sql`INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, added) VALUES (${pid}, ${trackId}, ${now()})`);
}

export async function removeFromPlaylist(pid, trackId) {
  await db.run(sql`DELETE FROM playlist_items WHERE playlist_id = ${pid} AND track_id = ${trackId}`);
}

// ---------- uploads from the Mini App editor ----------

export async function savePart(userId, token, idx, bytes) {
  await db.run(sql`DELETE FROM uploads WHERE created < ${now() - 3600}`);
  await db.run(sql`INSERT INTO uploads (user_id, token, idx, data, created) VALUES (${userId}, ${token}, ${idx}, ${bytes}, ${now()})`);
}

export async function takeParts(userId, token) {
  const rows = await db.all(sql`SELECT idx, data FROM uploads WHERE user_id = ${userId} AND token = ${token} ORDER BY idx`);
  await db.run(sql`DELETE FROM uploads WHERE user_id = ${userId} AND token = ${token}`);
  return rows;
}
