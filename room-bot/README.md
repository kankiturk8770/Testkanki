# PUBG room bot (@UFDEVILLCNL_bot) — Telegram Serverless

The `room_bot.sh` Python bot rebuilt for Telegram Serverless (tgcloud), plus Gemini.

- Room announcement, framed post, giveaways (UC / likes / custom / quick) with a join button,
  sponsor check, capacity and deadline, random draw; several channels, pinning, scheduling, stats.
- 🪄 AI: write what you want in one sentence ("روم ساعت ۱۱ لیویک اسکواد ۱۰۰ یوسی به MVP") and the bot
  fills the post; "write it for me" button for framed posts. Key: `/set gemini_key …` (owner only).
- Precise timing: `/timer` (owner) opens a page with the settings for a free cron-job.org job that
  calls `endpoints/tick` every minute. Without it, due posts go out on the next bot activity.

Deploy: `npx tgcloud push` (schema changes: `npx tgcloud migrate`). The first user to talk to the bot is its owner.
