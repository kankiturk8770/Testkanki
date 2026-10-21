"""Finding and downloading tracks with yt-dlp (YouTube, YouTube Music, SoundCloud and ~1800 other sites)."""
import asyncio
import re
from pathlib import Path
from typing import Any

import yt_dlp

from .config import cfg

# Parallel heavy downloads per instance; serverless containers are small.
_dl_lock = asyncio.Semaphore(2)

AUDIO_QUALITIES = ("128", "192", "320")
VIDEO_QUALITIES = ("360", "480", "720", "1080")

_JUNK = re.compile(
    r"\s*[\(\[](official|music|lyric|lyrics|audio|video|hd|4k|visualizer|موزیک ویدیو|ویدیو|متن)[^\)\]]*[\)\]]",
    re.I,
)


def _base_opts() -> dict[str, Any]:
    opts: dict[str, Any] = {"quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "socket_timeout": 20}
    if cfg.ytdlp_cookies:
        opts["cookiefile"] = cfg.ytdlp_cookies
    return opts


def split_title(title: str, uploader: str | None) -> tuple[str, str | None]:
    """'Artist - Song (Official Video)' -> ('Song', 'Artist')."""
    clean = _JUNK.sub("", title or "").strip()
    for sep in (" - ", " – ", " | ", " — "):
        if sep in clean:
            a, t = clean.split(sep, 1)
            return t.strip(), a.strip()
    if uploader:
        uploader = re.sub(r"\s*-\s*Topic$|VEVO$", "", uploader).strip()
    return clean, uploader


def _to_track(e: dict[str, Any]) -> dict[str, Any] | None:
    source = (e.get("ie_key") or e.get("extractor_key") or e.get("extractor") or "web").lower()
    url = e.get("webpage_url") or e.get("url")
    if not url:
        return None
    if source == "youtube" and e.get("id") and not url.startswith("http"):
        url = f"https://www.youtube.com/watch?v={e['id']}"
    title, artist = split_title(e.get("track") or e.get("title") or "", e.get("artist") or e.get("uploader") or e.get("channel"))
    if e.get("track") and e.get("artist"):
        title, artist = e["track"], e["artist"]
    thumb = e.get("thumbnail")
    if not thumb and e.get("thumbnails"):
        thumb = e["thumbnails"][-1].get("url")
    if source == "youtube" and e.get("id"):
        thumb = f"https://i.ytimg.com/vi/{e['id']}/hqdefault.jpg"
    return {
        "key": f"{source}:{e.get('id') or url}",
        "url": url,
        "title": title or e.get("title") or "?",
        "artist": artist,
        "duration": int(e["duration"]) if e.get("duration") else None,
        "thumb": thumb,
        "source": source,
    }


def _search_sync(prefix: str, query: str, n: int) -> list[dict[str, Any]]:
    opts = _base_opts() | {"extract_flat": "in_playlist", "skip_download": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"{prefix}{n}:{query}", download=False)
    except Exception:
        return []
    out = []
    for e in (info or {}).get("entries") or []:
        t = _to_track(e)
        # skip hour-long mixes/streams in normal search
        if t and (t["duration"] is None or t["duration"] <= 20 * 60):
            out.append(t)
    return out


async def search(query: str, limit: int = 12, sources: tuple[str, ...] = ("ytsearch", "scsearch")) -> list[dict]:
    """Search all sources in parallel and interleave the results (YT, SC, YT, SC, ...)."""
    per = max(4, limit // len(sources) + 2)
    lists = await asyncio.gather(*(asyncio.to_thread(_search_sync, s, query, per) for s in sources))
    seen, merged = set(), []
    for i in range(max((len(l) for l in lists), default=0)):
        for lst in lists:
            if i < len(lst) and lst[i]["key"] not in seen:
                seen.add(lst[i]["key"])
                merged.append(lst[i])
    return merged[:limit]


async def remixes(title: str, artist: str | None, limit: int = 12) -> list[dict]:
    base = f"{artist or ''} {title}".strip()
    results = await search(f"{base} remix", limit + 4)
    words = ("remix", "ریمیکس", "mix", "edit", "bootleg", "cover", "slowed", "sped", "lofi", "live")
    good = [r for r in results if any(w in (r["title"] + " " + (r["artist"] or "")).lower() for w in words)]
    return (good or results)[:limit]


def _info_sync(url: str) -> dict[str, Any] | None:
    try:
        with yt_dlp.YoutubeDL(_base_opts() | {"skip_download": True}) as ydl:
            return ydl.extract_info(url, download=False)
    except Exception:
        return None


async def from_url(url: str) -> dict | None:
    info = await asyncio.to_thread(_info_sync, url)
    if not info:
        return None
    if info.get("entries"):
        info = next(iter(info["entries"]), None) or info
    return _to_track(info)


def _safe(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", key)[-80:]


def _download_audio_sync(url: str, out: Path, kbps: str) -> Path:
    opts = _base_opts() | {
        "format": "bestaudio/best",
        "outtmpl": str(out.with_suffix(".%(ext)s")),
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": kbps},
            {"key": "FFmpegMetadata"},
        ],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    return out


def _download_video_sync(url: str, out: Path, height: str) -> Path:
    opts = _base_opts() | {
        "format": f"bv*[height<={height}][ext=mp4]+ba[ext=m4a]/bv*[height<={height}]+ba/b[height<={height}]/b",
        "merge_output_format": "mp4",
        "outtmpl": str(out.with_suffix(".%(ext)s")),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    return out


async def _alternatives(track: dict, prefixes: tuple[str, ...]) -> list[str]:
    """Same song on another source, closest duration first (for DRM / region-blocked / deleted uploads)."""
    found = await search(f"{track.get('artist') or ''} {track['title']}".strip(), 8, prefixes)
    found = [f for f in found if f["key"] != track["key"]]
    if track.get("duration"):
        found = [f for f in found if not f["duration"] or abs(f["duration"] - track["duration"]) <= 15] or found
    return [f["url"] for f in found[:3]]


async def _fetch(track: dict, out: Path, fn, arg: str, alt_prefixes: tuple[str, ...]) -> Path:
    if out.exists():
        return out
    async with _dl_lock:
        if out.exists():
            return out
        try:
            await asyncio.to_thread(fn, track["url"], out, arg)
            return out
        except Exception as first:
            for url in await _alternatives(track, alt_prefixes):
                try:
                    await asyncio.to_thread(fn, url, out, arg)
                    return out
                except Exception:
                    continue
            raise first


async def audio_file(track: dict, kbps: str = "192") -> Path:
    """mp3 of the track in the local cache (downloaded once, reused for streaming/editing)."""
    out = cfg.cache_dir / f"{_safe(track['key'])}_{kbps}.mp3"
    return await _fetch(track, out, _download_audio_sync, kbps, ("ytsearch", "scsearch"))


async def video_file(track: dict, height: str = "720") -> Path:
    out = cfg.cache_dir / f"{_safe(track['key'])}_{height}p.mp4"
    return await _fetch(track, out, _download_video_sync, height, ("ytsearch",))


async def best_cached_audio(track: dict) -> Path:
    """Any already-downloaded mp3 of this track, else download 192k."""
    for q in ("320", "192", "128"):
        p = cfg.cache_dir / f"{_safe(track['key'])}_{q}.mp3"
        if p.exists():
            return p
    return await audio_file(track, "192")
