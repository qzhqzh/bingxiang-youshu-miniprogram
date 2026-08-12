import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';
import { PostgresIdentityService } from '../src/postgres/identity-service.js';
import type { PgClientLike, PgPoolLike } from '../src/postgres/mutation-executor.js';
import { TestWechatIdentityProvider } from '../src/wechat.js';

interface SqlStep {
  includes: string;
  rows?: QueryResultRow[];
  rowCount?: number;
}

class ScriptedPool implements PgPoolLike {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  connections = 0;
  releases = 0;

  constructor(private readonly steps: SqlStep[]) {}

  async connect(): Promise<PgClientLike> {
    this.connections += 1;
    return {
      query: async <R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) => {
        this.calls.push({ text, values });
        const step = this.steps.shift();
        assert.ok(step, `没有为 SQL 准备脚本：${text}`);
        assert.ok(text.includes(step.includes), `SQL 未包含预期片段：${step.includes}`);
        const rows = (step.rows ?? []) as R[];
        return { command: 'SQL', rowCount: step.rowCount ?? rows.length, oid: 0, fields: [], rows } as QueryResult<R>;
      },
      release: () => { this.releases += 1; },
    };
  }

  done(): void {
    assert.equal(this.steps.length, 0, '仍有未使用的 SQL 脚本');
    assert.equal(this.connections, this.releases, '每个数据库连接都必须释放');
  }
}

const now = Date.parse('2026-08-13T08:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const householdRow = {
  id: 'home-db', name: '我的冰箱', timezone: 'Asia/Shanghai', owner_user_id: 'user-db', status: 'active',
  version: '1', created_at: iso(), deleted_at: null,
};

function identityService(pool: PgPoolLike) {
  return new PostgresIdentityService(pool, new TestWechatIdentityProvider({ login: 'wx-subject-sensitive' }), {
    appId: 'test-app', now: () => now, sessionTtlMs: 60_000,
  });
}

describe('2.0 PostgreSQL 身份与会话', () => {
  it('49. 首次微信登录在 SERIALIZABLE 事务中原子创建用户、默认家庭、cursor 与会话', async () => {
    const pool = new ScriptedPool([
      { includes: 'BEGIN' },
      { includes: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE' },
      { includes: 'pg_advisory_xact_lock' },
      { includes: 'FROM auth_identities i', rows: [] },
      { includes: 'INSERT INTO users' },
      { includes: 'INSERT INTO auth_identities' },
      { includes: 'INSERT INTO households' },
      { includes: 'INSERT INTO household_members' },
      { includes: 'INSERT INTO household_sync_cursors' },
      { includes: 'INSERT INTO sync_changes' },
      { includes: 'INSERT INTO device_sessions' },
      { includes: 'FROM households h JOIN household_members m', rows: [householdRow] },
      { includes: 'COMMIT' },
    ]);
    const service = identityService(pool);
    const result = await service.loginWechat('login', 'raw-device-id');
    assert.equal(result.households[0]?.id, 'home-db');
    assert.equal(result.expiresAt, now + 60_000);
    assert.ok(result.accessToken.length >= 40);
    const sessionInsert = pool.calls.find((item) => item.text.includes('INSERT INTO device_sessions'))!;
    assert.equal(typeof sessionInsert.values[2], 'string');
    assert.equal((sessionInsert.values[2] as string).length, 64);
    assert.equal((sessionInsert.values[3] as string).length, 64);
    const transmitted = JSON.stringify(pool.calls);
    assert.ok(!transmitted.includes(result.accessToken));
    assert.ok(!transmitted.includes('raw-device-id'));
    assert.ok(pool.calls.some((item) => item.text.includes('current_cursor, minimum_cursor') && item.text.includes('VALUES ($1, 2, 0)')));
    pool.done();
  });

  it('50. 重复微信身份复用同一用户，冻结账号回滚且不创建会话', async () => {
    const pool = new ScriptedPool([
      { includes: 'BEGIN' },
      { includes: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE' },
      { includes: 'pg_advisory_xact_lock' },
      { includes: 'FROM auth_identities i', rows: [{
        id: 'user-db', display_name: '小秦', status: 'frozen', created_at: iso(-1_000), deleted_at: null,
      }] },
      { includes: 'ROLLBACK' },
    ]);
    const service = identityService(pool);
    await assert.rejects(service.loginWechat('login', 'device'), (error: any) => error?.code === 'UNAUTHENTICATED');
    assert.ok(!pool.calls.some((item) => item.text.includes('INSERT INTO device_sessions')));
    pool.done();
  });

  it('51. 会话列表只查询安全列且返回值不含 token/device hash', async () => {
    const pool = new ScriptedPool([
      { includes: "s.token_hash = decode($1, 'hex')", rows: [{
        session_id: 'session-1', user_id: 'user-db', created_at: iso(-2_000), expires_at: iso(60_000),
        last_seen_at: iso(-1_000), revoked_at: null, display_name: '小秦', user_status: 'active',
        user_created_at: iso(-5_000), user_deleted_at: null,
      }] },
      { includes: 'UPDATE device_sessions SET last_seen_at' },
      { includes: 'SELECT id, user_id, created_at, expires_at, last_seen_at, revoked_at', rows: [{
        id: 'session-1', user_id: 'user-db', created_at: iso(-2_000), expires_at: iso(60_000),
        last_seen_at: iso(), revoked_at: null,
      }] },
    ]);
    const service = identityService(pool);
    const sessions = await service.listSessions('opaque-access-token');
    assert.equal(sessions[0]?.id, 'session-1');
    assert.ok(!JSON.stringify(sessions).includes('tokenHash'));
    assert.ok(!JSON.stringify(sessions).includes('deviceIdHash'));
    const listSql = pool.calls[2]?.text ?? '';
    assert.ok(!listSql.includes('token_hash'));
    assert.ok(!listSql.includes('device_id_hash'));
    pool.done();
  });
});
