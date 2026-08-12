import { ApiError } from './errors.js';

export interface WechatIdentity {
  providerSubject: string;
  unionId?: string;
}

export interface WechatIdentityProvider {
  exchange(code: string): Promise<WechatIdentity>;
}

export class LiveWechatIdentityProvider implements WechatIdentityProvider {
  constructor(private readonly appId: string, private readonly appSecret: string) {
    if (!appId || !appSecret) throw new Error('微信 AppID/AppSecret 未配置');
  }

  async exchange(code: string): Promise<WechatIdentity> {
    if (!code) throw new ApiError('VALIDATION_ERROR', '缺少微信登录 code', 400);
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.searchParams.set('appid', this.appId);
    url.searchParams.set('secret', this.appSecret);
    url.searchParams.set('js_code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new ApiError('UNAUTHENTICATED', '微信身份服务暂不可用', 503);
    const body = await response.json() as { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
    if (!body.openid) {
      throw new ApiError('UNAUTHENTICATED', '微信登录凭证校验失败', 401, { errcode: body.errcode });
    }
    return body.unionid
      ? { providerSubject: body.openid, unionId: body.unionid }
      : { providerSubject: body.openid };
  }
}

export class TestWechatIdentityProvider implements WechatIdentityProvider {
  constructor(private readonly subjects: Readonly<Record<string, string>>) {}
  async exchange(code: string): Promise<WechatIdentity> {
    const providerSubject = this.subjects[code];
    if (!providerSubject) throw new ApiError('UNAUTHENTICATED', '测试登录 code 无效', 401);
    return { providerSubject };
  }
}
