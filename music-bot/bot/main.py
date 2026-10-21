"""Entry point: one aiohttp server = Telegram webhook + Mini App + its API.

MODE=webhook  (serverless / production; needs PUBLIC_URL with HTTPS)
MODE=polling  (local testing; Mini App still served on PORT, expose it with a tunnel for Telegram)
"""
import asyncio
import contextlib
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.types import BotCommand, MenuButtonWebApp, WebAppInfo
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application
from aiohttp import web

from . import db, handlers, webapi
from .config import cfg

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")
WEBHOOK_PATH = "/webhook"


async def _janitor_loop() -> None:
    while True:
        with contextlib.suppress(Exception):
            await asyncio.to_thread(webapi.janitor)
        await asyncio.sleep(900)


async def on_startup(bot: Bot) -> None:
    await db.init()
    await bot.set_my_commands([
        BotCommand(command="start", description="شروع و راهنما"),
        BotCommand(command="app", description="باز کردن مینی‌اپ (پلیر و پلی‌لیست)"),
        BotCommand(command="history", description="تاریخچه"),
        BotCommand(command="remix", description="جستجوی ریمیکس"),
    ])
    if cfg.public_url:
        await bot.set_chat_menu_button(menu_button=MenuButtonWebApp(text="🎵 پلیر", web_app=WebAppInfo(url=cfg.webapp_url)))
    if cfg.mode == "webhook":
        await bot.set_webhook(f"{cfg.public_url}{WEBHOOK_PATH}", secret_token=cfg.webhook_secret or None,
                              allowed_updates=["message", "callback_query"], drop_pending_updates=False)
        log.info("webhook set to %s%s", cfg.public_url, WEBHOOK_PATH)


async def on_shutdown(bot: Bot) -> None:
    await db.close()


def build() -> tuple[web.Application, Bot, Dispatcher]:
    if not cfg.bot_token:
        raise SystemExit("BOT_TOKEN is not set")
    bot = Bot(cfg.bot_token, default=DefaultBotProperties(parse_mode="HTML"))
    dp = Dispatcher()
    dp.include_router(handlers.router)
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)

    app = web.Application(client_max_size=30 * 1024 * 1024)
    app["bot"] = bot
    webapi.setup(app)
    return app, bot, dp


def main() -> None:
    app, bot, dp = build()

    async def janitor_ctx(_app):
        task = asyncio.create_task(_janitor_loop())
        yield
        task.cancel()

    app.cleanup_ctx.append(janitor_ctx)

    if cfg.mode == "webhook":
        if not cfg.public_url.startswith("https://"):
            raise SystemExit("PUBLIC_URL must be an https:// address in webhook mode")
        SimpleRequestHandler(dp, bot, secret_token=cfg.webhook_secret or None).register(app, path=WEBHOOK_PATH)
        setup_application(app, dp, bot=bot)
        web.run_app(app, host="0.0.0.0", port=cfg.port)
        return

    async def polling() -> None:
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", cfg.port).start()
        log.info("Mini App on http://localhost:%s/app/ (polling mode)", cfg.port)
        await bot.delete_webhook()
        try:
            await dp.start_polling(bot)
        finally:
            await runner.cleanup()

    asyncio.run(polling())


if __name__ == "__main__":
    main()
