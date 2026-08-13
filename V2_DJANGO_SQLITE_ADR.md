# ADR：2.0 首发采用 Django + SQLite

状态：已接受，适用于 2.0 小规模单机首发；部署等待最终域名与服务器方案。

## 决策

- Python 3.12 与 uv 管理运行时和锁定依赖。
- Django 5.2 LTS 提供模型、迁移、HTTP API 和运维命令。
- SQLite3 保存首发用户数据；同一 VPS 上不额外部署数据库服务。
- 保持 `/v2` API、命令名、Outbox、cursor、canonical 和错误体契约不变。
- 旧 TypeScript/PostgreSQL 实现暂时保留为协议与未来扩容参考，正式运行时以 `backend/` 为准。

## 一致性策略

SQLite 不支持行级 `SELECT FOR UPDATE`。首发采用一个应用 worker、`IMMEDIATE` 短事务和数据库级写串行化；每次写入同时提交：

1. 领域实体；
2. 不可变库存流水；
3. 单调同步游标与 change log；
4. mutationId 幂等结果。

库存使用 Decimal 定点列并设置非负约束。客户端继续携带 `baseVersion`，冲突返回服务端 canonical 值。

## 迁移 PostgreSQL 的触发条件

出现任一条件就安排迁移：

- 需要两个以上应用 worker 或多台 VPS；
- `database is locked` 在正常流量中持续出现；
- 写请求延迟或同步积压超过产品可接受范围；
- 需要高频运营统计、复杂查询或独立任务集群；
- 备份窗口、恢复时间或容灾目标超出单文件数据库能力。

Django 模型避免 SQLite 专属业务 SQL，迁移时保留 API 和小程序同步协议，只替换数据库配置并补充 PostgreSQL 并发回归。

## 国内依赖源

`backend/pyproject.toml` 将清华 PyPI 镜像设为 uv 默认索引，`uv.lock` 固定解析结果。部署时系统包镜像由最终 VPS 方案统一配置，不在应用代码中写死服务器地址。
