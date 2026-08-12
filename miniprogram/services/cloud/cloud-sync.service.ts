import { appConfig } from '../../data/app-config';
import { LocalV2Repository } from '../../repositories/local/local-v2.repository';
import type { CloudStatusView, MigrationSummary } from '../../v2/models';
import { SyncCoordinator } from './sync-coordinator';
import { WechatRemoteSyncGateway } from './remote-sync.gateway';

export class CloudSyncService {
  private readonly local = new LocalV2Repository();

  available(): boolean { return appConfig.cloudSyncEnabled && /^https:\/\//.test(appConfig.apiBaseUrl); }

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
    this.local.saveAuth({
      mode: 'cloud',
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      user: result.user,
      households: result.households,
      ...(result.households[0] ? { activeHouseholdId: result.households[0].id } : {}),
    });
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

  private gateway(): WechatRemoteSyncGateway {
    if (!this.available()) throw new Error('云同步服务尚未配置，当前数据继续安全保存在本机');
    return new WechatRemoteSyncGateway(appConfig.apiBaseUrl);
  }

  private requireCloudAuth(): { accessToken: string; householdId: string } {
    const auth = this.local.auth();
    if (auth.mode !== 'cloud' || !auth.accessToken || !auth.activeHouseholdId) throw new Error('请先开启云同步并选择家庭');
    if (auth.expiresAt && auth.expiresAt <= Date.now()) throw new Error('登录已过期，请重新开启云同步');
    return { accessToken: auth.accessToken, householdId: auth.activeHouseholdId };
  }
}

export const cloudSyncService = new CloudSyncService();
