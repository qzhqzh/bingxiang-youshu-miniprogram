# 冰箱有数 2.0 威胁模型

更新时间：2026-08-13

## 需要保护的资产

- 微信身份映射、内部用户 ID、设备会话。
- 家庭成员关系、角色和邀请 token。
- 食材库存、购入/丢弃流水、做菜记录、购物清单和偏好。
- 用户导出、注销请求、后台审计日志。
- AppSecret、数据库凭据、备份密钥和运营后台凭据。

## 信任边界

```text
微信客户端（不可信输入）
        │ HTTPS + Bearer
        ▼
公开 API（鉴权、限流、schema 校验）
        │ 私网 + 最小权限账号
        ▼
PostgreSQL / Redis / 备份

运营后台（独立身份、MFA、审计） ──受控命令──► 公开 API 的同一领域层
```

## 主要威胁与控制

| 威胁 | 控制 | 验证 |
|---|---|---|
| 伪造微信用户 | 服务端调用 `jscode2session`；不接受客户端 openid；AppSecret 只在服务端 | 假 code/伪造 token 测试 |
| 会话泄露 | 只存 token hash；短时效；设备会话可撤销；日志脱敏 | 过期/撤销/假会话测试 |
| 越权读取其他家庭 | 每个请求从 session user + active membership 鉴权；查询强制 household scope | 双家庭跨租户测试 |
| 低角色越权写入 | 服务端 RBAC；不信任客户端角色 | viewer/member/admin/owner 矩阵测试 |
| 邀请枚举或重放 | 256-bit 随机 token、只存 hash、过期、撤销、使用次数和成员上限 | 过期/撤销/重复接受测试 |
| 网络重试造成重复扣减 | `(userId, mutationId)` 幂等唯一键，保存 canonical 结果 | mutation 重放测试 |
| 并发做菜超扣 | 数据库行锁、稳定 FEFO、非负 CHECK、单事务提交 | 并发做菜测试；待 PostgreSQL 集成测试 |
| 旧客户端覆盖新数据 | `baseVersion` 和 canonical 服务端值；冲突进入本机冲突箱 | version 冲突测试 |
| 已移除成员继续补传 | push 前和事务内重新校验 membership，返回 `MEMBERSHIP_CHANGED` | 移除成员 Outbox 测试 |
| 恶意或损坏迁移数据 | 大小限制、JSON/schema/引用校验、checksum、显式两步确认、空目标约束 | 损坏/重复/已有数据测试 |
| 增量日志过期导致静默缺数据 | minimum cursor + `FULL_RESYNC_REQUIRED` + bootstrap | 游标压缩测试 |
| AppSecret 进入包或仓库 | `.env*` 忽略、仅 `.env.example` 变量名、CI secret scan | 提交前扫描；人工复核 |
| 后台人员直接篡改事实 | 后台调用同一领域命令；MFA、最小权限、全量审计、敏感操作双人复核 | 后台审计测试（待实现） |
| 数据删除不可恢复或删错租户 | 注销冷静期、任务状态机、目标复核、备份保留和恢复演练 | 删除/恢复演练（待实现） |

## 上线前仍需关闭的高风险缺口

- PostgreSQL Store 未实现，数据库并发锁与事务尚未在真实实例验证。
- API 未接入运行时 schema 校验、限流、指标、告警和集中脱敏日志。
- 用户导出、注销、数据删除任务尚未实现。
- 运营后台及其 MFA/审计/双人复核尚未实现。
- 未完成第三方依赖、容器镜像、密钥和备份的安全审查。

这些项目完成前，`cloudSyncEnabled` 必须保持 `false`，生产环境必须拒绝使用内存 Store。
