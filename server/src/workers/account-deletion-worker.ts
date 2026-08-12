import type { AccountDeletionRequest } from '../types.js';

export interface AccountDeletionExecutor {
  executeDueAccountDeletions(at?: number, limit?: number): Promise<AccountDeletionRequest[]>;
}

export interface AccountDeletionWorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  now?: () => number;
  onRun?: (completed: AccountDeletionRequest[]) => void;
  onError?: (error: unknown) => void;
}

/** 单进程调度器；数据库 SKIP LOCKED 负责多副本间互斥，本类负责本进程不重叠执行。 */
export class AccountDeletionWorker {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly now: () => number;
  private readonly onRun: (completed: AccountDeletionRequest[]) => void;
  private readonly onError: (error: unknown) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<AccountDeletionRequest[]> | undefined;

  constructor(private readonly executor: AccountDeletionExecutor, options: AccountDeletionWorkerOptions = {}) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000) throw new Error('注销 worker 间隔不能小于 1000ms');
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error('注销 worker 批量大小必须在 1 到 1000 之间');
    }
    this.now = options.now ?? Date.now;
    this.onRun = options.onRun ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
  }

  runOnce(): Promise<AccountDeletionRequest[]> {
    if (this.inFlight) return this.inFlight;
    const execution = Promise.resolve().then(
      () => this.executor.executeDueAccountDeletions(this.now(), this.batchSize),
    );
    this.inFlight = execution;
    void execution.then(
      (completed) => {
        try { this.onRun(completed); }
        finally { if (this.inFlight === execution) this.inFlight = undefined; }
      },
      (error) => {
        try { this.onError(error); }
        finally { if (this.inFlight === execution) this.inFlight = undefined; }
      },
    ).catch(() => undefined);
    return execution;
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce().catch(() => undefined);
    this.timer = setInterval(() => void this.runOnce().catch(() => undefined), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inFlight) {
      try { await this.inFlight; } catch { /* 错误已经交给 onError，停机继续释放资源 */ }
    }
  }
}
