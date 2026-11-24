FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --disable-pip-version-check --timeout 300 --retries 20 -r requirements.txt

COPY . .
EXPOSE 8001
CMD ["sh", "-c", "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8001 --reload"]
