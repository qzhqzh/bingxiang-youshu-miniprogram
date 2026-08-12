import { completeCooking, parseDateOnly, previewCooking, refreshRecipeProgress, unlockRecipe } from '../../miniprogram/domain/rules.js';
import { seedIngredients } from '../../miniprogram/data/ingredients.js';
import { seedRecipes } from '../../miniprogram/data/recipes.js';
import { validateImportJson } from '../../miniprogram/services/data-transfer.js';
import type { AppSettings, PantryBatch, RecipeProgress } from '../../miniprogram/domain/models.js';
import { ApiError, assertApi } from './errors.js';
import { requirePermission, canAssignRole } from './rbac.js';
import { checksum, hashSecret, newId, newOpaqueToken } from './security.js';
import { InMemoryV2Store } from './store.js';
import type {
  AccountDeletionRequest,
  AuditLog,
  DataExportArtifact,
  Household,
  HouseholdMember,
  HouseholdRole,
  HouseholdSnapshot,
  Invitation,
  InventoryMovement,
  LoginResult,
  MemberPreferences,
  MigrationSummary,
  Permission,
  PushResult,
  ServerCookingRecord,
  ServerPantryBatch,
  ServerRecipeProgress,
  ServerShoppingItem,
  SessionPrincipal,
  SyncCommand,
  User,
} from './types.js';
import type { WechatIdentityProvider } from './wechat.js';

export interface V2ServiceOptions {
  appId: string;
  sessionTtlMs?: number;
  catalogVersion?: number;
  now?: () => number;
  deletionCoolingMs?: number;
  dataExportTtlMs?: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  freshnessReminderDays: 3,
  defaultStorageMode: 'chilled',
  favoriteRecipeIds: [],
};

const commandPermission: Record<SyncCommand['command'], Permission> = {
  PurchaseBatch: 'inventory:write',
  CompleteCooking: 'cooking:write',
  AddShoppingItem: 'shopping:write',
  CheckShoppingItem: 'shopping:write',
  RemoveShoppingItem: 'shopping:write',
  DiscardBatch: 'inventory:write',
  UnlockRecipe: 'cooking:write',
  UpdatePreferences: 'household:read',
};

export class V2Service {
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly catalogVersion: number;
  private readonly deletionCoolingMs: number;
  private readonly dataExportTtlMs: number;

  constructor(
    readonly store: InMemoryV2Store,
    private readonly wechat: WechatIdentityProvider,
    private readonly options: V2ServiceOptions,
  ) {
    assertApi(Boolean(options.appId), 'VALIDATION_ERROR', '服务端 AppID 未配置');
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? 2 * 60 * 60 * 1_000;
    this.catalogVersion = options.catalogVersion ?? 1;
    this.deletionCoolingMs = options.deletionCoolingMs ?? 7 * 24 * 60 * 60 * 1_000;
    this.dataExportTtlMs = options.dataExportTtlMs ?? 24 * 60 * 60 * 1_000;
  }

  async loginWechat(code: string, deviceId: string): Promise<LoginResult> {
    assertApi(Boolean(deviceId?.trim()), 'VALIDATION_ERROR', '缺少设备 ID');
    const identity = await this.wechat.exchange(code);
    const identityKey = this.store.identityKey(this.options.appId, identity.providerSubject);
    let authIdentity = this.store.identities.get(identityKey);
    let user: User;
    const now = this.now();
    if (authIdentity) {
      user = this.requireActiveUser(authIdentity.userId);
    } else {
      user = {
        id: newId('usr'),
        displayName: `家庭成员 ${this.store.users.size + 1}`,
        status: 'active',
        createdAt: now,
      };
      authIdentity = {
        userId: user.id,
        provider: 'wechat-miniprogram',
        appId: this.options.appId,
        providerSubject: identity.providerSubject,
        createdAt: now,
      };
      this.store.users.set(user.id, user);
      this.store.identities.set(identityKey, authIdentity);
      this.createHouseholdFor(user, '我的冰箱', 'Asia/Shanghai', now);
    }

    const accessToken = newOpaqueToken();
    const session = {
      id: newId('ses'),
      userId: user.id,
      deviceIdHash: hashSecret(deviceId),
      tokenHash: hashSecret(accessToken),
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
      lastSeenAt: now,
    };
    this.store.sessions.set(session.id, session);
    return {
      accessToken,
      expiresAt: session.expiresAt,
      user,
      households: this.householdsFor(user.id),
    };
  }

  authenticate(accessToken: string): SessionPrincipal {
    const principal = this.authenticateForLifecycle(accessToken);
    if (principal.user.status !== 'active') throw new ApiError('UNAUTHENTICATED', '账号正在注销或已不可用', 401);
    return principal;
  }

  private authenticateForLifecycle(accessToken: string): SessionPrincipal {
    const tokenHash = hashSecret(accessToken ?? '');
    const session = [...this.store.sessions.values()].find((item) => item.tokenHash === tokenHash);
    if (!session) throw new ApiError('UNAUTHENTICATED', '登录状态无效', 401);
    if (session.revokedAt) throw new ApiError('SESSION_REVOKED', '当前设备会话已撤销', 401);
    if (session.expiresAt <= this.now()) throw new ApiError('UNAUTHENTICATED', '登录状态已过期', 401);
    const user = this.store.users.get(session.userId);
    if (!user || (user.status !== 'active' && user.status !== 'deletionPending')) {
      throw new ApiError('UNAUTHENTICATED', '账号不可用', 401);
    }
    session.lastSeenAt = this.now();
    this.store.sessions.set(session.id, session);
    return { user, session };
  }

  logout(accessToken: string): void {
    const principal = this.authenticate(accessToken);
    this.store.sessions.set(principal.session.id, { ...principal.session, revokedAt: this.now() });
  }

  listSessions(accessToken: string) {
    const principal = this.authenticate(accessToken);
    return [...this.store.sessions.values()]
      .filter((item) => item.userId === principal.user.id)
      .map(({ tokenHash: _tokenHash, deviceIdHash: _deviceIdHash, ...safe }) => safe)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revokeSession(accessToken: string, sessionId: string): void {
    const principal = this.authenticate(accessToken);
    const target = this.store.sessions.get(sessionId);
    assertApi(target && target.userId === principal.user.id, 'NOT_FOUND', '没有找到这个设备会话', 404);
    this.store.sessions.set(target.id, { ...target, revokedAt: this.now() });
  }

  createDataExport(accessToken: string): DataExportArtifact {
    const principal = this.authenticate(accessToken);
    const exportedAt = this.now();
    const sessions = [...this.store.sessions.values()]
      .filter((item) => item.userId === principal.user.id)
      .map(({ tokenHash: _tokenHash, deviceIdHash: _deviceIdHash, ...safe }) => safe)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    const households = this.store.activeMemberships(principal.user.id).map((membership) => {
      const household = this.requireHousehold(membership.householdId);
      const members = this.store.activeMembers(household.id).map((member) => ({
        userId: member.userId,
        role: member.role,
        status: member.status,
        joinedAt: member.joinedAt,
        version: member.version,
        displayName: this.store.users.get(member.userId)?.displayName ?? '已注销成员',
      }));
      return {
        scope: membership.role === 'owner' ? 'owner-full' as const : 'member-readable' as const,
        household,
        membership,
        members,
        batches: [...this.store.batches.values()].filter((item) => item.householdId === household.id && !item.deletedAt),
        movements: [...this.store.movements.values()].filter((item) => item.householdId === household.id),
        shoppingItems: [...this.store.shoppingItems.values()].filter((item) => item.householdId === household.id && !item.deletedAt),
        cookingRecords: [...this.store.cookingRecords.values()].filter((item) => item.householdId === household.id),
        recipeProgress: this.progressFor(household.id, principal.user.id).map((item) => this.asServerProgress(household.id, principal.user.id, item)),
        preferences: this.preferencesFor(household.id, principal.user.id),
      };
    });
    const payload: DataExportArtifact['payload'] = {
      format: 'bingxiang-v2-user-export',
      exportedAt,
      user: principal.user,
      sessions,
      households,
      exclusions: [
        '微信 providerSubject 与认证 code',
        '会话 token、设备指纹和邀请口令/哈希',
        '其他成员的个人食谱进度与偏好',
        '运营审计元数据与服务端密钥',
      ],
    };
    const artifact: DataExportArtifact = {
      id: newId('exp'),
      userId: principal.user.id,
      status: 'ready',
      createdAt: exportedAt,
      expiresAt: exportedAt + this.dataExportTtlMs,
      checksum: checksum(JSON.stringify(payload)),
      payload,
    };
    this.store.dataExports.set(artifact.id, artifact);
    this.audit('user.export.created', principal.user.id, 'dataExport', artifact.id, {
      householdCount: households.length,
      expiresAt: artifact.expiresAt,
    });
    return artifact;
  }

  requestAccountDeletion(accessToken: string, confirmation: string): AccountDeletionRequest {
    const principal = this.authenticate(accessToken);
    assertApi(confirmation === '注销账号', 'VALIDATION_ERROR', '请完整输入“注销账号”确认');
    const existing = [...this.store.deletionRequests.values()]
      .find((item) => item.userId === principal.user.id && item.status === 'pending');
    if (existing) return existing;
    const ownedHouseholdIds = this.householdsFor(principal.user.id)
      .filter((item) => item.ownerUserId === principal.user.id)
      .map((item) => item.id);
    assertApi(ownedHouseholdIds.length === 0, 'CONFLICT', '请先转移或删除你拥有的家庭', 409, { ownedHouseholdIds });
    const requestedAt = this.now();
    const request: AccountDeletionRequest = {
      id: newId('del'),
      userId: principal.user.id,
      status: 'pending',
      requestedAt,
      executeAfter: requestedAt + this.deletionCoolingMs,
      restrictedSessionId: principal.session.id,
    };
    this.store.deletionRequests.set(request.id, request);
    this.store.users.set(principal.user.id, { ...principal.user, status: 'deletionPending' });
    for (const session of this.store.sessions.values()) {
      if (session.id === principal.session.id) {
        this.store.sessions.set(session.id, { ...session, expiresAt: Math.max(session.expiresAt, request.executeAfter) });
      } else if (session.userId === principal.user.id && !session.revokedAt) {
        this.store.sessions.set(session.id, { ...session, revokedAt: requestedAt });
      }
    }
    this.audit('user.deletion.requested', principal.user.id, 'user', principal.user.id, {
      requestId: request.id,
      executeAfter: request.executeAfter,
    });
    return request;
  }

  accountDeletionStatus(accessToken: string): AccountDeletionRequest {
    const principal = this.authenticateForLifecycle(accessToken);
    const request = [...this.store.deletionRequests.values()]
      .filter((item) => item.userId === principal.user.id)
      .sort((left, right) => right.requestedAt - left.requestedAt)[0];
    assertApi(request, 'NOT_FOUND', '没有账号注销申请', 404);
    return request;
  }

  cancelAccountDeletion(accessToken: string): AccountDeletionRequest {
    const principal = this.authenticateForLifecycle(accessToken);
    const request = this.accountDeletionStatus(accessToken);
    assertApi(request.status === 'pending', 'CONFLICT', '当前注销申请不能取消', 409);
    assertApi(request.executeAfter > this.now(), 'CONFLICT', '注销申请已进入执行阶段', 409);
    const next: AccountDeletionRequest = { ...request, status: 'cancelled', cancelledAt: this.now() };
    this.store.deletionRequests.set(next.id, next);
    this.store.users.set(principal.user.id, { ...principal.user, status: 'active' });
    this.audit('user.deletion.cancelled', principal.user.id, 'user', principal.user.id, { requestId: next.id });
    return next;
  }

  /** 由受控后台任务调用；共享库存/做菜事实保留，身份映射与个人状态被删除或匿名化。 */
  executeDueAccountDeletions(at = this.now()): AccountDeletionRequest[] {
    const completed: AccountDeletionRequest[] = [];
    for (const request of this.store.deletionRequests.values()) {
      if (request.status !== 'pending' || request.executeAfter > at) continue;
      const owned = [...this.store.households.values()].filter((item) => item.status === 'active' && item.ownerUserId === request.userId);
      if (owned.length > 0) {
        const blocked: AccountDeletionRequest = { ...request, status: 'blocked', blockedReason: 'OWNED_HOUSEHOLD_REMAINS' };
        this.store.deletionRequests.set(blocked.id, blocked);
        completed.push(blocked);
        continue;
      }
      for (const membership of this.store.activeMemberships(request.userId)) {
        const removed: HouseholdMember = { ...membership, status: 'removed', version: membership.version + 1 };
        this.store.members.set(this.store.memberKey(membership.householdId, request.userId), removed);
        this.store.appendChange(membership.householdId, 'member', request.userId, 'delete', removed.version, {
          userId: request.userId,
          displayName: '已注销成员',
        }, at);
      }
      for (const [key, identity] of this.store.identities) if (identity.userId === request.userId) this.store.identities.delete(key);
      for (const session of this.store.sessions.values()) {
        if (session.userId === request.userId && !session.revokedAt) this.store.sessions.set(session.id, { ...session, revokedAt: at });
      }
      for (const [key, value] of this.store.preferences) if (value.userId === request.userId) this.store.preferences.delete(key);
      for (const [key, value] of this.store.recipeProgress) if (value.userId === request.userId) this.store.recipeProgress.delete(key);
      for (const [key, artifact] of this.store.dataExports) {
        if (artifact.userId === request.userId) this.store.dataExports.set(key, { ...artifact, status: 'expired' });
      }
      const user = this.store.users.get(request.userId);
      if (user) this.store.users.set(user.id, { ...user, displayName: '已注销成员', status: 'deleted', deletedAt: at });
      const next: AccountDeletionRequest = { ...request, status: 'completed', completedAt: at };
      this.store.deletionRequests.set(next.id, next);
      this.audit('user.deletion.completed', request.userId, 'user', request.userId, { requestId: next.id });
      completed.push(next);
    }
    return completed;
  }

  me(accessToken: string): User {
    return this.authenticate(accessToken).user;
  }

  updateProfile(accessToken: string, displayName: string): User {
    const principal = this.authenticate(accessToken);
    const normalized = displayName.trim();
    assertApi(normalized.length >= 1 && normalized.length <= 30, 'VALIDATION_ERROR', '显示名称应为 1–30 个字符');
    const user = { ...principal.user, displayName: normalized };
    this.store.users.set(user.id, user);
    return user;
  }

  listHouseholds(accessToken: string): Household[] {
    return this.householdsFor(this.authenticate(accessToken).user.id);
  }

  createHousehold(accessToken: string, name: string, timezone = 'Asia/Shanghai'): Household {
    const principal = this.authenticate(accessToken);
    assertApi(this.store.activeMemberships(principal.user.id).length < this.store.limits.maxHouseholdsPerUser, 'VALIDATION_ERROR', '已达到可加入家庭数量上限');
    return this.createHouseholdFor(principal.user, name, timezone, this.now());
  }

  updateHousehold(accessToken: string, householdId: string, input: { name?: string; timezone?: string }): Household {
    const principal = this.authenticate(accessToken);
    const member = this.memberFor(householdId, principal.user.id);
    requirePermission(member, 'household:settings');
    const household = this.requireHousehold(householdId);
    const name = input.name?.trim() || household.name;
    const timezone = input.timezone?.trim() || household.timezone;
    assertApi(name.length <= 30, 'VALIDATION_ERROR', '家庭名称不能超过 30 个字符');
    const next = { ...household, name, timezone, version: household.version + 1 };
    this.store.households.set(householdId, next);
    this.store.appendChange(householdId, 'household', householdId, 'upsert', next.version, next, this.now());
    return next;
  }

  createInvitation(
    accessToken: string,
    householdId: string,
    role: Exclude<HouseholdRole, 'owner'> = 'member',
    maxUses = 1,
  ): { token: string; invitation: Omit<Invitation, 'tokenHash'> } {
    const principal = this.authenticate(accessToken);
    const member = requirePermission(this.memberFor(householdId, principal.user.id), 'members:invite');
    assertApi(canAssignRole(member.role, role), 'HOUSEHOLD_FORBIDDEN', '不能邀请为这个角色', 403);
    assertApi(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 10, 'VALIDATION_ERROR', '邀请使用次数应为 1–10');
    const token = newOpaqueToken();
    const now = this.now();
    const invitation: Invitation = {
      id: newId('inv'),
      householdId,
      tokenHash: hashSecret(token),
      role,
      expiresAt: now + this.store.limits.invitationTtlMs,
      maxUses,
      usedCount: 0,
      createdBy: principal.user.id,
      createdAt: now,
    };
    this.store.invitations.set(invitation.id, invitation);
    const { tokenHash: _tokenHash, ...safe } = invitation;
    return { token, invitation: safe };
  }

  revokeInvitation(accessToken: string, householdId: string, invitationId: string): void {
    const principal = this.authenticate(accessToken);
    requirePermission(this.memberFor(householdId, principal.user.id), 'members:invite');
    const invitation = this.store.invitations.get(invitationId);
    assertApi(invitation && invitation.householdId === householdId, 'NOT_FOUND', '没有找到这个邀请', 404);
    this.store.invitations.set(invitation.id, { ...invitation, revokedAt: this.now() });
  }

  acceptInvitation(accessToken: string, token: string): HouseholdMember {
    const principal = this.authenticate(accessToken);
    const tokenHash = hashSecret(token);
    const invitation = [...this.store.invitations.values()].find((item) => item.tokenHash === tokenHash);
    assertApi(invitation, 'NOT_FOUND', '邀请不存在', 404);
    const existing = this.memberFor(invitation.householdId, principal.user.id);
    if (existing?.status === 'active') return existing;
    assertApi(!invitation.revokedAt, 'CONFLICT', '邀请已被撤销', 409);
    assertApi(invitation.expiresAt > this.now(), 'CONFLICT', '邀请已过期', 409);
    assertApi(invitation.usedCount < invitation.maxUses, 'CONFLICT', '邀请使用次数已达上限', 409);
    assertApi(this.store.activeMemberships(principal.user.id).length < this.store.limits.maxHouseholdsPerUser, 'VALIDATION_ERROR', '已达到可加入家庭数量上限');
    assertApi(this.store.activeMembers(invitation.householdId).length < this.store.limits.maxMembersPerHousehold, 'VALIDATION_ERROR', '这个家庭的成员已满');
    const member: HouseholdMember = {
      householdId: invitation.householdId,
      userId: principal.user.id,
      role: invitation.role,
      status: 'active',
      joinedAt: this.now(),
      version: (existing?.version ?? 0) + 1,
    };
    this.store.members.set(this.store.memberKey(member.householdId, member.userId), member);
    this.store.invitations.set(invitation.id, { ...invitation, usedCount: invitation.usedCount + 1 });
    this.store.appendChange(member.householdId, 'member', member.userId, 'upsert', member.version, member, this.now());
    return member;
  }

  updateMemberRole(accessToken: string, householdId: string, targetUserId: string, role: Exclude<HouseholdRole, 'owner'>): HouseholdMember {
    const principal = this.authenticate(accessToken);
    const actor = requirePermission(this.memberFor(householdId, principal.user.id), 'members:role');
    const target = this.memberFor(householdId, targetUserId);
    assertApi(target?.status === 'active', 'NOT_FOUND', '没有找到这个家庭成员', 404);
    assertApi(target.role !== 'owner' && canAssignRole(actor.role, role), 'HOUSEHOLD_FORBIDDEN', '不能调整为这个角色', 403);
    const next = { ...target, role, version: target.version + 1 };
    this.store.members.set(this.store.memberKey(householdId, targetUserId), next);
    this.store.appendChange(householdId, 'member', targetUserId, 'upsert', next.version, next, this.now());
    return next;
  }

  removeMember(accessToken: string, householdId: string, targetUserId: string): void {
    const principal = this.authenticate(accessToken);
    const actor = requirePermission(this.memberFor(householdId, principal.user.id), 'members:remove');
    const target = this.memberFor(householdId, targetUserId);
    assertApi(target?.status === 'active', 'NOT_FOUND', '没有找到这个家庭成员', 404);
    assertApi(target.role !== 'owner', 'HOUSEHOLD_FORBIDDEN', '不能移除家庭所有者', 403);
    assertApi(actor.role === 'owner' || target.role === 'member' || target.role === 'viewer', 'HOUSEHOLD_FORBIDDEN', '管理员只能移除普通成员或访客', 403);
    const next: HouseholdMember = { ...target, status: 'removed', version: target.version + 1 };
    this.store.members.set(this.store.memberKey(householdId, targetUserId), next);
    this.store.appendChange(householdId, 'member', targetUserId, 'delete', next.version, { userId: targetUserId }, this.now());
  }

  transferOwnership(accessToken: string, householdId: string, targetUserId: string): Household {
    const principal = this.authenticate(accessToken);
    const actor = requirePermission(this.memberFor(householdId, principal.user.id), 'household:transfer');
    const target = this.memberFor(householdId, targetUserId);
    assertApi(actor.role === 'owner' && target?.status === 'active', 'HOUSEHOLD_FORBIDDEN', '只能把所有权转给有效家庭成员', 403);
    const household = this.requireHousehold(householdId);
    const now = this.now();
    const nextHousehold = { ...household, ownerUserId: targetUserId, version: household.version + 1 };
    const oldOwner: HouseholdMember = { ...actor, role: 'admin', version: actor.version + 1 };
    const newOwner: HouseholdMember = { ...target, role: 'owner', version: target.version + 1 };
    this.store.households.set(householdId, nextHousehold);
    this.store.members.set(this.store.memberKey(householdId, actor.userId), oldOwner);
    this.store.members.set(this.store.memberKey(householdId, target.userId), newOwner);
    this.store.appendChange(householdId, 'household', householdId, 'upsert', nextHousehold.version, nextHousehold, now);
    this.store.appendChange(householdId, 'member', oldOwner.userId, 'upsert', oldOwner.version, oldOwner, now);
    this.store.appendChange(householdId, 'member', newOwner.userId, 'upsert', newOwner.version, newOwner, now);
    return nextHousehold;
  }

  bootstrap(accessToken: string, householdId: string): HouseholdSnapshot {
    const principal = this.authenticate(accessToken);
    requirePermission(this.memberFor(householdId, principal.user.id), 'household:read');
    const household = this.requireHousehold(householdId);
    const preferences = this.preferencesFor(householdId, principal.user.id);
    return {
      household,
      members: this.store.activeMembers(householdId).map((member) => ({
        ...member,
        displayName: this.requireActiveUser(member.userId).displayName,
      })),
      batches: [...this.store.batches.values()].filter((item) => item.householdId === householdId && !item.deletedAt),
      movements: [...this.store.movements.values()].filter((item) => item.householdId === householdId),
      shoppingItems: [...this.store.shoppingItems.values()].filter((item) => item.householdId === householdId && !item.deletedAt),
      cookingRecords: [...this.store.cookingRecords.values()].filter((item) => item.householdId === householdId),
      recipeProgress: this.progressFor(householdId, principal.user.id).map((item) => this.asServerProgress(householdId, principal.user.id, item)),
      preferences,
      cursor: this.store.currentCursor(householdId),
      catalogVersion: this.catalogVersion,
    };
  }

  async push(accessToken: string, command: SyncCommand): Promise<PushResult> {
    const principal = this.authenticate(accessToken);
    this.validateCommand(command);
    this.requireCommandMember(command.householdId, principal.user.id, commandPermission[command.command]);
    const previous = this.store.processedMutations.get(this.store.mutationKey(principal.user.id, command.mutationId));
    if (previous) {
      assertApi(previous.householdId === command.householdId, 'MUTATION_REJECTED', 'mutationId 已用于其他家庭', 409);
      return { ...previous.result, replayed: true };
    }
    return this.store.runHouseholdExclusive(command.householdId, async () => {
      this.requireCommandMember(command.householdId, principal.user.id, commandPermission[command.command]);
      const repeated = this.store.processedMutations.get(this.store.mutationKey(principal.user.id, command.mutationId));
      if (repeated) return { ...repeated.result, replayed: true };
      const canonical = this.applyCommand(principal.user.id, command);
      const result: PushResult = {
        mutationId: command.mutationId,
        accepted: true,
        replayed: false,
        cursor: this.store.currentCursor(command.householdId),
        canonical,
      };
      this.store.processedMutations.set(this.store.mutationKey(principal.user.id, command.mutationId), {
        userId: principal.user.id,
        mutationId: command.mutationId,
        householdId: command.householdId,
        result,
        processedAt: this.now(),
      });
      return result;
    });
  }

  pull(accessToken: string, householdId: string, cursor: number, limit?: number) {
    const principal = this.authenticate(accessToken);
    requirePermission(this.memberFor(householdId, principal.user.id), 'household:read');
    assertApi(Number.isInteger(cursor) && cursor >= 0, 'VALIDATION_ERROR', '同步 cursor 无效');
    const minimum = this.store.minimumCursors.get(householdId) ?? 0;
    if (cursor < minimum) throw new ApiError('FULL_RESYNC_REQUIRED', '本地游标过旧，需要完整同步', 409, { minimumCursor: minimum });
    const pageSize = Math.min(Math.max(limit ?? this.store.limits.pullPageSize, 1), 500);
    const all = (this.store.changes.get(householdId) ?? []).filter((item) => item.cursor > cursor);
    const changes = all.slice(0, pageSize);
    return {
      changes,
      nextCursor: changes.at(-1)?.cursor ?? cursor,
      hasMore: all.length > changes.length,
      catalogVersion: this.catalogVersion,
    };
  }

  prepareV1Migration(accessToken: string, householdId: string, importBatchId: string, source: string): MigrationSummary {
    const principal = this.authenticate(accessToken);
    requirePermission(this.memberFor(householdId, principal.user.id), 'inventory:write');
    const existing = this.store.migrations.get(this.store.migrationKey(principal.user.id, importBatchId));
    if (existing) return existing;
    const validated = validateImportJson(source);
    const summary: MigrationSummary = {
      importBatchId,
      householdId,
      batchCount: validated.summary.batchCount,
      shoppingItemCount: validated.summary.shoppingItemCount,
      cookingRecordCount: validated.summary.cookingRecordCount,
      progressCount: validated.snapshot.progress.length,
      checksum: checksum(source),
      status: 'prepared',
    };
    this.store.migrations.set(this.store.migrationKey(principal.user.id, importBatchId), summary);
    return summary;
  }

  async commitV1Migration(accessToken: string, householdId: string, importBatchId: string, source: string): Promise<MigrationSummary> {
    const principal = this.authenticate(accessToken);
    requirePermission(this.memberFor(householdId, principal.user.id), 'inventory:write');
    const key = this.store.migrationKey(principal.user.id, importBatchId);
    const prepared = this.store.migrations.get(key);
    assertApi(prepared && prepared.householdId === householdId, 'VALIDATION_ERROR', '请先准备这次迁移');
    if (prepared.status === 'committed') return prepared;
    assertApi(prepared.checksum === checksum(source), 'VALIDATION_ERROR', '迁移数据与准备阶段不一致');
    const validated = validateImportJson(source);
    return this.store.runHouseholdExclusive(householdId, () => {
      const repeated = this.store.migrations.get(key);
      if (repeated?.status === 'committed') return repeated;
      const hasSharedData = [...this.store.batches.values()].some((item) => item.householdId === householdId)
        || [...this.store.shoppingItems.values()].some((item) => item.householdId === householdId)
        || [...this.store.cookingRecords.values()].some((item) => item.householdId === householdId);
      assertApi(!hasSharedData, 'CONFLICT', '目标家庭已有数据，请创建新家庭后迁移', 409);
      const now = this.now();
      const consumedByBatch = new Map<string, number>();
      validated.snapshot.cookingRecords.forEach((record) => record.consumptions.forEach((item) => {
        consumedByBatch.set(item.pantryBatchId, (consumedByBatch.get(item.pantryBatchId) ?? 0) + item.quantity);
      }));
      validated.snapshot.batches.forEach((batch) => {
        const originalQuantity = batch.quantity + (consumedByBatch.get(batch.id) ?? 0);
        const serverBatch: ServerPantryBatch = {
          ...batch,
          householdId,
          originalQuantity,
          version: 1,
          createdBy: principal.user.id,
        };
        this.store.batches.set(serverBatch.id, serverBatch);
        const movement: InventoryMovement = {
          id: newId('mov'),
          householdId,
          pantryBatchId: serverBatch.id,
          ingredientId: serverBatch.ingredientId,
          type: 'purchase',
          quantityDelta: originalQuantity,
          unit: serverBatch.unit,
          actorUserId: principal.user.id,
          sourceMutationId: importBatchId,
          occurredAt: batch.createdAt,
        };
        this.store.movements.set(movement.id, movement);
        this.store.appendChange(householdId, 'pantryBatch', serverBatch.id, 'upsert', 1, serverBatch, now);
      });
      validated.snapshot.cookingRecords.forEach((record) => {
        const serverRecord: ServerCookingRecord = {
          ...record,
          householdId,
          actorUserId: principal.user.id,
          mutationId: importBatchId,
          version: 1,
        };
        this.store.cookingRecords.set(serverRecord.id, serverRecord);
        record.consumptions.forEach((item) => {
          const movement: InventoryMovement = {
            id: newId('mov'),
            householdId,
            pantryBatchId: item.pantryBatchId,
            ingredientId: item.ingredientId,
            type: 'cook_consume',
            quantityDelta: -item.quantity,
            unit: item.unit,
            actorUserId: principal.user.id,
            sourceMutationId: importBatchId,
            occurredAt: record.cookedAt,
          };
          this.store.movements.set(movement.id, movement);
        });
        this.store.appendChange(householdId, 'cookingRecord', serverRecord.id, 'upsert', 1, serverRecord, now);
      });
      validated.snapshot.shoppingList.forEach((item) => {
        const serverItem: ServerShoppingItem = {
          ...item,
          householdId,
          version: 1,
          createdBy: principal.user.id,
          updatedAt: item.createdAt,
        };
        this.store.shoppingItems.set(serverItem.id, serverItem);
        this.store.appendChange(householdId, 'shoppingItem', serverItem.id, 'upsert', 1, serverItem, now);
      });
      validated.snapshot.progress.forEach((item) => {
        const progress: ServerRecipeProgress = { ...item, userId: principal.user.id, householdId, version: 1 };
        this.store.recipeProgress.set(this.store.progressKey(householdId, principal.user.id, item.recipeId), progress);
        this.store.appendChange(householdId, 'recipeProgress', `${principal.user.id}:${item.recipeId}`, 'upsert', 1, progress, now);
      });
      const preferences: MemberPreferences = {
        ...validated.snapshot.settings,
        favoriteRecipeIds: validated.snapshot.settings.favoriteRecipeIds ?? [],
        userId: principal.user.id,
        householdId,
        version: 1,
        updatedAt: now,
      };
      this.store.preferences.set(this.store.preferencesKey(householdId, principal.user.id), preferences);
      this.store.appendChange(householdId, 'preferences', principal.user.id, 'upsert', 1, preferences, now);
      const committed: MigrationSummary = { ...prepared, status: 'committed' };
      this.store.migrations.set(key, committed);
      return committed;
    });
  }

  migrationStatus(accessToken: string, importBatchId: string): MigrationSummary {
    const principal = this.authenticate(accessToken);
    const migration = this.store.migrations.get(this.store.migrationKey(principal.user.id, importBatchId));
    assertApi(migration, 'NOT_FOUND', '没有找到这次迁移', 404);
    return migration;
  }

  private applyCommand(userId: string, command: SyncCommand): unknown {
    switch (command.command) {
      case 'PurchaseBatch': return this.applyPurchase(userId, command);
      case 'CompleteCooking': return this.applyCooking(userId, command);
      case 'AddShoppingItem': return this.applyAddShopping(userId, command);
      case 'CheckShoppingItem': return this.applyCheckShopping(command);
      case 'RemoveShoppingItem': return this.applyRemoveShopping(command);
      case 'DiscardBatch': return this.applyDiscard(userId, command);
      case 'UnlockRecipe': return this.applyUnlock(userId, command);
      case 'UpdatePreferences': return this.applyPreferences(userId, command);
    }
  }

  private applyPurchase(userId: string, command: Extract<SyncCommand, { command: 'PurchaseBatch' }>): ServerPantryBatch {
    const ingredient = seedIngredients.find((item) => item.id === command.payload.ingredientId);
    assertApi(ingredient, 'VALIDATION_ERROR', '未知食材');
    assertApi(command.payload.quantity > 0 && Number.isFinite(command.payload.quantity), 'VALIDATION_ERROR', '购入数量无效');
    assertApi(command.payload.unit === ingredient.defaultUnit, 'VALIDATION_ERROR', '购入单位与食材不一致');
    parseDateOnly(command.payload.purchasedAt);
    assertApi(command.baseVersion === 0, 'VERSION_CONFLICT', '新增批次的 baseVersion 必须为 0', 409);
    assertApi(!this.store.batches.has(command.entityId), 'VERSION_CONFLICT', '批次 ID 已存在', 409);
    const shopping = command.payload.shoppingItemId
      ? this.store.shoppingItems.get(command.payload.shoppingItemId)
      : undefined;
    if (command.payload.shoppingItemId) {
      assertApi(shopping?.householdId === command.householdId && !shopping.deletedAt, 'NOT_FOUND', '购物项不存在', 404);
    }
    const now = this.now();
    const batch: ServerPantryBatch = {
      id: command.entityId,
      householdId: command.householdId,
      ingredientId: command.payload.ingredientId,
      quantity: command.payload.quantity,
      originalQuantity: command.payload.quantity,
      unit: command.payload.unit,
      purchasedAt: command.payload.purchasedAt,
      storageMode: command.payload.storageMode,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      version: 1,
      createdBy: userId,
      ...(command.payload.shelfLifeDaysOverride ? { shelfLifeDaysOverride: command.payload.shelfLifeDaysOverride } : {}),
      ...(command.payload.note ? { note: command.payload.note } : {}),
    };
    const movement: InventoryMovement = {
      id: newId('mov'),
      householdId: command.householdId,
      pantryBatchId: batch.id,
      ingredientId: batch.ingredientId,
      type: 'purchase',
      quantityDelta: batch.quantity,
      unit: batch.unit,
      actorUserId: userId,
      sourceMutationId: command.mutationId,
      occurredAt: now,
    };
    this.store.batches.set(batch.id, batch);
    this.store.movements.set(movement.id, movement);
    this.store.appendChange(command.householdId, 'pantryBatch', batch.id, 'upsert', batch.version, batch, now);
    this.store.appendChange(command.householdId, 'inventoryMovement', movement.id, 'upsert', 1, movement, now);
    if (shopping) {
      const nextShopping = { ...shopping, checked: true, updatedAt: now, version: shopping.version + 1 };
      this.store.shoppingItems.set(shopping.id, nextShopping);
      this.store.appendChange(command.householdId, 'shoppingItem', shopping.id, 'upsert', nextShopping.version, nextShopping, now);
    }
    return batch;
  }

  private applyCooking(userId: string, command: Extract<SyncCommand, { command: 'CompleteCooking' }>): ServerCookingRecord {
    assertApi(Number.isFinite(command.payload.servings) && command.payload.servings > 0, 'VALIDATION_ERROR', '份数无效');
    const recipe = seedRecipes.find((item) => item.id === command.payload.recipeId);
    assertApi(recipe, 'VALIDATION_ERROR', '未知食谱');
    assertApi(!this.store.cookingRecords.has(command.entityId), 'VERSION_CONFLICT', '做菜记录 ID 已存在', 409);
    const progress = this.progressFor(command.householdId, userId);
    assertApi(progress.find((item) => item.recipeId === recipe.id)?.status === 'mastered', 'MUTATION_REJECTED', '请先解锁并掌握这个食谱', 409);
    const batches = [...this.store.batches.values()].filter((item) => item.householdId === command.householdId && !item.deletedAt);
    const now = this.now();
    let commit;
    try {
      commit = completeCooking(recipe, command.payload.servings, batches, seedIngredients, progress, now, command.entityId);
    } catch (error) {
      const preview = previewCooking(recipe, command.payload.servings, batches, seedIngredients);
      throw new ApiError('INVENTORY_CONFLICT', error instanceof Error ? error.message : '当前库存不足', 409, {
        missing: preview.missing,
        recommendation: '请按当前库存重新确认，或取消本次做菜操作',
      });
    }
    commit.batches.forEach((plain) => {
      const current = this.store.batches.get(plain.id)!;
      if (current.quantity === plain.quantity && current.status === plain.status) return;
      const next: ServerPantryBatch = { ...current, quantity: plain.quantity, status: plain.status, updatedAt: now, version: current.version + 1 };
      this.store.batches.set(next.id, next);
      this.store.appendChange(command.householdId, 'pantryBatch', next.id, 'upsert', next.version, next, now);
    });
    commit.record.consumptions.forEach((item) => {
      const movement: InventoryMovement = {
        id: newId('mov'), householdId: command.householdId, pantryBatchId: item.pantryBatchId,
        ingredientId: item.ingredientId, type: 'cook_consume', quantityDelta: -item.quantity, unit: item.unit,
        actorUserId: userId, sourceMutationId: command.mutationId, occurredAt: now,
      };
      this.store.movements.set(movement.id, movement);
      this.store.appendChange(command.householdId, 'inventoryMovement', movement.id, 'upsert', 1, movement, now);
    });
    const record: ServerCookingRecord = {
      ...commit.record,
      householdId: command.householdId,
      actorUserId: userId,
      mutationId: command.mutationId,
      version: 1,
    };
    this.store.cookingRecords.set(record.id, record);
    this.store.appendChange(command.householdId, 'cookingRecord', record.id, 'upsert', 1, record, now);
    const updatedProgress = commit.progress.find((item) => item.recipeId === recipe.id)!;
    const serverProgress = this.saveProgress(command.householdId, userId, updatedProgress, now);
    this.store.appendChange(command.householdId, 'recipeProgress', `${userId}:${recipe.id}`, 'upsert', serverProgress.version, serverProgress, now);
    return record;
  }

  private applyAddShopping(userId: string, command: Extract<SyncCommand, { command: 'AddShoppingItem' }>): ServerShoppingItem {
    const ingredient = seedIngredients.find((item) => item.id === command.payload.ingredientId);
    assertApi(ingredient, 'VALIDATION_ERROR', '未知食材');
    assertApi(command.payload.suggestedQuantity > 0 && Number.isFinite(command.payload.suggestedQuantity), 'VALIDATION_ERROR', '建议数量无效');
    assertApi(command.payload.unit === ingredient.defaultUnit, 'VALIDATION_ERROR', '购物项单位与食材不一致');
    assertApi(command.baseVersion === 0, 'VERSION_CONFLICT', '新增购物项的 baseVersion 必须为 0', 409);
    assertApi(!this.store.shoppingItems.has(command.entityId), 'VERSION_CONFLICT', '购物项 ID 已存在', 409);
    const now = this.now();
    const item: ServerShoppingItem = {
      id: command.entityId,
      householdId: command.householdId,
      ingredientId: command.payload.ingredientId,
      suggestedQuantity: command.payload.suggestedQuantity,
      unit: command.payload.unit,
      checked: false,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      version: 1,
      ...(command.payload.sourceRecipeId ? { sourceRecipeId: command.payload.sourceRecipeId } : {}),
    };
    this.store.shoppingItems.set(item.id, item);
    this.store.appendChange(command.householdId, 'shoppingItem', item.id, 'upsert', 1, item, now);
    return item;
  }

  private applyCheckShopping(command: Extract<SyncCommand, { command: 'CheckShoppingItem' }>): ServerShoppingItem {
    const item = this.store.shoppingItems.get(command.entityId);
    assertApi(item?.householdId === command.householdId && !item.deletedAt, 'NOT_FOUND', '购物项不存在', 404);
    if (item.checked === command.payload.checked) return item;
    assertApi(command.baseVersion === item.version, 'VERSION_CONFLICT', '购物项已被其他成员修改', 409, { serverValue: item });
    const next = { ...item, checked: command.payload.checked, updatedAt: this.now(), version: item.version + 1 };
    this.store.shoppingItems.set(item.id, next);
    this.store.appendChange(command.householdId, 'shoppingItem', item.id, 'upsert', next.version, next, this.now());
    return next;
  }

  private applyRemoveShopping(command: Extract<SyncCommand, { command: 'RemoveShoppingItem' }>): { id: string; deletedAt: number; version: number } {
    const item = this.store.shoppingItems.get(command.entityId);
    assertApi(item?.householdId === command.householdId, 'NOT_FOUND', '购物项不存在', 404);
    if (item.deletedAt) return { id: item.id, deletedAt: item.deletedAt, version: item.version };
    assertApi(command.baseVersion === item.version, 'VERSION_CONFLICT', '购物项已被其他成员修改', 409, { serverValue: item });
    const deletedAt = this.now();
    const next: ServerShoppingItem = { ...item, deletedAt, updatedAt: deletedAt, version: item.version + 1 };
    this.store.shoppingItems.set(item.id, next);
    const tombstone = { id: item.id, deletedAt, version: next.version };
    this.store.appendChange(command.householdId, 'shoppingItem', item.id, 'delete', next.version, tombstone, deletedAt);
    return tombstone;
  }

  private applyDiscard(userId: string, command: Extract<SyncCommand, { command: 'DiscardBatch' }>): ServerPantryBatch {
    const batch = this.store.batches.get(command.entityId);
    assertApi(batch?.householdId === command.householdId && !batch.deletedAt, 'NOT_FOUND', '批次不存在', 404);
    if (batch.status === 'discarded') return batch;
    assertApi(command.baseVersion === batch.version, 'VERSION_CONFLICT', '批次已被其他成员修改', 409, { serverValue: batch });
    const now = this.now();
    const movement: InventoryMovement = {
      id: newId('mov'), householdId: command.householdId, pantryBatchId: batch.id, ingredientId: batch.ingredientId,
      type: 'discard', quantityDelta: -batch.quantity, unit: batch.unit, actorUserId: userId,
      sourceMutationId: command.mutationId, occurredAt: now,
    };
    const next: ServerPantryBatch = { ...batch, quantity: 0, status: 'discarded', updatedAt: now, version: batch.version + 1 };
    this.store.batches.set(batch.id, next);
    this.store.movements.set(movement.id, movement);
    this.store.appendChange(command.householdId, 'pantryBatch', batch.id, 'upsert', next.version, next, now);
    this.store.appendChange(command.householdId, 'inventoryMovement', movement.id, 'upsert', 1, movement, now);
    return next;
  }

  private applyUnlock(userId: string, command: Extract<SyncCommand, { command: 'UnlockRecipe' }>): ServerRecipeProgress {
    assertApi(seedRecipes.some((item) => item.id === command.payload.recipeId), 'VALIDATION_ERROR', '未知食谱');
    const progress = this.progressFor(command.householdId, userId);
    let unlocked: RecipeProgress[];
    try { unlocked = unlockRecipe(progress, command.payload.recipeId, this.now()); }
    catch (error) { throw new ApiError('MUTATION_REJECTED', error instanceof Error ? error.message : '食谱无法解锁', 409); }
    const changed = unlocked.find((item) => item.recipeId === command.payload.recipeId)!;
    const saved = this.saveProgress(command.householdId, userId, changed, this.now());
    this.store.appendChange(command.householdId, 'recipeProgress', `${userId}:${changed.recipeId}`, 'upsert', saved.version, saved, this.now());
    return saved;
  }

  private applyPreferences(userId: string, command: Extract<SyncCommand, { command: 'UpdatePreferences' }>): MemberPreferences {
    const current = this.preferencesFor(command.householdId, userId);
    assertApi(command.baseVersion === current.version, 'VERSION_CONFLICT', '偏好设置已在其他设备修改', 409, { serverValue: current });
    const favoriteRecipeIds = command.payload.favoriteRecipeIds ?? current.favoriteRecipeIds ?? [];
    assertApi(favoriteRecipeIds.every((id) => seedRecipes.some((recipe) => recipe.id === id)), 'VALIDATION_ERROR', '收藏中包含未知食谱');
    const next: MemberPreferences = {
      ...current,
      freshnessReminderDays: command.payload.freshnessReminderDays ?? current.freshnessReminderDays,
      defaultStorageMode: command.payload.defaultStorageMode ?? current.defaultStorageMode,
      favoriteRecipeIds: [...new Set(favoriteRecipeIds)],
      version: current.version + 1,
      updatedAt: this.now(),
    };
    assertApi(next.freshnessReminderDays >= 1 && next.freshnessReminderDays <= 30, 'VALIDATION_ERROR', '提醒范围应为 1–30 天');
    this.store.preferences.set(this.store.preferencesKey(command.householdId, userId), next);
    this.store.appendChange(command.householdId, 'preferences', userId, 'upsert', next.version, next, this.now());
    return next;
  }

  private validateCommand(command: SyncCommand): void {
    assertApi(Boolean(command.mutationId && command.deviceId && command.householdId && command.entityId), 'VALIDATION_ERROR', '同步命令缺少必要标识');
    assertApi(Number.isInteger(command.baseVersion) && command.baseVersion >= 0, 'VALIDATION_ERROR', 'baseVersion 无效');
    assertApi(!Number.isNaN(Date.parse(command.clientOccurredAt)), 'VALIDATION_ERROR', 'clientOccurredAt 无效');
    this.requireHousehold(command.householdId);
  }

  private requireCommandMember(householdId: string, userId: string, permission: Permission): HouseholdMember {
    const member = this.memberFor(householdId, userId);
    if (!member || member.status !== 'active') {
      throw new ApiError('MEMBERSHIP_CHANGED', '家庭成员关系已变化，请停止重试并重新同步', 409, {
        householdId,
        recommendation: '清理该家庭待发送操作，并刷新家庭列表',
      });
    }
    return requirePermission(member, permission);
  }

  private progressFor(householdId: string, userId: string): RecipeProgress[] {
    const stored = [...this.store.recipeProgress.values()].filter((item) => item.householdId === householdId && item.userId === userId);
    const purchasedIngredientIds = [...new Set([...this.store.movements.values()]
      .filter((item) => item.householdId === householdId && item.type === 'purchase')
      .map((item) => item.ingredientId))];
    return refreshRecipeProgress(seedRecipes, stored, purchasedIngredientIds);
  }

  private saveProgress(householdId: string, userId: string, progress: RecipeProgress, now: number): ServerRecipeProgress {
    const key = this.store.progressKey(householdId, userId, progress.recipeId);
    const current = this.store.recipeProgress.get(key);
    const next: ServerRecipeProgress = {
      ...progress,
      userId,
      householdId,
      version: (current?.version ?? 0) + 1,
      ...(progress.unlockedAt ? { unlockedAt: progress.unlockedAt } : {}),
      ...(progress.lastCookedAt ? { lastCookedAt: progress.lastCookedAt } : {}),
    };
    this.store.recipeProgress.set(key, next);
    void now;
    return next;
  }

  private asServerProgress(householdId: string, userId: string, progress: RecipeProgress): ServerRecipeProgress {
    const current = this.store.recipeProgress.get(this.store.progressKey(householdId, userId, progress.recipeId));
    return { ...progress, userId, householdId, version: current?.version ?? 0 };
  }

  private preferencesFor(householdId: string, userId: string): MemberPreferences {
    const key = this.store.preferencesKey(householdId, userId);
    const existing = this.store.preferences.get(key);
    if (existing) return existing;
    const preferences: MemberPreferences = {
      ...DEFAULT_SETTINGS,
      favoriteRecipeIds: [],
      householdId,
      userId,
      version: 0,
      updatedAt: this.now(),
    };
    this.store.preferences.set(key, preferences);
    return preferences;
  }

  private createHouseholdFor(user: User, name: string, timezone: string, now: number): Household {
    const normalized = name.trim();
    assertApi(normalized.length >= 1 && normalized.length <= 30, 'VALIDATION_ERROR', '家庭名称应为 1–30 个字符');
    const household: Household = {
      id: newId('hh'),
      name: normalized,
      timezone,
      ownerUserId: user.id,
      status: 'active',
      version: 1,
      createdAt: now,
    };
    const member: HouseholdMember = {
      householdId: household.id,
      userId: user.id,
      role: 'owner',
      status: 'active',
      joinedAt: now,
      version: 1,
    };
    this.store.households.set(household.id, household);
    this.store.members.set(this.store.memberKey(household.id, user.id), member);
    this.store.appendChange(household.id, 'household', household.id, 'upsert', 1, household, now);
    this.store.appendChange(household.id, 'member', user.id, 'upsert', 1, member, now);
    return household;
  }

  private householdsFor(userId: string): Household[] {
    return this.store.activeMemberships(userId)
      .map((member) => this.store.households.get(member.householdId))
      .filter((item): item is Household => Boolean(item && item.status === 'active'));
  }

  private memberFor(householdId: string, userId: string): HouseholdMember | undefined {
    return this.store.members.get(this.store.memberKey(householdId, userId));
  }

  private requireHousehold(householdId: string): Household {
    const household = this.store.households.get(householdId);
    assertApi(household?.status === 'active', 'NOT_FOUND', '家庭空间不存在', 404);
    return household;
  }

  private audit(
    action: string,
    actorUserId: string | undefined,
    targetType: string | undefined,
    targetId: string | undefined,
    metadata: Record<string, unknown> = {},
  ): AuditLog {
    const audit: AuditLog = {
      id: newId('aud'),
      ...(actorUserId ? { actorUserId } : {}),
      action,
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      metadata,
      createdAt: this.now(),
    };
    this.store.auditLogs.set(audit.id, audit);
    return audit;
  }

  private requireActiveUser(userId: string): User {
    const user = this.store.users.get(userId);
    assertApi(user?.status === 'active', 'UNAUTHENTICATED', '账号不可用', 401);
    return user;
  }
}
