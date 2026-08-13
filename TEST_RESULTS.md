# 冰箱有数测试与工程检查结果

执行日期：2026-08-13（Asia/Shanghai）

## 命令

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run check
pnpm run release:check:placeholder
```

## 结果

- TypeScript 严格类型检查：通过，0 错误。
- Node 测试：11 个套件，15 个场景；15 passed，0 failed，0 skipped。
- 静态工程检查：通过；9 个页面、9 个页面控制器、109 个小程序文件。
- JSON/WXML：全部 JSON 可解析；WXML 标签均为支持标签且正确闭合。
- 架构边界：页面及非 LocalRepository 代码没有直接调用微信 Storage。
- 资源：所有源码引用的本地图片均存在。
- 发布预检：通过；`devSeed=false`，主包约 228.7 KiB，无登录、网络请求或云端调用。
- AppID：已写入所有者微信开发者平台项目中的真实 AppID `wxc62caa8eb9379ed4`，可执行正式发布门禁。

## 官方微信开发者工具实测

- 工具版本：微信开发者工具 RC 2.02.2607271；使用工具内置测试号完成导入与编译。
- 最终普通编译：通过；问题面板 0 个问题，未发现小程序运行错误。
- 页面冒烟：首页、购入食材、仓库、食材详情、食谱库、“我的”均正常渲染。
- 本地闭环：购入 6 枚鸡蛋后，首页库存种类从 0 更新为 1，食谱可用度由 0/2 更新为 1/2；仓库显示 6 枚、1 个批次，详情页显示正确剩余量与新鲜状态。
- 调试控制台只有开发者工具自身的灰度基础库、预加载及 worker 能力提示，不包含应用业务异常。
- 内置测试号只用于首轮模拟器验证；当前工程已替换为所有者项目的真实 AppID，仍未包含 AppSecret 或上传私钥。
- 真实 AppID 复验：重新打开项目以加载 `wxc62caa8eb9379ed4`，普通编译通过；首页正常渲染，问题面板 0 个问题，上传入口可进入。
- 正式代码上传：版本 `1.0.0` 于 2026-08-12 通过官方开发者工具上传成功；工具明确显示“代码上传成功”。上传说明为“食仓 1.0.0：食材批次库存、新鲜度提醒、食谱解锁、FEFO 做菜扣减与购物清单闭环。”
- 上传排除项：开发者工具提示 SourceMap 中有 3 个无依赖文件未上传，均为 CloudRepository 预留实现/类型文件，不影响首版纯本地运行。

## 1.1.0 品牌升级复验

- 产品名、工程名和全局导航已统一为“冰箱有数”，推荐仓库名为 `bingxiang-youshu-miniprogram`。
- 新版冰箱图标已落地为本地资源 `miniprogram/assets/png/app-logo-v2.png`；首页、“我的”页、分享标题和主要用户文案已完成升级。
- TypeScript 严格检查：通过，0 错误。
- Node 测试：15 passed，0 failed，0 skipped。
- 静态工程检查：通过；9 个页面、9 个页面控制器、110 个小程序文件。
- 发布门禁：通过；品牌为“冰箱有数”，AppID 为 `wxc62caa8eb9379ed4`，`devSeed=false`，主包约 477.3 KiB，无登录、网络请求或云端调用。
- 微信开发者工具热更新实测：首页和“我的”页均正确显示新名称、配色、图标及本地数据说明；问题面板为 0。
- 为保证已有 1.0 本地数据可继续读取，Storage key 保持 `pantry:v1:*` 不变。
- 原“食仓”1.0.0 上传记录保留；品牌升级版 `1.1.0` 已于 2026-08-12 通过官方微信开发者工具上传成功，并自动覆盖原体验版。
- 1.1.0 上传说明为“冰箱有数 1.1.0：品牌升级，优化首页、我的与分享体验；保留食材批次、新鲜度、食谱匹配、FEFO 扣减和购物清单闭环。”
- 开发者工具再次提示 3 个无依赖的 SourceMap 文件未上传，均为纯类型或 CloudRepository 预留文件，不影响运行。

## 已覆盖测试类型

1. freshness 四种边界状态与非法日期。
2. 同一食材多个 active 批次聚合。
3. FEFO 跨两个批次扣减及同到期日 tie-break。
4. 可选配料不足不影响 availability。
5. 必选配料不足时 missing list 精确计算。
6. starter 食谱为 unlockable，主动解锁后才 mastered。
7. prerequisite 与历史入库 inventory 规则状态变化。
8. 完成烹饪生成 CookingRecord、扣批次、consumed 与 cookCount。
9. Service 层“解锁 → 做菜 → 写记录”闭环。
10. “食谱缺料 → 购物清单 → 转购入 → 仓库”闭环。
11. 30 种食材/16 道食谱 seed 的 ID 与引用完整性。

## 1.2.0 本地体验收口复验

- JSON 导入：支持格式、字段、ID 唯一性、食材/食谱/批次引用和核心数值校验；损坏数据不会覆盖当前快照。
- 导入回退：导入前自动保存完整备份；恢复时将恢复前数据再保存为新备份。
- 快捷购入：最近购入返回上次数量和保存方式，常用数量按单位生成。
- 食谱发现：支持菜名、食材和标签搜索，支持库存齐全与收藏筛选。
- seed 食谱由 10 道扩充到 16 道，已有数据通过稳定 ID 自动合并新目录。
- Node 测试：14 个套件，19 个场景；19 passed，0 failed，0 skipped。
- TypeScript、静态工程检查和发布门禁均通过；共 9 个页面、9 个页面控制器、111 个小程序文件。
- 正式主包约 392.0 KiB；`app-logo-v2.png` 已在保持透明 PNG 与清晰显示的前提下优化至 200 KiB 以下。
- 正式 Git 仓库已作为新项目导入微信开发者工具；空仓库冷启动、食谱列表、关键词搜索、收藏与“我的收藏”筛选、“我的”JSON 导入入口、购入页常用数量均正常。
- 页面组件改为相对路径声明，微信开发者工具灰度基础库 3.17.0 下问题面板为 0；控制台仅有工具自身的灰度基础库/预加载提示。
- 2026-08-13 前两次发起 1.2.0 上传时，微信上传通道返回 `Error: read ECONNRESET [2.02.2607271][win32-x64]`；第三次重试成功，开发者工具明确显示“代码上传成功”，并按提示覆盖原体验版。
- 当前仍无登录、网络或云端调用。

## 2.0.0-alpha.1 家庭协作与事务边界复验

执行命令：

```bash
pnpm run typecheck
pnpm test
pnpm run check
pnpm run release:check
```

- 1.x：19 项领域与本地业务闭环测试通过。
- 2.0：38 项身份、会话、RBAC、租户隔离、幂等、同步、冲突、并发 FEFO、迁移、HTTP schema、家庭切换和 PostgreSQL 事务边界测试通过。
- 合计：57 passed，0 failed，0 skipped；小程序与服务端 TypeScript 严格检查均为 0 错误。
- 全量快照额外覆盖初始 `cursor=0`，快照、Outbox 与 conflicts 在同一个本地原子写入中切换。
- HTTP 运行时校验覆盖缺失字段、额外字段、非法负数和超过 2 MiB 的迁移请求；非法请求不会进入领域服务。
- PostgreSQL 执行器测试覆盖 `SERIALIZABLE`、家庭与 mutation advisory lock、幂等重放、失败回滚、同事务 cursor/变更日志，以及做菜候选批次 `FOR UPDATE` 后的 FEFO 分配。
- 静态检查：13 个页面、13 个页面控制器、132 个小程序文件；JSON、WXML、资源和 Repository 存储边界均通过。
- 2.0 契约门禁：OpenAPI、运行时 schema、PostgreSQL 核心表与非负库存/唯一 owner/幂等键约束、事务边界均通过。
- 发布安全门禁：`devSeed=false`、`cloudSyncEnabled=false`、API 地址为空；`wx.login` 和 `wx.request` 只存在于关闭状态的远端网关。
- 微信开发者工具 RC 2.02.2607271 普通编译通过：首页、“我的”和新增“家庭与云同步”页正常渲染；首次切页存在约 10–15 秒的工具渲染延迟，等待后内容完整出现。
- 新增“同步冲突”页通过专项启动路径与普通编译入口两次实测，空状态文案、图标和返回导航正常；云同步页原生入口可达。
- 新增“家庭空间”和“家庭成员”页分别通过专项启动路径实测；游客提示、安全禁用状态和返回导航正常。家庭成员页首次增量编译等待较久，完整刷新后内容正常且无业务错误。
- 专项验证结束后已切回普通编译，首页再次正常渲染。
- 在云同步关闭状态点击登录，只显示“云同步尚未开放”提示，未产生业务网络请求；调试控制台未发现应用业务异常。
- `release:check` 结果：品牌=冰箱有数，AppID=`wxc62caa8eb9379ed4`，`devSeed=false`，`cloudSyncEnabled=false`，主包约 456.4 KiB。
- 该 Alpha 未上传微信平台；稳定体验版仍为已上传的 1.2.0。

## 2.0.0-alpha.2 数据权利与接口防护复验

- 全量结果：1.x 19 项 + 2.0 44 项，共 63 passed，0 failed，0 skipped；小程序与服务端 TypeScript 严格检查 0 错误。
- 接口限流：登录、邀请、同步 push、迁移、导出和注销均接入可替换限流契约；相同 IP/设备超额返回 429 与 `Retry-After`，不同设备桶隔离，测试证明桶 key 不含原始 IP/设备 ID。
- 数据导出：只包含当前用户可读的家庭共享事实和本人进度/偏好；回归验证不包含 providerSubject、access token、设备原始 ID、token/device hash 字段。
- 账号注销：回归覆盖 owner 前置阻止、所有权转移、其他会话撤销、受限会话贯穿冷静期、取消恢复、到期执行、身份映射删除、个人设置删除与共享做菜操作者匿名保留。
- PostgreSQL migration 新增 `data_export_jobs`、`account_deletion_requests`、单用户唯一 pending 约束与到期扫描索引；尚未在真实 PostgreSQL 实例执行。
- 小程序新增“数据与账号”页；Remote Gateway 与 Service 已接入导出、注销状态、申请和取消接口。
- 微信开发者工具专项启动实测：“数据与账号”游客模式标题、边界说明和本地模式提示正常，无网络请求或业务错误；专项验证后切回普通编译，首页正常。
- 静态检查：14 个页面、14 个控制器、136 个小程序文件；JSON、WXML、资源和 Repository 边界均通过。
- 发布安全门禁：品牌=冰箱有数，AppID=`wxc62caa8eb9379ed4`，`devSeed=false`，`cloudSyncEnabled=false`，API 地址为空，主包约 467.5 KiB。
- 该 Alpha 未上传微信平台；稳定体验版仍为已上传的 1.2.0。生产 PostgreSQL、Redis/任务 worker、对象存储和真实双设备测试未完成。

## 2.0.0-alpha.3 PostgreSQL 一致性读模型复验

- 新增 4 项 PostgreSQL 读模型测试；2.0 共 48 项，全量 67 passed，0 failed，0 skipped。
- 会话鉴权测试证明数据库查询只接收 access token 的 SHA-256 哈希，返回 principal 的 token/device hash 固定脱敏，调用记录中不存在 token 原文。
- bootstrap 映射覆盖家庭、成员、库存批次、不可变流水、购物清单、带 consumptions 的做菜记录、当前用户食谱进度/偏好与 cursor；测试逐条确认家庭事实查询首参数为 `household_id`，个人表同时使用 `user_id`。
- pull 覆盖 minimum cursor 过期的 `FULL_RESYNC_REQUIRED`、`limit + 1` 分页、next cursor 和 catalogVersion。
- Pool 模式验证使用单连接 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`，成功 `COMMIT` 并释放连接；代码同时包含失败 `ROLLBACK` 路径。
- 当前机器未发现 Docker、`psql` 或 PostgreSQL 服务，本轮没有把模拟 SQL 边界测试宣称为真实数据库集成测试。

## 2.0.0-alpha.4 PostgreSQL 身份与会话复验

- 新增 3 项 PostgreSQL 身份/会话测试；2.0 共 51 项，全量 70 passed，0 failed，0 skipped。
- 首次微信登录测试覆盖 `SERIALIZABLE`、按微信身份 advisory lock、用户/身份/默认家庭/owner/cursor/两条初始变更/会话同事务提交。
- 测试确认设备 ID 和 access token 原文不出现在 SQL 参数记录中，落库值为 64 位 SHA-256 十六进制并通过 `decode(..., 'hex')` 转 `bytea`。
- 冻结账号登录在创建会话前返回 `UNAUTHENTICATED` 并执行 `ROLLBACK`。
- 安全会话列表 SQL 不选择 `token_hash`/`device_id_hash`，返回对象也不含这两个字段；所有连接均有 release 断言。
- 当前仍没有真实 PostgreSQL 实例，完整 `PostgresV2Service` 与 API 生产接线尚未完成，`NODE_ENV=production` 继续拒绝内存 Store。

## 2.0.0-alpha.5 PostgreSQL 家庭协作事务复验

- 新增 4 项 PostgreSQL 家庭/成员/邀请测试；2.0 共 55 项，全量 74 passed，0 failed，0 skipped。
- 创建家庭测试覆盖 `SERIALIZABLE`、用户家庭配额 advisory lock、家庭/owner/cursor/两条初始变更/审计同事务提交。
- 接受邀请测试确认 SQL 只接收邀请 token 的 64 位 SHA-256 哈希，原始口令不出现在数据库调用记录；邀请、家庭和用户配额依次锁定，被移除成员可原子恢复并追加同步变更。
- 所有权转移测试确认旧 owner 必须先降级，再升级新 owner，并在同一事务追加家庭、旧 owner、新 owner 三条单调 cursor 变更。
- 越权测试确认访客角色在事务内复核后返回 `HOUSEHOLD_FORBIDDEN`，执行 `ROLLBACK`，不写邀请或审计日志。
- TypeScript、静态契约、发布安全门禁继续通过；本机仍无真实 PostgreSQL 实例，因此该结果不包含真实数据库 migration/并发集成验证。

## 2.0.0-alpha.6 PostgreSQL 同步命令复验

- 新增 4 项 PostgreSQL 同步命令测试；2.0 共 59 项，全量 78 passed，0 failed，0 skipped。
- 购入命令测试确认批次、purchase 流水、两条同步变更和幂等 canonical 在同一 `SERIALIZABLE` 事务提交。
- 购物项版本冲突测试确认返回 `VERSION_CONFLICT` 与服务端 version，执行 `ROLLBACK`，不分配 cursor，也不保存 `processed_mutations`。
- 个人偏好测试覆盖 viewer 修改本人设置、version 0 首次 upsert、个人实体隔离和单条同步变更。
- 做菜测试覆盖候选批次 `FOR UPDATE`、纯 TypeScript FEFO、跨批次扣减、两条不可变流水、两条 consumption、`CookingRecord`、食谱进度和 6 条单调 change 同事务提交。
- TypeScript、静态契约与发布安全门禁通过；真实 PostgreSQL migration、并发和断线重试仍未在本机执行。

## 2.0.0-alpha.7 PostgreSQL 数据权利复验

- 新增 4 项 PostgreSQL 数据导出/注销测试；2.0 共 63 项，全量 82 passed，0 failed，0 skipped。
- 导出测试确认只组装可读家庭、当前成员和本人状态，响应与持久化负载均不含 token/device hash 或原始 access token，并写导出审计。
- owner 阻断测试确认注销前置条件在事务内重新检查，仍拥有家庭时 `ROLLBACK`，不会修改用户状态。
- 冷静期测试覆盖当前受限会话续期、其他会话撤销、用户 `deletionPending` 和冷静期内原子取消。
- worker 测试覆盖 `FOR UPDATE SKIP LOCKED`、成员 tombstone/cursor、身份映射及个人状态清理、用户匿名化和完成审计，同时断言没有删除共享 `cooking_records`。
- TypeScript、静态契约和发布安全门禁通过；加密对象存储、真实备份删除边界和 PostgreSQL 实例联调仍未完成。

## 2.0.0-alpha.8 PostgreSQL v1 迁移复验

- 新增 3 项 PostgreSQL v1 迁移测试；2.0 共 66 项，全量 85 passed，0 failed，0 skipped。
- 预检测试覆盖事务内库存权限复核、checksum/数量摘要落库和同源幂等重放；同一批次 ID 携带不同快照会被拒绝。
- 确认测试覆盖空目标复核、批次与 purchase 流水、个人偏好、单调 change/cursor 和 committed 状态在一个 `SERIALIZABLE` 事务提交。
- 回滚测试证明目标家庭已有共享数据时不会写入导入批次、流水或 cursor；实现同时覆盖购物项、食谱进度、做菜记录、consumption 与 consume 流水。
- TypeScript、静态契约与发布安全门禁通过；本机仍无真实 PostgreSQL 实例，因此尚未完成真实 migration、约束和并发验证。

## 2.0.0-alpha.9 PostgreSQL 生产 API 组合复验

- 新增 3 项 PostgreSQL 生产运行时测试；2.0 共 69 项，全量 88 passed，0 failed，0 skipped。
- 测试确认生产环境缺少数据库连接时拒绝降级内存 Store，数据库池参数从服务端环境变量读取且不会进入小程序包。
- 启动预检覆盖两份必须 migration 和 `users`、会话、cursor、隐私任务关键表；未完成 migration 时在监听端口前失败，关闭时释放连接池。
- 契约门禁确认 `PostgresV2Service` 组合全部五组持久化服务，家庭 bootstrap 与同步 pull 使用 `REPEATABLE READ READ ONLY` 单连接快照。
- TypeScript、静态契约、仓库密钥扫描和发布安全门禁通过；该结果仍基于模拟数据库协议，本机没有可用于集成验证的真实 PostgreSQL 实例。

## 2.0.0-alpha.10 账号注销 worker 复验

- 新增 3 项账号注销 worker 测试；2.0 共 72 项，全量 91 passed，0 failed，0 skipped。
- 防重入测试证明同一进程的重叠触发只执行一个数据库批次，并传入稳定扫描时间和受限批量大小。
- 失败恢复测试证明单轮异常会交给脱敏错误回调、释放运行锁并允许下一轮正常重试。
- 停机测试证明 worker 会等待在途批处理完成；小于 1 秒的轮询和超过 1000 的批量会在启动前拒绝。
- TypeScript、静态契约、仓库密钥扫描与发布安全门禁通过；真实 PostgreSQL 多 worker、容器停机宽限期和备份删除演练仍待预发验证。

## 2.0.0-alpha.11 小程序云命令总线复验

- 新增 3 项客户端云命令总线测试；2.0 共 75 项，全量 94 passed，0 failed，0 skipped。
- 原子性测试证明购入命令、Outbox、乐观批次和回滚前像只产生一次家庭信封写入。
- 八类命令覆盖测试确认所有云写操作走同一入口，并从当前 canonical 实体携带正确 `baseVersion`。
- 冲突测试确认客户端提取服务端 `serverValue`，回滚乐观状态并用新版本 canonical 替换界面实体。
- TypeScript、静态契约、仓库密钥扫描与发布门禁通过；云同步和 API 地址在正式小程序配置中继续关闭。
