import type {
  CloudAuthState,
  DeviceIdentity,
  HouseholdEnvelope,
  LocalConflict,
  OutboxItem,
  SyncChange,
  SyncCommand,
} from '../../v2/models';

const DEVICE_KEY = 'pantry:v2:device';
const AUTH_KEY = 'pantry:v2:user';
const HOUSEHOLD_PREFIX = 'pantry:v2:household:';
const MIGRATION_BACKUP_PREFIX = 'pantry:v2:migrationBackup:';

export interface StorageAdapter {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
}

class WechatStorageAdapter implements StorageAdapter {
  get<T>(key: string): T | undefined { return wx.getStorageSync(key) || undefined; }
  set<T>(key: string, value: T): void { wx.setStorageSync(key, value); }
  remove(key: string): void { wx.removeStorageSync(key); }
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function emptyEnvelope(householdId: string, now: number): HouseholdEnvelope {
  return {
    schemaVersion: 2,
    householdId,
    revision: 0,
    cursor: 0,
    catalogVersion: 0,
    entities: {},
    outbox: [],
    conflicts: [],
    updatedAt: now,
  };
}

export class LocalV2Repository {
  constructor(private readonly storage: StorageAdapter = new WechatStorageAdapter(), private readonly now: () => number = Date.now) {}

  device(): DeviceIdentity {
    const existing = this.storage.get<DeviceIdentity>(DEVICE_KEY);
    if (existing?.deviceId) return existing;
    const created = { deviceId: randomId('device'), createdAt: this.now() };
    this.storage.set(DEVICE_KEY, created);
    return created;
  }

  auth(): CloudAuthState {
    return this.storage.get<CloudAuthState>(AUTH_KEY) ?? { mode: 'guest', households: [] };
  }

  saveAuth(auth: CloudAuthState): void { this.storage.set(AUTH_KEY, auth); }

  clearAuth(): void { this.storage.set<CloudAuthState>(AUTH_KEY, { mode: 'guest', households: [] }); }

  envelope(householdId: string): HouseholdEnvelope {
    const stored = this.storage.get<HouseholdEnvelope>(this.householdKey(householdId));
    return stored ?? emptyEnvelope(householdId, this.now());
  }

  mutateEnvelope(householdId: string, mutate: (current: HouseholdEnvelope) => HouseholdEnvelope): HouseholdEnvelope {
    const previous = this.envelope(householdId);
    const draft = JSON.parse(JSON.stringify(previous)) as HouseholdEnvelope;
    const changed = mutate(draft);
    if (changed.householdId !== householdId || changed.schemaVersion !== 2) throw new Error('家庭同步信封无效');
    const next = { ...changed, revision: previous.revision + 1, updatedAt: this.now() };
    // 单个 storage key 是本地事务边界；snapshot/outbox/cursor/conflicts 不分开写。
    this.storage.set(this.householdKey(householdId), next);
    return next;
  }

  enqueue(command: SyncCommand): HouseholdEnvelope {
    return this.mutateEnvelope(command.householdId, (current) => {
      if (current.outbox.some((item) => item.command.mutationId === command.mutationId)) return current;
      const item: OutboxItem = {
        command,
        state: 'pending',
        attemptCount: 0,
        nextAttemptAt: this.now(),
        createdAt: this.now(),
      };
      return { ...current, outbox: [...current.outbox, item] };
    });
  }

  markSending(householdId: string, mutationId: string): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => ({
      ...current,
      outbox: current.outbox.map((item) => item.command.mutationId === mutationId
        ? { ...item, state: 'sending', attemptCount: item.attemptCount + 1 }
        : item),
    }));
  }

  acknowledge(householdId: string, mutationId: string): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => ({
      ...current,
      outbox: current.outbox.filter((item) => item.command.mutationId !== mutationId),
    }));
  }

  retryLater(householdId: string, mutationId: string, errorCode: string, delayMs: number): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => ({
      ...current,
      outbox: current.outbox.map((item) => item.command.mutationId === mutationId
        ? { ...item, state: 'pending', nextAttemptAt: this.now() + delayMs, lastErrorCode: errorCode }
        : item),
    }));
  }

  recordConflict(householdId: string, conflict: LocalConflict): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => ({
      ...current,
      outbox: current.outbox.map((item) => item.command.mutationId === conflict.mutationId
        ? { ...item, state: 'conflict', lastErrorCode: conflict.type }
        : item),
      conflicts: current.conflicts.some((item) => item.mutationId === conflict.mutationId)
        ? current.conflicts
        : [...current.conflicts, conflict],
    }));
  }

  applyChanges(householdId: string, changes: SyncChange[], nextCursor: number, catalogVersion: number): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => {
      if (nextCursor < current.cursor) throw new Error('同步游标不能倒退');
      const entities = { ...current.entities };
      changes.forEach((change) => {
        if (change.householdId !== householdId || change.cursor <= current.cursor) return;
        const bucket = { ...(entities[change.entityType] ?? {}) };
        const existing = bucket[change.entityId];
        if (!existing || change.version >= existing.version) {
          bucket[change.entityId] = {
            version: change.version,
            deleted: change.operation === 'delete',
            value: change.payload,
          };
        }
        entities[change.entityType] = bucket;
      });
      return { ...current, entities, cursor: nextCursor, catalogVersion };
    });
  }

  replaceSnapshot(householdId: string, changes: SyncChange[], nextCursor: number, catalogVersion: number): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => {
      const entities: HouseholdEnvelope['entities'] = {};
      changes.forEach((change) => {
        if (change.householdId !== householdId) return;
        const bucket = { ...(entities[change.entityType] ?? {}) };
        const existing = bucket[change.entityId];
        if (!existing || change.version >= existing.version) {
          bucket[change.entityId] = {
            version: change.version,
            deleted: change.operation === 'delete',
            value: change.payload,
          };
        }
        entities[change.entityType] = bucket;
      });
      return {
        ...emptyEnvelope(householdId, this.now()),
        entities,
        cursor: nextCursor,
        catalogVersion,
        outbox: current.outbox,
        conflicts: current.conflicts,
      };
    });
  }

  resetForFullSync(householdId: string): HouseholdEnvelope {
    return this.mutateEnvelope(householdId, (current) => ({
      ...emptyEnvelope(householdId, this.now()),
      outbox: current.outbox,
      conflicts: current.conflicts,
    }));
  }

  saveMigrationBackup(importBatchId: string, source: string): void {
    this.storage.set(`${MIGRATION_BACKUP_PREFIX}${importBatchId}`, source);
  }

  migrationBackup(importBatchId: string): string | null {
    return this.storage.get<string>(`${MIGRATION_BACKUP_PREFIX}${importBatchId}`) ?? null;
  }

  private householdKey(householdId: string): string { return `${HOUSEHOLD_PREFIX}${householdId}`; }
}
