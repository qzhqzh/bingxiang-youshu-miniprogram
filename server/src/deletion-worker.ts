import { createServiceRuntime } from './runtime.js';
import { AccountDeletionWorker } from './workers/account-deletion-worker.js';

if (process.env.NODE_ENV !== 'production') {
  throw new Error('注销 worker 仅允许在 NODE_ENV=production 且使用 PostgreSQL 时启动');
}

const runtime = createServiceRuntime();
if (runtime.mode !== 'postgres' || !runtime.accountDeletionExecutor) {
  await runtime.close();
  throw new Error('注销 worker 必须连接 PostgreSQL 数据服务');
}

try {
  await runtime.ready();
} catch (error) {
  await runtime.close();
  throw error;
}

const intervalMs = Number(process.env.BINGXIANG_DELETION_WORKER_INTERVAL_MS ?? 60_000);
const batchSize = Number(process.env.BINGXIANG_DELETION_WORKER_BATCH_SIZE ?? 100);
let worker: AccountDeletionWorker;
try {
  worker = new AccountDeletionWorker(runtime.accountDeletionExecutor, {
    intervalMs,
    batchSize,
    onRun: (completed) => {
      if (completed.length > 0) process.stdout.write(`account-deletion worker completed=${completed.length}\n`);
    },
    onError: (error) => {
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      process.stderr.write(`account-deletion worker failed type=${errorType}\n`);
    },
  });
} catch (error) {
  await runtime.close();
  throw error;
}
worker.start();

await new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
await worker.stop();
await runtime.close();
