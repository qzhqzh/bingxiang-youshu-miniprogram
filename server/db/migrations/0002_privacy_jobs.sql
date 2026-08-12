-- 冰箱有数 2.0：用户数据导出与账号注销冷静期任务。
-- 导出载荷属于敏感数据；生产环境应使用应用层加密或对象存储加密，并由 expires_at 定期清理。

CREATE TABLE data_export_jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('ready', 'expired')),
  checksum text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX data_export_jobs_expiry_idx ON data_export_jobs(expires_at)
  WHERE status = 'ready';

CREATE TABLE account_deletion_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending', 'cancelled', 'completed', 'blocked')),
  restricted_session_id text NOT NULL REFERENCES device_sessions(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  execute_after timestamptz NOT NULL,
  cancelled_at timestamptz,
  completed_at timestamptz,
  blocked_reason text,
  CHECK (execute_after > requested_at),
  CHECK ((status <> 'cancelled') OR cancelled_at IS NOT NULL),
  CHECK ((status <> 'completed') OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX account_one_pending_deletion_idx ON account_deletion_requests(user_id)
  WHERE status = 'pending';
CREATE INDEX account_deletion_due_idx ON account_deletion_requests(execute_after)
  WHERE status = 'pending';
