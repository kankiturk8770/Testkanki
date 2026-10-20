# نصب و استفادهٔ KANKI

## نصب سرور با یک دستور

پیش‌نیاز: یک VPS با Debian یا Ubuntu، دسترسی root، و یک دامنه (یا زیردامنه) که رکورد A آن به IP همین سرور اشاره کند. اگر از Cloudflare استفاده می‌کنید، رکورد را روی «DNS only» بگذارید (ابر خاکستری)؛ ترافیک UDP تونل از پروکسی Cloudflare عبور نمی‌کند.

```bash
curl -fsSL https://raw.githubusercontent.com/kankiturk8770/Testkanki/main/install.sh | sudo bash -s -- vpn.example.com
```

برای انتخاب پورت UDP تونل، آن را آرگومان دوم بدهید (پیش‌فرض 4000):

```bash
curl -fsSL https://raw.githubusercontent.com/kankiturk8770/Testkanki/main/install.sh | sudo bash -s -- vpn.example.com 9090
```

این دستور:

1. سورس را از GitHub در `/opt/kanki/src` می‌گیرد.
2. هستهٔ VPN (`kanki-vpnd`) را روی همان سرور کامپایل و نصب می‌کند و NAT و forwarding را فعال می‌کند.
3. پنل مدیریت را راه‌اندازی می‌کند.
4. Caddy را نصب می‌کند تا گواهی SSL معتبر Let's Encrypt را برای دامنه بگیرد و خودش تمدید کند. پنل روی `https://دامنه` باز می‌شود.
5. در پایان آدرس پنل، توکن مدیریت و پورت تونل را چاپ می‌کند. توکن در `/etc/kanki-admin.env` هم ذخیره است.

پورت‌های TCP 80 و 443 (برای گواهی و پنل) و پورت UDP تونل را در فایروال دیتاسنتر باز کنید. اگر `ufw` فعال باشد، نصب‌کننده خودش این پورت‌ها را باز می‌کند. برای ثبت ایمیل در Let's Encrypt متغیر `KANKI_EMAIL=you@example.com` را قبل از `bash` بگذارید (`... | sudo KANKI_EMAIL=you@example.com bash -s -- vpn.example.com`).

اجرای دوبارهٔ همان دستور، نسخهٔ جدید را از GitHub می‌گیرد و سرویس‌ها را به‌روز می‌کند؛ کاربران، کلیدها، حجم‌ها و تنظیمات حفظ می‌شوند.

> اگر مخزن GitHub خصوصی است، لینک raw بدون توکن کار نمی‌کند. مخزن را عمومی کنید، یا سورس را دستی روی سرور بیاورید و `sudo bash install.sh vpn.example.com` را از داخل پوشه اجرا کنید. شاخه را می‌توانید با `KANKI_BRANCH=...` عوض کنید.

بررسی وضعیت:

```bash
sudo systemctl status kanki-admin kanki-vpnd kanki-gateway caddy
sudo journalctl -u kanki-vpnd -u kanki-admin --since '10 minutes ago'
```

## پنل

با توکن مدیریت وارد `https://دامنه` شوید.

- **کاربران**: کاربر بسازید و حجم (صفر یعنی نامحدود)، تاریخ انقضا (UTC، پایان همان روز) و تعداد دستگاه را تعیین کنید. حجم و انقضا در خود هسته اجرا می‌شوند، نه فقط در نمایش. «لینک» آدرس اشتراک را کپی می‌کند. «کلید جدید» لینک و کلید همهٔ دستگاه‌های کاربر را باطل می‌کند.
- **پروفایل سرورها**: هر پروفایل یک پورت UDP واقعی روی هستهٔ همین سرور است، با تنظیمات Repeat، FEC و Jitter خودش. با افزودن یا حذف پروفایل، هسته حدود دو ثانیه بعد پورت را باز یا بسته می‌کند و همان پورت در لینک اشتراک قرار می‌گیرد؛ نیازی به وارد کردن دستی پورت در برنامه نیست. پورت جدید را در فایروال دیتاسنتر هم باز کنید. MTU تونل بزرگ‌ترین MTU پروفایل‌هاست.

تغییرات کاربران حدود دو ثانیه بعد در هسته اعمال می‌شوند. آمار در `/var/lib/kanki/status.txt` هر ثانیه ذخیره و بعد از restart حفظ می‌شود.

## اندروید

1. APK را نصب کنید (Android 8 به بالا، ARM64). APK از GitHub Actions این مخزن (بخش Artifacts) یا از ساخت محلی به دست می‌آید.
2. لینک اشتراک `https://دامنه/sub/...` را از پنل کپی و در برنامه وارد کنید و «دریافت اشتراک» را بزنید.
3. پروفایل مخصوص همین دستگاه را انتخاب کنید. آدرس سرور، پورت، کلید و تنظیمات از اشتراک پر می‌شوند.
4. حالت را انتخاب کنید: **Full VPN** همهٔ برنامه‌ها را از تونل عبور می‌دهد. **Gaming Smart** فقط بازی‌ها و برنامه‌های انتخابی را، همراه Google Play Services، Play Store و Google Services Framework، از تونل عبور می‌دهد.
5. «اتصال امن» را بزنید و مجوز VPN را بدهید. وضعیت «متصل» فقط بعد از پاسخ رمزنگاری‌شدهٔ سرور نمایش داده می‌شود. RTT نمایش‌داده‌شده RTT تا سرور تونل است، نه تا سرور بازی.

تنظیمات دستی (سرور، پورت، کلید، Repeat و…) زیر دکمهٔ «تنظیمات دستی (پیشرفته)» پنهان است و برای کار معمولی لازم نیست. IPv6 داخل VPN گرفته و حذف می‌شود تا نشت نکند. برای قطع کامل اینترنت در زمان قطع VPN، در تنظیمات اندروید Always-on VPN و «Block connections without VPN» را فعال کنید.

### ساخت اپ

JDK 17 یا جدیدتر، SDK 34، Build-tools 34.0.0، NDK 26.3.11579264 و CMake 3.22.1 لازم است:

```bash
cd client-android
export ANDROID_NDK_ROOT="$ANDROID_HOME/ndk/26.3.11579264"
./build-openssl.sh "$PWD/openssl-android" arm64-v8a
./gradlew --no-daemon assembleDebug assembleDebugAndroidTest lintDebug \
  -POPENSSL_ROOT="$PWD/openssl-android"
```

خروجی در `client-android/app/build/outputs/apk/debug/app-debug.apk` است. با هر push، GitHub Actions همین کار را انجام و APK را به‌عنوان artifact ذخیره می‌کند. APK با کلید Debug امضا می‌شود؛ برای انتشار عمومی کلید Release خودتان لازم است.

## چند سرور

حالت پیش‌فرض تک‌سرور است. برای یک پنل مرکزی و چند سرور (نود)، [راهنمای چندسرور](CLUSTER_FA.md) را ببینید.

## آزمون‌ها

```bash
bash tests/run.sh
sudo bash tests/linux_netns.sh      # نیازمند root، TUN و قابلیت ایجاد namespace
sudo python3 tests/cluster_netns.py
```

کلاینت لینوکسی `tests/tools/kanki-vpn-client` فقط ابزار همین تست‌هاست و روی سرور نصب نمی‌شود. کد خروج 77 یعنی امکان تست در میزبان موجود نیست؛ آن را PASS محسوب نکنید.

تست دستگاه اندروید پس از نصب دو APK و دادن مجوز VPN:

```bash
adb install -r app-debug.apk
adb install -r app-debug-androidTest.apk
adb shell am instrument -w \
  -e vpnHost SERVER_IPV4 -e vpnPort 4000 \
  -e vpnKey DEVICE_KEY -e vpnIp 10.66.0.2 \
  -e echoHost TEST_UDP_ECHO_HOST -e echoPort 18081 \
  com.kanki.tunnel.test/androidx.test.runner.AndroidJUnitRunner
```
