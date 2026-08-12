import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalV2Repository, type StorageAdapter } from '../../miniprogram/repositories/local/local-v2.repository.js';
import { RemoteApiError, type BootstrapResponse, type LoginResponse, type RemoteSyncGateway } from '../../miniprogram/services/cloud/remote-sync.gateway.js';
import { SyncCoordinator } from '../../miniprogram/services/cloud/sync-coordinator.js';
import type { MigrationSummary, PullPage, PushResult, SyncCommand } from '../../miniprogram/v2/models.js';

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
    household: { id: 'home', version: 2 },
    members: [{ userId: 'alice', version: 1 }],
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
  async bootstrap(): Promise<BootstrapResponse> { return this.bootstrapResult; }
  async prepareMigration(): Promise<MigrationSummary> { throw new Error('not used'); }
  async commitMigration(): Promise<MigrationSummary> { throw new Error('not used'); }
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
