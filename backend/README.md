# 冰箱有数 2.0 Django 后台

这是 2.0 的新生产后台实现，保持小程序已有 `/v2` REST/JSON 契约，技术栈为 Python 3.12、uv、Django 5.2 LTS 和 SQLite3。

## 本地启动

依赖默认从清华 PyPI 镜像解析，版本由 `uv.lock` 固定：

```bash
uv sync
uv run python manage.py migrate
uv run python manage.py runserver 127.0.0.1:8787
```

正式启动前必须参照 `environment.example` 创建仅存在于服务器的 `.env`。真实 `WECHAT_APP_SECRET`、`DJANGO_SECRET_KEY` 和域名不得提交 Git。

## 验证

```bash
uv run ruff check .
uv run python manage.py check
uv run python manage.py makemigrations --check --dry-run
uv run coverage run manage.py test
uv run coverage report
```

当前 26 项测试覆盖身份映射、Bearer 会话、家庭租户隔离、RBAC、邀请、唯一 owner、8 类同步命令、mutation 幂等、版本冲突、FEFO、增量同步、v1 完整迁移、数据导出、注销冷静期、限流、SQLite PRAGMA 和在线一致性备份，语句覆盖率 89%。

## SQLite 运行边界

- `journal_mode=WAL`、`synchronous=FULL`、外键检查和 20 秒 busy timeout。
- 写事务使用 `IMMEDIATE`，库存事实、流水、变更游标和幂等结果在同一短事务提交。
- 正式环境只运行一个 Gunicorn worker；限流器也是单进程实现。
- 数据库存储整数/定点 Decimal，不使用 SQLite `REAL` 表示库存。
- 数据库文件与备份目录必须位于持久磁盘，且不能放入 Git 工作区。
- 当持续出现锁等待、写延迟明显升高或需要多进程/多 VPS 时，迁移 PostgreSQL。

## 运维命令

```bash
# 一致性在线备份，并执行 integrity_check
uv run python manage.py backup_sqlite --destination /var/backups/bingxiang-youshu

# 执行已过 7 天冷静期的注销任务
uv run python manage.py process_deletions --limit 50
```

存活检查为 `/v2/health`，数据库就绪检查为 `/v2/health/ready`。

## 当前尚未执行

- 未连接真实微信 AppSecret，测试使用可注入的假身份交换器。
- 未部署到 VPS；用户已要求等待新的部署方案和域名。
- 小程序正式开关仍关闭，1.x 页面尚未全部路由到云端 canonical 视图。
- 尚未完成两台真实手机、弱网和 SQLite 并发压力验收。
