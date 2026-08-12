import { buildApp } from './app.js';
import { V2Service } from './service.js';
import { InMemoryV2Store } from './store.js';
import { LiveWechatIdentityProvider } from './wechat.js';

const appId = process.env.BINGXIANG_WECHAT_APP_ID ?? '';
const appSecret = process.env.BINGXIANG_WECHAT_APP_SECRET ?? '';
const host = process.env.BINGXIANG_API_HOST ?? '127.0.0.1';
const port = Number(process.env.BINGXIANG_API_PORT ?? 3210);

if (process.env.NODE_ENV === 'production') {
  throw new Error('2.0 alpha 尚未接入 PostgreSQL Store，禁止用内存 Store 启动生产环境');
}

const service = new V2Service(
  new InMemoryV2Store(),
  new LiveWechatIdentityProvider(appId, appSecret),
  {
    appId,
    ...(process.env.BINGXIANG_SESSION_TTL_SECONDS
      ? { sessionTtlMs: Number(process.env.BINGXIANG_SESSION_TTL_SECONDS) * 1_000 }
      : {}),
  },
);

const app = buildApp(service);
await app.listen({ host, port });
