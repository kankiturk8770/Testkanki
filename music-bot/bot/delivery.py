"""Sending tracks/edits to a chat. Used by both chat handlers and the Mini App API."""
import logging
from pathlib import Path

from aiogram import Bot
from aiogram.types import FSInputFile

from . import audio, db, keyboards, sources
from .config import cfg

log = logging.getLogger(__name__)


class TooBig(Exception):
    pass


def _too_big(p: Path) -> bool:
    return p.stat().st_size > cfg.max_upload_mb * 1024 * 1024


def _name(track: dict, suffix: str = "") -> str:
    base = f"{track.get('artist') or ''} - {track['title']}".strip(" -")
    return "".join(c for c in base if c not in '\\/:*?"<>|')[:80] + suffix


async def send_audio(bot: Bot, chat_id: int, track: dict, kbps: str = "192") -> None:
    variant = f"a{kbps}"
    file_id = await db.cached_file(track["id"], variant)
    if file_id:
        await bot.send_audio(chat_id, file_id, reply_markup=keyboards.edit_menu(track["id"]))
        return
    path = await sources.audio_file(track, kbps)
    # long mixes at 320k can exceed the upload limit -> step down automatically
    for lower in [q for q in sources.AUDIO_QUALITIES if int(q) < int(kbps)][::-1]:
        if not _too_big(path):
            break
        path = await sources.audio_file(track, lower)
    if _too_big(path):
        raise TooBig
    msg = await bot.send_audio(
        chat_id, FSInputFile(path, filename=_name(track, ".mp3")),
        title=track["title"], performer=track.get("artist"), duration=track.get("duration"),
        reply_markup=keyboards.edit_menu(track["id"]),
    )
    await db.cache_file(track["id"], variant, msg.audio.file_id)


async def send_video(bot: Bot, chat_id: int, track: dict, height: str = "720") -> None:
    variant = f"v{height}"
    file_id = await db.cached_file(track["id"], variant)
    if file_id:
        await bot.send_video(chat_id, file_id, supports_streaming=True)
        return
    path = await sources.video_file(track, height)
    if _too_big(path):
        raise TooBig
    msg = await bot.send_video(
        chat_id, FSInputFile(path, filename=_name(track, ".mp4")),
        caption=f"🎬 {_name(track)} · {height}p", supports_streaming=True,
    )
    await db.cache_file(track["id"], variant, msg.video.file_id)


async def send_voice(bot: Bot, chat_id: int, track: dict) -> None:
    src = await sources.best_cached_audio(track)
    out = await audio.to_voice(src)
    try:
        await bot.send_voice(chat_id, FSInputFile(out), caption=f"🎙 {_name(track)}")
    finally:
        audio.cleanup(out)


async def send_effect(bot: Bot, chat_id: int, track: dict, name: str) -> None:
    variant = f"fx_{name}"
    file_id = await db.cached_file(track["id"], variant)
    if file_id:
        await bot.send_audio(chat_id, file_id)
        return
    src = await sources.best_cached_audio(track)
    out = await audio.effect(src, name)
    label = audio.EFFECTS[name][0].split(" ", 1)[1]
    try:
        msg = await bot.send_audio(
            chat_id, FSInputFile(out, filename=_name(track, f" ({label}).mp3")),
            title=f"{track['title']} ({label})", performer=track.get("artist"),
        )
        await db.cache_file(track["id"], variant, msg.audio.file_id)
    finally:
        audio.cleanup(out)


async def make_cut(track: dict, start: float, end: float, fmt: str = "mp3", fade: bool = True) -> Path:
    src = await sources.best_cached_audio(track)
    dur = track.get("duration") or await audio.probe_duration(src)
    if dur:
        end = min(end, dur)
    return await audio.cut(src, max(0.0, start), end, fmt=fmt, fade=fade)


async def send_cut(bot: Bot, chat_id: int, track: dict, start: float, end: float,
                   fmt: str = "mp3", fade: bool = True) -> None:
    out = await make_cut(track, start, end, fmt, fade)
    span = f"{audio.fmt_time(start)}-{audio.fmt_time(end)}"
    try:
        if fmt == "m4r":
            await bot.send_document(chat_id, FSInputFile(out, filename=_name(track, " (ringtone).m4r")),
                                    caption=f"🔔 رینگتون آیفون · {span}")
        elif fmt == "ogg":
            await bot.send_voice(chat_id, FSInputFile(out), caption=f"✂️ {span}")
        else:
            await bot.send_audio(chat_id, FSInputFile(out, filename=_name(track, f" ({span}).mp3")),
                                 title=f"{track['title']} ✂️ {span}", performer=track.get("artist"))
    finally:
        audio.cleanup(out)
