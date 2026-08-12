import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'server/openapi.yaml',
  'server/db/migrations/0001_v2_core.sql',
  'server/db/migrations/0002_privacy_jobs.sql',
  'server/src/app.ts',
  'server/src/api-service.ts',
  'server/src/http-schema.ts',
  'server/src/rate-limit.ts',
  'server/src/postgres/mutation-executor.ts',
  'server/src/postgres/query-store.ts',
  'server/src/postgres/identity-service.ts',
  'server/src/postgres/household-service.ts',
  'server/src/postgres/sync-service.ts',
  'server/src/postgres/privacy-service.ts',
  'server/src/postgres/migration-service.ts',
  'server/src/postgres/service.ts',
  'server/src/runtime.ts',
  'server/src/deletion-worker.ts',
  'server/src/workers/account-deletion-worker.ts',
  'server/src/service.ts',
  'miniprogram/repositories/local/local-v2.repository.ts',
  'miniprogram/services/cloud/sync-coordinator.ts',
];
required.forEach((path) => assert.ok(existsSync(join(root, path)), `缺少 2.0 契约文件：${path}`));

const openapi = readFileSync(join(root, 'server/openapi.yaml'), 'utf8');
for (const route of ['/auth/wechat:', '/me/export:', '/me/deletion-request:', '/households:', '/bootstrap:', '/sync/push:', '/sync/pull:', '/migrations/v1/prepare:', '/migrations/v1/commit:']) {
  assert.ok(openapi.includes(route), `OpenAPI 缺少 ${route}`);
}
assert.ok(openapi.includes('bearerAuth:'), 'OpenAPI 缺少 Bearer 会话定义');
assert.ok(openapi.includes('FULL_RESYNC_REQUIRED'), 'OpenAPI 缺少完整重同步错误说明');

const sql = readFileSync(join(root, 'server/db/migrations/0001_v2_core.sql'), 'utf8');
for (const table of ['users', 'auth_identities', 'device_sessions', 'households', 'household_members', 'pantry_batches', 'inventory_movements', 'processed_mutations', 'sync_changes', 'audit_logs']) {
  assert.match(sql, new RegExp(`CREATE TABLE ${table}\\s*\\(`), `数据库迁移缺少 ${table}`);
}
assert.ok(!/\b(uuid|gen_random_uuid)\b/i.test(sql), '客户端与领域 ID 为带前缀字符串，SQL 不应错误限制为 UUID');
assert.ok(sql.includes('CHECK (quantity >= 0)'), '库存表必须有非负约束');
assert.ok(sql.includes('household_one_active_owner_idx'), '缺少家庭唯一有效 owner 约束');
assert.ok(sql.includes('PRIMARY KEY (user_id, mutation_id)'), '缺少 mutation 幂等唯一键');
const privacySql = readFileSync(join(root, 'server/db/migrations/0002_privacy_jobs.sql'), 'utf8');
assert.match(privacySql, /CREATE TABLE data_export_jobs\s*\(/, '缺少数据导出任务表');
assert.match(privacySql, /CREATE TABLE account_deletion_requests\s*\(/, '缺少账号注销任务表');
assert.ok(privacySql.includes('account_one_pending_deletion_idx'), '缺少单用户唯一待执行注销约束');
assert.ok(privacySql.includes('account_deletion_due_idx'), '缺少注销任务到期扫描索引');

const appSource = readFileSync(join(root, 'server/src/app.ts'), 'utf8');
const httpSchema = readFileSync(join(root, 'server/src/http-schema.ts'), 'utf8');
const rateLimitSource = readFileSync(join(root, 'server/src/rate-limit.ts'), 'utf8');
assert.ok(appSource.includes('removeAdditional: false'), 'API 必须拒绝额外字段，不能静默丢弃');
assert.ok(appSource.includes("code: 'VALIDATION_ERROR'"), 'API 缺少统一运行时校验错误体');
assert.ok(httpSchema.includes("commandSchema('CompleteCooking'"), '运行时契约缺少做菜命令');
assert.ok(httpSchema.includes('maxLength: 2_000_000'), '迁移载荷缺少大小上限');
assert.ok(appSource.includes("rateLimit('syncPush'"), '同步 push 缺少接口限流');
assert.ok(appSource.includes("rateLimit('migration'"), '迁移接口缺少接口限流');
assert.ok(rateLimitSource.includes('export interface RateLimiter'), '缺少可替换的限流器契约');

const transactionSource = readFileSync(join(root, 'server/src/postgres/mutation-executor.ts'), 'utf8');
for (const boundary of [
  'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  'pg_advisory_xact_lock',
  'FOR UPDATE',
  'ROLLBACK',
  'processed_mutations',
  'household_sync_cursors',
]) assert.ok(transactionSource.includes(boundary), `PostgreSQL 事务执行器缺少边界：${boundary}`);

const queryStoreSource = readFileSync(join(root, 'server/src/postgres/query-store.ts'), 'utf8');
for (const boundary of [
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  "s.token_hash = decode($1, 'hex')",
  "FROM pantry_batches WHERE household_id = $1",
  "FROM recipe_progress WHERE household_id = $1 AND user_id = $2",
  'FULL_RESYNC_REQUIRED',
]) assert.ok(queryStoreSource.includes(boundary), `PostgreSQL 读模型缺少边界：${boundary}`);

const identitySource = readFileSync(join(root, 'server/src/postgres/identity-service.ts'), 'utf8');
for (const boundary of [
  'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  'identity:wechat-miniprogram:',
  "decode($3, 'hex'), decode($4, 'hex')",
  'INSERT INTO household_sync_cursors',
  'INSERT INTO sync_changes',
  'ROLLBACK',
]) assert.ok(identitySource.includes(boundary), `PostgreSQL 身份服务缺少边界：${boundary}`);

const householdSource = readFileSync(join(root, 'server/src/postgres/household-service.ts'), 'utf8');
for (const boundary of [
  'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  'user-households:',
  'household:',
  "token_hash = decode($1, 'hex')",
  'FOR UPDATE',
  "SET role = 'admin'",
  "SET role = 'owner'",
  'INSERT INTO audit_logs',
  'ROLLBACK',
]) assert.ok(householdSource.includes(boundary), `PostgreSQL 家庭服务缺少边界：${boundary}`);

const syncSource = readFileSync(join(root, 'server/src/postgres/sync-service.ts'), 'utf8');
for (const boundary of [
  'new PostgresMutationExecutor',
  "case 'PurchaseBatch'",
  "case 'CompleteCooking'",
  "case 'UpdatePreferences'",
  'lockCookingPlan',
  'INSERT INTO inventory_movements',
  'INSERT INTO cooking_consumptions',
  'ON CONFLICT (household_id, user_id) DO UPDATE',
  'VERSION_CONFLICT',
]) assert.ok(syncSource.includes(boundary), `PostgreSQL 同步命令服务缺少边界：${boundary}`);

const privacySource = readFileSync(join(root, 'server/src/postgres/privacy-service.ts'), 'utf8');
for (const boundary of [
  'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  'INSERT INTO data_export_jobs',
  'user-lifecycle:',
  'GREATEST(expires_at, $4)',
  'FOR UPDATE SKIP LOCKED',
  'DELETE FROM auth_identities',
  'DELETE FROM member_preferences',
  'DELETE FROM recipe_progress',
  "display_name = '已注销成员'",
  'ROLLBACK',
]) assert.ok(privacySource.includes(boundary), `PostgreSQL 数据权利服务缺少边界：${boundary}`);

const migrationSource = readFileSync(join(root, 'server/src/postgres/migration-service.ts'), 'utf8');
for (const boundary of [
  'validateImportJson',
  'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  'migration:',
  'FOR UPDATE',
  ') AS occupied',
  'INSERT INTO inventory_movements',
  "UPDATE v1_migrations SET status = 'committed'",
  'ROLLBACK',
]) assert.ok(migrationSource.includes(boundary), `PostgreSQL v1 迁移服务缺少边界：${boundary}`);

const postgresServiceSource = readFileSync(join(root, 'server/src/postgres/service.ts'), 'utf8');
for (const boundary of [
  'implements V2ApiService',
  'new PostgresIdentityService',
  'new PostgresHouseholdService',
  'new PostgresSyncService',
  'new PostgresPrivacyService',
  'new PostgresMigrationService',
]) assert.ok(postgresServiceSource.includes(boundary), `PostgresV2Service 缺少组合：${boundary}`);

const runtimeSource = readFileSync(join(root, 'server/src/runtime.ts'), 'utf8');
for (const boundary of [
  "env.NODE_ENV === 'production'",
  '生产环境必须配置 BINGXIANG_DATABASE_URL',
  'new PostgresV2Service',
  'FROM schema_migrations',
  'to_regclass',
  'pool.end()',
]) assert.ok(runtimeSource.includes(boundary), `生产运行时缺少安全边界：${boundary}`);
assert.ok(queryStoreSource.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), '一致性读必须使用只读快照事务');
assert.ok(householdSource.includes('PostgresQueryStore.fromPool(pool'), '家庭 bootstrap 必须接入一致性连接池读模型');
assert.ok(syncSource.includes('PostgresQueryStore.fromPool(pool'), '同步 pull 必须接入一致性连接池读模型');

const workerSource = readFileSync(join(root, 'server/src/workers/account-deletion-worker.ts'), 'utf8');
for (const boundary of [
  'if (this.inFlight) return this.inFlight',
  'executeDueAccountDeletions',
  'clearInterval',
  'await this.inFlight',
]) assert.ok(workerSource.includes(boundary), `注销 worker 缺少生命周期边界：${boundary}`);
const workerEntrySource = readFileSync(join(root, 'server/src/deletion-worker.ts'), 'utf8');
assert.ok(workerEntrySource.includes("process.env.NODE_ENV !== 'production'"), '注销 worker 必须拒绝非生产误启动');
assert.ok(workerEntrySource.includes('await runtime.ready()'), '注销 worker 必须执行数据库启动预检');

console.log('2.0 契约检查通过：OpenAPI、运行时 schema/限流、租户与隐私任务表、库存约束、唯一 owner、幂等键与 PostgreSQL 事务边界均存在。');
