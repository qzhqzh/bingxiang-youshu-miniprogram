from django.db import models


class User(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    display_name = models.CharField(max_length=30)
    status = models.CharField(max_length=24, default="active")
    created_at = models.BigIntegerField()
    deleted_at = models.BigIntegerField(null=True)


class AuthIdentity(models.Model):
    provider = models.CharField(max_length=32)
    app_id = models.CharField(max_length=64)
    provider_subject_hash = models.CharField(max_length=64)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    created_at = models.BigIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["provider", "app_id", "provider_subject_hash"], name="identity_unique")
        ]


class DeviceSession(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    device_id_hash = models.CharField(max_length=64)
    token_hash = models.CharField(max_length=64, unique=True)
    created_at = models.BigIntegerField()
    expires_at = models.BigIntegerField(db_index=True)
    last_seen_at = models.BigIntegerField()
    revoked_at = models.BigIntegerField(null=True)


class Household(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    name = models.CharField(max_length=30)
    timezone = models.CharField(max_length=64, default="Asia/Shanghai")
    owner = models.ForeignKey(User, on_delete=models.PROTECT, related_name="owned_households")
    status = models.CharField(max_length=24, default="active")
    version = models.PositiveIntegerField(default=1)
    current_cursor = models.PositiveBigIntegerField(default=0)
    minimum_cursor = models.PositiveBigIntegerField(default=0)
    created_at = models.BigIntegerField()
    deleted_at = models.BigIntegerField(null=True)


class HouseholdMember(models.Model):
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    role = models.CharField(max_length=16)
    status = models.CharField(max_length=16, default="active")
    joined_at = models.BigIntegerField()
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["household", "user"], name="membership_unique")]
        indexes = [models.Index(fields=["user", "status"]), models.Index(fields=["household", "status"])]


class Invitation(models.Model):
    id = models.CharField(primary_key=True, max_length=80)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    token_hash = models.CharField(max_length=64, unique=True)
    role = models.CharField(max_length=16)
    expires_at = models.BigIntegerField(db_index=True)
    max_uses = models.PositiveSmallIntegerField(default=1)
    used_count = models.PositiveSmallIntegerField(default=0)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT)
    created_at = models.BigIntegerField()
    revoked_at = models.BigIntegerField(null=True)


class PantryBatch(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    ingredient_id = models.CharField(max_length=80)
    quantity = models.DecimalField(max_digits=14, decimal_places=3)
    original_quantity = models.DecimalField(max_digits=14, decimal_places=3)
    unit = models.CharField(max_length=16)
    purchased_at = models.CharField(max_length=10)
    storage_mode = models.CharField(max_length=16)
    shelf_life_days_override = models.PositiveIntegerField(null=True)
    note = models.CharField(max_length=200, blank=True)
    status = models.CharField(max_length=16, default="active")
    created_by = models.ForeignKey(User, on_delete=models.PROTECT)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    version = models.PositiveIntegerField(default=1)
    deleted_at = models.BigIntegerField(null=True)

    class Meta:
        indexes = [models.Index(fields=["household", "ingredient_id", "status"])]
        constraints = [models.CheckConstraint(condition=models.Q(quantity__gte=0), name="batch_quantity_nonnegative")]


class InventoryMovement(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    pantry_batch = models.ForeignKey(PantryBatch, on_delete=models.PROTECT)
    ingredient_id = models.CharField(max_length=80)
    type = models.CharField(max_length=24)
    quantity_delta = models.DecimalField(max_digits=14, decimal_places=3)
    unit = models.CharField(max_length=16)
    actor = models.ForeignKey(User, on_delete=models.PROTECT)
    source_mutation_id = models.CharField(max_length=100)
    occurred_at = models.BigIntegerField()


class ShoppingItem(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    ingredient_id = models.CharField(max_length=80)
    suggested_quantity = models.DecimalField(max_digits=14, decimal_places=3)
    unit = models.CharField(max_length=16)
    source_recipe_id = models.CharField(max_length=80, blank=True)
    checked = models.BooleanField(default=False)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    version = models.PositiveIntegerField(default=1)
    deleted_at = models.BigIntegerField(null=True)


class CookingRecord(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    recipe_id = models.CharField(max_length=80)
    cooked_at = models.BigIntegerField()
    servings = models.DecimalField(max_digits=8, decimal_places=2)
    consumptions = models.JSONField(default=list)
    actor = models.ForeignKey(User, on_delete=models.PROTECT)
    mutation_id = models.CharField(max_length=100)
    version = models.PositiveIntegerField(default=1)


class RecipeProgress(models.Model):
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    recipe_id = models.CharField(max_length=80)
    status = models.CharField(max_length=16, default="unlockable")
    unlocked_at = models.BigIntegerField(null=True)
    cook_count = models.PositiveIntegerField(default=0)
    last_cooked_at = models.BigIntegerField(null=True)
    version = models.PositiveIntegerField(default=1)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["household", "user", "recipe_id"], name="progress_unique")]


class MemberPreferences(models.Model):
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    freshness_reminder_days = models.PositiveSmallIntegerField(default=3)
    default_storage_mode = models.CharField(max_length=16, default="chilled")
    favorite_recipe_ids = models.JSONField(default=list)
    version = models.PositiveIntegerField(default=1)
    updated_at = models.BigIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["household", "user"], name="preferences_unique")]


class SyncChange(models.Model):
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    cursor = models.PositiveBigIntegerField()
    entity_type = models.CharField(max_length=32)
    entity_id = models.CharField(max_length=100)
    operation = models.CharField(max_length=8)
    version = models.PositiveIntegerField()
    payload = models.JSONField(null=True)
    server_time = models.BigIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["household", "cursor"], name="change_cursor_unique")]
        indexes = [models.Index(fields=["household", "cursor"])]


class ProcessedMutation(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    mutation_id = models.CharField(max_length=100)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    result = models.JSONField()
    processed_at = models.BigIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "mutation_id"], name="processed_mutation_unique")]


class V1Migration(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    import_batch_id = models.CharField(max_length=100)
    household = models.ForeignKey(Household, on_delete=models.CASCADE)
    checksum = models.CharField(max_length=64)
    summary = models.JSONField()
    source = models.TextField()
    status = models.CharField(max_length=16)
    created_at = models.BigIntegerField()
    committed_at = models.BigIntegerField(null=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "import_batch_id"], name="migration_unique")]


class AccountDeletionRequest(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    status = models.CharField(max_length=16)
    requested_at = models.BigIntegerField()
    execute_after = models.BigIntegerField(db_index=True)
    restricted_session = models.ForeignKey(DeviceSession, on_delete=models.PROTECT)
    cancelled_at = models.BigIntegerField(null=True)
    completed_at = models.BigIntegerField(null=True)
    blocked_reason = models.CharField(max_length=200, blank=True)


class AuditLog(models.Model):
    id = models.CharField(primary_key=True, max_length=100)
    actor = models.ForeignKey(User, null=True, on_delete=models.SET_NULL)
    household = models.ForeignKey(Household, null=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=100)
    target_type = models.CharField(max_length=60, blank=True)
    target_id = models.CharField(max_length=100, blank=True)
    metadata = models.JSONField(default=dict)
    created_at = models.BigIntegerField()
