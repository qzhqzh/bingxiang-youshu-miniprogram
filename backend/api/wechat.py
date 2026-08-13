import json
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

from .errors import ApiError


def exchange_code(code: str) -> str:
    if not settings.WECHAT_APP_ID or not settings.WECHAT_APP_SECRET:
        raise ApiError("SERVICE_NOT_CONFIGURED", "微信登录尚未配置", 503)
    query = urllib.parse.urlencode(
        {
            "appid": settings.WECHAT_APP_ID,
            "secret": settings.WECHAT_APP_SECRET,
            "js_code": code,
            "grant_type": "authorization_code",
        }
    )
    request = urllib.request.Request(f"https://api.weixin.qq.com/sns/jscode2session?{query}", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:  # noqa: S310 - fixed official HTTPS host
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise ApiError("WECHAT_UNAVAILABLE", "微信登录服务暂不可用", 503) from error
    if payload.get("errcode") or not payload.get("openid"):
        raise ApiError("WECHAT_LOGIN_FAILED", "微信登录凭证无效", 401)
    return str(payload["openid"])
