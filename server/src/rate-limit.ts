export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number, now?: number): Promise<RateLimitDecision> | RateLimitDecision;
}

interface WindowCounter {
  count: number;
  resetAt: number;
  lastSeenAt: number;
}

/**
 * 单进程开发/预发限流器。key 必须由调用方先哈希；生产多副本部署时替换为实现同一接口的 Redis 限流器。
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, WindowCounter>();
  private operations = 0;

  constructor(private readonly maxEntries = 50_000) {}

  consume(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('限流额度必须是正整数');
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error('限流窗口必须大于 0');
    this.operations += 1;
    if (this.operations % 256 === 0 || this.counters.size > this.maxEntries) this.sweep(now);

    const current = this.counters.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs, lastSeenAt: now }
      : current;
    bucket.lastSeenAt = now;
    if (bucket.count >= limit) {
      this.counters.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, bucket.resetAt - now) };
    }
    bucket.count += 1;
    this.counters.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - now),
    };
  }

  private sweep(now: number): void {
    for (const [key, value] of this.counters) {
      if (value.resetAt <= now) this.counters.delete(key);
    }
    if (this.counters.size <= this.maxEntries) return;
    const oldest = [...this.counters.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
      .slice(0, this.counters.size - this.maxEntries);
    oldest.forEach(([key]) => this.counters.delete(key));
  }
}

export type RateLimitScope =
  | 'login'
  | 'invitationCreate'
  | 'invitationAccept'
  | 'syncPush'
  | 'migration'
  | 'privacyExport'
  | 'privacyDeletion';

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export const defaultRateLimitPolicies: Record<RateLimitScope, RateLimitPolicy> = {
  login: { limit: 20, windowMs: 15 * 60_000 },
  invitationCreate: { limit: 20, windowMs: 60 * 60_000 },
  invitationAccept: { limit: 30, windowMs: 60 * 60_000 },
  syncPush: { limit: 300, windowMs: 60_000 },
  migration: { limit: 5, windowMs: 60 * 60_000 },
  privacyExport: { limit: 3, windowMs: 24 * 60 * 60_000 },
  privacyDeletion: { limit: 5, windowMs: 24 * 60 * 60_000 },
};
