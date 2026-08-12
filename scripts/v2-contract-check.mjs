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

console.log('2.0 契约检查通过：OpenAPI、运行时 schema/限流、租户与隐私任务表、库存约束、唯一 owner、幂等键与 PostgreSQL 事务边界均存在。');
