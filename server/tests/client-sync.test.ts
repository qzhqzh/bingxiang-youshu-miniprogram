import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalV2Repository, type StorageAdapter } from '../../miniprogram/repositories/local/local-v2.repository.js';
import { CloudSyncService } from '../../miniprogram/services/cloud/cloud-sync.service.js';
import {
  RemoteApiError,
  type BootstrapResponse,
  type CloudAccountGateway,
  type InvitationResponse,
  type LoginResponse,
  type RemoteSyncGateway,
} from '../../miniprogram/services/cloud/remote-sync.gateway.js';
import { SyncCoordinator } from '../../miniprogram/services/cloud/sync-coordinator.js';
import type {
  CloudAccountDeletionRequest,
  CloudDataExportArtifact,
  CloudHousehold,
  CloudHouseholdMember,
  CloudHouseholdRole,
  MigrationSummary,
  PullPage,
  PushResult,
  SyncCommand,
} from '../../miniprogram/v2/models.js';

class MemoryStorage implements StorageAdapter {
  readonly values = new Map<string, unknown>();
  writes = 0;
  failNextWrite = false;
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  set<T>(key: string, value: T): void {
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error('disk full'); }
    this.writes += 1;
    this.values.set(key, structuredClone(value));
  }
  remove(key: string): void { this.values.delete(key); }
}

class FakeGateway implements RemoteSyncGateway {
  pushed: SyncCommand[] = [];
  pullPages: PullPage[] = [];
  pushError?: RemoteApiError;
  pullError?: RemoteApiError;
  bootstrapResult: BootstrapResponse = {
    household: { id: 'home', name: '我的冰箱', timezone: 'Asia/Shanghai', ownerUserId: 'alice', version: 2 },
    members: [{ householdId: 'home', userId: 'alice', role: 'owner', status: 'active', joinedAt: 1, version: 1 }],
    batches: [{ id: 'batch-server', version: 3, quantity: 2 }],
    movements: [], shoppingItems: [], cookingRecords: [], recipeProgress: [],
    preferences: { userId: 'alice', version: 1 }, cursor: 22, catalogVersion: 3,
  };
  async login(_deviceId: string): Promise<LoginResponse> { throw new Error('not used'); }
  async logout(_accessToken: string): Promise<void> {}
  async push(_accessToken: string, command: SyncCommand): Promise<PushResult> {
    this.pushed.push(command);
    if (this.pushError) throw this.pushError;
    return { mutationId: command.mutationId, accepted: true, replayed: false, cursor: 1, canonical: {} };
  }
  async pull(_accessToken: string, _householdId: string, cursor: number): Promise<PullPage> {
    if (this.pullError) throw this.pullError;
    return this.pullPages.shift() ?? { changes: [], nextCursor: cursor, hasMore: false, catalogVersion: 1 };
  }
  async bootstrap(_accessToken?: string, _householdId?: string): Promise<BootstrapResponse> { return this.bootstrapResult; }
  async prepareMigration(): Promise<MigrationSummary> { throw new Error('not used'); }
  async commitMigration(): Promise<MigrationSummary> { throw new Error('not used'); }
}

function snapshot(household: CloudHousehold, memberName: string): BootstrapResponse {
  return {
    household,
    members: [{ householdId: household.id, userId: 'alice', displayName: memberName, role: 'owner', status: 'active', joinedAt: 1, version: 1 }],
    batches: [], movements: [], shoppingItems: [], cookingRecords: [], recipeProgress: [],
    preferences: { householdId: household.id, userId: 'alice', freshnessReminderDays: 3, defaultStorageMode: 'chilled', favoriteRecipeIds: [], version: 1 },
    cursor: 0,
    catalogVersion: 3,
  };
}

class FakeAccountGateway extends FakeGateway implements CloudAccountGateway {
  households: CloudHousehold[] = [
    { id: 'home', name: '我的冰箱', timezone: 'Asia/Shanghai', ownerUserId: 'alice', version: 1 },
    { id: 'family', name: '爸妈家', timezone: 'Asia/Shanghai', ownerUserId: 'alice', version: 1 },
  ];
  snapshots = new Map(this.households.map((item) => [item.id, snapshot(item, item.id === 'home' ? '小秦' : '妈妈')]));
  failBootstrapFor = '';
  deletion: CloudAccountDeletionRequest = {
    id: 'delete-1', userId: 'alice', status: 'pending', requestedAt: 1, executeAfter: 2,
    restrictedSessionId: 'session-1',
  };

  async login(): Promise<LoginResponse> {
    return { accessToken: 'cloud-token', expiresAt: Date.now() + 60_000, user: { id: 'alice', displayName: '小秦' }, households: this.households };
  }
  async bootstrap(_accessToken: string, householdId: string): Promise<BootstrapResponse> {
    if (householdId === this.failBootstrapFor) throw new RemoteApiError('NETWORK_UNAVAILABLE', 'offline', 0);
    const found = this.snapshots.get(householdId);
    if (!found) throw new Error('missing snapshot');
    return found;
  }
  async listHouseholds(): Promise<CloudHousehold[]> { return this.households; }
  async createHousehold(_token: string, name: string): Promise<CloudHousehold> {
    const created = { id: `created-${this.households.length}`, name, timezone: 'Asia/Shanghai', ownerUserId: 'alice', version: 1 };
    this.households = [...this.households, created];
    this.snapshots.set(created.id, snapshot(created, '小秦'));
    return created;
  }
  async createInvitation(_token: string, householdId: string): Promise<InvitationResponse> {
    return { invitation: { id: 'invite-1', householdId, role: 'member', expiresAt: Date.now() + 60_000, maxUses: 1, usedCount: 0 }, token: 'invite-token' };
  }
  async acceptInvitation(): Promise<CloudHouseholdMember> {
    return { householdId: 'family', userId: 'alice', role: 'member', status: 'active', joinedAt: 1, version: 1 };
  }
  async updateMemberRole(
    _token: string, householdId: string, userId: string, role: Exclude<CloudHouseholdRole, 'owner'>,
  ): Promise<CloudHouseholdMember> {
    return { householdId, userId, role, status: 'active', joinedAt: 1, version: 2 };
  }
  async removeMember(): Promise<void> {}
  async transferOwnership(_token: string, householdId: string, userId: string): Promise<CloudHousehold> {
    const found = this.households.find((item) => item.id === householdId)!;
    return { ...found, ownerUserId: userId, version: found.version + 1 };
  }
  async createDataExport(): Promise<CloudDataExportArtifact> {
    return {
      id: 'export-1', userId: 'alice', status: 'ready', createdAt: 1, expiresAt: 2,
      checksum: 'checksum', payload: { format: 'bingxiang-v2-user-export' },
    };
  }
  async requestAccountDeletion(_token: string, confirmation: string): Promise<CloudAccountDeletionRequest> {
    if (confirmation !== '注销账号') throw new Error('bad confirmation');
    return this.deletion;
  }
  async accountDeletionStatus(): Promise<CloudAccountDeletionRequest> { return this.deletion; }
  async cancelAccountDeletion(): Promise<CloudAccountDeletionRequest> {
    this.deletion = { ...this.deletion, status: 'cancelled', cancelledAt: 2 };
    return this.deletion;
  }
}

let commandSequence = 0;
function command(householdId = 'home'): SyncCommand {
  commandSequence += 1;
  return {
    mutationId: `client-mutation-${commandSequence}`,
    deviceId: 'device-1',
    householdId,
    command: 'PurchaseBatch',
    entityId: `batch-${commandSequence}`,
    baseVersion: 0,
    payload: { ingredientId: 'egg', quantity: 2 },
    clientOccurredAt: '2026-08-13T08:00:00.000Z',
  };
}

describe('2.0 小程序本地信封', () => {
  it('20. snapshot、Outbox、cursor 与 conflicts 始终在同一个 key 原子写入', () => {
    const storage = new MemoryStorage();
    const local = new LocalV2Repository(storage, () => 100);
    const before = storage.writes;
    local.enqueue(command());
    assert.equal(storage.writes, before + 1);
    const envelope = local.envelope('home');
    assert.equal(envelope.schemaVersion, 2);
    assert.equal(envelope.outbox.length, 1);
    storage.failNextWrite = true;
    assert.throws(() => local.applyChanges('home', [], 5, 1), /disk full/);
    assert.equal(local.envelope('home').cursor, 0);
    assert.equal(local.envelope('home').outbox.length, 1);
  });

  it('21. deviceId 稳定且 mutationId 重复入队幂等', () => {
    const storage = new MemoryStorage();
    const local = new LocalV2Repository(storage, () => 100);
    assert.equal(local.device().deviceId, local.device().deviceId);
    const queued = command();
    local.enqueue(queued);
    local.enqueue(queued);
    assert.equal(local.envelope('home').outbox.length, 1);
  });

  it('22. 增量合并拒绝 cursor 倒退，按 version 保留新值和 tombstone', () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 100);
    local.applyChanges('home', [{
      householdId: 'home', cursor: 1, entityType: 'shoppingItem', entityId: 'shop', operation: 'upsert',
      version: 2, payload: { checked: true }, serverTime: 100,
    }], 1, 1);
    local.applyChanges('home', [{
      householdId: 'home', cursor: 2, entityType: 'shoppingItem', entityId: 'shop', operation: 'delete',
      version: 3, payload: { id: 'shop' }, serverTime: 101,
    }], 2, 1);
    const item = local.envelope('home').entities.shoppingItem?.shop;
    assert.equal(item?.version, 3);
    assert.equal(item?.deleted, true);
    assert.throws(() => local.applyChanges('home', [], 1, 1), /不能倒退/);
  });
});

describe('2.0 小程序同步协调器', () => {
  it('23. 断网时保留 Outbox 并安排指数退避，不丢用户操作', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 1_000);
    const remote = new FakeGateway();
    remote.pushError = new RemoteApiError('NETWORK_UNAVAILABLE', 'offline', 0);
    const queued = command();
    local.enqueue(queued);
    const outcome = await new SyncCoordinator(local, remote, () => 1_000).sync('token', 'home');
    const outbox = local.envelope('home').outbox;
    assert.equal(outcome.offline, true);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.state, 'pending');
    assert.ok((outbox[0]?.nextAttemptAt ?? 0) > 1_000);
  });

  it('24. 业务冲突进入冲突箱且不再自动重试', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 1_000);
    const remote = new FakeGateway();
    remote.pushError = new RemoteApiError('INVENTORY_CONFLICT', '库存不足', 409, { missing: ['egg'] });
    const queued = command();
    local.enqueue(queued);
    const outcome = await new SyncCoordinator(local, remote, () => 1_000).sync('token', 'home');
    assert.equal(outcome.conflicts, 1);
    assert.equal(local.envelope('home').outbox[0]?.state, 'conflict');
    assert.equal(local.envelope('home').conflicts[0]?.type, 'INVENTORY_CONFLICT');
  });

  it('25. 成功 push 后删除 Outbox，并分页 pull 到最新 cursor', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 1_000);
    const remote = new FakeGateway();
    const queued = command();
    local.enqueue(queued);
    remote.pullPages = [
      { changes: [{ householdId: 'home', cursor: 1, entityType: 'pantryBatch', entityId: 'server-1', operation: 'upsert', version: 1, payload: { quantity: 2 }, serverTime: 1 }], nextCursor: 1, hasMore: true, catalogVersion: 1 },
      { changes: [{ householdId: 'home', cursor: 2, entityType: 'pantryBatch', entityId: 'server-2', operation: 'upsert', version: 1, payload: { quantity: 3 }, serverTime: 2 }], nextCursor: 2, hasMore: false, catalogVersion: 1 },
    ];
    const outcome = await new SyncCoordinator(local, remote, () => 1_000).sync('token', 'home');
    assert.equal(outcome.pushed, 1);
    assert.equal(outcome.pulled, 2);
    assert.equal(local.envelope('home').outbox.length, 0);
    assert.equal(local.envelope('home').cursor, 2);
    assert.equal(Object.keys(local.envelope('home').entities.pantryBatch ?? {}).length, 2);
  });

  it('26. FULL_RESYNC_REQUIRED 会重建实体快照但保留待发送操作', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 1_000);
    const remote = new FakeGateway();
    local.applyChanges('home', [{ householdId: 'home', cursor: 1, entityType: 'shoppingItem', entityId: 'old', operation: 'upsert', version: 1, payload: {}, serverTime: 1 }], 1, 1);
    remote.pullError = new RemoteApiError('FULL_RESYNC_REQUIRED', 'old cursor', 409);
    const outcome = await new SyncCoordinator(local, remote, () => 1_000).sync('token', 'home');
    const envelope = local.envelope('home');
    assert.equal(outcome.fullResynced, true);
    assert.equal(envelope.cursor, 22);
    assert.equal(envelope.entities.shoppingItem?.old, undefined);
    assert.equal(envelope.entities.pantryBatch?.['batch-server']?.version, 3);
  });

  it('27. cursor 为 0 的首次全量快照也会完整落地', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 1_000);
    const remote = new FakeGateway();
    remote.pullError = new RemoteApiError('FULL_RESYNC_REQUIRED', 'cursor reset', 409);
    remote.bootstrapResult = { ...remote.bootstrapResult, cursor: 0 };
    const outcome = await new SyncCoordinator(local, remote, () => 1_000).sync('token', 'home');
    const envelope = local.envelope('home');
    assert.equal(outcome.fullResynced, true);
    assert.equal(envelope.cursor, 0);
    assert.equal(envelope.entities.household?.home?.version, 2);
    assert.equal(envelope.entities.pantryBatch?.['batch-server']?.version, 3);
  });
});

describe('2.0 冲突中心', () => {
  it('28. 用户确认重试后保留 mutationId 并重新进入待同步队列', () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 2_000);
    const queued = command();
    local.enqueue(queued);
    local.recordConflict('home', {
      id: 'conflict-retry', mutationId: queued.mutationId, householdId: 'home', type: 'INVENTORY_CONFLICT',
      command: queued.command, recommendation: '重新确认', createdAt: 1_000,
    });
    local.retryConflict('home', 'conflict-retry', 7);
    const envelope = local.envelope('home');
    assert.equal(envelope.conflicts.length, 0);
    assert.equal(envelope.outbox[0]?.state, 'pending');
    assert.equal(envelope.outbox[0]?.command.mutationId, queued.mutationId);
    assert.equal(envelope.outbox[0]?.command.baseVersion, 7);
    assert.equal(envelope.outbox[0]?.nextAttemptAt, 2_000);
  });

  it('29. 取消冲突只删除对应本机操作，成员变化冲突禁止重试', () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 2_000);
    const first = command();
    const second = command();
    local.enqueue(first);
    local.enqueue(second);
    local.recordConflict('home', {
      id: 'membership-conflict', mutationId: first.mutationId, householdId: 'home', type: 'MEMBERSHIP_CHANGED',
      command: first.command, recommendation: '停止重试', createdAt: 1_000,
    });
    assert.throws(() => local.retryConflict('home', 'membership-conflict'), /不能重试/);
    local.cancelConflict('home', 'membership-conflict');
    const envelope = local.envelope('home');
    assert.equal(envelope.conflicts.length, 0);
    assert.deepEqual(envelope.outbox.map((item) => item.command.mutationId), [second.mutationId]);
  });
});

describe('2.0 家庭切换客户端', () => {
  it('37. 登录先完整下载首个家庭，再原子保存云端身份与成员快照', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 2_000);
    const gateway = new FakeAccountGateway();
    const service = new CloudSyncService(local, () => gateway, { cloudSyncEnabled: true, apiBaseUrl: 'https://api.example.test' });
    await service.signIn();
    assert.equal(service.authState().mode, 'cloud');
    assert.equal(service.authState().activeHouseholdId, 'home');
    assert.equal(service.status().activeHouseholdName, '我的冰箱');
    assert.equal(service.members()[0]?.displayName, '小秦');
    assert.equal(local.envelope('home').entities.household?.home?.version, 1);
  });

  it('38. 切换家庭失败不会改变当前选择，成功后保留原家庭 Outbox', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 2_000);
    const gateway = new FakeAccountGateway();
    const service = new CloudSyncService(local, () => gateway, { cloudSyncEnabled: true, apiBaseUrl: 'https://api.example.test' });
    await service.signIn();
    local.enqueue(command('home'));
    gateway.failBootstrapFor = 'family';
    await assert.rejects(service.switchHousehold('family'), /offline/);
    assert.equal(service.authState().activeHouseholdId, 'home');
    gateway.failBootstrapFor = '';
    await service.switchHousehold('family');
    assert.equal(service.authState().activeHouseholdId, 'family');
    assert.equal(service.members()[0]?.displayName, '妈妈');
    assert.equal(local.envelope('home').outbox.length, 1);
  });

  it('44. 数据权利页面通过账号网关执行导出、注销申请与冷静期取消', async () => {
    const local = new LocalV2Repository(new MemoryStorage(), () => 2_000);
    const gateway = new FakeAccountGateway();
    const service = new CloudSyncService(local, () => gateway, { cloudSyncEnabled: true, apiBaseUrl: 'https://api.example.test' });
    await service.signIn();
    const artifact = await service.createDataExport();
    assert.equal(artifact.payload.format, 'bingxiang-v2-user-export');
    const pending = await service.requestAccountDeletion('注销账号');
    assert.equal(pending.status, 'pending');
    assert.equal((await service.accountDeletionStatus()).id, pending.id);
    const cancelled = await service.cancelAccountDeletion();
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(service.authState().mode, 'cloud');
  });
});
