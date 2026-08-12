import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PoolConfig, QueryResult, QueryResultRow } from 'pg';
import type { RuntimeDependencies, RuntimePool } from '../src/runtime.js';
import { createServiceRuntime } from '../src/runtime.js';
import { TestWechatIdentityProvider } from '../src/wechat.js';

class FakeRuntimePool implements RuntimePool {
  readonly queries: string[] = [];
  closes = 0;
  constructor(private readonly migrations: string[] = ['0001_v2_core.sql', '0002_privacy_jobs.sql']) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> {
    this.queries.push(text);
    const rows = text.includes('FROM schema_migrations')
      ? this.migrations.map((name) => ({ name }))
      : [{ users: 'users', sessions: 'device_sessions', cursors: 'household_sync_cursors', privacy_jobs: 'account_deletion_requests' }];
    return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as R[] };
  }

  async connect(): Promise<never> { throw new Error('本测试不应创建事务连接'); }
  async end(): Promise<void> { this.closes += 1; }
}

function dependencies(pool: FakeRuntimePool, configs: PoolConfig[]): RuntimeDependencies {
  return {
    createPool: (config) => {
      configs.push(config);
      return pool;
    },
    createWechat: () => new TestWechatIdentityProvider({}),
  };
}

const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  BINGXIANG_WECHAT_APP_ID: 'wx-test-app',
  BINGXIANG_WECHAT_APP_SECRET: 'server-only-secret',
};

describe('2.0 PostgreSQL 生产运行时', () => {
  it('67. 生产环境缺少数据库连接时拒绝降级为内存服务', () => {
    const pool = new FakeRuntimePool();
    const configs: PoolConfig[] = [];
    assert.throws(
      () => createServiceRuntime(baseEnv, dependencies(pool, configs)),
      /生产环境必须配置 BINGXIANG_DATABASE_URL/,
    );
    assert.equal(configs.length, 0);
  });

  it('68. PostgreSQL 运行时启动前核验必要 migration 和实体表，关闭时释放连接池', async () => {
    const pool = new FakeRuntimePool();
    const configs: PoolConfig[] = [];
    const runtime = createServiceRuntime({
      ...baseEnv,
      BINGXIANG_DATABASE_URL: 'postgresql://private-host/app',
      BINGXIANG_DATABASE_POOL_MAX: '6',
    }, dependencies(pool, configs));

    assert.equal(runtime.mode, 'postgres');
    assert.equal(configs[0]?.connectionString, 'postgresql://private-host/app');
    assert.equal(configs[0]?.max, 6);
    await runtime.ready();
    assert.equal(pool.queries.length, 2);
    assert.match(pool.queries[0] ?? '', /schema_migrations/);
    assert.match(pool.queries[1] ?? '', /to_regclass/);
    await runtime.close();
    assert.equal(pool.closes, 1);
  });

  it('69. migration 未完整应用时在监听端口前失败', async () => {
    const pool = new FakeRuntimePool(['0001_v2_core.sql']);
    const runtime = createServiceRuntime({
      ...baseEnv,
      BINGXIANG_DATABASE_URL: 'postgresql://private-host/app',
    }, dependencies(pool, []));

    await assert.rejects(runtime.ready(), /0002_privacy_jobs\.sql/);
    assert.equal(pool.queries.length, 1);
  });
});
