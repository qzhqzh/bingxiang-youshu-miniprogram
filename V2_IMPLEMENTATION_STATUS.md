# 冰箱有数 2.0 实现状态

更新时间：2026-08-13
当前阶段：`2.0.0-alpha.12`，Django + SQLite 后台已可在本地真实迁移和测试；**部署按用户要求等待最终域名与服务器方案，小程序正式云开关仍关闭**。

本文用代码证据区分“已经完成”“已实现但尚未生产化”和“尚未实现”，避免把设计文档误读成上线事实。2.0 的完整目标仍以 [`V2_MULTI_USER_SYNC_DESIGN.md`](./V2_MULTI_USER_SYNC_DESIGN.md) 为准。

## 已完成

| 能力 | 当前证据 |
|---|---|
| 游客模式默认可用，不自动登录/联网 | `cloudSyncEnabled: false`；1.x 页面和本地 Repository 保持不变 |
| 内部用户、微信身份、设备会话 | [`server/src/service.ts`](./server/src/service.ts)、[`server/src/wechat.ts`](./server/src/wechat.ts) |
| 家庭空间与 owner/admin/member/viewer RBAC | [`server/src/rbac.ts`](./server/src/rbac.ts) |
| 邀请、撤销、过期、次数与成员上限 | [`server/src/service.ts`](./server/src/service.ts) |
| mutation 幂等、cursor pull、tombstone、完整重同步信号 | [`server/src/store.ts`](./server/src/store.ts)、[`server/src/service.ts`](./server/src/service.ts) |
| 服务端 FEFO 跨批次扣减与并发串行化 | [`server/src/service.ts`](./server/src/service.ts) |
| v1 显式预检/确认迁移、checksum、重复提交幂等 | [`server/src/service.ts`](./server/src/service.ts) |
| 小程序 v2 原子家庭信封 | [`miniprogram/repositories/local/local-v2.repository.ts`](./miniprogram/repositories/local/local-v2.repository.ts) |
| Outbox、退避、冲突箱、分页 pull、全量重建 | [`miniprogram/services/cloud/sync-coordinator.ts`](./miniprogram/services/cloud/sync-coordinator.ts) |
| 小程序 8 类云命令统一入口、原子乐观视图、回滚前像和 canonical 冲突恢复 | [`miniprogram/services/cloud/cloud-command.service.ts`](./miniprogram/services/cloud/cloud-command.service.ts)、[`miniprogram/repositories/local/local-v2.repository.ts`](./miniprogram/repositories/local/local-v2.repository.ts) |
| uv + Django 5.2 + SQLite 后台、真实 migration、限流、注销与一致性备份 | [`backend/`](./backend)、[`V2_DJANGO_SQLITE_ADR.md`](./V2_DJANGO_SQLITE_ADR.md) |
| 版本化 HTTP 路由和统一错误体 | [`server/src/app.ts`](./server/src/app.ts) |
| HTTP 严格运行时 schema、2 MiB 迁移上限与统一 400/413 | [`server/src/http-schema.ts`](./server/src/http-schema.ts)、[`server/src/app.ts`](./server/src/app.ts) |
| 可异步注入的服务契约 | [`server/src/api-service.ts`](./server/src/api-service.ts) |
| OpenAPI 初版契约 | [`server/openapi.yaml`](./server/openapi.yaml) |
| PostgreSQL 初版 schema 与约束 | [`server/db/migrations/0001_v2_core.sql`](./server/db/migrations/0001_v2_core.sql) |
| PostgreSQL `SERIALIZABLE` mutation 执行器、幂等/cursor/变更同事务与做菜批次锁 | [`server/src/postgres/mutation-executor.ts`](./server/src/postgres/mutation-executor.ts) |
| PostgreSQL 哈希会话鉴权、租户限定 bootstrap/pull 与一致性只读快照 | [`server/src/postgres/query-store.ts`](./server/src/postgres/query-store.ts) |
| PostgreSQL 微信身份登录、默认家庭原子创建、资料与安全设备会话 | [`server/src/postgres/identity-service.ts`](./server/src/postgres/identity-service.ts) |
| PostgreSQL 家庭/成员/邀请事务、配额锁、唯一 owner 转移与审计 | [`server/src/postgres/household-service.ts`](./server/src/postgres/household-service.ts) |
| PostgreSQL 8 类同步命令、FEFO 做菜事实、版本冲突与幂等提交 | [`server/src/postgres/sync-service.ts`](./server/src/postgres/sync-service.ts) |
| PostgreSQL 脱敏导出、注销冷静期/取消、到期 worker 与匿名化审计 | [`server/src/postgres/privacy-service.ts`](./server/src/postgres/privacy-service.ts) |
| PostgreSQL v1 预检/确认迁移、checksum、空目标保护、事实重建与原子回滚 | [`server/src/postgres/migration-service.ts`](./server/src/postgres/migration-service.ts) |
| 完整 PostgreSQL API 组合、生产环境禁用内存降级、启动 migration/关键表预检与连接池关闭 | [`server/src/postgres/service.ts`](./server/src/postgres/service.ts)、[`server/src/runtime.ts`](./server/src/runtime.ts) |
| 独立账号注销 worker、防重入调度、失败重试、停机排空与多副本数据库锁 | [`server/src/deletion-worker.ts`](./server/src/deletion-worker.ts)、[`server/src/workers/account-deletion-worker.ts`](./server/src/workers/account-deletion-worker.ts) |
| 小程序“家庭与云同步”状态/双重迁移确认页 | [`miniprogram/pages/cloud-sync/index.wxml`](./miniprogram/pages/cloud-sync/index.wxml) |
| 冲突中心、显式重试/取消与成员变化永久拒绝 | [`miniprogram/pages/sync-conflicts/index.wxml`](./miniprogram/pages/sync-conflicts/index.wxml)、[`miniprogram/repositories/local/local-v2.repository.ts`](./miniprogram/repositories/local/local-v2.repository.ts) |
| 家庭创建/切换/接受邀请与切换前原子下载 | [`miniprogram/pages/households/index.wxml`](./miniprogram/pages/households/index.wxml)、[`miniprogram/services/cloud/cloud-sync.service.ts`](./miniprogram/services/cloud/cloud-sync.service.ts) |
| 成员列表、邀请分享、角色调整、移除与所有权转移 | [`miniprogram/pages/household-members/index.wxml`](./miniprogram/pages/household-members/index.wxml)、[`miniprogram/services/cloud/remote-sync.gateway.ts`](./miniprogram/services/cloud/remote-sync.gateway.ts) |
| 可替换接口限流、哈希桶键、429 与 Retry-After | [`server/src/rate-limit.ts`](./server/src/rate-limit.ts)、[`server/src/app.ts`](./server/src/app.ts) |
| 脱敏个人数据导出、注销冷静期/取消/执行与匿名共享审计 | [`server/src/service.ts`](./server/src/service.ts)、[`server/db/migrations/0002_privacy_jobs.sql`](./server/db/migrations/0002_privacy_jobs.sql) |
| “数据与账号”页面及云端账号网关 | [`miniprogram/pages/account-data/index.wxml`](./miniprogram/pages/account-data/index.wxml)、[`miniprogram/services/cloud/cloud-sync.service.ts`](./miniprogram/services/cloud/cloud-sync.service.ts) |

## 已实现但尚未生产化

- 新 Django 后台已使用真实 SQLite migration 完成身份/会话、家庭协作、8 类同步命令、数据权利和 v1 两阶段完整迁移测试。单机首发只运行一个应用 worker，旧 PostgreSQL 实现保留为未来扩容参考。
- 小程序 Remote Gateway 已实现 `wx.login`、Bearer API、push/pull 和迁移调用；正式配置保持关闭，API 域名为空，等待最终域名后联调。
- 2.0 同步、冲突、家庭和成员页面已可在开发包查看，但登录按钮在未配置生产环境时只解释当前状态，不会发出网络请求。
- v2 信封和云命令服务可以可靠管理远端实体、8 类写操作、Outbox、乐观状态和冲突；现有 1.x 页面仍使用本地 `AppService`，真实云模式需要在预发验证后再按配置选择数据源。
- Django schema migration 与 v1 用户数据迁移已在真实 SQLite 测试库执行；生产数据备份恢复和并发压力仍待最终部署环境演练。
- 数据导出与注销流程已在内存领域服务、HTTP、客户端、PostgreSQL schema 和独立生产 worker 层实现；加密对象存储、导出到期物理清理和备份删除边界尚未联调。
- 当前 Django 限流器是单进程实现，与 SQLite 单 worker 首发边界一致；多进程或多 VPS 前必须迁移共享限流和 PostgreSQL。

## 尚未实现

1. SQLite 多线程写入压力、断电恢复、备份还原和磁盘耗尽演练；超过单 worker 边界时迁移 PostgreSQL。
2. 结构化脱敏日志、指标与存活告警；多实例前增加共享限流。
3. access token 轮换/续期；导出加密存储、到期物理清理与注销删除恢复演练。注销 worker 进程与停机排空已实现。
4. 小程序主业务页面按游客/云模式选择本地 `AppService` 或云命令/远端 canonical 视图；命令总线已完成，页面模式路由尚未接入。
5. 运营后台前端、客服受控操作、审计查询和双人审批。
6. 生产/预发环境、HTTPS API 域名、备份恢复演练、告警和灾难恢复。
7. 两台真实设备并发、弱网/断网、成员移除和大数据量回归。
8. 隐私协议最终文本、服务类目确认、微信隐私保护指引申报和主体合规复核。

## 自动验证

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run check
pnpm run release:check
```

当前结果：

- 1.x：19 项领域与闭环测试通过。
- TypeScript 2.0：75 项测试通过。
- Django + SQLite 后台：26 项测试通过，语句覆盖率 89%。
- 合计：120 项测试通过。
- 小程序与服务端 TypeScript 严格检查通过。
- 14 个小程序页面、137 个小程序文件通过静态检查。
- OpenAPI、运行时 schema、数据库关键约束和 PostgreSQL 事务边界通过契约检查。
- 同步状态、冲突中心、家庭空间、家庭成员和数据与账号页面已在微信开发者工具中完成专项渲染回归；结束后普通编译首页正常。
- 提审配置保持 `devSeed=false`、`cloudSyncEnabled=false`，不会自动登录或联网。

## 进入真实联调前的最小外部条件

- 微信小程序 AppID（已有）及管理员/开发者权限。
- AppSecret：仅写入服务端密钥管理，不进入仓库、小程序包或聊天记录。
- 已备案、可配置 HTTPS 证书的 API 域名，并加入微信 request 合法域名。
- 最终 VPS 持久数据目录、独立备份目录和 HTTPS API 域名；SQLite 首发不需要额外数据库服务。
- 主体、服务类目、用户隐私保护指引、隐私政策与注销/导出处理口径。

满足这些条件后，仍应先完成 SQLite 备份恢复、并发压力和双设备预发验证，不能直接把当前 Alpha 开关改为 `true` 后提交生产。
