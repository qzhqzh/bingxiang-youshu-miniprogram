import pg, { type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import type { V2ApiService } from './api-service.js';
import { PostgresV2Service } from './postgres/service.js';
import type { PgPoolLike } from './postgres/mutation-executor.js';
import { V2Service } from './service.js';
import { InMemoryV2Store } from './store.js';
import { LiveWechatIdentityProvider, type WechatIdentityProvider } from './wechat.js';
import type { AccountDeletionExecutor } from './workers/account-deletion-worker.js';

const REQUIRED_MIGRATIONS = ['0001_v2_core.sql', '0002_privacy_jobs.sql'] as const;

export interface RuntimePool extends PgPoolLike {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

export interface ServiceRuntime {
  mode: 'memory' | 'postgres';
  service: V2ApiService;
  accountDeletionExecutor?: AccountDeletionExecutor;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeDependencies {
  createPool(config: PoolConfig): RuntimePool;
  createWechat(appId: string, appSecret: string): WechatIdentityProvider;
}

interface MigrationNameRow extends QueryResultRow { name: string }
interface RequiredTablesRow extends QueryResultRow {
  users: string | null;
  sessions: string | null;
  cursors: string | null;
  privacy_jobs: string | null;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

const defaultDependencies: RuntimeDependencies = {
  createPool: (config) => new pg.Pool(config) as unknown as RuntimePool,
  createWechat: (appId, appSecret) => new LiveWechatIdentityProvider(appId, appSecret),
};

/** 创建 API 运行时；生产环境没有 PostgreSQL 时拒绝降级到内存实现。 */
export function createServiceRuntime(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: RuntimeDependencies = defaultDependencies,
): ServiceRuntime {
  const appId = env.BINGXIANG_WECHAT_APP_ID ?? '';
  const appSecret = env.BINGXIANG_WECHAT_APP_SECRET ?? '';
  if (!appId) throw new Error('缺少 BINGXIANG_WECHAT_APP_ID');
  if (!appSecret) throw new Error('缺少 BINGXIANG_WECHAT_APP_SECRET');

  const sessionTtlMs = positiveInteger(env.BINGXIANG_SESSION_TTL_SECONDS, 'BINGXIANG_SESSION_TTL_SECONDS', 7_200) * 1_000;
  const wechat = dependencies.createWechat(appId, appSecret);
  const databaseUrl = env.BINGXIANG_DATABASE_URL?.trim();

  if (!databaseUrl) {
    if (env.NODE_ENV === 'production') {
      throw new Error('生产环境必须配置 BINGXIANG_DATABASE_URL，禁止降级为内存数据服务');
    }
    return {
      mode: 'memory',
      service: new V2Service(new InMemoryV2Store(), wechat, { appId, sessionTtlMs }),
      ready: async () => undefined,
      close: async () => undefined,
    };
  }

  const pool = dependencies.createPool({
    connectionString: databaseUrl,
    max: positiveInteger(env.BINGXIANG_DATABASE_POOL_MAX, 'BINGXIANG_DATABASE_POOL_MAX', 10),
    connectionTimeoutMillis: positiveInteger(
      env.BINGXIANG_DATABASE_CONNECT_TIMEOUT_MS,
      'BINGXIANG_DATABASE_CONNECT_TIMEOUT_MS',
      5_000,
    ),
    idleTimeoutMillis: positiveInteger(env.BINGXIANG_DATABASE_IDLE_TIMEOUT_MS, 'BINGXIANG_DATABASE_IDLE_TIMEOUT_MS', 30_000),
  });
  const service = new PostgresV2Service(pool, wechat, { appId, sessionTtlMs });

  return {
    mode: 'postgres',
    service,
    accountDeletionExecutor: service,
    ready: async () => {
      const migrationResult = await pool.query<MigrationNameRow>(
        'SELECT name FROM schema_migrations WHERE name = ANY($1::text[])',
        [[...REQUIRED_MIGRATIONS]],
      );
      const applied = new Set(migrationResult.rows.map((row) => row.name));
      const missing = REQUIRED_MIGRATIONS.filter((name) => !applied.has(name));
      if (missing.length > 0) {
        throw new Error(`数据库迁移未完成：${missing.join(', ')}；请先运行 pnpm run db:migrate`);
      }
      const tables = await pool.query<RequiredTablesRow>(
        `SELECT to_regclass('public.users')::text AS users,
                to_regclass('public.device_sessions')::text AS sessions,
                to_regclass('public.household_sync_cursors')::text AS cursors,
                to_regclass('public.account_deletion_requests')::text AS privacy_jobs`,
      );
      const row = tables.rows[0];
      if (!row || Object.values(row).some((value) => value === null)) {
        throw new Error('数据库结构不完整；请检查 schema_migrations 与实际表结构');
      }
    },
    close: async () => pool.end(),
  };
}
