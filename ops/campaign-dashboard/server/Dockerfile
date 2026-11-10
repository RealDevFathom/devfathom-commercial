# DevFathom campaign ops dashboard (stdlib only). Build context: this directory (server/).
#   docker build --platform linux/amd64 -t campaign-dashboard server/
FROM --platform=linux/amd64 python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DATA_DIR=/data

RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /app /data \
 && chown app:app /data

WORKDIR /app
COPY --chown=root:root *.py /app/
COPY --chown=root:root static/ /app/static/

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).read()==b'ok' else 1)"]

CMD ["python", "/app/app.py"]
