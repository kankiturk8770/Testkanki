import asyncio
import html
import logging
import re
from pathlib import Path

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message

from . import audio, db, delivery, keyboards, recognize, sources
from .config import cfg

log = logging.getLogger(__name__)
router = Router()

URL_RE = re.compile(r"https?://\S+")

WELCOME = (
    "سلام {name} 👋\n\n"
    "🎵 <b>اسم آهنگ</b> یا خواننده یا یه تیکه از متن آهنگ رو بنویس تا از یوتیوب، ساندکلاد و ... پیداش کنم.\n"
    "🎙 <b>ویس</b> بفرست (آهنگی که پخش میشه یا خودت بخونی/زمزمه کنی) تا تشخیص بدم چه آهنگیه.\n"
    "🎬 <b>ویدیو، ویدیو مسیج یا لینک</b> (اینستا، تیک‌تاک، یوتیوب...) بفرست تا آهنگش رو پیدا کنم.\n"
    "✂️ بعد از دریافت آهنگ، با دکمه‌های زیرش برش، رینگتون، اسلو، باس و ... بساز.\n"
    "💬 می‌تونی بنویسی «<i>آهنگشو بفرست</i>» یا «<i>ویدیوشو بفرست</i>» یا «<i>برش ۰:۳۰ تا ۱:۰۰</i>».\n\n"
    "📱 پلیر، پلی‌لیست‌ها، تاریخچه و شناسایی زنده تو <b>مینی‌اپ</b> هست 👇"
)

# words that mean "send me the song/video of the last track" rather than a search query
_FILLER = set(
    "رو را لطفا لطفاً برام واسم برای من میخوام می‌خوام میخواهم بده بفرست بفرستش بفرستید دانلود کن "
    "همین اینو این همینو اون اونو please send me the it this".split()
)
_AUDIO_W = {"آهنگ", "آهنگش", "آهنگشو", "آهنگو", "صدا", "صداش", "صداشو", "موزیک", "موزیکش", "موزیکشو", "mp3", "audio", "song", "music"}
_VIDEO_W = {"ویدیو", "ویدیوش", "ویدیوشو", "ویدئو", "ویدئوشو", "کلیپ", "کلیپش", "کلیپشو", "فیلم", "فیلمش", "فیلمشو", "mp4", "video", "clip"}
_REMIX_W = {"ریمیکس", "ریمیکسش", "ریمیکساش", "ریمیکس‌هاش", "remix", "remixes"}
_CUT_W = {"برش", "کات", "ببر", "cut", "رینگتون"}


async def _user(m: Message | CallbackQuery) -> int:
    u = m.from_user
    await db.touch_user(u.id, u.full_name)
    return u.id


async def _track_or_alert(cb: CallbackQuery, tid: str) -> dict | None:
    t = await db.get_track(int(tid))
    if not t:
        await cb.answer("این آهنگ پیدا نشد، دوباره جستجو کن.", show_alert=True)
    return t


def _title(t: dict) -> str:
    name = f"{t['artist']} - {t['title']}" if t.get("artist") else t["title"]
    return html.escape(name)


async def _register(tracks: list[dict]) -> list[dict]:
    rows = [await db.upsert_track(t) for t in tracks]
    seen: set[int] = set()
    return [r for r in rows if not (r["id"] in seen or seen.add(r["id"]))]  # dedupe, keep order


async def show_card(bot: Bot, chat_id: int, user_id: int, t: dict, from_link: bool = False) -> None:
    await db.set_state(user_id, "last", str(t["id"]))
    liked = t["id"] in await db.liked_ids(user_id)
    caption = (f"🎵 <b>{_title(t)}</b>\n⏱ {audio.fmt_time(t.get('duration'))} · {t.get('source')}\n"
               f"<a href=\"{html.escape(t['url'])}\">لینک منبع</a>")
    kb = keyboards.track_card(t["id"], liked, from_link)
    if t.get("thumb"):
        try:
            await bot.send_photo(chat_id, t["thumb"], caption=caption, reply_markup=kb)
            return
        except TelegramBadRequest:
            pass
    await bot.send_message(chat_id, caption, reply_markup=kb, disable_web_page_preview=True)


async def do_search(msg: Message, query: str, uid: int) -> None:
    status = await msg.answer(f"🔎 دنبال «{html.escape(query)}» می‌گردم...")
    tracks = await _register(await sources.search(query))
    await db.log(uid, "search", query)
    if not tracks:
        await status.edit_text("😕 چیزی پیدا نشد. اسم رو جور دیگه بنویس یا یه ویس از آهنگ بفرست.")
        return
    await status.edit_text(f"🎶 نتایج «{html.escape(query)}»:", reply_markup=keyboards.results(tracks))


async def _with_errors(cb_or_msg, coro, busy: str = "⏳ در حال آماده‌سازی...") -> None:
    """Show a progress note, run the job, turn known errors into friendly text."""
    chat = cb_or_msg.message.chat.id if isinstance(cb_or_msg, CallbackQuery) else cb_or_msg.chat.id
    bot: Bot = cb_or_msg.bot
    note = await bot.send_message(chat, busy)
    try:
        await coro
    except delivery.TooBig:
        await bot.send_message(chat, f"⚠️ فایل از {cfg.max_upload_mb} مگابایت بزرگ‌تره؛ کیفیت پایین‌تر رو انتخاب کن.")
    except audio.FFmpegError as e:
        log.warning("ffmpeg: %s", e)
        await bot.send_message(chat, "⚠️ پردازش صدا ناموفق بود.")
    except Exception as e:
        log.exception("job failed")
        await bot.send_message(chat, f"⚠️ خطا در دانلود/ارسال: {html.escape(str(e)[:200])}")
    finally:
        try:
            await note.delete()
        except TelegramBadRequest:
            pass


# ---------------- commands ----------------

@router.message(CommandStart())
async def start(msg: Message) -> None:
    await _user(msg)
    await msg.answer(WELCOME.format(name=html.escape(msg.from_user.first_name)),
                     reply_markup=keyboards._kb([[keyboards.webapp_button("📱 باز کردن مینی‌اپ")]]))


@router.message(Command("app"))
async def app_cmd(msg: Message) -> None:
    await msg.answer("📱 مینی‌اپ:", reply_markup=keyboards._kb([[keyboards.webapp_button("باز کردن")]]))


@router.message(Command("history"))
async def history_cmd(msg: Message) -> None:
    uid = await _user(msg)
    rows = await db.history(uid, limit=15)
    if not rows:
        await msg.answer("تاریخچه‌ات خالیه.")
        return
    lines = []
    for r in rows:
        what = _title(r) if r.get("title") else html.escape(r.get("query") or "")
        lines.append(f"• {r['kind']}: {what}")
    await msg.answer("🕘 آخرین فعالیت‌ها:\n" + "\n".join(lines) + "\n\nتاریخچه کامل تو مینی‌اپ 📱")


@router.message(Command("remix"))
async def remix_cmd(msg: Message) -> None:
    uid = await _user(msg)
    q = (msg.text or "").partition(" ")[2].strip()
    if q:
        await do_search(msg, f"{q} remix", uid)
    else:
        await msg.answer("بنویس: /remix اسم آهنگ")


# ---------------- media: recognition ----------------

async def _download_tg_file(bot: Bot, file_id: str, suffix: str) -> Path:
    path = cfg.cache_dir / f"in_{file_id[-24:]}{suffix}"
    await bot.download(file_id, destination=path)
    return path


async def run_recognition(bot: Bot, chat_id: int, uid: int, src: Path, hum: bool = False) -> None:
    status = await bot.send_message(chat_id, "🎧 دارم گوش می‌دم...")
    try:
        res = await recognize.recognize(src, hum=hum)
    finally:
        audio.cleanup(src)
    if res.match:
        m = res.match
        query = m.query
        tracks = []
        if m.youtube_id:
            t = await sources.from_url(f"https://www.youtube.com/watch?v={m.youtube_id}")
            tracks = [t] if t else []
        tracks = await _register(tracks + await sources.search(query, 8))
        await db.log(uid, "recognize", query, tracks[0]["id"] if tracks else None)
        text = (f"✅ پیدا شد! ({m.engine})\n\n🎵 <b>{html.escape(m.title)}</b>\n👤 {html.escape(m.artist or '?')}"
                + (f"\n💿 {html.escape(m.album)}" if m.album else "")
                + "\n\nنسخه‌ای که می‌خوای رو انتخاب کن 👇 (ریمیکس و کاور هم هست)")
        await status.edit_text(text, reply_markup=keyboards.results(tracks))
        return
    if res.transcript:
        queries = [h.query for h in res.lyric_hits] or [res.transcript]
        tracks = await _register(await sources.search(queries[0], 6))
        if len(queries) > 1:
            tracks += await _register(await sources.search(queries[1], 3))
        await db.log(uid, "recognize", res.transcript, tracks[0]["id"] if tracks else None)
        hits = "\n".join(f"• {html.escape(h.query)}" for h in res.lyric_hits[:5])
        await status.edit_text(
            f"📝 چیزی که شنیدم: «{html.escape(res.transcript[:300])}»\n\n"
            + (f"آهنگ‌هایی که این متن رو دارن:\n{hits}\n\n" if hits else "")
            + "نتایج 👇", reply_markup=keyboards.results(tracks) if tracks else None)
        return
    await status.edit_text(
        "😕 نتونستم تشخیص بدم.\n• صدای آهنگ واضح‌تر و ۱۰-۱۵ ثانیه باشه\n"
        "• یا یه تیکه از متن آهنگ رو بنویس\n• یا تو مینی‌اپ دکمه «گوش بده» رو بزن")


@router.message(F.voice | F.audio | F.video | F.video_note | F.document)
async def media_in(msg: Message, bot: Bot) -> None:
    uid = await _user(msg)
    obj = msg.voice or msg.audio or msg.video or msg.video_note or msg.document
    if msg.document and not (msg.document.mime_type or "").startswith(("audio/", "video/")):
        await msg.answer("فقط فایل صوتی یا ویدیویی رو می‌تونم بررسی کنم.")
        return
    if (obj.file_size or 0) > 20 * 1024 * 1024:
        await msg.answer("⚠️ تلگرام اجازه دانلود فایل بیشتر از ۲۰ مگ رو به ربات نمی‌ده؛ یه تیکه کوتاه‌تر بفرست.")
        return
    hum = bool(msg.caption and any(w in msg.caption for w in ("زمزمه", "هامینگ", "hum")))
    src = await _download_tg_file(bot, obj.file_id, ".bin")
    await run_recognition(bot, msg.chat.id, uid, src, hum=hum)


# ---------------- text: links, intents, search ----------------

async def _last_track(uid: int) -> dict | None:
    v = await db.get_state(uid, "last")
    return await db.get_track(int(v)) if v else None


@router.message(F.text)
async def text_in(msg: Message, bot: Bot) -> None:
    uid = await _user(msg)
    text = msg.text.strip()

    pending = await db.get_state(uid, "await")
    if pending:
        await db.set_state(uid, "await", None)
        kind, _, arg = pending.partition(":")
        if kind == "plname":
            pid = await db.create_playlist(uid, text)
            await db.add_to_playlist(pid, int(arg))
            await msg.answer(f"📁 پلی‌لیست «{html.escape(text[:64])}» ساخته شد و آهنگ بهش اضافه شد.")
            return
        if kind == "cut" and (rng := audio.parse_range(text)):
            t = await db.get_track(int(arg))
            if t:
                await db.log(uid, "edit", "cut", t["id"])
                await _with_errors(msg, delivery.send_cut(bot, msg.chat.id, t, *rng), "✂️ در حال برش...")
                return

    if m := URL_RE.search(text):
        status = await msg.answer("🔗 در حال بررسی لینک...")
        t = await sources.from_url(m.group(0))
        await status.delete()
        if not t:
            await msg.answer("⚠️ این لینک رو نتونستم باز کنم.")
            return
        t = await db.upsert_track(t)
        await db.log(uid, "open", m.group(0), t["id"])
        await show_card(bot, msg.chat.id, uid, t, from_link=True)
        return

    words = re.findall(r"[\w‌]+", text.lower())
    rest = [w for w in words if w not in _FILLER | _AUDIO_W | _VIDEO_W | _REMIX_W | _CUT_W]
    last = await _last_track(uid)
    rng = audio.parse_range(text)
    if last and rng and any(w in _CUT_W for w in words):
        await db.log(uid, "edit", "cut", last["id"])
        await _with_errors(msg, delivery.send_cut(bot, msg.chat.id, last, *rng), "✂️ در حال برش...")
        return
    if last and not rest and words:
        if any(w in _VIDEO_W for w in words):
            await msg.answer(f"🎬 {_title(last)}\nکیفیت ویدیو؟", reply_markup=keyboards.video_qualities(last["id"]))
            return
        if any(w in _REMIX_W for w in words):
            await _send_remixes(msg, last, uid)
            return
        if any(w in _AUDIO_W for w in words):
            await msg.answer(f"🎧 {_title(last)}\nکیفیت آهنگ؟", reply_markup=keyboards.audio_qualities(last["id"]))
            return
    query = " ".join(rest) if rest and len(rest) < len(words) else text
    if any(w in _REMIX_W for w in words) and "remix" not in query:
        query += " remix"
    await do_search(msg, query, uid)


async def _send_remixes(msg: Message, t: dict, uid: int) -> None:
    status = await msg.answer(f"🔁 دنبال ریمیکس‌های {_title(t)} می‌گردم...")
    found = await _register(await sources.remixes(t["title"], t.get("artist")))
    found = [r for r in found if r["id"] != t["id"]]
    await db.log(uid, "search", f"{t['title']} remix")
    if not found:
        await status.edit_text("ریمیکسی پیدا نشد.")
        return
    await status.edit_text(f"🔁 ریمیکس‌ها و نسخه‌های دیگه‌ی {_title(t)}:", reply_markup=keyboards.results(found, remix_of=t["id"]))


# ---------------- callbacks ----------------

@router.callback_query(F.data == "cancel")
async def cb_cancel(cb: CallbackQuery) -> None:
    await db.set_state(cb.from_user.id, "await", None)
    await cb.answer("لغو شد")
    await cb.message.delete()


@router.callback_query(F.data.startswith("t:"))
async def cb_track(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    if t := await _track_or_alert(cb, cb.data[2:]):
        await cb.answer()
        await db.log(uid, "open", None, t["id"])
        await show_card(bot, cb.message.chat.id, uid, t)


@router.callback_query(F.data.startswith("a:"))
async def cb_audio_menu(cb: CallbackQuery) -> None:
    if t := await _track_or_alert(cb, cb.data[2:]):
        await cb.answer()
        await cb.message.answer(f"🎧 {_title(t)}\nکیفیت آهنگ؟", reply_markup=keyboards.audio_qualities(t["id"]))


@router.callback_query(F.data.startswith("v:"))
async def cb_video_menu(cb: CallbackQuery) -> None:
    if t := await _track_or_alert(cb, cb.data[2:]):
        await cb.answer()
        await cb.message.answer(f"🎬 {_title(t)}\nکیفیت ویدیو؟", reply_markup=keyboards.video_qualities(t["id"]))


@router.callback_query(F.data.startswith("aq:"))
async def cb_audio(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    _, tid, q = cb.data.split(":")
    if t := await _track_or_alert(cb, tid):
        await cb.answer("در حال دانلود...")
        await db.set_state(uid, "last", tid)
        await db.log(uid, "download", f"audio {q}", t["id"])
        await _with_errors(cb, delivery.send_audio(bot, cb.message.chat.id, t, q), f"⏳ دانلود آهنگ با کیفیت {q}...")


@router.callback_query(F.data.startswith("vq:"))
async def cb_video(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    _, tid, h = cb.data.split(":")
    if t := await _track_or_alert(cb, tid):
        await cb.answer("در حال دانلود...")
        await db.log(uid, "download", f"video {h}", t["id"])
        await _with_errors(cb, delivery.send_video(bot, cb.message.chat.id, t, h), f"⏳ دانلود ویدیو {h}p...")


@router.callback_query(F.data.startswith("vo:"))
async def cb_voice(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    if t := await _track_or_alert(cb, cb.data[3:]):
        await cb.answer()
        await db.log(uid, "download", "voice", t["id"])
        await _with_errors(cb, delivery.send_voice(bot, cb.message.chat.id, t))


@router.callback_query(F.data.startswith("rx:"))
async def cb_remix(cb: CallbackQuery) -> None:
    uid = await _user(cb)
    if t := await _track_or_alert(cb, cb.data[3:]):
        await cb.answer()
        await _send_remixes(cb.message, t, uid)


@router.callback_query(F.data.startswith("lk:"))
async def cb_like(cb: CallbackQuery) -> None:
    uid = await _user(cb)
    tid = int(cb.data[3:])
    now = await db.toggle_like(uid, tid)
    await cb.answer("❤️ به علاقه‌مندی‌ها اضافه شد" if now else "از علاقه‌مندی‌ها حذف شد")
    try:
        await cb.message.edit_reply_markup(reply_markup=keyboards.track_card(tid, now, "rec:" in str(cb.message.reply_markup)))
    except TelegramBadRequest:
        pass


@router.callback_query(F.data.startswith("pl:"))
async def cb_playlist_pick(cb: CallbackQuery) -> None:
    uid = await _user(cb)
    tid = int(cb.data[3:])
    await cb.answer()
    await cb.message.answer("به کدوم پلی‌لیست اضافه بشه؟", reply_markup=keyboards.playlist_picker(tid, await db.playlists(uid)))


@router.callback_query(F.data.startswith("pa:"))
async def cb_playlist_add(cb: CallbackQuery) -> None:
    uid = await _user(cb)
    _, pid, tid = cb.data.split(":")
    if not await db.owns_playlist(uid, int(pid)):
        await cb.answer("پلی‌لیست پیدا نشد", show_alert=True)
        return
    await db.add_to_playlist(int(pid), int(tid))
    await cb.answer("✅ اضافه شد")
    await cb.message.delete()


@router.callback_query(F.data.startswith("pn:"))
async def cb_playlist_new(cb: CallbackQuery) -> None:
    uid = await _user(cb)
    await db.set_state(uid, "await", f"plname:{cb.data[3:]}")
    await cb.answer()
    await cb.message.edit_text("📝 اسم پلی‌لیست جدید رو بفرست:")


@router.callback_query(F.data.startswith("fx:"))
async def cb_effect(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    _, tid, name = cb.data.split(":")
    if name not in audio.EFFECTS:
        await cb.answer()
        return
    if t := await _track_or_alert(cb, tid):
        await cb.answer("در حال ساخت...")
        await db.log(uid, "edit", name, t["id"])
        await _with_errors(cb, delivery.send_effect(bot, cb.message.chat.id, t, name), f"🎛 در حال ساخت {audio.EFFECTS[name][0]}...")


@router.callback_query(F.data.startswith("cut:"))
async def cb_cut(cb: CallbackQuery) -> None:
    uid = await _user(cb)
    if t := await _track_or_alert(cb, cb.data[4:]):
        await db.set_state(uid, "await", f"cut:{t['id']}")
        await cb.answer()
        await cb.message.answer(
            f"✂️ برش {_title(t)} (طول: {audio.fmt_time(t.get('duration'))})\n"
            "بازه رو بفرست، مثلاً: <code>0:45-1:15</code> یا <code>۴۵ تا ۷۵</code>\nیا یکی از این‌ها:",
            reply_markup=keyboards.cut_presets(t["id"]))


def _preset(t: dict, which: str, length: float = 30) -> tuple[float, float]:
    dur = t.get("duration") or 180
    if which == "head":
        return 0.0, min(length, dur)
    mid = dur * 0.4  # the first chorus is usually around 35-45% of a pop song
    return max(0.0, mid - length / 2), min(dur, mid + length / 2)


@router.callback_query(F.data.startswith("cp:"))
async def cb_cut_preset(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    _, tid, which = cb.data.split(":")
    if t := await _track_or_alert(cb, tid):
        await db.set_state(uid, "await", None)
        await cb.answer()
        await db.log(uid, "edit", "cut", t["id"])
        await _with_errors(cb, delivery.send_cut(bot, cb.message.chat.id, t, *_preset(t, which)), "✂️ در حال برش...")


@router.callback_query(F.data.startswith("rt:"))
async def cb_ringtone_menu(cb: CallbackQuery) -> None:
    if t := await _track_or_alert(cb, cb.data[3:]):
        await cb.answer()
        await cb.message.answer(f"🔔 رینگتون از {_title(t)} (۳۰ ثانیه از وسط آهنگ):", reply_markup=keyboards.ringtone(t["id"]))


@router.callback_query(F.data.startswith("rg:"))
async def cb_ringtone(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    _, tid, fmt = cb.data.split(":")
    if t := await _track_or_alert(cb, tid):
        await cb.answer()
        await db.log(uid, "edit", "ringtone", t["id"])
        await _with_errors(cb, delivery.send_cut(bot, cb.message.chat.id, t, *_preset(t, "mid"), fmt=fmt), "🔔 ساخت رینگتون...")


@router.callback_query(F.data.startswith("rec:"))
async def cb_recognize_link(cb: CallbackQuery, bot: Bot) -> None:
    uid = await _user(cb)
    if t := await _track_or_alert(cb, cb.data[4:]):
        await cb.answer("دارم آهنگ ویدیو رو تشخیص می‌دم...")
        try:
            src = await sources.audio_file(t, "128")
        except Exception as e:
            await cb.message.answer(f"⚠️ دانلود ناموفق: {html.escape(str(e)[:150])}")
            return
        # recognition deletes its input, so give it a copy of the cached mp3
        tmp = cfg.cache_dir / f"in_{src.name}"
        await asyncio.to_thread(tmp.write_bytes, src.read_bytes())
        await run_recognition(bot, cb.message.chat.id, uid, tmp)
