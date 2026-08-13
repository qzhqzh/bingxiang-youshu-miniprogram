import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.getenv("DJANGO_DEBUG", "false").lower() == "true"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", "local-tests-only-not-for-production")
ENVIRONMENT = os.getenv("DJANGO_ENV", "local")
if ENVIRONMENT == "production" and (len(SECRET_KEY) < 50 or not os.getenv("WECHAT_APP_SECRET")):
    raise ImproperlyConfigured("生产环境必须配置强 DJANGO_SECRET_KEY 和 WECHAT_APP_SECRET")
ALLOWED_HOSTS = [
    item for item in os.getenv("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost,testserver").split(",") if item
]
CSRF_TRUSTED_ORIGINS = [item for item in os.getenv("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if item]

INSTALLED_APPS = ["api"]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "api.middleware.RequestIdMiddleware",
    "api.middleware.RateLimitMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "Asia/Shanghai"
SQLITE_FILE = Path(os.getenv("SQLITE_PATH", str(BASE_DIR / "var" / "db.sqlite3")))
SQLITE_FILE.parent.mkdir(parents=True, exist_ok=True)

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": SQLITE_FILE,
        "OPTIONS": {
            "timeout": 20,
            "transaction_mode": "IMMEDIATE",
            "init_command": "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=20000;",
        },
    }
}

WECHAT_APP_ID = os.getenv("WECHAT_APP_ID", "")
WECHAT_APP_SECRET = os.getenv("WECHAT_APP_SECRET", "")
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "false").lower() == "true"
WECHAT_CODE_EXCHANGER = os.getenv("WECHAT_CODE_EXCHANGER", "api.wechat.exchange_code")
SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "2592000"))
CATALOG_VERSION = 1
DATA_EXPORT_TTL_SECONDS = 86400
ACCOUNT_DELETION_COOLING_SECONDS = 604800
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https") if TRUST_PROXY_HEADERS else None
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SECURE_SSL_REDIRECT = ENVIRONMENT == "production"
SECURE_HSTS_SECONDS = 31_536_000 if ENVIRONMENT == "production" else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = ENVIRONMENT == "production"
SECURE_HSTS_PRELOAD = False
SILENCED_SYSTEM_CHECKS = ["security.W003"]  # 纯 Bearer API 不使用 Cookie 身份，因此不依赖 CSRF token。

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {
            "format": '{{"time":"{asctime}","level":"{levelname}","logger":"{name}","message":"{message}"}}',
            "style": "{",
        }
    },
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "json"}},
    "root": {"handlers": ["console"], "level": os.getenv("LOG_LEVEL", "INFO")},
}
