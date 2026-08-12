import type { QueryResultRow } from 'pg';
import { ApiError } from '../errors.js';
import { checksum, newId } from '../security.js';
import type {
  AccountDeletionRequest,
  DataExportArtifact,
  DeviceSession,
  HouseholdMember,
} from '../types.js';
import { PostgresMutationContext, type PgClientLike, type PgPoolLike } from './mutation-executor.js';
import { PostgresQueryStore } from './query-store.js';

export interface PostgresPrivacyServiceOptions {
  now?: () => number;
  dataExportTtlMs?: number;
  deletionCoolingMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
}

interface DeletionRow extends QueryResultRow {
  id: string;
  user_id: string;
  status: AccountDeletionRequest['status'];
  restricted_session_id: string;
  requested_at: Date | string;
  execute_after: Date | string;
  cancelled_at: Date | string | null;
  completed_at: Date | string | null;
  blocked_reason: string | null;
}

interface IdRow extends QueryResultRow { id: string }
interface MemberRow extends QueryResultRow {
  household_id: string;
  user_id: string;
  role: HouseholdMember['role'];
  status: HouseholdMember['status'];
  joined_at: Date | string;
  version: string | number;
}

function timestamp(value: Date | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效时间');
  return parsed;
}

function deletionFromRow(row: DeletionRow): AccountDeletionRequest {
  return {
    id: row.id, userId: row.user_id, status: row.status,
    requestedAt: timestamp(row.requested_at)!, executeAfter: timestamp(row.execute_after)!,
    restrictedSessionId: row.restricted_session_id,
    ...(row.cancelled_at ? { cancelledAt: timestamp(row.cancelled_at)! } : {}),
    ...(row.completed_at ? { completedAt: timestamp(row.completed_at)! } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason } : {}),
  };
}

function memberFromRow(row: MemberRow): HouseholdMember {
  return {
    householdId: row.household_id, userId: row.user_id, role: row.role, status: row.status,
    joinedAt: timestamp(row.joined_at)!, version: Number(row.version),
  };
}

/** PostgreSQL 用户数据权利服务。导出脱敏；注销按冷静期状态机执行并保留共享事实。 */
export class PostgresPrivacyService {
  private readonly now: () => number;
  private readonly dataExportTtlMs: number;
  private readonly deletionCoolingMs: number;
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly queryStore: PostgresQueryStore;

  constructor(private readonly pool: PgPoolLike, options: PostgresPrivacyServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.dataExportTtlMs = options.dataExportTtlMs ?? 24 * 60 * 60 * 1_000;
    this.deletionCoolingMs = options.deletionCoolingMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.queryStore = new PostgresQueryStore({
      query: (text, values) => this.withClientQuery(text, values),
    }, { now: this.now });
  }

  async createDataExport(accessToken: string): Promise<DataExportArtifact> {
    const principal = await this.queryStore.authenticate(accessToken);
    const [households, sessions] = await Promise.all([
      this.queryStore.listHouseholds(principal.user.id),
      this.safeSessions(principal.user.id),
    ]);
    const exportedAt = this.now();
    const exportedHouseholds = [];
    for (const household of households) {
      const snapshot = await this.queryStore.bootstrap(household.id, principal.user.id);
      const membership = snapshot.members.find((item) => item.userId === principal.user.id);
      if (!membership) throw new ApiError('HOUSEHOLD_FORBIDDEN', '家庭成员关系已变化，请重新导出', 409);
      exportedHouseholds.push({
        scope: household.ownerUserId === principal.user.id ? 'owner-full' as const : 'member-readable' as const,
        household: snapshot.household,
        membership,
        members: snapshot.members.map(({ userId, role, status, joinedAt, version, displayName }) => ({
          userId, role, status, joinedAt, version, displayName: displayName ?? '家庭成员',
        })),
        batches: snapshot.batches,
        movements: snapshot.movements,
        shoppingItems: snapshot.shoppingItems,
        cookingRecords: snapshot.cookingRecords,
        recipeProgress: snapshot.recipeProgress,
        preferences: snapshot.preferences,
      });
    }
    const payload: DataExportArtifact['payload'] = {
      format: 'bingxiang-v2-user-export',
      exportedAt,
      user: principal.user,
      sessions,
      households: exportedHouseholds,
      exclusions: [
        '微信 providerSubject 与认证 code',
        '会话 token、设备指纹和邀请口令/哈希',
        '其他成员的个人食谱进度与偏好',
        '运营审计元数据与服务端密钥',
      ],
    };
    const artifact: DataExportArtifact = {
      id: newId('exp'), userId: principal.user.id, status: 'ready', createdAt: exportedAt,
      expiresAt: exportedAt + this.dataExportTtlMs, checksum: checksum(JSON.stringify(payload)), payload,
    };
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO data_export_jobs (id, user_id, status, checksum, payload, created_at, expires_at)
         VALUES ($1, $2, 'ready', $3, $4::jsonb, $5, $6)`,
        [artifact.id, artifact.userId, artifact.checksum, JSON.stringify(payload),
          new Date(artifact.createdAt), new Date(artifact.expiresAt)],
      );
      await this.audit(client, principal.user.id, 'user.export.created', 'dataExport', artifact.id, {
        householdCount: exportedHouseholds.length, expiresAt: artifact.expiresAt,
      });
    });
    return artifact;
  }

  async requestAccountDeletion(accessToken: string, confirmation: string): Promise<AccountDeletionRequest> {
    if (confirmation !== '注销账号') throw new ApiError('VALIDATION_ERROR', '请完整输入“注销账号”确认', 400);
    const principal = await this.queryStore.authenticate(accessToken);
    return this.transaction(async (client) => {
      await this.lock(client, `user-lifecycle:${principal.user.id}`);
      const existing = await client.query<DeletionRow>(
        `SELECT id, user_id, status, restricted_session_id, requested_at, execute_after,
                cancelled_at, completed_at, blocked_reason
         FROM account_deletion_requests WHERE user_id = $1 AND status = 'pending' FOR UPDATE`,
        [principal.user.id],
      );
      if (existing.rows[0]) return deletionFromRow(existing.rows[0]);
      const owned = await client.query<IdRow>(
        `SELECT id FROM households
         WHERE owner_user_id = $1 AND status = 'active' FOR SHARE`,
        [principal.user.id],
      );
      if (owned.rows.length > 0) {
        throw new ApiError('CONFLICT', '请先转移或删除你拥有的家庭', 409, {
          ownedHouseholdIds: owned.rows.map((item) => item.id),
        });
      }
      const requestedAt = this.now();
      const request: AccountDeletionRequest = {
        id: newId('del'), userId: principal.user.id, status: 'pending', requestedAt,
        executeAfter: requestedAt + this.deletionCoolingMs, restrictedSessionId: principal.session.id,
      };
      await client.query(
        `INSERT INTO account_deletion_requests
           (id, user_id, status, restricted_session_id, requested_at, execute_after)
         VALUES ($1, $2, 'pending', $3, $4, $5)`,
        [request.id, request.userId, request.restrictedSessionId,
          new Date(request.requestedAt), new Date(request.executeAfter)],
      );
      await client.query("UPDATE users SET status = 'deletionPending' WHERE id = $1 AND status = 'active'", [principal.user.id]);
      await client.query(
        `UPDATE device_sessions
         SET revoked_at = CASE WHEN id = $2 THEN revoked_at ELSE COALESCE(revoked_at, $3) END,
             expires_at = CASE WHEN id = $2 THEN GREATEST(expires_at, $4) ELSE expires_at END
         WHERE user_id = $1`,
        [principal.user.id, principal.session.id, new Date(requestedAt), new Date(request.executeAfter)],
      );
      await this.audit(client, principal.user.id, 'user.deletion.requested', 'user', principal.user.id, {
        requestId: request.id, executeAfter: request.executeAfter,
      });
      return request;
    });
  }

  async accountDeletionStatus(accessToken: string): Promise<AccountDeletionRequest> {
    const principal = await this.queryStore.authenticate(accessToken, true);
    const result = await this.withClientQuery<DeletionRow>(
      `SELECT id, user_id, status, restricted_session_id, requested_at, execute_after,
              cancelled_at, completed_at, blocked_reason
       FROM account_deletion_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [principal.user.id],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '没有账号注销申请', 404);
    return deletionFromRow(result.rows[0]);
  }

  async cancelAccountDeletion(accessToken: string): Promise<AccountDeletionRequest> {
    const principal = await this.queryStore.authenticate(accessToken, true);
    return this.transaction(async (client) => {
      await this.lock(client, `user-lifecycle:${principal.user.id}`);
      const selected = await client.query<DeletionRow>(
        `SELECT id, user_id, status, restricted_session_id, requested_at, execute_after,
                cancelled_at, completed_at, blocked_reason
         FROM account_deletion_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`,
        [principal.user.id],
      );
      const current = selected.rows[0] ? deletionFromRow(selected.rows[0]) : undefined;
      if (!current) throw new ApiError('NOT_FOUND', '没有账号注销申请', 404);
      if (current.status !== 'pending') throw new ApiError('CONFLICT', '当前注销申请不能取消', 409);
      if (current.executeAfter <= this.now()) throw new ApiError('CONFLICT', '注销申请已进入执行阶段', 409);
      const cancelledAt = this.now();
      const updated = await client.query<DeletionRow>(
        `UPDATE account_deletion_requests SET status = 'cancelled', cancelled_at = $2
         WHERE id = $1 AND status = 'pending'
         RETURNING id, user_id, status, restricted_session_id, requested_at, execute_after,
                   cancelled_at, completed_at, blocked_reason`,
        [current.id, new Date(cancelledAt)],
      );
      if (!updated.rows[0]) throw new ApiError('CONFLICT', '注销申请状态已变化', 409);
      await client.query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'deletionPending'", [principal.user.id]);
      await this.audit(client, principal.user.id, 'user.deletion.cancelled', 'user', principal.user.id, {
        requestId: current.id,
      });
      return deletionFromRow(updated.rows[0]);
    });
  }

  /** 由受控 worker 调用。共享库存/做菜事实保留，身份映射和个人状态删除或匿名化。 */
  async executeDueAccountDeletions(at = this.now(), limit = 100): Promise<AccountDeletionRequest[]> {
    return this.transaction(async (client) => {
      const due = await client.query<DeletionRow>(
        `SELECT id, user_id, status, restricted_session_id, requested_at, execute_after,
                cancelled_at, completed_at, blocked_reason
         FROM account_deletion_requests
         WHERE status = 'pending' AND execute_after <= $1
         ORDER BY execute_after, id
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [new Date(at), Math.min(Math.max(limit, 1), 500)],
      );
      const completed: AccountDeletionRequest[] = [];
      for (const row of due.rows) {
        const request = deletionFromRow(row);
        await this.lock(client, `user-lifecycle:${request.userId}`);
        const owned = await client.query<IdRow>(
          "SELECT id FROM households WHERE owner_user_id = $1 AND status = 'active' FOR SHARE",
          [request.userId],
        );
        if (owned.rows.length > 0) {
          const blocked = await client.query<DeletionRow>(
            `UPDATE account_deletion_requests SET status = 'blocked', blocked_reason = 'OWNED_HOUSEHOLD_REMAINS'
             WHERE id = $1
             RETURNING id, user_id, status, restricted_session_id, requested_at, execute_after,
                       cancelled_at, completed_at, blocked_reason`,
            [request.id],
          );
          completed.push(deletionFromRow(blocked.rows[0]!));
          continue;
        }
        const memberships = await client.query<MemberRow>(
          `SELECT household_id, user_id, role, status, joined_at, version
           FROM household_members WHERE user_id = $1 AND status = 'active' ORDER BY household_id FOR UPDATE`,
          [request.userId],
        );
        for (const memberRow of memberships.rows) {
          const member = memberFromRow(memberRow);
          await this.lock(client, `household:${member.householdId}`);
          const removed = await client.query<MemberRow>(
            `UPDATE household_members SET status = 'removed', version = version + 1
             WHERE household_id = $1 AND user_id = $2 AND status = 'active'
             RETURNING household_id, user_id, role, status, joined_at, version`,
            [member.householdId, request.userId],
          );
          if (removed.rows[0]) {
            const next = memberFromRow(removed.rows[0]);
            await new PostgresMutationContext(client, member.householdId, () => at).appendChange({
              entityType: 'member', entityId: request.userId, operation: 'delete', version: next.version,
              payload: { userId: request.userId, displayName: '已注销成员' },
            });
          }
        }
        await client.query('DELETE FROM auth_identities WHERE user_id = $1', [request.userId]);
        await client.query('UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1', [request.userId, new Date(at)]);
        await client.query('DELETE FROM member_preferences WHERE user_id = $1', [request.userId]);
        await client.query('DELETE FROM recipe_progress WHERE user_id = $1', [request.userId]);
        await client.query(
          `UPDATE data_export_jobs SET status = 'expired', payload = '{"expired":true}'::jsonb,
             checksum = $2 WHERE user_id = $1 AND status = 'ready'`,
          [request.userId, checksum('{"expired":true}')],
        );
        await client.query(
          `UPDATE users SET display_name = '已注销成员', status = 'deleted', deleted_at = $2 WHERE id = $1`,
          [request.userId, new Date(at)],
        );
        const updated = await client.query<DeletionRow>(
          `UPDATE account_deletion_requests SET status = 'completed', completed_at = $2
           WHERE id = $1
           RETURNING id, user_id, status, restricted_session_id, requested_at, execute_after,
                     cancelled_at, completed_at, blocked_reason`,
          [request.id, new Date(at)],
        );
        await this.audit(client, request.userId, 'user.deletion.completed', 'user', request.userId, {
          requestId: request.id,
        });
        completed.push(deletionFromRow(updated.rows[0]!));
      }
      return completed;
    });
  }

  private async safeSessions(userId: string): Promise<Array<Omit<DeviceSession, 'tokenHash' | 'deviceIdHash'>>> {
    const result = await this.withClientQuery<SessionRow>(
      `SELECT id, user_id, created_at, expires_at, last_seen_at, revoked_at
       FROM device_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC, id`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id, userId: row.user_id, createdAt: timestamp(row.created_at)!, expiresAt: timestamp(row.expires_at)!,
      lastSeenAt: timestamp(row.last_seen_at)!, ...(row.revoked_at ? { revokedAt: timestamp(row.revoked_at)! } : {}),
    }));
  }

  private async audit(
    client: PgClientLike,
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [actorUserId, action, targetType, targetId, JSON.stringify(metadata), new Date(this.now())],
    );
  }

  private async lock(client: PgClientLike, key: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }

  private async withClientQuery<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    const client = await this.pool.connect();
    try { return await client.query<R>(text, values); }
    finally { client.release(); }
  }

  private async transaction<T>(work: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 保留原始失败原因 */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
