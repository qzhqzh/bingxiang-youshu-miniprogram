import os
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "使用 SQLite 在线备份 API 创建一致性数据库快照"

    def add_arguments(self, parser):
        parser.add_argument("--destination", required=True)

    def handle(self, *args, **options):
        source = Path(settings.DATABASES["default"]["NAME"]).resolve()
        destination_dir = Path(options["destination"]).resolve()
        destination_dir.mkdir(parents=True, exist_ok=True)
        if source.parent == destination_dir or source in destination_dir.parents:
            raise CommandError("备份目录必须与运行数据库目录隔离")
        target = destination_dir / f"bingxiang-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.sqlite3"
        with closing(sqlite3.connect(source)) as source_db, closing(sqlite3.connect(target)) as target_db:
            with target_db:
                source_db.backup(target_db)
                result = target_db.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            target.unlink(missing_ok=True)
            raise CommandError("备份完整性检查失败")
        if os.name != "nt":
            os.chmod(target, 0o600)
        self.stdout.write(str(target))
