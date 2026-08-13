import { appConfig } from '../../data/app-config';
import { LocalV2Repository } from '../../repositories/local/local-v2.repository';
import type {
  CloudAuthState,
  CloudAccountDeletionRequest,
  CloudDataExportArtifact,
  CloudHousehold,
  CloudHouseholdMember,
  CloudHouseholdRole,
  CloudStatusView,
  LocalConflict,
  MigrationSummary,
} from '../../v2/models';
import { SyncCoordinator } from './sync-coordinator';
import { CloudCommandService } from './cloud-command.service';
import type { CloudAccountGateway, InvitationResponse } from './remote-sync.gateway';
import { WechatRemoteSyncGateway } from './remote-sync.gateway';

export class CloudSyncService {
  readonly commands: CloudCommandService;
  constructor(
    private readonly local = new LocalV2Repository(),
    private readonly createGateway: (apiBaseUrl: string) => CloudAccountGateway = (url) => new WechatRemoteSyncGateway(url),
    private readonly config: { cloudSyncEnabled: boolean; apiBaseUrl: string } = appConfig,
  ) {
    this.commands = new CloudCommandService(this.local, () => this.syncNow());
  }

  available(): boolean { return this.config.cloudSyncEnabled && /^https:\/\//.test(this.config.apiBaseUrl); }

  status(): CloudStatusView {
    const auth = this.local.auth();
    const household = auth.households.find((item) => item.id === auth.activeHouseholdId);
    const envelope = auth.activeHouseholdId ? this.local.envelope(auth.activeHouseholdId) : null;
    return {
      mode: auth.mode,
      available: this.available(),
      activeHouseholdName: household?.name ?? '未选择家庭',
      pendingCount: envelope?.outbox.filter((item) => item.state !== 'conflict').length ?? 0,
      conflictCount: envelope?.conflicts.length ?? 0,
      ...(envelope?.cursor ? { lastSyncedAt: envelope.updatedAt } : {}),
    };
  }

  async signIn(): Promise<void> {
    const gateway = this.gateway();
    const result = await gateway.login(this.local.device().deviceId);
    const auth: CloudAuthState = {
      mode: 'cloud',
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      user: result.user,
      households: result.households,
      ...(result.households[0] ? { activeHouseholdId: result.households[0].id } : {}),
    };
    if (auth.activeHouseholdId) await this.hydrateHousehold(auth.accessToken!, auth.activeHouseholdId);
    this.local.saveAuth(auth);
  }

  async signOut(): Promise<void> {
    const auth = this.local.auth();
    if (auth.accessToken) {
      try { await this.gateway().logout(auth.accessToken); } catch { /* 本地退出不依赖网络成功 */ }
    }
    this.local.clearAuth();
  }

  async prepareMigration(source: string): Promise<MigrationSummary> {
    const auth = this.requireCloudAuth();
    const importBatchId = `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    this.local.saveMigrationBackup(importBatchId, source);
    return this.gateway().prepareMigration(auth.accessToken, auth.householdId, importBatchId, source);
  }

  async commitMigration(summary: MigrationSummary): Promise<MigrationSummary> {
    const auth = this.requireCloudAuth();
    const source = this.local.migrationBackup(summary.importBatchId);
    if (!source) throw new Error('本机迁移备份不存在，请重新预检');
    const committed = await this.gateway().commitMigration(auth.accessToken, auth.householdId, summary.importBatchId, source);
    await this.syncNow();
    return committed;
  }

  async syncNow() {
    const auth = this.requireCloudAuth();
    return new SyncCoordinator(this.local, this.gateway()).sync(auth.accessToken, auth.householdId);
  }

  authState(): CloudAuthState { return this.local.auth(); }

  members(): CloudHouseholdMember[] {
    const householdId = this.requireActiveHousehold();
    const bucket = this.local.envelope(householdId).entities.member ?? {};
    return Object.values(bucket)
      .filter((item) => !item.deleted)
      .map((item) => item.value as CloudHouseholdMember)
      .filter((item) => item.status === 'active')
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async refreshHouseholds(): Promise<CloudHousehold[]> {
    const auth = this.requireCloudSession();
    const households = await this.gateway().listHouseholds(auth.accessToken);
    const activeHouseholdId = households.some((item) => item.id === auth.state.activeHouseholdId)
      ? auth.state.activeHouseholdId
      : households[0]?.id;
    if (activeHouseholdId) await this.hydrateHousehold(auth.accessToken, activeHouseholdId);
    const { activeHouseholdId: _previousHouseholdId, ...session } = auth.state;
    this.local.saveAuth({ ...session, households, ...(activeHouseholdId ? { activeHouseholdId } : {}) });
    return households;
  }

  async createHousehold(name: string): Promise<CloudHousehold> {
    const auth = this.requireCloudSession();
    const created = await this.gateway().createHousehold(auth.accessToken, name.trim());
    await this.hydrateHousehold(auth.accessToken, created.id);
    this.local.saveAuth({
      ...auth.state,
      households: [...auth.state.households.filter((item) => item.id !== created.id), created],
      activeHouseholdId: created.id,
    });
    return created;
  }

  async switchHousehold(householdId: string): Promise<void> {
    const auth = this.requireCloudSession();
    if (!auth.state.households.some((item) => item.id === householdId)) throw new Error('你不是这个家庭的成员');
    await this.hydrateHousehold(auth.accessToken, householdId);
    this.local.saveAuth({ ...auth.state, activeHouseholdId: householdId });
  }

  async acceptInvitation(token: string): Promise<void> {
    const auth = this.requireCloudSession();
    const member = await this.gateway().acceptInvitation(auth.accessToken, token.trim());
    await this.refreshHouseholds();
    await this.switchHousehold(member.householdId);
  }

  async createInvitation(
    role: Exclude<CloudHouseholdRole, 'owner'> = 'member',
    maxUses = 1,
  ): Promise<InvitationResponse> {
    const auth = this.requireCloudAuth();
    return this.gateway().createInvitation(auth.accessToken, auth.householdId, role, maxUses);
  }

  async updateMemberRole(userId: string, role: Exclude<CloudHouseholdRole, 'owner'>): Promise<void> {
    const auth = this.requireCloudAuth();
    await this.gateway().updateMemberRole(auth.accessToken, auth.householdId, userId, role);
    await this.hydrateHousehold(auth.accessToken, auth.householdId);
  }

  async removeMember(userId: string): Promise<void> {
    const auth = this.requireCloudAuth();
    await this.gateway().removeMember(auth.accessToken, auth.householdId, userId);
    await this.hydrateHousehold(auth.accessToken, auth.householdId);
  }

  async transferOwnership(userId: string): Promise<void> {
    const auth = this.requireCloudAuth();
    const household = await this.gateway().transferOwnership(auth.accessToken, auth.householdId, userId);
    const state = this.local.auth();
    this.local.saveAuth({ ...state, households: state.households.map((item) => item.id === household.id ? household : item) });
    await this.hydrateHousehold(auth.accessToken, auth.householdId);
  }

  async createDataExport(): Promise<CloudDataExportArtifact> {
    const auth = this.requireCloudSession();
    return this.gateway().createDataExport(auth.accessToken);
  }

  async requestAccountDeletion(confirmation: string): Promise<CloudAccountDeletionRequest> {
    const auth = this.requireCloudSession();
    return this.gateway().requestAccountDeletion(auth.accessToken, confirmation);
  }

  async accountDeletionStatus(): Promise<CloudAccountDeletionRequest> {
    const auth = this.requireCloudSession();
    return this.gateway().accountDeletionStatus(auth.accessToken);
  }

  async cancelAccountDeletion(): Promise<CloudAccountDeletionRequest> {
    const auth = this.requireCloudSession();
    return this.gateway().cancelAccountDeletion(auth.accessToken);
  }

  conflicts(): LocalConflict[] {
    const auth = this.local.auth();
    if (!auth.activeHouseholdId) return [];
    return this.local.envelope(auth.activeHouseholdId).conflicts;
  }

  retryConflict(conflictId: string, baseVersion?: number): void {
    const householdId = this.requireActiveHousehold();
    this.local.retryConflict(householdId, conflictId, baseVersion);
  }

  cancelConflict(conflictId: string): void {
    const householdId = this.requireActiveHousehold();
    this.local.cancelConflict(householdId, conflictId);
  }

  private gateway(): CloudAccountGateway {
    if (!this.available()) throw new Error('云同步服务尚未配置，当前数据继续安全保存在本机');
    return this.createGateway(this.config.apiBaseUrl);
  }

  private requireCloudAuth(): { accessToken: string; householdId: string } {
    const auth = this.local.auth();
    if (auth.mode !== 'cloud' || !auth.accessToken || !auth.activeHouseholdId) throw new Error('请先开启云同步并选择家庭');
    if (auth.expiresAt && auth.expiresAt <= Date.now()) throw new Error('登录已过期，请重新开启云同步');
    return { accessToken: auth.accessToken, householdId: auth.activeHouseholdId };
  }

  private requireCloudSession(): { accessToken: string; state: CloudAuthState } {
    const state = this.local.auth();
    if (state.mode !== 'cloud' || !state.accessToken) throw new Error('请先开启云同步');
    if (state.expiresAt && state.expiresAt <= Date.now()) throw new Error('登录已过期，请重新开启云同步');
    return { accessToken: state.accessToken, state };
  }

  private requireActiveHousehold(): string {
    const householdId = this.local.auth().activeHouseholdId;
    if (!householdId) throw new Error('当前没有可处理的家庭空间');
    return householdId;
  }

  private async hydrateHousehold(accessToken: string, householdId: string): Promise<void> {
    const snapshot = await this.gateway().bootstrap(accessToken, householdId);
    const changes = [
      { entityType: 'household' as const, entityId: snapshot.household.id, version: snapshot.household.version, payload: snapshot.household },
      ...snapshot.members.map((item) => ({ entityType: 'member' as const, entityId: item.userId, version: item.version, payload: item })),
      ...snapshot.batches.map((item) => ({ entityType: 'pantryBatch' as const, entityId: item.id, version: item.version, payload: item })),
      ...snapshot.movements.map((item) => ({ entityType: 'inventoryMovement' as const, entityId: item.id, version: 1, payload: item })),
      ...snapshot.shoppingItems.map((item) => ({ entityType: 'shoppingItem' as const, entityId: item.id, version: item.version, payload: item })),
      ...snapshot.cookingRecords.map((item) => ({ entityType: 'cookingRecord' as const, entityId: item.id, version: item.version, payload: item })),
      ...snapshot.recipeProgress.map((item) => ({ entityType: 'recipeProgress' as const, entityId: `${item.userId}:${item.recipeId}`, version: item.version, payload: item })),
      { entityType: 'preferences' as const, entityId: snapshot.preferences.userId, version: snapshot.preferences.version, payload: snapshot.preferences },
    ].map((item) => ({
      householdId,
      cursor: snapshot.cursor,
      operation: 'upsert' as const,
      serverTime: Date.now(),
      ...item,
    }));
    this.local.replaceSnapshot(householdId, changes, snapshot.cursor, snapshot.catalogVersion);
  }
}

export const cloudSyncService = new CloudSyncService();
