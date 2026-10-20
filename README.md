# KANKI 0.4.1

VPN اختصاصی IPv4 برای بازی و مسیرهای ناپایدار: AES-256-GCM، HKDF، XOR FEC، Repeat (۳ تا ۱۰ نسخه از هر بسته)، Jitter و Auto-tune. کاهش پینگ تضمین نمی‌شود؛ هدف حذف loss بدون انتظار برای ارسال مجدد است.

## نصب سرور (یک دستور)

دامنه را به IP سرور وصل کنید (رکورد A) و روی سرور Debian/Ubuntu اجرا کنید:

```bash
curl -fsSL https://raw.githubusercontent.com/kankiturk8770/Testkanki/main/install.sh | sudo bash -s -- vpn.example.com
```

هستهٔ VPN، پنل و گواهی SSL خودکار نصب می‌شوند. آرگومان دوم اختیاری، پورت UDP تونل است (پیش‌فرض 4000). در پایان آدرس پنل و توکن مدیریت چاپ می‌شود.

## اتصال

در پنل کاربر بسازید، لینک اشتراک را کپی کنید و در برنامهٔ اندروید «دریافت اشتراک» را بزنید. سرور، پورت و کلید از خود لینک خوانده می‌شوند.

## ساختار

- `server/`: هستهٔ VPN لینوکس (`kanki-vpnd`)
- `admin/`: پنل مدیریت و API اشتراک
- `client-android/`: برنامهٔ اندروید (Full VPN و Gaming Smart)
- `deploy/`: نصب‌کننده، سرویس‌های systemd و NAT
- `agent/`: عامل نود برای حالت چندسرور (اختیاری)
- `tests/`: رگرسیون‌ها و تست‌های واقعی شبکه

راهنماها: [نصب و استفاده](docs/INSTALL_FA.md) · [چندسرور](docs/CLUSTER_FA.md) · [معماری و تغییرات](docs/CHANGES_FA.md) · [گزارش آزمون](docs/TEST_REPORT_FA.md)
