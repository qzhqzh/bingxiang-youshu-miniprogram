import type { QueryResultRow } from 'pg';
import { ApiError } from '../errors.js';
import { canAssignRole, requirePermission } from '../rbac.js';
import { hashSecret, newId, newOpaqueToken } from '../security.js';
import type {
  Household,
  HouseholdMember,
  HouseholdRole,
  HouseholdSnapshot,
  Invitation,
} from '../types.js';
import { PostgresMutationContext, type PgClientLike, type PgPoolLike } from './mutation-executor.js';
import { PostgresQueryStore } from './query-store.js';

export interface PostgresHouseholdServiceOptions {
  now?: () => number;
  maxHouseholdsPerUser?: number;
  maxMembersPerHousehold?: number;
  invitationTtlMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

interface HouseholdRow extends QueryResultRow {
  id: string;
  name: string;
  timezone: string;
  owner_user_id: string;
  status: Household['status'];
  version: string | number;
  created_at: Date | string;
  deleted_at: Date | string | null;
}

interface MemberRow extends QueryResultRow {
  household_id: string;
  user_id: string;
  role: HouseholdRole;
  status: HouseholdMember['status'];
  joined_at: Date | string;
  version: string | number;
  display_name?: string;
}

interface InvitationRow extends QueryResultRow {
  id: string;
  household_id: string;
  role: Exclude<HouseholdRole, 'owner'>;
  expires_at: Date | string;
  max_uses: string | number;
  used_count: string | number;
  created_by: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
}

interface CountRow extends QueryResultRow { count: string | number }

function timestamp(value: Date | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('数据库返回了无效时间');
  return parsed;
}

function householdFromRow(row: HouseholdRow): Household {
  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    ownerUserId: row.owner_user_id,
    status: row.status,
    version: Number(row.version),
    createdAt: timestamp(row.created_at)!,
    ...(row.deleted_at ? { deletedAt: timestamp(row.deleted_at)! } : {}),
  };
}

function memberFromRow(row: MemberRow): HouseholdMember {
  return {
    householdId: row.household_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    joinedAt: timestamp(row.joined_at)!,
    version: Number(row.version),
    ...(row.display_name ? { displayName: row.display_name } : {}),
  };
}

function invitationFromRow(row: InvitationRow): Omit<Invitation, 'tokenHash'> {
  return {
    id: row.id,
    householdId: row.household_id,
    role: row.role,
    expiresAt: timestamp(row.expires_at)!,
    maxUses: Number(row.max_uses),
    usedCount: Number(row.used_count),
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at)!,
    ...(row.revoked_at ? { revokedAt: timestamp(row.revoked_at)! } : {}),
  };
}

function normalizeName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 30) {
    throw new ApiError('VALIDATION_ERROR', '家庭名称应为 1–30 个字符', 400);
  }
  return normalized;
}

function normalizeTimezone(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) {
    throw new ApiError('VALIDATION_ERROR', '时区不能为空且不能超过 64 个字符', 400);
  }
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: normalized }).format(0);
  } catch {
    throw new ApiError('VALIDATION_ERROR', '时区不是有效的 IANA 时区', 400);
  }
  return normalized;
}

function validateInviteRole(role: HouseholdRole): asserts role is Exclude<HouseholdRole, 'owner'> {
  if (role !== 'admin' && role !== 'member' && role !== 'viewer') {
    throw new ApiError('VALIDATION_ERROR', '邀请角色无效', 400);
  }
}

/** PostgreSQL 家庭、成员与邀请服务。所有授权判断都在写事务内重新读取。 */
export class PostgresHouseholdService {
  private readonly now: () => number;
  private readonly maxHouseholdsPerUser: number;
  private readonly maxMembersPerHousehold: number;
  private readonly invitationTtlMs: number;
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly queryStore: PostgresQueryStore;

  constructor(private readonly pool: PgPoolLike, options: PostgresHouseholdServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxHouseholdsPerUser = options.maxHouseholdsPerUser ?? 5;
    this.maxMembersPerHousehold = options.maxMembersPerHousehold ?? 10;
    this.invitationTtlMs = options.invitationTtlMs ?? 72 * 60 * 60 * 1_000;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 8_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.queryStore = PostgresQueryStore.fromPool(pool, { now: this.now });
  }

  async listHouseholds(accessToken: string): Promise<Household[]> {
    const principal = await this.queryStore.authenticate(accessToken);
    return this.queryStore.listHouseholds(principal.user.id);
  }

  async bootstrap(accessToken: string, householdId: string): Promise<HouseholdSnapshot> {
    const principal = await this.queryStore.authenticate(accessToken);
    return this.queryStore.bootstrap(householdId, principal.user.id);
  }

  async createHousehold(accessToken: string, name: string, timezone = 'Asia/Shanghai'): Promise<Household> {
    const principal = await this.queryStore.authenticate(accessToken);
    const normalizedName = normalizeName(name);
    const normalizedTimezone = normalizeTimezone(timezone);
    return this.transaction(async (client) => {
      await this.lock(client, `user-households:${principal.user.id}`);
      const count = await client.query<CountRow>(
        `SELECT count(*)::int AS count
         FROM household_members m JOIN households h ON h.id = m.household_id
         WHERE m.user_id = $1 AND m.status = 'active' AND h.status = 'active'`,
        [principal.user.id],
      );
      if (Number(count.rows[0]?.count ?? 0) >= this.maxHouseholdsPerUser) {
        throw new ApiError('VALIDATION_ERROR', '已达到可加入家庭数量上限', 400);
      }
      const now = this.now();
      const household: Household = {
        id: newId('hh'),
        name: normalizedName,
        timezone: normalizedTimezone,
        ownerUserId: principal.user.id,
        status: 'active',
        version: 1,
        createdAt: now,
      };
      const member: HouseholdMember = {
        householdId: household.id,
        userId: principal.user.id,
        role: 'owner',
        status: 'active',
        joinedAt: now,
        version: 1,
      };
      await client.query(
        `INSERT INTO households (id, name, timezone, owner_user_id, status, version, created_at)
         VALUES ($1, $2, $3, $4, 'active', 1, $5)`,
        [household.id, household.name, household.timezone, principal.user.id, new Date(now)],
      );
      await client.query(
        `INSERT INTO household_members (household_id, user_id, role, status, joined_at, version)
         VALUES ($1, $2, 'owner', 'active', $3, 1)`,
        [household.id, principal.user.id, new Date(now)],
      );
      await client.query(
        'INSERT INTO household_sync_cursors (household_id, current_cursor, minimum_cursor) VALUES ($1, 2, 0)',
        [household.id],
      );
      await client.query(
        `INSERT INTO sync_changes
           (household_id, cursor, entity_type, entity_id, operation, version, payload, server_time)
         VALUES
           ($1, 1, 'household', $1, 'upsert', 1, $2::jsonb, $4),
           ($1, 2, 'member', $3, 'upsert', 1, $5::jsonb, $4)`,
        [household.id, JSON.stringify(household), member.userId, new Date(now), JSON.stringify(member)],
      );
      await this.audit(client, principal.user.id, household.id, 'household.created', 'household', household.id);
      return household;
    });
  }

  async updateHousehold(
    accessToken: string,
    householdId: string,
    input: { name?: string; timezone?: string },
  ): Promise<Household> {
    const principal = await this.queryStore.authenticate(accessToken);
    return this.transaction(async (client) => {
      await this.lock(client, `household:${householdId}`);
      requirePermission(await this.actorForUpdate(client, householdId, principal.user.id), 'household:settings');
      const current = await this.householdForUpdate(client, householdId);
      const name = input.name === undefined ? current.name : normalizeName(input.name);
      const timezone = input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
      const result = await client.query<HouseholdRow>(
        `UPDATE households SET name = $2, timezone = $3, version = version + 1
         WHERE id = $1 AND status = 'active'
         RETURNING id, name, timezone, owner_user_id, status, version, created_at, deleted_at`,
        [householdId, name, timezone],
      );
      const next = householdFromRow(result.rows[0]!);
      await new PostgresMutationContext(client, householdId, this.now).appendChange({
        entityType: 'household', entityId: householdId, operation: 'upsert', version: next.version, payload: next,
      });
      await this.audit(client, principal.user.id, householdId, 'household.updated', 'household', householdId);
      return next;
    });
  }

  async createInvitation(
    accessToken: string,
    householdId: string,
    role: Exclude<HouseholdRole, 'owner'> = 'member',
    maxUses = 1,
  ): Promise<{ token: string; invitation: Omit<Invitation, 'tokenHash'> }> {
    const principal = await this.queryStore.authenticate(accessToken);
    validateInviteRole(role);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) {
      throw new ApiError('VALIDATION_ERROR', '邀请使用次数应为 1–10', 400);
    }
    return this.transaction(async (client) => {
      await this.lock(client, `household:${householdId}`);
      const actor = requirePermission(
        await this.actorForUpdate(client, householdId, principal.user.id),
        'members:invite',
      );
      if (!canAssignRole(actor.role, role)) {
        throw new ApiError('HOUSEHOLD_FORBIDDEN', '不能邀请为这个角色', 403);
      }
      const now = this.now();
      const token = newOpaqueToken();
      const id = newId('inv');
      const result = await client.query<InvitationRow>(
        `INSERT INTO invitations
           (id, household_id, token_hash, role, expires_at, max_uses, used_count, created_by, created_at)
         VALUES ($1, $2, decode($3, 'hex'), $4, $5, $6, 0, $7, $8)
         RETURNING id, household_id, role, expires_at, max_uses, used_count, created_by, created_at, revoked_at`,
        [id, householdId, hashSecret(token), role, new Date(now + this.invitationTtlMs), maxUses, principal.user.id, new Date(now)],
      );
      await this.audit(client, principal.user.id, householdId, 'invitation.created', 'invitation', id, { role, maxUses });
      return { token, invitation: invitationFromRow(result.rows[0]!) };
    });
  }

  async revokeInvitation(accessToken: string, householdId: string, invitationId: string): Promise<void> {
    const principal = await this.queryStore.authenticate(accessToken);
    await this.transaction(async (client) => {
      await this.lock(client, `household:${householdId}`);
      requirePermission(await this.actorForUpdate(client, householdId, principal.user.id), 'members:invite');
      const result = await client.query(
        `UPDATE invitations SET revoked_at = COALESCE(revoked_at, $3)
         WHERE id = $1 AND household_id = $2
         RETURNING id`,
        [invitationId, householdId, new Date(this.now())],
      );
      if (!result.rowCount) throw new ApiError('NOT_FOUND', '没有找到这个邀请', 404);
      await this.audit(client, principal.user.id, householdId, 'invitation.revoked', 'invitation', invitationId);
    });
  }

  async acceptInvitation(accessToken: string, token: string): Promise<HouseholdMember> {
    const principal = await this.queryStore.authenticate(accessToken);
    const tokenHash = hashSecret(token ?? '');
    return this.transaction(async (client) => {
      await this.lock(client, `invitation:${tokenHash}`);
      const invitationResult = await client.query<InvitationRow>(
        `SELECT id, household_id, role, expires_at, max_uses, used_count, created_by, created_at, revoked_at
         FROM invitations WHERE token_hash = decode($1, 'hex') FOR UPDATE`,
        [tokenHash],
      );
      const invitationRow = invitationResult.rows[0];
      if (!invitationRow) throw new ApiError('NOT_FOUND', '邀请不存在', 404);
      const invitation = invitationFromRow(invitationRow);
      await this.lock(client, `household:${invitation.householdId}`);
      await this.lock(client, `user-households:${principal.user.id}`);
      await this.householdForUpdate(client, invitation.householdId);
      const existing = await this.memberForUpdate(client, invitation.householdId, principal.user.id);
      if (existing?.status === 'active') return existing;
      if (invitation.revokedAt) throw new ApiError('CONFLICT', '邀请已被撤销', 409);
      if (invitation.expiresAt <= this.now()) throw new ApiError('CONFLICT', '邀请已过期', 409);
      if (invitation.usedCount >= invitation.maxUses) throw new ApiError('CONFLICT', '邀请使用次数已达上限', 409);

      const householdCount = await client.query<CountRow>(
        `SELECT count(*)::int AS count
         FROM household_members m JOIN households h ON h.id = m.household_id
         WHERE m.user_id = $1 AND m.status = 'active' AND h.status = 'active'`,
        [principal.user.id],
      );
      if (Number(householdCount.rows[0]?.count ?? 0) >= this.maxHouseholdsPerUser) {
        throw new ApiError('VALIDATION_ERROR', '已达到可加入家庭数量上限', 400);
      }
      const memberCount = await client.query<CountRow>(
        `SELECT count(*)::int AS count FROM household_members
         WHERE household_id = $1 AND status = 'active'`,
        [invitation.householdId],
      );
      if (Number(memberCount.rows[0]?.count ?? 0) >= this.maxMembersPerHousehold) {
        throw new ApiError('VALIDATION_ERROR', '这个家庭的成员已满', 400);
      }
      const now = this.now();
      const memberResult = await client.query<MemberRow>(
        `INSERT INTO household_members (household_id, user_id, role, status, joined_at, version)
         VALUES ($1, $2, $3, 'active', $4, 1)
         ON CONFLICT (household_id, user_id) DO UPDATE
           SET role = EXCLUDED.role, status = 'active', joined_at = EXCLUDED.joined_at,
               version = household_members.version + 1
         RETURNING household_id, user_id, role, status, joined_at, version`,
        [invitation.householdId, principal.user.id, invitation.role, new Date(now)],
      );
      const member = memberFromRow(memberResult.rows[0]!);
      await client.query('UPDATE invitations SET used_count = used_count + 1 WHERE id = $1', [invitation.id]);
      await new PostgresMutationContext(client, invitation.householdId, this.now).appendChange({
        entityType: 'member', entityId: member.userId, operation: 'upsert', version: member.version, payload: member,
      });
      await this.audit(
        client, principal.user.id, invitation.householdId, 'invitation.accepted', 'invitation', invitation.id,
      );
      return member;
    });
  }

  async updateMemberRole(
    accessToken: string,
    householdId: string,
    targetUserId: string,
    role: Exclude<HouseholdRole, 'owner'>,
  ): Promise<HouseholdMember> {
    const principal = await this.queryStore.authenticate(accessToken);
    validateInviteRole(role);
    return this.transaction(async (client) => {
      await this.lock(client, `household:${householdId}`);
      const actor = requirePermission(
        await this.actorForUpdate(client, householdId, principal.user.id),
        'members:role',
      );
      const target = await this.memberForUpdate(client, householdId, targetUserId);
      if (!target || target.status !== 'active') throw new ApiError('NOT_FOUND', '没有找到这个家庭成员', 404);
      if (target.role === 'owner' || !canAssignRole(actor.role, role)) {
        throw new ApiError('HOUSEHOLD_FORBIDDEN', '不能调整为这个角色', 403);
      }
      const result = await client.query<MemberRow>(
        `UPDATE household_members SET role = $3, version = version + 1
         WHERE household_id = $1 AND user_id = $2 AND status = 'active'
         RETURNING household_id, user_id, role, status, joined_at, version`,
        [householdId, targetUserId, role],
      );
      const next = memberFromRow(result.rows[0]!);
      await new PostgresMutationContext(client, householdId, this.now).appendChange({
        entityType: 'member', entityId: targetUserId, operation: 'upsert', version: next.version, payload: next,
      });
      await this.audit(client, principal.user.id, householdId, 'member.role_updated', 'member', targetUserId, { role });
      return next;
    });
  }

  async removeMember(accessToken: string, householdId: string, targetUserId: string): Promise<void> {
    const principal = await this.queryStore.authenticate(accessToken);
    await this.transaction(async (client) => {
      await this.lock(client, `household:${householdId}`);
      const actor = requirePermission(
        await this.actorForUpdate(client, householdId, principal.user.id),
        'members:remove',
      );
      const target = await this.memberForUpdate(client, householdId, targetUserId);
      if (!target || target.status !== 'active') throw new ApiError('NOT_FOUND', '没有找到这个家庭成员', 404);
      if (target.role === 'owner') throw new ApiError('HOUSEHOLD_FORBIDDEN', '不能移除家庭所有者', 403);
      if (actor.role !== 'owner' && target.role !== 'member' && target.role !== 'viewer') {
        throw new ApiError('HOUSEHOLD_FORBIDDEN', '管理员只能移除普通成员或访客', 403);
      }
      const result = await client.query<MemberRow>(
        `UPDATE household_members SET status = 'removed', version = version + 1
         WHERE household_id = $1 AND user_id = $2 AND status = 'active'
         RETURNING household_id, user_id, role, status, joined_at, version`,
        [householdId, targetUserId],
      );
      const next = memberFromRow(result.rows[0]!);
      await new PostgresMutationContext(client, householdId, this.now).appendChange({
        entityType: 'member', entityId: targetUserId, operation: 'delete', version: next.version,
        payload: { userId: targetUserId },
      });
      await this.audit(client, principal.user.id, householdId, 'member.removed', 'member', targetUserId);
    });
  }

  async transferOwnership(accessToken: string, householdId: string, targetUserId: string): Promise<Household> {
    const principal = await this.queryStore.authenticate(accessToken);
    if (targetUserId === principal.user.id) {
      throw new ApiError('VALIDATION_ERROR', '新所有者不能是当前所有者本人', 400);
    }
    return this.transaction(async (client) => {
      await this.lock(client, `household:${householdId}`);
      const actor = requirePermission(
        await this.actorForUpdate(client, householdId, principal.user.id),
        'household:transfer',
      );
      const target = await this.memberForUpdate(client, householdId, targetUserId);
      if (actor.role !== 'owner' || !target || target.status !== 'active') {
        throw new ApiError('HOUSEHOLD_FORBIDDEN', '只能把所有权转给有效家庭成员', 403);
      }
      const current = await this.householdForUpdate(client, householdId);
      const oldOwnerResult = await client.query<MemberRow>(
        `UPDATE household_members SET role = 'admin', version = version + 1
         WHERE household_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'
         RETURNING household_id, user_id, role, status, joined_at, version`,
        [householdId, actor.userId],
      );
      const oldOwner = memberFromRow(oldOwnerResult.rows[0]!);
      const newOwnerResult = await client.query<MemberRow>(
        `UPDATE household_members SET role = 'owner', version = version + 1
         WHERE household_id = $1 AND user_id = $2 AND status = 'active'
         RETURNING household_id, user_id, role, status, joined_at, version`,
        [householdId, targetUserId],
      );
      const newOwner = memberFromRow(newOwnerResult.rows[0]!);
      const householdResult = await client.query<HouseholdRow>(
        `UPDATE households SET owner_user_id = $2, version = version + 1
         WHERE id = $1 AND status = 'active'
         RETURNING id, name, timezone, owner_user_id, status, version, created_at, deleted_at`,
        [householdId, targetUserId],
      );
      const nextHousehold = householdFromRow(householdResult.rows[0]!);
      const changes = new PostgresMutationContext(client, householdId, this.now);
      await changes.appendChange({
        entityType: 'household', entityId: householdId, operation: 'upsert',
        version: nextHousehold.version, payload: nextHousehold,
      });
      await changes.appendChange({
        entityType: 'member', entityId: oldOwner.userId, operation: 'upsert', version: oldOwner.version, payload: oldOwner,
      });
      await changes.appendChange({
        entityType: 'member', entityId: newOwner.userId, operation: 'upsert', version: newOwner.version, payload: newOwner,
      });
      await this.audit(client, principal.user.id, householdId, 'household.ownership_transferred', 'member', targetUserId, {
        previousOwnerUserId: current.ownerUserId,
      });
      return nextHousehold;
    });
  }

  private async actorForUpdate(client: PgClientLike, householdId: string, userId: string): Promise<HouseholdMember | undefined> {
    const result = await client.query<MemberRow>(
      `SELECT m.household_id, m.user_id, m.role, m.status, m.joined_at, m.version
       FROM household_members m JOIN households h ON h.id = m.household_id
       WHERE m.household_id = $1 AND m.user_id = $2 AND m.status = 'active' AND h.status = 'active'
       FOR UPDATE OF m`,
      [householdId, userId],
    );
    return result.rows[0] ? memberFromRow(result.rows[0]) : undefined;
  }

  private async memberForUpdate(client: PgClientLike, householdId: string, userId: string): Promise<HouseholdMember | undefined> {
    const result = await client.query<MemberRow>(
      `SELECT household_id, user_id, role, status, joined_at, version
       FROM household_members WHERE household_id = $1 AND user_id = $2 FOR UPDATE`,
      [householdId, userId],
    );
    return result.rows[0] ? memberFromRow(result.rows[0]) : undefined;
  }

  private async householdForUpdate(client: PgClientLike, householdId: string): Promise<Household> {
    const result = await client.query<HouseholdRow>(
      `SELECT id, name, timezone, owner_user_id, status, version, created_at, deleted_at
       FROM households WHERE id = $1 AND status = 'active' FOR UPDATE`,
      [householdId],
    );
    if (!result.rows[0]) throw new ApiError('NOT_FOUND', '家庭空间不存在', 404);
    return householdFromRow(result.rows[0]);
  }

  private async lock(client: PgClientLike, key: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }

  private async audit(
    client: PgClientLike,
    actorUserId: string,
    householdId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs
         (actor_user_id, household_id, action, target_type, target_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [actorUserId, householdId, action, targetType, targetId, JSON.stringify(metadata), new Date(this.now())],
    );
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
