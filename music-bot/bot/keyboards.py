from aiogram.types import InlineKeyboardButton as B, InlineKeyboardMarkup, WebAppInfo

from . import audio
from .config import cfg
from .sources import AUDIO_QUALITIES, VIDEO_QUALITIES

_SRC_ICON = {"youtube": "▶️", "soundcloud": "☁️"}


def _kb(rows) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[r for r in rows if r])


def webapp_button(text: str, path: str = "") -> B:
    return B(text=text, web_app=WebAppInfo(url=cfg.webapp_url + path))


def results(tracks: list[dict], remix_of: int | None = None) -> InlineKeyboardMarkup:
    rows = []
    for t in tracks:
        name = f"{t['artist']} - {t['title']}" if t.get("artist") else t["title"]
        label = f"{_SRC_ICON.get(t['source'], '🌐')} {name[:48]} · {audio.fmt_time(t.get('duration'))}"
        rows.append([B(text=label, callback_data=f"t:{t['id']}")])
    if remix_of is None and tracks:
        rows.append([webapp_button("📱 باز کردن در پلیر", "")])
    return _kb(rows)


def track_card(tid: int, liked: bool, from_link: bool = False) -> InlineKeyboardMarkup:
    return _kb([
        [B(text="🎧 دریافت آهنگ", callback_data=f"a:{tid}"), B(text="🎬 دریافت ویدیو", callback_data=f"v:{tid}")],
        [B(text="🔁 ریمیکس‌ها", callback_data=f"rx:{tid}"),
         B(text="❤️ لایک شده" if liked else "🤍 لایک", callback_data=f"lk:{tid}"),
         B(text="➕ پلی‌لیست", callback_data=f"pl:{tid}")],
        [B(text="🔍 این چه آهنگیه؟ (تشخیص)", callback_data=f"rec:{tid}")] if from_link else None,
        [webapp_button("📱 پخش / برش در مینی‌اپ", f"?t={tid}")],
    ])


def audio_qualities(tid: int) -> InlineKeyboardMarkup:
    return _kb([
        [B(text=f"{q} kbps", callback_data=f"aq:{tid}:{q}") for q in AUDIO_QUALITIES],
        [B(text="🎙 به صورت ویس", callback_data=f"vo:{tid}")],
    ])


def video_qualities(tid: int) -> InlineKeyboardMarkup:
    return _kb([[B(text=f"{h}p", callback_data=f"vq:{tid}:{h}") for h in VIDEO_QUALITIES]])


def edit_menu(tid: int) -> InlineKeyboardMarkup:
    fx = list(audio.EFFECTS.items())
    return _kb([
        [B(text="✂️ برش", callback_data=f"cut:{tid}"), B(text="🔔 رینگتون", callback_data=f"rt:{tid}")],
        [B(text=label, callback_data=f"fx:{tid}:{name}") for name, (label, _) in fx[:2]],
        [B(text=label, callback_data=f"fx:{tid}:{name}") for name, (label, _) in fx[2:4]],
        [B(text=label, callback_data=f"fx:{tid}:{name}") for name, (label, _) in fx[4:6]],
        [B(text="🔁 ریمیکس‌ها", callback_data=f"rx:{tid}"), B(text="🎬 ویدیو", callback_data=f"v:{tid}")],
        [webapp_button("✂️ برش دقیق در مینی‌اپ", f"?t={tid}&cut=1")],
    ])


def cut_presets(tid: int) -> InlineKeyboardMarkup:
    return _kb([
        [B(text="۳۰ ثانیه اول", callback_data=f"cp:{tid}:head"), B(text="۳۰ ثانیه وسط (کُر)", callback_data=f"cp:{tid}:mid")],
        [webapp_button("🎚 انتخاب دقیق با اسلایدر", f"?t={tid}&cut=1")],
        [B(text="❌ لغو", callback_data="cancel")],
    ])


def ringtone(tid: int) -> InlineKeyboardMarkup:
    return _kb([
        [B(text="📱 اندروید (mp3)", callback_data=f"rg:{tid}:mp3"), B(text="🍏 آیفون (m4r)", callback_data=f"rg:{tid}:m4r")],
        [webapp_button("🎚 انتخاب بخش دلخواه", f"?t={tid}&cut=1")],
    ])


def playlist_picker(tid: int, playlists: list[dict]) -> InlineKeyboardMarkup:
    rows = [[B(text=f"📁 {p['name']} ({p['count']})", callback_data=f"pa:{p['id']}:{tid}")] for p in playlists[:10]]
    rows.append([B(text="➕ پلی‌لیست جدید", callback_data=f"pn:{tid}")])
    return _kb(rows)


def recognized(tid_list: list[dict]) -> InlineKeyboardMarkup:
    return results(tid_list, remix_of=0)
