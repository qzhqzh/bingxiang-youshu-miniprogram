import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { seedIngredients } from '../../miniprogram/data/ingredients.js';
import { seedRecipes } from '../../miniprogram/data/recipes.js';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import { can } from '../src/rbac.js';
import { V2Service } from '../src/service.js';
import { defaultLimits, InMemoryV2Store } from '../src/store.js';
import type { LoginResult, SyncCommand } from '../src/types.js';
import { TestWechatIdentityProvider } from '../src/wechat.js';

const subjects = {
  alice: 'wx-alice', bob: 'wx-bob', carol: 'wx-carol', dave: 'wx-dave', erin: 'wx-erin',
};

function context(options: { now?: number; sessionTtlMs?: number; store?: InMemoryV2Store } = {}) {
  const clock = { value: options.now ?? Date.parse('2026-08-13T08:00:00.000Z') };
  const store = options.store ?? new InMemoryV2Store();
  const service = new V2Service(store, new TestWechatIdentityProvider(subjects), {
    appId: 'test-app-id',
    now: () => clock.value,
    ...(options.sessionTtlMs ? { sessionTtlMs: options.sessionTtlMs } : {}),
  });
  return { clock, store, service };
}

async function login(service: V2Service, code: keyof typeof subjects, device = `device-${code}`): Promise<LoginResult> {
  return service.loginWechat(code, device);
}

let sequence = 0;
function base<T extends SyncCommand['command']>(
  command: T,
  householdId: string,
  entityId: string,
  payload: Extract<SyncCommand, { command: T }>['payload'],
  baseVersion = 0,
): Extract<SyncCommand, { command: T }> {
  sequence += 1;
  return {
    command,
    householdId,
    entityId,
    payload,
    baseVersion,
    mutationId: `mutation-${sequence}`,
    deviceId: 'device-test',
    clientOccurredAt: '2026-08-13T08:00:00.000Z',
  } as Extract<SyncCommand, { command: T }>;
}

function purchase(householdId: string, entityId: string, ingredientId: string, quantity: number, purchasedAt = '2026-08-13') {
  const ingredient = seedIngredients.find((item) => item.id === ingredientId)!;
  const storageMode = ingredient.shelfLifeDays.chilled ? 'chilled' : 'room';
  return base('PurchaseBatch', householdId, entityId, {
    ingredientId, quantity, purchasedAt, storageMode, unit: ingredient.defaultUnit,
  });
}

function unlock(householdId: string, recipeId = 'steamed_egg') {
  return base('UnlockRecipe', householdId, `progress-${recipeId}`, { recipeId });
}

function cook(householdId: string, entityId: string, recipeId = 'steamed_egg', servings = 1) {
  return base('CompleteCooking', householdId, entityId, { recipeId, servings });
}

async function stockSteamedEgg(service: V2Service, accessToken: string, householdId: string, eggQuantity = 2, saltQuantity = 2) {
  await service.push(accessToken, purchase(householdId, `egg-${sequence + 1}`, 'egg', eggQuantity));
  await service.push(accessToken, purchase(householdId, `salt-${sequence + 1}`, 'salt', saltQuantity));
  await service.push(accessToken, unlock(householdId));
}

async function expectCode(action: () => unknown | Promise<unknown>, code: ApiError['code']) {
  await assert.rejects(async () => action(), (error: unknown) => error instanceof ApiError && error.code === code);
}

function exportSource(batchQuantity = 4): string {
  const now = Date.parse('2026-08-13T08:00:00.000Z');
  return JSON.stringify({
    ingredients: seedIngredients,
    recipes: seedRecipes,
    batches: [{
      id: 'legacy-egg', ingredientId: 'egg', quantity: batchQuantity, unit: 'piece', purchasedAt: '2026-08-12',
      storageMode: 'chilled', status: 'active', createdAt: now - 1_000, updatedAt: now - 1_000,
    }],
    progress: [],
    cookingRecords: [],
    shoppingList: [],
    settings: { freshnessReminderDays: 3, defaultStorageMode: 'chilled', favoriteRecipeIds: [] },
    meta: { version: 3, initializedAt: now - 10_000, purchasedIngredientIds: ['egg'] },
  });
}

describe('2.0 身份与会话', () => {
  it('1. 同一微信身份在不同设备映射到同一内部用户', async () => {
    const { service, store } = context();
    const first = await login(service, 'alice', 'phone');
    const second = await login(service, 'alice', 'tablet');
    assert.equal(first.user.id, second.user.id);
    assert.equal(store.users.size, 1);
    assert.equal(store.sessions.size, 2);
    assert.equal(second.households.length, 1);
  });

  it('2. 伪造、过期和撤销会话均不能访问', async () => {
    const { service, clock } = context({ sessionTtlMs: 100 });
    const account = await login(service, 'alice');
    await expectCode(() => service.me('fake-token'), 'UNAUTHENTICATED');
    clock.value += 101;
    await expectCode(() => service.me(account.accessToken), 'UNAUTHENTICATED');
    const fresh = await login(service, 'alice', 'another-device');
    service.logout(fresh.accessToken);
    await expectCode(() => service.me(fresh.accessToken), 'SESSION_REVOKED');
  });

  it('3. 会话列表不泄露 token 与设备指纹，并可按本人权限撤销', async () => {
    const { service } = context();
    const first = await login(service, 'alice', 'phone');
    const second = await login(service, 'alice', 'tablet');
    const sessions = service.listSessions(first.accessToken);
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((item) => !('tokenHash' in item) && !('deviceIdHash' in item)));
    const secondSession = [...service.store.sessions.values()].find((item) => item.id !== service.authenticate(first.accessToken).session.id)!;
    service.revokeSession(first.accessToken, secondSession.id);
    assert.ok(service.listSessions(first.accessToken).some((item) => item.id === secondSession.id && item.revokedAt));
    await expectCode(() => service.me(second.accessToken), 'SESSION_REVOKED');
  });
});

describe('2.0 家庭空间与 RBAC', () => {
  it('4. 四种角色的权限矩阵符合设计', () => {
    assert.equal(can('owner', 'household:transfer'), true);
    assert.equal(can('admin', 'members:role'), true);
    assert.equal(can('admin', 'household:transfer'), false);
    assert.equal(can('member', 'inventory:write'), true);
    assert.equal(can('member', 'members:invite'), false);
    assert.equal(can('viewer', 'household:read'), true);
    assert.equal(can('viewer', 'shopping:write'), false);
  });

  it('5. 邀请支持重复接受、过期和撤销防护', async () => {
    const { service, clock } = context();
    const owner = await login(service, 'alice');
    const member = await login(service, 'bob');
    const householdId = owner.households[0]!.id;
    const invitation = service.createInvitation(owner.accessToken, householdId, 'member', 2);
    const accepted = service.acceptInvitation(member.accessToken, invitation.token);
    assert.equal(service.acceptInvitation(member.accessToken, invitation.token).version, accepted.version);

    const expired = service.createInvitation(owner.accessToken, householdId);
    clock.value += defaultLimits.invitationTtlMs + 1;
    const carol = await login(service, 'carol');
    await expectCode(() => service.acceptInvitation(carol.accessToken, expired.token), 'CONFLICT');

    clock.value -= defaultLimits.invitationTtlMs + 1;
    const revoked = service.createInvitation(owner.accessToken, householdId);
    service.revokeInvitation(owner.accessToken, householdId, revoked.invitation.id);
    await expectCode(() => service.acceptInvitation(carol.accessToken, revoked.token), 'CONFLICT');
  });

  it('6. 家庭数量和成员数量上限由服务端强制执行', async () => {
    const store = new InMemoryV2Store({ ...defaultLimits, maxHouseholdsPerUser: 1, maxMembersPerHousehold: 1 });
    const { service } = context({ store });
    const owner = await login(service, 'alice');
    await expectCode(() => service.createHousehold(owner.accessToken, '第二个家'), 'VALIDATION_ERROR');
    const invite = service.createInvitation(owner.accessToken, owner.households[0]!.id);
    const member = await login(service, 'bob');
    await expectCode(() => service.acceptInvitation(member.accessToken, invite.token), 'VALIDATION_ERROR');
  });

  it('7. 跨家庭读取被租户边界拒绝', async () => {
    const { service } = context();
    const alice = await login(service, 'alice');
    const bob = await login(service, 'bob');
    await expectCode(() => service.bootstrap(bob.accessToken, alice.households[0]!.id), 'HOUSEHOLD_FORBIDDEN');
  });

  it('8. viewer 可读但不能写库存', async () => {
    const { service } = context();
    const owner = await login(service, 'alice');
    const viewer = await login(service, 'bob');
    const householdId = owner.households[0]!.id;
    const invite = service.createInvitation(owner.accessToken, householdId, 'viewer');
    service.acceptInvitation(viewer.accessToken, invite.token);
    assert.equal(service.bootstrap(viewer.accessToken, householdId).household.id, householdId);
    await expectCode(() => service.push(viewer.accessToken, purchase(householdId, 'viewer-egg', 'egg', 2)), 'HOUSEHOLD_FORBIDDEN');
  });

  it('9. 所有权转移保持恰好一个 owner', async () => {
    const { service, store } = context();
    const owner = await login(service, 'alice');
    const member = await login(service, 'bob');
    const householdId = owner.households[0]!.id;
    service.acceptInvitation(member.accessToken, service.createInvitation(owner.accessToken, householdId, 'admin').token);
    service.transferOwnership(owner.accessToken, householdId, member.user.id);
    const active = store.activeMembers(householdId);
    assert.equal(active.filter((item) => item.role === 'owner').length, 1);
    assert.equal(active.find((item) => item.userId === owner.user.id)?.role, 'admin');
  });
});

describe('2.0 同步、冲突与库存事务', () => {
  it('10. mutationId 重放只生效一次并返回原 canonical', async () => {
    const { service, store } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    const command = purchase(householdId, 'idem-egg', 'egg', 6);
    const first = await service.push(account.accessToken, command);
    const replay = await service.push(account.accessToken, command);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(store.batches.size, 1);
    assert.equal(store.movements.size, 1);
  });

  it('11. 可编辑对象使用 baseVersion 检测冲突并产生 tombstone', async () => {
    const { service } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    const added = await service.push(account.accessToken, base('AddShoppingItem', householdId, 'shop-1', {
      ingredientId: 'egg', suggestedQuantity: 6, unit: 'piece',
    }));
    await service.push(account.accessToken, base('CheckShoppingItem', householdId, 'shop-1', { checked: true }, 1));
    await expectCode(
      () => service.push(account.accessToken, base('CheckShoppingItem', householdId, 'shop-1', { checked: false }, 1)),
      'VERSION_CONFLICT',
    );
    const removed = await service.push(account.accessToken, base('RemoveShoppingItem', householdId, 'shop-1', {}, 2));
    assert.equal((removed.canonical as { version: number }).version, 3);
    assert.ok(service.pull(account.accessToken, householdId, 0).changes.some((item) => item.operation === 'delete'));
    assert.equal((added.canonical as { checked: boolean }).checked, false);
  });

  it('12. 做菜按 FEFO 跨批次扣减并保留不可变流水', async () => {
    const { service, store } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    await service.push(account.accessToken, purchase(householdId, 'egg-old', 'egg', 1, '2026-08-01'));
    await service.push(account.accessToken, purchase(householdId, 'egg-new', 'egg', 3, '2026-08-12'));
    await service.push(account.accessToken, purchase(householdId, 'salt-stock', 'salt', 10, '2026-08-01'));
    await service.push(account.accessToken, unlock(householdId));
    const result = await service.push(account.accessToken, cook(householdId, 'cook-fefo'));
    const consumptions = (result.canonical as { consumptions: Array<{ pantryBatchId: string; quantity: number }> }).consumptions;
    assert.deepEqual(consumptions.filter((item) => item.pantryBatchId.startsWith('egg')).map((item) => item.quantity), [1, 1]);
    assert.equal(store.batches.get('egg-old')?.quantity, 0);
    assert.equal(store.batches.get('egg-new')?.quantity, 2);
    assert.equal([...store.movements.values()].filter((item) => item.type === 'cook_consume').length, 3);
  });

  it('13. 两个并发做菜命令不会把库存扣成负数或生成半条记录', async () => {
    const { service, store } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    await stockSteamedEgg(service, account.accessToken, householdId, 2, 1);
    const settled = await Promise.allSettled([
      service.push(account.accessToken, cook(householdId, 'cook-concurrent-a')),
      service.push(account.accessToken, cook(householdId, 'cook-concurrent-b')),
    ]);
    assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((item) => item.status === 'rejected').length, 1);
    assert.ok([...store.batches.values()].every((item) => item.quantity >= 0));
    assert.equal(store.cookingRecords.size, 1);
  });

  it('14. 成员被移除后，离线 Outbox 命令返回 MEMBERSHIP_CHANGED', async () => {
    const { service } = context();
    const owner = await login(service, 'alice');
    const member = await login(service, 'bob');
    const householdId = owner.households[0]!.id;
    service.acceptInvitation(member.accessToken, service.createInvitation(owner.accessToken, householdId).token);
    const queued = purchase(householdId, 'offline-egg', 'egg', 4);
    service.removeMember(owner.accessToken, householdId, member.user.id);
    await expectCode(() => service.push(member.accessToken, queued), 'MEMBERSHIP_CHANGED');
  });

  it('15. pull 支持分页、单调 cursor 和过旧游标完整重同步信号', async () => {
    const { service, store } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    await service.push(account.accessToken, purchase(householdId, 'cursor-egg', 'egg', 2));
    const page1 = service.pull(account.accessToken, householdId, 0, 1);
    const page2 = service.pull(account.accessToken, householdId, page1.nextCursor, 500);
    assert.equal(page1.hasMore, true);
    assert.ok(page2.nextCursor > page1.nextCursor);
    store.compactBefore(householdId, page2.nextCursor);
    await expectCode(() => service.pull(account.accessToken, householdId, 0), 'FULL_RESYNC_REQUIRED');
  });

  it('16. 食谱进度和偏好按用户隔离，偏好同时执行版本控制', async () => {
    const { service } = context();
    const owner = await login(service, 'alice');
    const member = await login(service, 'bob');
    const householdId = owner.households[0]!.id;
    service.acceptInvitation(member.accessToken, service.createInvitation(owner.accessToken, householdId).token);
    await service.push(member.accessToken, unlock(householdId));
    const ownerProgress = service.bootstrap(owner.accessToken, householdId).recipeProgress.find((item) => item.recipeId === 'steamed_egg');
    const memberProgress = service.bootstrap(member.accessToken, householdId).recipeProgress.find((item) => item.recipeId === 'steamed_egg');
    assert.equal(ownerProgress?.status, 'unlockable');
    assert.equal(memberProgress?.status, 'mastered');
    await service.push(member.accessToken, base('UpdatePreferences', householdId, member.user.id, { freshnessReminderDays: 5 }, 0));
    await expectCode(
      () => service.push(member.accessToken, base('UpdatePreferences', householdId, member.user.id, { freshnessReminderDays: 6 }, 0)),
      'VERSION_CONFLICT',
    );
    assert.equal(service.bootstrap(owner.accessToken, householdId).preferences.freshnessReminderDays, 3);
  });
});

describe('2.0 显式迁移与 HTTP 契约', () => {
  it('17. v1 数据先预检再提交，重复提交幂等且核对数量一致', async () => {
    const { service, store } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    const source = exportSource();
    const prepared = service.prepareV1Migration(account.accessToken, householdId, 'import-1', source);
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.batchCount, 1);
    const committed = await service.commitV1Migration(account.accessToken, householdId, 'import-1', source);
    const repeated = await service.commitV1Migration(account.accessToken, householdId, 'import-1', source);
    assert.equal(committed.status, 'committed');
    assert.deepEqual(repeated, committed);
    assert.equal(store.batches.get('legacy-egg')?.quantity, 4);
    assert.equal(service.migrationStatus(account.accessToken, 'import-1').checksum, prepared.checksum);
  });

  it('18. 损坏数据及已有共享数据的目标家庭不会被迁移覆盖', async () => {
    const { service, store } = context();
    const account = await login(service, 'alice');
    const householdId = account.households[0]!.id;
    assert.throws(() => service.prepareV1Migration(account.accessToken, householdId, 'bad', '{oops'));
    assert.equal(store.migrations.size, 0);
    await service.push(account.accessToken, purchase(householdId, 'existing', 'egg', 2));
    const source = exportSource();
    service.prepareV1Migration(account.accessToken, householdId, 'import-occupied', source);
    await expectCode(() => service.commitV1Migration(account.accessToken, householdId, 'import-occupied', source), 'CONFLICT');
    assert.equal(store.batches.size, 1);
  });

  it('19. Fastify API 返回版本化路由、统一错误体并接受 Bearer 会话', async () => {
    const { service } = context();
    const app = buildApp(service);
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    const unauthorized = await app.inject({ method: 'GET', url: '/v2/me' });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.json().error.code, 'UNAUTHENTICATED');
    const auth = await app.inject({ method: 'POST', url: '/v2/auth/wechat', payload: { code: 'alice', deviceId: 'api-phone' } });
    assert.equal(auth.statusCode, 200);
    const token = auth.json().accessToken as string;
    const me = await app.inject({ method: 'GET', url: '/v2/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().id, auth.json().user.id);
    await app.close();
  });

  it('30. HTTP schema 在进入身份服务前拒绝缺失字段和额外字段', async () => {
    const { service, store } = context();
    const app = buildApp(service);
    const missing = await app.inject({ method: 'POST', url: '/v2/auth/wechat', payload: { code: 'alice' } });
    const extra = await app.inject({
      method: 'POST', url: '/v2/auth/wechat', payload: { code: 'alice', deviceId: 'phone', unexpected: true },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(extra.statusCode, 400);
    assert.equal(missing.json().error.code, 'VALIDATION_ERROR');
    assert.equal(store.users.size, 0);
    await app.close();
  });

  it('31. 非法同步命令由运行时契约拒绝且不产生库存事实', async () => {
    const { service, store } = context();
    const app = buildApp(service);
    const auth = await app.inject({ method: 'POST', url: '/v2/auth/wechat', payload: { code: 'alice', deviceId: 'phone' } });
    const householdId = auth.json().households[0].id as string;
    const response = await app.inject({
      method: 'POST',
      url: '/v2/sync/push',
      headers: { authorization: `Bearer ${auth.json().accessToken as string}` },
      payload: {
        mutationId: 'bad-purchase', deviceId: 'phone', householdId, command: 'PurchaseBatch', entityId: 'bad-batch',
        baseVersion: 0, clientOccurredAt: '2026-08-13T01:00:00.000Z',
        payload: { ingredientId: 'egg', quantity: -1, unit: '枚', purchasedAt: '2026-08-13', storageMode: 'chilled' },
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.equal(store.batches.size, 0);
    assert.equal(store.movements.size, 0);
    await app.close();
  });

  it('32. 超大请求在解析领域数据前返回统一 413 错误', async () => {
    const { service } = context();
    const app = buildApp(service);
    const response = await app.inject({
      method: 'POST',
      url: '/v2/migrations/v1/prepare',
      headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
      payload: JSON.stringify({ householdId: 'home', importBatchId: 'large', source: 'x'.repeat(2_200_000) }),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.equal(response.json().error.message, '请求内容超过允许大小');
    await app.close();
  });
});
