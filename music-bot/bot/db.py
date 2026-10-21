"""SQLite storage: users, tracks, history, playlists, likes and Telegram file_id cache."""
import time
from typing import Any

import aiosqlite

from .config import cfg

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT, created REAL
);
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,          -- extractor:id, e.g. youtube:dQw4w9WgXcQ
    url TEXT NOT NULL,
    title TEXT, artist TEXT, duration INTEGER, thumb TEXT, source TEXT,
    created REAL
);
CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,                -- search | recognize | open | play | download | edit
    query TEXT, track_id INTEGER, ts REAL
);
CREATE INDEX IF NOT EXISTS history_user ON history(user_id, ts);
CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, created REAL
);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL, added REAL,
    PRIMARY KEY (playlist_id, track_id)
);
CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL, track_id INTEGER NOT NULL, added REAL,
    PRIMARY KEY (user_id, track_id)
);
CREATE TABLE IF NOT EXISTS file_cache (
    track_id INTEGER NOT NULL, variant TEXT NOT NULL, file_id TEXT NOT NULL,
    PRIMARY KEY (track_id, variant)
);
CREATE TABLE IF NOT EXISTS state (
    user_id INTEGER NOT NULL, k TEXT NOT NULL, v TEXT,
    PRIMARY KEY (user_id, k)
);
"""

_db: aiosqlite.Connection | None = None


async def init() -> None:
    global _db
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    _db = await aiosqlite.connect(cfg.db_path)
    _db.row_factory = aiosqlite.Row
    await _db.executescript(SCHEMA)
    await _db.commit()


async def close() -> None:
    if _db:
        await _db.close()


async def _exec(sql: str, args: tuple = ()) -> aiosqlite.Cursor:
    cur = await _db.execute(sql, args)
    await _db.commit()
    return cur


async def _all(sql: str, args: tuple = ()) -> list[dict]:
    async with _db.execute(sql, args) as cur:
        return [dict(r) for r in await cur.fetchall()]


async def _one(sql: str, args: tuple = ()) -> dict | None:
    rows = await _all(sql, args)
    return rows[0] if rows else None


# ---------- users / state ----------

async def touch_user(user_id: int, name: str) -> None:
    await _exec(
        "INSERT INTO users(id, name, created) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
        (user_id, name, time.time()),
    )


async def set_state(user_id: int, k: str, v: str | None) -> None:
    if v is None:
        await _exec("DELETE FROM state WHERE user_id=? AND k=?", (user_id, k))
    else:
        await _exec("INSERT OR REPLACE INTO state(user_id,k,v) VALUES(?,?,?)", (user_id, k, v))


async def get_state(user_id: int, k: str) -> str | None:
    row = await _one("SELECT v FROM state WHERE user_id=? AND k=?", (user_id, k))
    return row["v"] if row else None


# ---------- tracks ----------

async def upsert_track(t: dict[str, Any]) -> dict:
    await _exec(
        """INSERT INTO tracks(key,url,title,artist,duration,thumb,source,created) VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             title=COALESCE(excluded.title,title), artist=COALESCE(excluded.artist,artist),
             duration=COALESCE(excluded.duration,duration), thumb=COALESCE(excluded.thumb,thumb)""",
        (t["key"], t["url"], t.get("title"), t.get("artist"), t.get("duration"),
         t.get("thumb"), t.get("source"), time.time()),
    )
    return await _one("SELECT * FROM tracks WHERE key=?", (t["key"],))


async def get_track(track_id: int) -> dict | None:
    return await _one("SELECT * FROM tracks WHERE id=?", (track_id,))


async def cached_file(track_id: int, variant: str) -> str | None:
    row = await _one("SELECT file_id FROM file_cache WHERE track_id=? AND variant=?", (track_id, variant))
    return row["file_id"] if row else None


async def cache_file(track_id: int, variant: str, file_id: str) -> None:
    await _exec("INSERT OR REPLACE INTO file_cache VALUES(?,?,?)", (track_id, variant, file_id))


# ---------- history ----------

async def log(user_id: int, kind: str, query: str | None = None, track_id: int | None = None) -> None:
    await _exec("INSERT INTO history(user_id,kind,query,track_id,ts) VALUES(?,?,?,?,?)",
                (user_id, kind, query, track_id, time.time()))


async def history(user_id: int, kind: str | None = None, limit: int = 200) -> list[dict]:
    sql = """SELECT h.id, h.kind, h.query, h.ts, t.id AS track_id, t.title, t.artist, t.duration, t.thumb, t.source
             FROM history h LEFT JOIN tracks t ON t.id = h.track_id WHERE h.user_id=?"""
    args: tuple = (user_id,)
    if kind:
        sql += " AND h.kind=?"
        args += (kind,)
    sql += " ORDER BY h.ts DESC LIMIT ?"
    return await _all(sql, args + (limit,))


async def clear_history(user_id: int) -> None:
    await _exec("DELETE FROM history WHERE user_id=?", (user_id,))


# ---------- smart playlist ----------

# How much each action says "the user really likes this track".
_WEIGHTS = {"download": 4.0, "play": 2.0, "edit": 3.0, "open": 1.0, "recognize": 2.0}
_HALF_LIFE_DAYS = 21.0


async def smart_picks(user_id: int, limit: int = 30) -> list[dict]:
    """Best tracks of a user: weighted actions with time decay, likes count extra."""
    rows = await _all(
        "SELECT track_id, kind, ts FROM history WHERE user_id=? AND track_id IS NOT NULL", (user_id,)
    )
    now = time.time()
    score: dict[int, float] = {}
    for r in rows:
        age_days = (now - r["ts"]) / 86400
        decay = 0.5 ** (age_days / _HALF_LIFE_DAYS)
        score[r["track_id"]] = score.get(r["track_id"], 0.0) + _WEIGHTS.get(r["kind"], 0.5) * decay
    for r in await _all("SELECT track_id FROM likes WHERE user_id=?", (user_id,)):
        score[r["track_id"]] = score.get(r["track_id"], 0.0) + 6.0
    best = sorted(score, key=score.get, reverse=True)[:limit]
    if not best:
        return []
    marks = ",".join("?" * len(best))
    tracks = {t["id"]: t for t in await _all(f"SELECT * FROM tracks WHERE id IN ({marks})", tuple(best))}
    return [tracks[i] for i in best if i in tracks]


# ---------- likes ----------

async def toggle_like(user_id: int, track_id: int) -> bool:
    if await _one("SELECT 1 FROM likes WHERE user_id=? AND track_id=?", (user_id, track_id)):
        await _exec("DELETE FROM likes WHERE user_id=? AND track_id=?", (user_id, track_id))
        return False
    await _exec("INSERT INTO likes VALUES(?,?,?)", (user_id, track_id, time.time()))
    return True


async def liked(user_id: int) -> list[dict]:
    return await _all(
        "SELECT t.* FROM likes l JOIN tracks t ON t.id=l.track_id WHERE l.user_id=? ORDER BY l.added DESC",
        (user_id,),
    )


async def liked_ids(user_id: int) -> set[int]:
    return {r["track_id"] for r in await _all("SELECT track_id FROM likes WHERE user_id=?", (user_id,))}


# ---------- playlists ----------

async def playlists(user_id: int) -> list[dict]:
    return await _all(
        """SELECT p.id, p.name, COUNT(i.track_id) AS count FROM playlists p
           LEFT JOIN playlist_items i ON i.playlist_id=p.id
           WHERE p.user_id=? GROUP BY p.id ORDER BY p.created DESC""",
        (user_id,),
    )


async def create_playlist(user_id: int, name: str) -> int:
    cur = await _exec("INSERT INTO playlists(user_id,name,created) VALUES(?,?,?)", (user_id, name[:64], time.time()))
    return cur.lastrowid


async def owns_playlist(user_id: int, pid: int) -> bool:
    return bool(await _one("SELECT 1 FROM playlists WHERE id=? AND user_id=?", (pid, user_id)))


async def rename_playlist(pid: int, name: str) -> None:
    await _exec("UPDATE playlists SET name=? WHERE id=?", (name[:64], pid))


async def delete_playlist(pid: int) -> None:
    await _exec("DELETE FROM playlist_items WHERE playlist_id=?", (pid,))
    await _exec("DELETE FROM playlists WHERE id=?", (pid,))


async def playlist_tracks(pid: int) -> list[dict]:
    return await _all(
        """SELECT t.* FROM playlist_items i JOIN tracks t ON t.id=i.track_id
           WHERE i.playlist_id=? ORDER BY i.added""",
        (pid,),
    )


async def add_to_playlist(pid: int, track_id: int) -> None:
    await _exec("INSERT OR IGNORE INTO playlist_items VALUES(?,?,?)", (pid, track_id, time.time()))


async def remove_from_playlist(pid: int, track_id: int) -> None:
    await _exec("DELETE FROM playlist_items WHERE playlist_id=? AND track_id=?", (pid, track_id))
