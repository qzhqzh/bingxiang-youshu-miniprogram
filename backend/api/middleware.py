import hashlib
import secrets
import threading
import time
from collections import defaultdict, deque

from django.conf import settings
from django.http import JsonResponse


class SlidingWindowLimiter:
    def __init__(self):
        self._events = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        current = time.monotonic()
        cutoff = current - window_seconds
        with self._lock:
            events = self._events[key]
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                return False, max(1, int(events[0] + window_seconds - current) + 1)
            events.append(current)
            return True, 0

    def clear(self):
        with self._lock:
            self._events.clear()


limiter = SlidingWindowLimiter()


class RateLimitMiddleware:
    RULES = {
        ("POST", "/v2/auth/wechat"): (10, 60),
        ("POST", "/v2/sync/push"): (120, 60),
        ("POST", "/v2/migrations/v1/prepare"): (5, 3600),
        ("POST", "/v2/migrations/v1/commit"): (5, 3600),
        ("POST", "/v2/me/export"): (3, 86400),
        ("POST", "/v2/me/deletion-request"): (3, 86400),
    }

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        rule = self.RULES.get((request.method, request.path))
        if rule:
            remote = (
                request.headers.get("X-Real-IP", request.META.get("REMOTE_ADDR", "unknown"))
                if settings.TRUST_PROXY_HEADERS
                else request.META.get("REMOTE_ADDR", "unknown")
            )
            identity = request.headers.get("Authorization") or remote
            identity = hashlib.sha256(identity.encode("utf-8")).hexdigest()
            allowed, retry_after = limiter.allow(f"{request.method}:{request.path}:{identity}", *rule)
            if not allowed:
                response = JsonResponse(
                    {"error": {"code": "RATE_LIMITED", "message": "请求过于频繁，请稍后重试"}}, status=429
                )
                response["Retry-After"] = str(retry_after)
                return response
        return self.get_response(request)


class RequestIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.request_id = secrets.token_hex(8)
        response = self.get_response(request)
        response["X-Request-Id"] = request.request_id
        return response
