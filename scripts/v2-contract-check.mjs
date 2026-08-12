import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'server/openapi.yaml',
  'server/db/migrations/0001_v2_core.sql',
  'server/src/app.ts',
  'server/src/service.ts',
  'miniprogram/repositories/local/local-v2.repository.ts',
  'miniprogram/services/cloud/sync-coordinator.ts',
];
required.forEach((path) => assert.ok(existsSync(join(root, path)), `缺少 2.0 契约文件：${path}`));

const openapi = readFileSync(join(root, 'server/openapi.yaml'), 'utf8');
for (const route of ['/auth/wechat:', '/households:', '/bootstrap:', '/sync/push:', '/sync/pull:', '/migrations/v1/prepare:', '/migrations/v1/commit:']) {
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

console.log('2.0 契约检查通过：OpenAPI 核心路由、租户表、库存约束、唯一 owner 与幂等键均存在。');
