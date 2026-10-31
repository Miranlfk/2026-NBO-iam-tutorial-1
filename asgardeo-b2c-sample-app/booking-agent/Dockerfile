# syntax=docker/dockerfile:1
#
# Wayfinder booking agent (FastAPI, port 5001).
#
# Build context: asgardeo-b2c-sample-app/booking-agent/, for example:
#   docker build -t wayfinder/booking-agent asgardeo-b2c-sample-app/booking-agent

FROM python:3.12-slim AS build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM python:3.12-slim
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AGENT_SERVER_HOST=0.0.0.0 \
    AGENT_SERVER_PORT=5001
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY *.py ./
USER app
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.getenv('AGENT_SERVER_PORT', '5001'), timeout=4)"]
CMD ["python", "main.py"]
