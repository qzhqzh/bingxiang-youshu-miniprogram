# ADR-001：2.0 采用 PostgreSQL 事实表 + 家庭增量日志

状态：Accepted for implementation
日期：2026-08-13

## 背景

2.0 同时面对离线写入、多设备重放、同一家庭多人操作、FEFO 跨批次扣减和成员权限变化。把一整份 JSON 文档最后写入者覆盖，会丢失并发事实，也无法可靠审计库存为什么变化。

## 决策

- PostgreSQL 是业务事实的最终来源。
- 库存批次保存当前量；`inventory_movements` 追加记录购入、做菜、调整和丢弃事实。
- 每个写命令都携带 `(userId, mutationId)`，`processed_mutations` 用联合主键保证幂等。
- 每个家庭有单调 cursor；同一事务内写业务事实、幂等结果和 `sync_changes`。
- 做菜事务锁定相关活动批次，按“预计到期日、购入日、创建时间、ID”稳定排序后扣减；任一必选食材不足则整个事务回滚。
- 所有家庭业务表显式保存 `household_id`，API 从会话和有效成员关系重新鉴权，不信任客户端自报角色。
- 删除使用状态或 tombstone，保留到超过离线客户端支持窗口后才归档增量日志。
- 客户端生成的 ID 是带类型前缀的字符串，因此数据库主键使用 `text`，不错误限定为 UUID。

## 事务约束

写命令事务必须按以下顺序执行：

1. 校验会话、用户状态和家庭成员状态。
2. 查询 `(user_id, mutation_id)`；存在则返回已保存结果。
3. 校验角色权限和 `baseVersion`。
4. 锁定会修改的业务行；执行领域命令。
5. 写事实表和不可变流水，验证库存非负。
6. 分配该家庭的新 cursor，写一条或多条 `sync_changes`。
7. 保存 canonical 响应到 `processed_mutations`。
8. 提交后返回；任何一步失败全部回滚。

## 取舍

- 相比整文档同步，表和事务更多，但能避免覆盖丢失并支持审计。
- 增量日志增加存储量；通过保留窗口、快照和 `FULL_RESYNC_REQUIRED` 控制。
- PostgreSQL 单库先满足早期一致性；只有容量数据证明需要时才引入分片或事件流系统。

## 禁止事项

- 不允许小程序直连数据库。
- 不允许通过客户端 `householdId` 绕过成员鉴权。
- 不允许运营后台直接手改库存余额。
- 不允许 AppSecret、数据库密码或原始会话 token 写入日志。
- 不允许在缺少 PostgreSQL Store 时以 `InMemoryV2Store` 启动生产服务。

初版 schema 见 [`server/db/migrations/0001_v2_core.sql`](./server/db/migrations/0001_v2_core.sql)。
