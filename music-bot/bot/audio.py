"""ffmpeg helpers: cutting, effects, format conversion, clips for recognition."""
import asyncio
import re
import uuid
from pathlib import Path

from .config import cfg

# name -> (Persian label, ffmpeg audio filter)
EFFECTS: dict[str, tuple[str, str]] = {
    "slow": ("🐢 اسلو + ریورب", "asetrate=44100*0.85,aresample=44100,aecho=0.8:0.85:60:0.3"),
    "fast": ("⚡ تند (Sped up)", "asetrate=44100*1.2,aresample=44100"),
    "bass": ("🔊 باس بوست", "bass=g=12:f=110:w=0.6,alimiter=limit=0.95"),
    "8d": ("🎧 هشت‌بعدی 8D", "apulsator=hz=0.09:amount=0.85"),
    "karaoke": ("🎤 حذف صدای خواننده", "pan=stereo|c0=c0-c1|c1=c1-c0"),
    "loud": ("📢 بلندتر", "loudnorm=I=-10:TP=-1.0"),
}


class FFmpegError(RuntimeError):
    pass


async def _ffmpeg(*args: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise FFmpegError(err.decode(errors="ignore")[-400:])


def _out(ext: str) -> Path:
    return cfg.cache_dir / f"edit_{uuid.uuid4().hex[:12]}.{ext}"


def parse_time(s: str) -> float:
    """'1:23' / '01:02:03' / '83' / '83.5' -> seconds."""
    s = s.strip().replace("٫", ".")
    s = s.translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789"))
    parts = [float(p) for p in s.split(":")]
    sec = 0.0
    for p in parts:
        sec = sec * 60 + p
    return sec


_RANGE = re.compile(r"([\d۰-۹:.٫]+)\s*(?:-|تا|to|–|_)\s*([\d۰-۹:.٫]+)")


def parse_range(text: str) -> tuple[float, float] | None:
    m = _RANGE.search(text)
    if not m:
        return None
    try:
        a, b = parse_time(m.group(1)), parse_time(m.group(2))
    except ValueError:
        return None
    return (a, b) if b > a else None


def fmt_time(sec: float | int | None) -> str:
    if not sec:
        return "--:--"
    sec = int(sec)
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60}:{sec % 60:02d}"


async def cut(src: Path, start: float, end: float, fmt: str = "mp3", fade: bool = True) -> Path:
    """Cut [start, end]; fmt mp3 | m4r (iPhone ringtone) | ogg (Telegram voice)."""
    dur = max(0.5, end - start)
    filters = []
    if fade:
        f = min(2.0, dur / 4)
        filters += [f"afade=t=in:st=0:d={f:.2f}", f"afade=t=out:st={dur - f:.2f}:d={f:.2f}"]
    args = ["-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", str(src), "-vn"]
    if filters:
        args += ["-af", ",".join(filters)]
    if fmt == "m4r":
        out = _out("m4r")
        args += ["-c:a", "aac", "-b:a", "192k", "-f", "ipod"]
    elif fmt == "ogg":
        out = _out("ogg")
        args += ["-c:a", "libopus", "-b:a", "64k"]
    else:
        out = _out("mp3")
        args += ["-c:a", "libmp3lame", "-b:a", "320k"]
    await _ffmpeg(*args, str(out))
    return out


async def effect(src: Path, name: str) -> Path:
    out = _out("mp3")
    await _ffmpeg("-i", str(src), "-vn", "-af", EFFECTS[name][1], "-c:a", "libmp3lame", "-b:a", "256k", str(out))
    return out


async def to_voice(src: Path, max_sec: int = 600) -> Path:
    out = _out("ogg")
    await _ffmpeg("-i", str(src), "-t", str(max_sec), "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "48k", str(out))
    return out


async def probe_duration(src: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(src),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    try:
        return float(out.decode().strip())
    except ValueError:
        return 0.0


async def clips_for_recognition(src: Path, clip_sec: int = 12) -> list[Path]:
    """Mono 16 kHz wav clips: whole file if short, else start/middle/later parts."""
    total = await probe_duration(src)
    starts = [0.0] if total <= clip_sec * 1.5 else [total * 0.15, total * 0.45, total * 0.7]
    clips = []
    for st in starts:
        out = _out("wav")
        await _ffmpeg("-ss", f"{st:.1f}", "-t", str(clip_sec), "-i", str(src), "-vn", "-ac", "1", "-ar", "16000", str(out))
        clips.append(out)
    return clips


async def to_wav(src: Path, max_sec: int = 30) -> Path:
    out = _out("wav")
    await _ffmpeg("-i", str(src), "-t", str(max_sec), "-vn", "-ac", "1", "-ar", "16000", str(out))
    return out


def cleanup(*paths: Path) -> None:
    for p in paths:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
