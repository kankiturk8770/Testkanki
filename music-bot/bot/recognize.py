"""Song recognition.

Order (stops at the first hit):
  1. Shazam (shazamio, free, no key)       - original recordings, also from videos/reels
  2. AudD (AUDD_API_TOKEN)                  - big catalogue incl. many local/indie songs
  3. ACRCloud music (ACRCLOUD_*)            - fingerprint, remixes/covers in their DB
  4. ACRCloud humming (ACRCLOUD_HUM_*)      - user hums / sings the melody
  5. Speech-to-text of the user's voice (STT_*) -> lyrics search (Genius) -> normal search
"""
import base64
import hashlib
import hmac
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp

from . import audio
from .config import cfg

log = logging.getLogger(__name__)
_timeout = aiohttp.ClientTimeout(total=40)


@dataclass
class Match:
    title: str
    artist: str | None
    engine: str
    album: str | None = None
    youtube_id: str | None = None
    extra: dict = field(default_factory=dict)

    @property
    def query(self) -> str:
        return f"{self.artist or ''} {self.title}".strip()


@dataclass
class Result:
    match: Match | None = None
    transcript: str | None = None        # what the user sang/said, when STT was used
    lyric_hits: list[Match] = field(default_factory=list)


# ---------------- engines ----------------

async def _shazam(clip: Path) -> Match | None:
    try:
        from shazamio import Shazam
    except ImportError:
        return None
    try:
        out = await Shazam().recognize(str(clip))
    except Exception as e:  # network / format errors must not kill the chain
        log.info("shazam failed: %s", e)
        return None
    t = out.get("track")
    if not t:
        return None
    album = None
    for sec in t.get("sections", []):
        for m in sec.get("metadata", []) or []:
            if m.get("title") == "Album":
                album = m.get("text")
    return Match(title=t.get("title", "?"), artist=t.get("subtitle"), album=album, engine="Shazam",
                 extra={"cover": (t.get("images") or {}).get("coverart")})


async def _audd(clip: Path) -> Match | None:
    if not cfg.audd_token:
        return None
    form = aiohttp.FormData()
    form.add_field("api_token", cfg.audd_token)
    form.add_field("return", "spotify")
    form.add_field("file", clip.read_bytes(), filename=clip.name)
    try:
        async with aiohttp.ClientSession(timeout=_timeout) as s:
            async with s.post("https://api.audd.io/", data=form) as r:
                data = await r.json(content_type=None)
    except Exception as e:
        log.info("audd failed: %s", e)
        return None
    res = data.get("result")
    if not res:
        return None
    return Match(title=res.get("title", "?"), artist=res.get("artist"), album=res.get("album"), engine="AudD")


async def _acr(clip: Path, key: str, secret: str, humming: bool) -> Match | None:
    if not (key and secret):
        return None
    ts = str(int(time.time()))
    to_sign = "\n".join(["POST", "/v1/identify", key, "audio", "1", ts])
    sig = base64.b64encode(hmac.new(secret.encode(), to_sign.encode(), hashlib.sha1).digest()).decode()
    sample = clip.read_bytes()
    form = aiohttp.FormData()
    for k, v in (("access_key", key), ("data_type", "audio"), ("signature_version", "1"),
                 ("signature", sig), ("sample_bytes", str(len(sample))), ("timestamp", ts)):
        form.add_field(k, v)
    form.add_field("sample", sample, filename=clip.name)
    try:
        async with aiohttp.ClientSession(timeout=_timeout) as s:
            async with s.post(f"https://{cfg.acr_host}/v1/identify", data=form) as r:
                data = await r.json(content_type=None)
    except Exception as e:
        log.info("acrcloud failed: %s", e)
        return None
    meta = data.get("metadata") or {}
    items = meta.get("humming" if humming else "music") or meta.get("music") or []
    if not items:
        return None
    it = items[0]
    yt = ((it.get("external_metadata") or {}).get("youtube") or {}).get("vid")
    return Match(
        title=it.get("title", "?"),
        artist=", ".join(a["name"] for a in it.get("artists", []) if a.get("name")) or None,
        album=(it.get("album") or {}).get("name"),
        youtube_id=yt,
        engine="ACRCloud (هامینگ)" if humming else "ACRCloud",
    )


async def transcribe(clip: Path) -> str | None:
    """Speech-to-text (OpenAI-compatible /audio/transcriptions, e.g. Groq or OpenAI Whisper)."""
    if not cfg.stt_key:
        return None
    form = aiohttp.FormData()
    form.add_field("model", cfg.stt_model)
    form.add_field("file", clip.read_bytes(), filename=clip.name)
    try:
        async with aiohttp.ClientSession(timeout=_timeout) as s:
            async with s.post(f"{cfg.stt_base}/audio/transcriptions", data=form,
                              headers={"Authorization": f"Bearer {cfg.stt_key}"}) as r:
                data = await r.json(content_type=None)
    except Exception as e:
        log.info("stt failed: %s", e)
        return None
    text = (data.get("text") or "").strip()
    return text if len(text) >= 4 else None


async def lyrics_search(text: str, limit: int = 5) -> list[Match]:
    """Find songs by a line of lyrics (Genius). Without a token returns []."""
    if not cfg.genius_token:
        return []
    try:
        async with aiohttp.ClientSession(timeout=_timeout) as s:
            async with s.get("https://api.genius.com/search", params={"q": text},
                             headers={"Authorization": f"Bearer {cfg.genius_token}"}) as r:
                data = await r.json(content_type=None)
    except Exception as e:
        log.info("genius failed: %s", e)
        return []
    out = []
    for h in (data.get("response") or {}).get("hits", [])[:limit]:
        res = h.get("result") or {}
        out.append(Match(title=res.get("title", "?"), artist=(res.get("primary_artist") or {}).get("name"),
                         engine="Genius"))
    return out


# ---------------- pipeline ----------------

async def recognize(src: Path, hum: bool = False) -> Result:
    """src: any audio/video file (voice note, mp4, video note, mp3, recording from the Mini App)."""
    clips = await audio.clips_for_recognition(src)
    try:
        if not hum:
            for engine in (_shazam, _audd):
                for clip in clips:
                    if m := await engine(clip):
                        return Result(match=m)
            for clip in clips:
                if m := await _acr(clip, cfg.acr_key, cfg.acr_secret, humming=False):
                    return Result(match=m)
        # humming / singing: melody first, then the words
        for clip in clips[:1]:
            if m := await _acr(clip, cfg.acr_hum_key, cfg.acr_hum_secret, humming=True):
                return Result(match=m)
        wav = await audio.to_wav(src, max_sec=30)
        try:
            text = await transcribe(wav)
        finally:
            audio.cleanup(wav)
        if text:
            return Result(transcript=text, lyric_hits=await lyrics_search(text))
        return Result()
    finally:
        audio.cleanup(*clips)
