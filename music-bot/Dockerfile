FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# YouTube extraction in yt-dlp needs a JavaScript runtime (deno)
COPY --from=denoland/deno:bin-2.4.5 /deno /usr/local/bin/deno
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot ./bot
COPY webapp ./webapp
ENV PYTHONUNBUFFERED=1 DATA_DIR=/data PORT=8080 MODE=webhook
VOLUME /data
EXPOSE 8080
CMD ["python", "-m", "bot.main"]
