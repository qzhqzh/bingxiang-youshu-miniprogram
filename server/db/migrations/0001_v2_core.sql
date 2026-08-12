-- 冰箱有数 2.0：用户、家庭空间、库存事实与增量同步基础表。
-- 所有家庭业务表都显式携带 household_id；服务层仍必须从会话成员关系重新鉴权。

CREATE TABLE users (
  id text PRIMARY KEY,
  display_name varchar(30) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'deletionPending', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE auth_identities (
  provider text NOT NULL CHECK (provider = 'wechat-miniprogram'),
  app_id text NOT NULL,
  provider_subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, app_id, provider_subject)
);

CREATE TABLE device_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  device_id_hash bytea NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX device_sessions_user_idx ON device_sessions(user_id, last_seen_at DESC);

CREATE TABLE households (
  id text PRIMARY KEY,
  name varchar(30) NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  owner_user_id text NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deletionPending', 'deleted')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE household_members (
  household_id text NOT NULL REFERENCES households(id),
  user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'frozen')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (household_id, user_id)
);
CREATE UNIQUE INDEX household_one_active_owner_idx ON household_members(household_id)
  WHERE role = 'owner' AND status = 'active';
CREATE INDEX household_members_user_idx ON household_members(user_id, status);

CREATE TABLE invitations (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  token_hash bytea NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  expires_at timestamptz NOT NULL,
  max_uses smallint NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 10),
  used_count smallint NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX invitations_household_idx ON invitations(household_id, expires_at DESC);

CREATE TABLE pantry_batches (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  ingredient_id text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity >= 0),
  original_quantity numeric(14,3) NOT NULL CHECK (original_quantity > 0 AND original_quantity >= quantity),
  unit text NOT NULL,
  purchased_at date NOT NULL,
  storage_mode text NOT NULL CHECK (storage_mode IN ('room', 'chilled', 'frozen')),
  shelf_life_days_override integer CHECK (shelf_life_days_override > 0),
  note varchar(200),
  status text NOT NULL CHECK (status IN ('active', 'consumed', 'discarded')),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (household_id, id)
);
CREATE INDEX pantry_batches_fefo_idx ON pantry_batches(household_id, ingredient_id, purchased_at, created_at)
  WHERE deleted_at IS NULL AND status = 'active' AND quantity > 0;

CREATE TABLE inventory_movements (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  pantry_batch_id text NOT NULL,
  ingredient_id text NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('purchase', 'cook_consume', 'adjust', 'discard')),
  quantity_delta numeric(14,3) NOT NULL CHECK (quantity_delta <> 0),
  unit text NOT NULL,
  actor_user_id text NOT NULL REFERENCES users(id),
  source_mutation_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (household_id, pantry_batch_id) REFERENCES pantry_batches(household_id, id)
);
CREATE INDEX inventory_movements_household_idx ON inventory_movements(household_id, occurred_at DESC);

CREATE TABLE shopping_items (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  ingredient_id text NOT NULL,
  suggested_quantity numeric(14,3) NOT NULL CHECK (suggested_quantity > 0),
  unit text NOT NULL,
  source_recipe_id text,
  checked boolean NOT NULL DEFAULT false,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (household_id, id)
);
CREATE INDEX shopping_items_household_idx ON shopping_items(household_id, checked, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE cooking_records (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  recipe_id text NOT NULL,
  cooked_at timestamptz NOT NULL,
  servings numeric(8,2) NOT NULL CHECK (servings > 0),
  actor_user_id text NOT NULL REFERENCES users(id),
  mutation_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (household_id, id),
  UNIQUE (actor_user_id, mutation_id)
);

CREATE TABLE cooking_consumptions (
  cooking_record_id text NOT NULL REFERENCES cooking_records(id),
  household_id text NOT NULL REFERENCES households(id),
  pantry_batch_id text NOT NULL,
  ingredient_id text NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  PRIMARY KEY (cooking_record_id, pantry_batch_id),
  FOREIGN KEY (household_id, pantry_batch_id) REFERENCES pantry_batches(household_id, id)
);

CREATE TABLE recipe_progress (
  household_id text NOT NULL REFERENCES households(id),
  user_id text NOT NULL REFERENCES users(id),
  recipe_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('locked', 'unlockable', 'mastered')),
  unlocked_at timestamptz,
  cook_count integer NOT NULL DEFAULT 0 CHECK (cook_count >= 0),
  last_cooked_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (household_id, user_id, recipe_id)
);

CREATE TABLE member_preferences (
  household_id text NOT NULL REFERENCES households(id),
  user_id text NOT NULL REFERENCES users(id),
  freshness_reminder_days smallint NOT NULL DEFAULT 3 CHECK (freshness_reminder_days BETWEEN 1 AND 30),
  default_storage_mode text NOT NULL DEFAULT 'chilled' CHECK (default_storage_mode IN ('room', 'chilled', 'frozen')),
  favorite_recipe_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(favorite_recipe_ids) = 'array'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE processed_mutations (
  user_id text NOT NULL REFERENCES users(id),
  mutation_id text NOT NULL,
  household_id text NOT NULL REFERENCES households(id),
  command_name text NOT NULL,
  result jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mutation_id)
);

CREATE TABLE household_sync_cursors (
  household_id text PRIMARY KEY REFERENCES households(id),
  current_cursor bigint NOT NULL DEFAULT 0 CHECK (current_cursor >= 0),
  minimum_cursor bigint NOT NULL DEFAULT 0 CHECK (minimum_cursor >= 0 AND minimum_cursor <= current_cursor)
);

CREATE TABLE sync_changes (
  household_id text NOT NULL REFERENCES households(id),
  cursor bigint NOT NULL CHECK (cursor > 0),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  version bigint NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  server_time timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, cursor)
);
CREATE INDEX sync_changes_retention_idx ON sync_changes(server_time);

CREATE TABLE v1_migrations (
  user_id text NOT NULL REFERENCES users(id),
  import_batch_id text NOT NULL,
  household_id text NOT NULL REFERENCES households(id),
  checksum text NOT NULL,
  summary jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared', 'committed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  PRIMARY KEY (user_id, import_batch_id)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id text REFERENCES users(id),
  household_id text REFERENCES households(id),
  action text NOT NULL,
  target_type text,
  target_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_household_idx ON audit_logs(household_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_user_id, created_at DESC);
