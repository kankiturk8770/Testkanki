import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Config:
    bot_token: str = _env("BOT_TOKEN")
    public_url: str = _env("PUBLIC_URL").rstrip("/")
    webhook_secret: str = _env("WEBHOOK_SECRET")
    mode: str = _env("MODE", "webhook")
    port: int = int(_env("PORT", "8080"))
    data_dir: Path = Path(_env("DATA_DIR", "./data"))

    audd_token: str = _env("AUDD_API_TOKEN")
    acr_host: str = _env("ACRCLOUD_HOST", "identify-eu-west-1.acrcloud.com")
    acr_key: str = _env("ACRCLOUD_ACCESS_KEY")
    acr_secret: str = _env("ACRCLOUD_ACCESS_SECRET")
    acr_hum_key: str = _env("ACRCLOUD_HUM_ACCESS_KEY")
    acr_hum_secret: str = _env("ACRCLOUD_HUM_ACCESS_SECRET")

    stt_key: str = _env("STT_API_KEY")
    stt_base: str = _env("STT_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
    stt_model: str = _env("STT_MODEL", "whisper-large-v3")

    genius_token: str = _env("GENIUS_TOKEN")
    ytdlp_cookies: str = _env("YTDLP_COOKIES")
    max_upload_mb: int = int(_env("MAX_UPLOAD_MB", "50"))

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "bot.db"

    @property
    def webapp_url(self) -> str:
        return f"{self.public_url}/app/"


cfg = Config()
cfg.cache_dir.mkdir(parents=True, exist_ok=True)
