FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

WORKDIR /app

RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple uv==0.8.13

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

EXPOSE 41000

CMD ["sh", "-c", "uv run --no-dev python manage.py migrate --noinput && exec uv run --no-dev gunicorn config.wsgi:application --bind 127.0.0.1:41000 --workers 1 --threads 4 --timeout 30 --access-logfile - --error-logfile -"]
