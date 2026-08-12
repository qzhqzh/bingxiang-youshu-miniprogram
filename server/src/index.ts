import { buildApp } from './app.js';
import { createServiceRuntime } from './runtime.js';

const host = process.env.BINGXIANG_API_HOST ?? '127.0.0.1';
const port = Number(process.env.BINGXIANG_API_PORT ?? 3210);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('BINGXIANG_API_PORT 必须是有效端口');

const runtime = createServiceRuntime();
try {
  await runtime.ready();
} catch (error) {
  await runtime.close();
  throw error;
}

const app = buildApp(runtime.service, { trustProxy: process.env.BINGXIANG_TRUST_PROXY === 'true' });
app.addHook('onClose', async () => runtime.close());
try {
  await app.listen({ host, port });
} catch (error) {
  await runtime.close();
  throw error;
}

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
