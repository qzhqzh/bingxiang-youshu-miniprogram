import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AccountDeletionRequest } from '../src/types.js';
import { AccountDeletionWorker, type AccountDeletionExecutor } from '../src/workers/account-deletion-worker.js';

const completedRequest: AccountDeletionRequest = {
  id: 'delete-1', userId: 'user-1', status: 'completed', requestedAt: 1,
  executeAfter: 2, restrictedSessionId: 'session-1', completedAt: 3,
};

describe('2.0 账号注销任务执行器', () => {
  it('70. 同一进程的重叠触发合并为一次数据库批处理', async () => {
    let calls = 0;
    let requestedAt = 0;
    let requestedLimit = 0;
    let resolveExecution!: (value: AccountDeletionRequest[]) => void;
    const pending = new Promise<AccountDeletionRequest[]>((resolve) => { resolveExecution = resolve; });
    const executor: AccountDeletionExecutor = {
      executeDueAccountDeletions: (at, limit) => {
        calls += 1;
        requestedAt = at ?? 0;
        requestedLimit = limit ?? 0;
        return pending;
      },
    };
    const worker = new AccountDeletionWorker(executor, { now: () => 123_000, batchSize: 25 });

    const first = worker.runOnce();
    const second = worker.runOnce();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(requestedAt, 123_000);
    assert.equal(requestedLimit, 25);
    resolveExecution([completedRequest]);
    assert.deepEqual(await first, [completedRequest]);
  });

  it('71. 一次失败会被安全上报并允许下一轮重试', async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const executor: AccountDeletionExecutor = {
      executeDueAccountDeletions: async () => {
        calls += 1;
        if (calls === 1) throw new Error('temporary database failure');
        return [completedRequest];
      },
    };
    const worker = new AccountDeletionWorker(executor, { onError: (error) => errors.push(error) });

    await assert.rejects(worker.runOnce(), /temporary database failure/);
    await Promise.resolve();
    assert.equal(errors.length, 1);
    assert.deepEqual(await worker.runOnce(), [completedRequest]);
    assert.equal(calls, 2);
  });

  it('72. 停机等待在途批处理完成并拒绝危险调度参数', async () => {
    let resolveExecution!: (value: AccountDeletionRequest[]) => void;
    const pending = new Promise<AccountDeletionRequest[]>((resolve) => { resolveExecution = resolve; });
    const worker = new AccountDeletionWorker({ executeDueAccountDeletions: () => pending });
    void worker.runOnce();
    await Promise.resolve();
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    resolveExecution([]);
    await stopping;
    assert.equal(stopped, true);
    assert.throws(() => new AccountDeletionWorker({ executeDueAccountDeletions: async () => [] }, { intervalMs: 999 }), /1000ms/);
    assert.throws(() => new AccountDeletionWorker({ executeDueAccountDeletions: async () => [] }, { batchSize: 1001 }), /1 到 1000/);
  });
});
