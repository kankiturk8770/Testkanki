"""HTTP API for the Mini App (served by the same aiohttp app as the webhook)."""
import hashlib
import hmac
import logging
import time
import uuid
from pathlib import Path

from aiogram import Bot
from aiogram.utils.web_app import safe_parse_webapp_init_data
from aiohttp import web

from . import audio, db, delivery, recognize, sources
from .config import cfg

log = logging.getLogger(__name__)
routes = web.RouteTableDef()
WEBAPP_DIR = Path(__file__).resolve().parent.parent / "webapp"
LINK_TTL = 6 * 3600


# ---------------- auth ----------------

def _sign(path: str, uid: int, exp: int) -> str:
    return hmac.new(cfg.bot_token.encode(), f"{path}:{uid}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def signed(path: str, uid: int) -> str:
    exp = int(time.time()) + LINK_TTL
    return f"{path}?u={uid}&e={exp}&s={_sign(path, uid, exp)}"


def _check_signed(req: web.Request) -> int:
    try:
        uid, exp, sig = int(req.query["u"]), int(req.query["e"]), req.query["s"]
    except (KeyError, ValueError):
        raise web.HTTPForbidden()
    if exp < time.time() or not hmac.compare_digest(sig, _sign(req.path, uid, exp)):
        raise web.HTTPForbidden()
    return uid


async def _uid(req: web.Request) -> int:
    """Validate Telegram WebApp initData (HMAC with the bot token) -> user id."""
    raw = req.headers.get("X-Init-Data", "")
    try:
        data = safe_parse_webapp_init_data(cfg.bot_token, raw)
    except ValueError:
        raise web.HTTPUnauthorized(text="bad initData")
    if time.time() - data.auth_date.timestamp() > 7 * 86400:
        raise web.HTTPUnauthorized(text="initData expired")
    u = data.user
    await db.touch_user(u.id, f"{u.first_name} {u.last_name or ''}".strip())
    return u.id


def _bot(req: web.Request) -> Bot:
    return req.app["bot"]


async def _track_json(t: dict, uid: int, liked: set[int] | None = None) -> dict:
    liked = liked if liked is not None else await db.liked_ids(uid)
    return {
        "id": t["id"], "title": t["title"], "artist": t.get("artist"), "duration": t.get("duration"),
        "thumb": t.get("thumb"), "source": t.get("source"), "url": t["url"],
        "liked": t["id"] in liked, "stream": signed(f"/api/stream/{t['id']}", uid),
    }


async def _tracks_json(tracks: list[dict], uid: int) -> list[dict]:
    liked = await db.liked_ids(uid)
    return [await _track_json(t, uid, liked) for t in tracks]


async def _track(req: web.Request, tid) -> dict:
    t = await db.get_track(int(tid))
    if not t:
        raise web.HTTPNotFound(text="track not found")
    return t


# ---------------- static ----------------

@routes.get("/app")
async def app_redirect(req: web.Request):
    raise web.HTTPFound("/app/")


@routes.get("/app/")
async def app_index(req: web.Request):
    return web.FileResponse(WEBAPP_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@routes.get("/health")
async def health(req: web.Request):
    return web.json_response({"ok": True})


# ---------------- data ----------------

@routes.get("/api/search")
async def api_search(req: web.Request):
    uid = await _uid(req)
    q = req.query.get("q", "").strip()
    if not q:
        return web.json_response([])
    tracks = [await db.upsert_track(t) for t in await sources.search(q, 20)]
    await db.log(uid, "search", q)
    return web.json_response(await _tracks_json(tracks, uid))


@routes.get("/api/track/{tid}")
async def api_track(req: web.Request):
    uid = await _uid(req)
    return web.json_response(await _track_json(await _track(req, req.match_info["tid"]), uid))


@routes.get("/api/remixes/{tid}")
async def api_remixes(req: web.Request):
    uid = await _uid(req)
    t = await _track(req, req.match_info["tid"])
    found = [await db.upsert_track(r) for r in await sources.remixes(t["title"], t.get("artist"), 15)]
    return web.json_response(await _tracks_json([r for r in found if r["id"] != t["id"]], uid))


@routes.get("/api/history")
async def api_history(req: web.Request):
    uid = await _uid(req)
    rows = await db.history(uid, req.query.get("kind") or None, 300)
    for r in rows:
        if r.get("track_id"):
            r["stream"] = signed(f"/api/stream/{r['track_id']}", uid)
    return web.json_response(rows)


@routes.delete("/api/history")
async def api_history_clear(req: web.Request):
    await db.clear_history(await _uid(req))
    return web.json_response({"ok": True})


@routes.get("/api/library")
async def api_library(req: web.Request):
    """Everything the library tab needs in one call."""
    uid = await _uid(req)
    return web.json_response({
        "smart": await _tracks_json(await db.smart_picks(uid), uid),
        "liked": await _tracks_json(await db.liked(uid), uid),
        "playlists": await db.playlists(uid),
    })


@routes.post("/api/like/{tid}")
async def api_like(req: web.Request):
    uid = await _uid(req)
    return web.json_response({"liked": await db.toggle_like(uid, int(req.match_info["tid"]))})


@routes.post("/api/play/{tid}")
async def api_play(req: web.Request):
    uid = await _uid(req)
    await db.log(uid, "play", None, int(req.match_info["tid"]))
    return web.json_response({"ok": True})


# ---------------- playlists ----------------

async def _own(req: web.Request, uid: int) -> int:
    pid = int(req.match_info["pid"])
    if not await db.owns_playlist(uid, pid):
        raise web.HTTPNotFound()
    return pid


@routes.post("/api/playlists")
async def api_pl_create(req: web.Request):
    uid = await _uid(req)
    body = await req.json()
    name = (body.get("name") or "").strip() or "پلی‌لیست من"
    pid = await db.create_playlist(uid, name)
    if body.get("track_id"):
        await db.add_to_playlist(pid, int(body["track_id"]))
    return web.json_response({"id": pid})


@routes.get("/api/playlists/{pid}")
async def api_pl_get(req: web.Request):
    uid = await _uid(req)
    pid = await _own(req, uid)
    return web.json_response(await _tracks_json(await db.playlist_tracks(pid), uid))


@routes.patch("/api/playlists/{pid}")
async def api_pl_rename(req: web.Request):
    uid = await _uid(req)
    pid = await _own(req, uid)
    await db.rename_playlist(pid, ((await req.json()).get("name") or "").strip() or "پلی‌لیست")
    return web.json_response({"ok": True})


@routes.delete("/api/playlists/{pid}")
async def api_pl_delete(req: web.Request):
    uid = await _uid(req)
    await db.delete_playlist(await _own(req, uid))
    return web.json_response({"ok": True})


@routes.post("/api/playlists/{pid}/tracks/{tid}")
async def api_pl_add(req: web.Request):
    uid = await _uid(req)
    await db.add_to_playlist(await _own(req, uid), int(req.match_info["tid"]))
    return web.json_response({"ok": True})


@routes.delete("/api/playlists/{pid}/tracks/{tid}")
async def api_pl_remove(req: web.Request):
    uid = await _uid(req)
    await db.remove_from_playlist(await _own(req, uid), int(req.match_info["tid"]))
    return web.json_response({"ok": True})


# ---------------- media ----------------

@routes.get("/api/stream/{tid}")
async def api_stream(req: web.Request):
    """mp3 with HTTP Range support, so the player can seek. Signed URL (an <audio> tag cannot send headers)."""
    _check_signed(req)
    t = await _track(req, req.match_info["tid"])
    try:
        path = await sources.best_cached_audio(t)
    except Exception as e:
        log.warning("stream download failed: %s", e)
        raise web.HTTPBadGateway(text="download failed")
    return web.FileResponse(path, headers={"Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400"})


@routes.get("/api/file/{name}")
async def api_file(req: web.Request):
    _check_signed(req)
    name = req.match_info["name"]
    path = cfg.cache_dir / name
    if not name.startswith("dl_") or "/" in name or not path.exists():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="{name[16:]}"'})


@routes.post("/api/send")
async def api_send(req: web.Request):
    """Send audio/video/voice of a track to the user's private chat with the bot."""
    uid = await _uid(req)
    body = await req.json()
    t = await _track(req, body.get("track_id"))
    kind, q = body.get("kind", "audio"), str(body.get("quality", ""))
    if kind == "video":
        await delivery.send_video(_bot(req), uid, t, q if q in sources.VIDEO_QUALITIES else "720")
    elif kind == "voice":
        await delivery.send_voice(_bot(req), uid, t)
    elif kind in audio.EFFECTS:
        await delivery.send_effect(_bot(req), uid, t, kind)
    else:
        await delivery.send_audio(_bot(req), uid, t, q if q in sources.AUDIO_QUALITIES else "192")
    await db.log(uid, "edit" if kind in audio.EFFECTS else "download", kind, t["id"])
    return web.json_response({"ok": True})


@routes.post("/api/cut")
async def api_cut(req: web.Request):
    uid = await _uid(req)
    body = await req.json()
    t = await _track(req, body.get("track_id"))
    start, end = float(body.get("start", 0)), float(body.get("end", 30))
    fmt = body.get("fmt") if body.get("fmt") in ("mp3", "m4r", "ogg") else "mp3"
    fade = bool(body.get("fade", True))
    if end - start < 1 or end - start > 15 * 60:
        return web.json_response({"error": "بازه نامعتبر"}, status=400)
    await db.log(uid, "edit", "cut", t["id"])
    if body.get("deliver") == "chat":
        await delivery.send_cut(_bot(req), uid, t, start, end, fmt, fade)
        return web.json_response({"ok": True})
    out = await delivery.make_cut(t, start, end, fmt, fade)
    safe = "".join(c for c in t["title"] if c.isalnum() or c in " -_")[:40].strip() or "cut"
    final = cfg.cache_dir / f"dl_{uuid.uuid4().hex[:12]}_{safe}.{fmt}"
    out.rename(final)
    return web.json_response({"url": signed(f"/api/file/{final.name}", uid), "name": f"{safe}.{fmt}"})


@routes.post("/api/recognize")
async def api_recognize(req: web.Request):
    uid = await _uid(req)
    reader = await req.multipart()
    src, hum = None, False
    while part := await reader.next():
        if part.name == "hum":
            hum = (await part.text()) == "1"
        elif part.name == "audio":
            src = cfg.cache_dir / f"in_{uuid.uuid4().hex}.bin"
            size = 0
            with src.open("wb") as f:
                while chunk := await part.read_chunk():
                    size += len(chunk)
                    if size > 25 * 1024 * 1024:
                        raise web.HTTPRequestEntityTooLarge(max_size=25 * 1024 * 1024, actual_size=size)
                    f.write(chunk)
    if not src:
        raise web.HTTPBadRequest(text="no audio")
    try:
        res = await recognize.recognize(src, hum=hum)
    finally:
        audio.cleanup(src)
    out: dict = {"match": None, "transcript": res.transcript, "lyric_hits": [h.query for h in res.lyric_hits]}
    query = None
    if res.match:
        m = res.match
        out["match"] = {"title": m.title, "artist": m.artist, "album": m.album, "engine": m.engine,
                        "cover": m.extra.get("cover")}
        query = m.query
    elif res.transcript:
        query = (res.lyric_hits[0].query if res.lyric_hits else res.transcript)
    tracks = [await db.upsert_track(t) for t in await sources.search(query, 10)] if query else []
    await db.log(uid, "recognize", query or "-", tracks[0]["id"] if tracks else None)
    out["tracks"] = await _tracks_json(tracks, uid)
    return web.json_response(out)


# ---------------- housekeeping ----------------

def janitor(max_cache_hours: float = 48) -> None:
    """Delete temp files after 1h and cached downloads after `max_cache_hours` (serverless disks are small)."""
    now = time.time()
    for p in cfg.cache_dir.iterdir():
        age = now - p.stat().st_mtime
        temp = p.name.startswith(("edit_", "dl_", "in_"))
        if (temp and age > 3600) or age > max_cache_hours * 3600:
            p.unlink(missing_ok=True)


@web.middleware
async def json_errors(req: web.Request, handler):
    """API errors as {"error": ...} so the Mini App can show them."""
    try:
        return await handler(req)
    except web.HTTPException:
        raise
    except delivery.TooBig:
        return web.json_response({"error": f"حجم فایل بیشتر از {cfg.max_upload_mb}MB است"}, status=413)
    except Exception as e:
        if not req.path.startswith("/api/"):
            raise
        log.exception("api error on %s", req.path)
        return web.json_response({"error": "دانلود یا پردازش ناموفق بود"} if "ERROR:" in str(e) else {"error": "خطای سرور"},
                                 status=502)


def setup(app: web.Application) -> None:
    app.middlewares.append(json_errors)
    app.add_routes(routes)
    app.router.add_static("/app/", WEBAPP_DIR)
