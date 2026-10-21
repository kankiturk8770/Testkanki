# گزارش تحویل — Kanki Music Bot (Telegram Serverless)

**کد:** ریپو `kankiturk8770/Testkanki`، برانچ `claude/telegram-music-search-bot-1quzmk`، پوشه `music-bot/`

## چی ساخته شده
ربات موزیک + مینی‌اپ برای **Telegram Serverless** (BotFather ← Serverless). فقط جاوااسکریپت، بدون سرور و Docker.
- `tgcloud/handlers/` ← message.js (جستجو، ویس/ویدیو برای تشخیص، لینک، دستورهای متنی مثل «آهنگشو بفرست»)، callback_query.js (دکمه‌ها)، channel_post.js (کانال ذخیره)
- `tgcloud/endpoints/` ← توابع مینی‌اپ: search, track, remixes, library, history, like, played, playlist, audioChunk, sendTrack, uploadEdit, recognize
- `tgcloud/lib/` ← sources.js (یوتیوب InnerTube + ساندکلاد)، recognize.js (AudD، ACRCloud، زمزمه، Whisper، Genius)، deliver.js، store.js (SQL)، ui.js، util.js، actions.js، webapp.js
- `tgcloud/schema.js` ← جدول‌ها: users, tracks, history, playlists, playlist_items, likes, file_cache, state, settings, uploads
- `webapp/` ← پلیر کامل، ویرایشگر (برش/رینگتون/افکت با Web Audio + lamejs روی گوشی کاربر)، «گوش بده»، کتابخانه، پلی‌لیست منتخب، تاریخچه

## محدودیت‌های Serverless و راه‌حل‌ها
- ffmpeg و yt-dlp نداره، هر fetch حداکثر ۳۰ مگه ← ویرایش صدا داخل مینی‌اپ انجام میشه
- ساندکلاد مستقیم دانلود میشه (m4a، ۱۶۰k). آهنگ‌های DRM‌دار رد میشن و جایگزین پیدا میشه
- یوتیوب: اول مستقیم امتحان میشه، اگه بلاک بشه همون آهنگ از ساندکلاد گرفته میشه. برای ۳۲۰، ویدیو HD و اینستا/تیک‌تاک: `/set cobalt_url`
- شازم اجرا نمیشه؛ به جاش AudD و ACRCloud
- کلیدها تو دیتابیس با `/set` ذخیره میشن (ادمین = اولین کسی که `/admin` بزنه)

## وضعیت تست
- تست شده: جستجو، دانلود ساندکلاد، fallback از یوتیوب به ساندکلاد، کش file_id، پلی‌لیست، تاریخچه، دستورهای متنی، ویرایشگر مینی‌اپ (mp3 سالم ساخت)، و ساختار پروژه با `tgcloud status`
- تست نشده: اجرای واقعی روی Serverless (محدودیت زمان اجرا مستند نیست)، سرویس‌های تشخیص با کلید واقعی، cobalt

## مراحل راه‌اندازی
1. BotFather ← ربات ← Serverless ← روشن
2. توی پوشه `music-bot`:
   - `npm install`
   - `npx tgcloud login` (توکن از بخش CLI Access)
   - `npx tgcloud push`
   - `npx tgcloud migrate`
   (یا فایل‌ها رو دستی توی Handlers / Endpoints / Library / Database / Mini App Files پنل کپی کن)
3. تو چت ربات:
   - `/admin`
   - `/set webapp_url https://app<id>.tgcloud.ai/`
   - `/set audd_token ...` (و بقیه کلیدها؛ راهنما با `/settings`)
4. کانال ذخیره: ربات رو ادمین کانال خصوصی کن ← توی کانال `/storage` ← تأیید تو چت ربات

## به‌روزرسانی (deploy شده روی app8859705249 / kankiMp3_bot)
- کد آپلود شده، دیتابیس migrate شده، وب‌هوک هماهنگه. آدرس مینی‌اپ: https://app8859705249.tgcloud.ai/
- **Shazam رایگان** اضافه شد: اثرانگشت تو مینی‌اپ + اندپوینت `shazam`. روی سرور تلگرام تست شد و درست تشخیص داد
- یوتیوب روی سرور تلگرام: جستجو ✅، ولی دانلود فقط ۱ مگ اوله (PO token) ← صدا از ساندکلاد میاد، ویدیو cobalt لازم داره
- WebAssembly تو sandbox اجرا نمیشه (HTTP 500)

## قدم‌های بعدی
- deploy و تست واقعی، بعد بررسی لاگ با `npx tgcloud run`
- اگه درخواست‌ها timeout شدن: کوچیک کردن تیکه‌ها، یا اضافه کردن cobalt
