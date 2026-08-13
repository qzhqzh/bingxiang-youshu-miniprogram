import hashlib
import json
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation

from django.conf import settings
from django.db import transaction
from django.utils.module_loading import import_string

from . import serializers
from .catalog import INGREDIENT_UNITS, RECIPES, SHELF_LIFE_DAYS, UNLOCK_RULES
from .errors import ApiError
from .models import (
    AuthIdentity,
    CookingRecord,
    DeviceSession,
    Household,
    HouseholdMember,
    InventoryMovement,
    MemberPreferences,
    PantryBatch,
    ProcessedMutation,
    RecipeProgress,
    ShoppingItem,
    SyncChange,
    User,
)
from .security import hash_secret, new_id, now_ms, opaque_token

ROLE_PERMISSIONS = {
    "owner": {"read", "inventory", "cooking", "shopping", "settings", "invite", "members", "transfer"},
    "admin": {"read", "inventory", "cooking", "shopping", "settings", "invite", "members"},
    "member": {"read", "inventory", "cooking", "shopping"},
    "viewer": {"read"},
}
COMMAND_PERMISSION = {
    "PurchaseBatch": "inventory",
    "CompleteCooking": "cooking",
    "AddShoppingItem": "shopping",
    "CheckShoppingItem": "shopping",
    "RemoveShoppingItem": "shopping",
    "DiscardBatch": "inventory",
    "UnlockRecipe": "cooking",
    "UpdatePreferences": "read",
}
COMMAND_PAYLOAD_FIELDS = {
    "PurchaseBatch": (
        {"ingredientId", "quantity", "unit", "purchasedAt", "storageMode"},
        {
            "ingredientId",
            "quantity",
            "unit",
            "purchasedAt",
            "storageMode",
            "shelfLifeDaysOverride",
            "note",
            "shoppingItemId",
        },
    ),
    "CompleteCooking": ({"recipeId", "servings"}, {"recipeId", "servings"}),
    "AddShoppingItem": (
        {"ingredientId", "suggestedQuantity", "unit"},
        {"ingredientId", "suggestedQuantity", "unit", "sourceRecipeId"},
    ),
    "CheckShoppingItem": ({"checked"}, {"checked"}),
    "RemoveShoppingItem": (set(), set()),
    "DiscardBatch": (set(), set()),
    "UnlockRecipe": ({"recipeId"}, {"recipeId"}),
    "UpdatePreferences": (set(), {"freshnessReminderDays", "defaultStorageMode", "favoriteRecipeIds"}),
}


def require_fields(payload: dict, required: set[str], allowed: set[str] | None = None):
    missing = sorted(required - payload.keys())
    extra = sorted(payload.keys() - allowed) if allowed is not None else []
    if missing or extra:
        raise ApiError("VALIDATION_ERROR", "请求字段不符合接口约定", 400, {"missing": missing, "extra": extra})


def principal(access_token: str, allow_deletion_pending: bool = False):
    if not access_token:
        raise ApiError("UNAUTHENTICATED", "缺少登录凭证", 401)
    current = now_ms()
    try:
        session = DeviceSession.objects.select_related("user").get(token_hash=hash_secret(access_token))
    except DeviceSession.DoesNotExist as error:
        raise ApiError("UNAUTHENTICATED", "登录状态无效", 401) from error
    if session.revoked_at or session.expires_at <= current:
        raise ApiError("SESSION_REVOKED", "登录状态已失效", 401)
    if session.user.status != "active" and not (allow_deletion_pending and session.user.status == "deletionPending"):
        raise ApiError("UNAUTHENTICATED", "账号不可用", 401)
    DeviceSession.objects.filter(pk=session.pk).update(last_seen_at=current)
    return session.user, session


def require_membership(user: User, household_id: str, permission: str = "read"):
    try:
        membership = HouseholdMember.objects.select_related("household", "user").get(
            household_id=household_id, user=user, status="active", household__status="active"
        )
    except HouseholdMember.DoesNotExist as error:
        raise ApiError("MEMBERSHIP_CHANGED", "已不再是该家庭成员", 403) from error
    if permission not in ROLE_PERMISSIONS.get(membership.role, set()):
        raise ApiError("FORBIDDEN", "当前家庭角色没有此操作权限", 403)
    return membership


def create_default_household(user: User, current: int) -> Household:
    household = Household.objects.create(id=new_id("hh"), name="我的冰箱", owner=user, created_at=current)
    HouseholdMember.objects.create(household=household, user=user, role="owner", joined_at=current)
    MemberPreferences.objects.create(household=household, user=user, updated_at=current)
    return household


@transaction.atomic
def login_wechat(code: str, device_id: str):
    if not code or not (8 <= len(device_id) <= 128):
        raise ApiError("VALIDATION_ERROR", "微信 code 或设备标识无效")
    subject = import_string(settings.WECHAT_CODE_EXCHANGER)(code)
    subject_hash = hash_secret(f"{settings.WECHAT_APP_ID}:{subject}")
    identity = (
        AuthIdentity.objects.select_related("user")
        .filter(provider="wechat-miniprogram", app_id=settings.WECHAT_APP_ID, provider_subject_hash=subject_hash)
        .first()
    )
    current = now_ms()
    if identity:
        user = identity.user
        if user.status != "active":
            raise ApiError("ACCOUNT_UNAVAILABLE", "账号当前不可登录", 403)
    else:
        user = User.objects.create(id=new_id("usr"), display_name="家庭成员", created_at=current)
        AuthIdentity.objects.create(
            provider="wechat-miniprogram",
            app_id=settings.WECHAT_APP_ID,
            provider_subject_hash=subject_hash,
            user=user,
            created_at=current,
        )
        create_default_household(user, current)
    token = opaque_token()
    session = DeviceSession.objects.create(
        id=new_id("ses"),
        user=user,
        device_id_hash=hash_secret(device_id),
        token_hash=hash_secret(token),
        created_at=current,
        last_seen_at=current,
        expires_at=current + settings.SESSION_TTL_SECONDS * 1000,
    )
    households = Household.objects.filter(householdmember__user=user, householdmember__status="active", status="active")
    return {
        "accessToken": token,
        "expiresAt": session.expires_at,
        "user": serializers.user(user),
        "households": [serializers.household(item) for item in households],
    }


def append_change(household: Household, entity_type: str, entity_id: str, operation: str, version: int, payload):
    household.current_cursor += 1
    household.save(update_fields=["current_cursor"])
    return SyncChange.objects.create(
        household=household,
        cursor=household.current_cursor,
        entity_type=entity_type,
        entity_id=entity_id,
        operation=operation,
        version=version,
        payload=payload,
        server_time=now_ms(),
    )


def canonical_conflict(command: dict, value):
    raise ApiError(
        "VERSION_CONFLICT",
        "数据已在其他设备更新",
        409,
        {"mutationId": command["mutationId"], "serverValue": value, "recommendation": "以服务器版本为准后重试"},
    )


def decimal_value(value, name: str, positive: bool = True) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError) as error:
        raise ApiError("VALIDATION_ERROR", f"{name} 格式无效") from error
    if not result.is_finite() or (positive and result <= 0):
        raise ApiError("VALIDATION_ERROR", f"{name} 必须大于零")
    return result.quantize(Decimal("0.001"))


def expiry_key(batch: PantryBatch):
    try:
        purchased = date.fromisoformat(batch.purchased_at)
    except ValueError:
        purchased = date.max
    shelf_life = batch.shelf_life_days_override
    if shelf_life is None:
        shelf_life = SHELF_LIFE_DAYS.get(batch.ingredient_id, {}).get(batch.storage_mode, 9999)
    return (purchased + timedelta(days=shelf_life), purchased, batch.created_at, batch.id)


def command_purchase(user, household, command, payload, current):
    ingredient = payload.get("ingredientId")
    if ingredient not in INGREDIENT_UNITS or payload.get("unit") != INGREDIENT_UNITS[ingredient]:
        raise ApiError("VALIDATION_ERROR", "食材或单位无效")
    quantity = decimal_value(payload.get("quantity"), "数量")
    try:
        date.fromisoformat(payload["purchasedAt"])
    except (TypeError, ValueError) as error:
        raise ApiError("VALIDATION_ERROR", "购入日期无效") from error
    if payload["storageMode"] not in {"room", "chilled", "frozen"}:
        raise ApiError("VALIDATION_ERROR", "保存方式无效")
    override = payload.get("shelfLifeDaysOverride")
    if override is not None and (
        isinstance(override, bool) or not isinstance(override, int) or not 1 <= override <= 3650
    ):
        raise ApiError("VALIDATION_ERROR", "保质期天数无效")
    if not isinstance(payload.get("note", ""), str) or len(payload.get("note", "")) > 200:
        raise ApiError("VALIDATION_ERROR", "批次备注无效")
    entity_id = command["entityId"]
    existing = PantryBatch.objects.filter(pk=entity_id).first()
    if existing:
        if existing.household_id == household.id:
            canonical_conflict(command, serializers.batch(existing))
        raise ApiError("VALIDATION_ERROR", "批次 ID 已被占用")
    batch = PantryBatch.objects.create(
        id=entity_id,
        household=household,
        ingredient_id=ingredient,
        quantity=quantity,
        original_quantity=quantity,
        unit=payload["unit"],
        purchased_at=payload.get("purchasedAt", ""),
        storage_mode=payload.get("storageMode", "chilled"),
        shelf_life_days_override=payload.get("shelfLifeDaysOverride"),
        note=payload.get("note", ""),
        created_by=user,
        created_at=current,
        updated_at=current,
    )
    movement = InventoryMovement.objects.create(
        id=new_id("mov"),
        household=household,
        pantry_batch=batch,
        ingredient_id=ingredient,
        type="purchase",
        quantity_delta=quantity,
        unit=batch.unit,
        actor=user,
        source_mutation_id=command["mutationId"],
        occurred_at=current,
    )
    append_change(household, "pantryBatch", batch.id, "upsert", batch.version, serializers.batch(batch))
    append_change(household, "inventoryMovement", movement.id, "upsert", 1, serializers.movement(movement))
    shopping_id = payload.get("shoppingItemId")
    if shopping_id:
        item = ShoppingItem.objects.filter(pk=shopping_id, household=household, deleted_at__isnull=True).first()
        if item:
            item.checked, item.version, item.updated_at = True, item.version + 1, current
            item.save(update_fields=["checked", "version", "updated_at"])
            append_change(household, "shoppingItem", item.id, "upsert", item.version, serializers.shopping(item))
    return serializers.batch(batch)


def command_add_shopping(user, household, command, payload, current):
    ingredient = payload.get("ingredientId")
    if ingredient not in INGREDIENT_UNITS or payload.get("unit") != INGREDIENT_UNITS[ingredient]:
        raise ApiError("VALIDATION_ERROR", "食材或单位无效")
    existing = ShoppingItem.objects.filter(pk=command["entityId"]).first()
    if existing:
        if existing.household_id == household.id:
            canonical_conflict(command, serializers.shopping(existing))
        raise ApiError("VALIDATION_ERROR", "购物项 ID 已被占用")
    if payload.get("sourceRecipeId") and payload["sourceRecipeId"] not in RECIPES:
        raise ApiError("VALIDATION_ERROR", "购物项来源食谱无效")
    item = ShoppingItem.objects.create(
        id=command["entityId"],
        household=household,
        ingredient_id=ingredient,
        suggested_quantity=decimal_value(payload.get("suggestedQuantity"), "建议数量"),
        unit=payload["unit"],
        source_recipe_id=payload.get("sourceRecipeId", ""),
        created_by=user,
        created_at=current,
        updated_at=current,
    )
    append_change(household, "shoppingItem", item.id, "upsert", item.version, serializers.shopping(item))
    return serializers.shopping(item)


def command_update_shopping(household, command, current, *, remove=False):
    try:
        item = ShoppingItem.objects.get(pk=command["entityId"], household=household, deleted_at__isnull=True)
    except ShoppingItem.DoesNotExist as error:
        raise ApiError("NOT_FOUND", "购物项不存在", 404) from error
    if item.version != command["baseVersion"]:
        canonical_conflict(command, serializers.shopping(item))
    if not remove and not isinstance(command["payload"].get("checked"), bool):
        raise ApiError("VALIDATION_ERROR", "购物项勾选状态无效")
    item.version += 1
    item.updated_at = current
    if remove:
        item.deleted_at = current
    else:
        item.checked = bool(command["payload"].get("checked"))
    item.save()
    payload = serializers.shopping(item)
    append_change(household, "shoppingItem", item.id, "delete" if remove else "upsert", item.version, payload)
    return payload


def command_discard(user, household, command, current):
    try:
        batch = PantryBatch.objects.get(pk=command["entityId"], household=household, deleted_at__isnull=True)
    except PantryBatch.DoesNotExist as error:
        raise ApiError("NOT_FOUND", "库存批次不存在", 404) from error
    if batch.version != command["baseVersion"]:
        canonical_conflict(command, serializers.batch(batch))
    discarded = batch.quantity
    batch.quantity, batch.status, batch.version, batch.updated_at = Decimal(0), "discarded", batch.version + 1, current
    batch.save()
    movement = InventoryMovement.objects.create(
        id=new_id("mov"),
        household=household,
        pantry_batch=batch,
        ingredient_id=batch.ingredient_id,
        type="discard",
        quantity_delta=-discarded,
        unit=batch.unit,
        actor=user,
        source_mutation_id=command["mutationId"],
        occurred_at=current,
    )
    append_change(household, "pantryBatch", batch.id, "upsert", batch.version, serializers.batch(batch))
    append_change(household, "inventoryMovement", movement.id, "upsert", 1, serializers.movement(movement))
    return serializers.batch(batch)


def command_preferences(user, household, command, payload, current):
    prefs, created = MemberPreferences.objects.get_or_create(
        household=household, user=user, defaults={"updated_at": current}
    )
    if command["baseVersion"] not in (0, prefs.version):
        canonical_conflict(command, serializers.preferences(prefs))
    days = payload.get("freshnessReminderDays", prefs.freshness_reminder_days)
    mode = payload.get("defaultStorageMode", prefs.default_storage_mode)
    favorites = payload.get("favoriteRecipeIds", prefs.favorite_recipe_ids)
    if (
        not isinstance(days, int)
        or not 0 <= days <= 30
        or mode not in {"room", "chilled", "frozen"}
        or not isinstance(favorites, list)
        or any(not isinstance(recipe_id, str) or recipe_id not in RECIPES for recipe_id in favorites)
    ):
        raise ApiError("VALIDATION_ERROR", "偏好设置无效")
    prefs.freshness_reminder_days, prefs.default_storage_mode, prefs.favorite_recipe_ids = days, mode, favorites
    prefs.version = 1 if created else prefs.version + 1
    prefs.updated_at = current
    prefs.save()
    value = serializers.preferences(prefs)
    append_change(household, "preferences", user.id, "upsert", prefs.version, value)
    return value


def command_unlock(user, household, command, payload, current):
    recipe_id = payload.get("recipeId")
    if recipe_id not in RECIPES:
        raise ApiError("VALIDATION_ERROR", "食谱不存在")
    progress, created = RecipeProgress.objects.get_or_create(household=household, user=user, recipe_id=recipe_id)
    if command["baseVersion"] not in (0, progress.version):
        canonical_conflict(command, serializers.progress(progress))
    rule_type, requirements = UNLOCK_RULES[recipe_id]
    if rule_type == "inventory":
        purchased = set(
            InventoryMovement.objects.filter(household=household, type="purchase").values_list(
                "ingredient_id", flat=True
            )
        )
        if not set(requirements).issubset(purchased):
            raise ApiError("RECIPE_LOCKED", "尚未满足食材探索条件", 409)
    elif rule_type == "prerequisite":
        mastered = set(
            RecipeProgress.objects.filter(household=household, user=user, status="mastered").values_list(
                "recipe_id", flat=True
            )
        )
        if not set(requirements).issubset(mastered):
            raise ApiError("RECIPE_LOCKED", "尚未掌握前置食谱", 409)
    progress.status, progress.unlocked_at = "mastered", current
    progress.version = 1 if created else progress.version + 1
    progress.save()
    value = serializers.progress(progress)
    append_change(household, "recipeProgress", f"{user.id}:{recipe_id}", "upsert", progress.version, value)
    return value


def command_cooking(user, household, command, payload, current):
    recipe = RECIPES.get(payload.get("recipeId"))
    servings = decimal_value(payload.get("servings"), "份数")
    if not recipe:
        raise ApiError("VALIDATION_ERROR", "食谱不存在")
    if not RecipeProgress.objects.filter(
        household=household, user=user, recipe_id=recipe.id, status="mastered"
    ).exists():
        raise ApiError("RECIPE_LOCKED", "请先解锁食谱", 409)
    existing = CookingRecord.objects.filter(pk=command["entityId"]).first()
    if existing:
        if existing.household_id == household.id:
            canonical_conflict(command, serializers.cooking(existing))
        raise ApiError("VALIDATION_ERROR", "做菜记录 ID 已被占用")
    factor = servings / Decimal(str(recipe.servings))
    consumptions = []
    planned = []
    for requirement in recipe.ingredients:
        needed = Decimal(str(requirement.amount)) * factor
        remaining = needed
        batches = list(
            PantryBatch.objects.filter(
                household=household,
                ingredient_id=requirement.ingredient_id,
                status="active",
                quantity__gt=0,
                deleted_at__isnull=True,
            )
        )
        batches.sort(key=expiry_key)
        for batch in batches:
            if remaining <= 0:
                break
            used = min(batch.quantity, remaining)
            remaining -= used
            planned.append((batch, used))
            consumptions.append(
                {
                    "pantryBatchId": batch.id,
                    "ingredientId": batch.ingredient_id,
                    "quantity": serializers.number(used),
                    "unit": batch.unit,
                }
            )
        if remaining > 0 and not requirement.optional:
            raise ApiError(
                "INVENTORY_CONFLICT",
                "必选食材不足，无法完成做菜",
                409,
                {"ingredientId": requirement.ingredient_id, "missing": serializers.number(remaining)},
            )
    for batch, used in planned:
        batch.quantity -= used
        batch.status = "consumed" if batch.quantity == 0 else "active"
        batch.version += 1
        batch.updated_at = current
        batch.save()
        movement = InventoryMovement.objects.create(
            id=new_id("mov"),
            household=household,
            pantry_batch=batch,
            ingredient_id=batch.ingredient_id,
            type="cook_consume",
            quantity_delta=-used,
            unit=batch.unit,
            actor=user,
            source_mutation_id=command["mutationId"],
            occurred_at=current,
        )
        append_change(household, "pantryBatch", batch.id, "upsert", batch.version, serializers.batch(batch))
        append_change(household, "inventoryMovement", movement.id, "upsert", 1, serializers.movement(movement))
    record = CookingRecord.objects.create(
        id=command["entityId"],
        household=household,
        recipe_id=recipe.id,
        cooked_at=current,
        servings=servings,
        consumptions=consumptions,
        actor=user,
        mutation_id=command["mutationId"],
    )
    progress, _ = RecipeProgress.objects.get_or_create(household=household, user=user, recipe_id=recipe.id)
    progress.status, progress.cook_count, progress.last_cooked_at, progress.version = (
        "mastered",
        progress.cook_count + 1,
        current,
        progress.version + 1,
    )
    progress.save()
    append_change(household, "cookingRecord", record.id, "upsert", record.version, serializers.cooking(record))
    append_change(
        household,
        "recipeProgress",
        f"{user.id}:{recipe.id}",
        "upsert",
        progress.version,
        serializers.progress(progress),
    )
    return serializers.cooking(record)


@transaction.atomic
def push_command(user: User, command: dict):
    required = {
        "mutationId",
        "deviceId",
        "householdId",
        "command",
        "entityId",
        "baseVersion",
        "payload",
        "clientOccurredAt",
    }
    require_fields(command, required, required)
    name = command["command"]
    if (
        name not in COMMAND_PERMISSION
        or not isinstance(command["payload"], dict)
        or isinstance(command["baseVersion"], bool)
        or not isinstance(command["baseVersion"], int)
        or command["baseVersion"] < 0
        or not all(
            isinstance(command[field], str) and command[field].strip()
            for field in ("mutationId", "deviceId", "householdId", "entityId", "clientOccurredAt")
        )
    ):
        raise ApiError("VALIDATION_ERROR", "同步命令无效")
    payload_required, payload_allowed = COMMAND_PAYLOAD_FIELDS[name]
    require_fields(command["payload"], payload_required, payload_allowed)
    existing = ProcessedMutation.objects.filter(user=user, mutation_id=command["mutationId"]).first()
    if existing:
        result = dict(existing.result)
        result["replayed"] = True
        return result
    membership = require_membership(user, command["householdId"], COMMAND_PERMISSION[name])
    household = Household.objects.get(pk=membership.household_id)
    current = now_ms()
    handlers = {
        "PurchaseBatch": lambda: command_purchase(user, household, command, command["payload"], current),
        "CompleteCooking": lambda: command_cooking(user, household, command, command["payload"], current),
        "AddShoppingItem": lambda: command_add_shopping(user, household, command, command["payload"], current),
        "CheckShoppingItem": lambda: command_update_shopping(household, command, current),
        "RemoveShoppingItem": lambda: command_update_shopping(household, command, current, remove=True),
        "DiscardBatch": lambda: command_discard(user, household, command, current),
        "UnlockRecipe": lambda: command_unlock(user, household, command, command["payload"], current),
        "UpdatePreferences": lambda: command_preferences(user, household, command, command["payload"], current),
    }
    canonical = handlers[name]()
    household.refresh_from_db(fields=["current_cursor"])
    result = {
        "mutationId": command["mutationId"],
        "accepted": True,
        "replayed": False,
        "cursor": household.current_cursor,
        "canonical": canonical,
    }
    ProcessedMutation.objects.create(
        user=user, mutation_id=command["mutationId"], household=household, result=result, processed_at=current
    )
    return result


def source_checksum(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def parse_source(source: str):
    try:
        payload = json.loads(source)
    except (TypeError, json.JSONDecodeError) as error:
        raise ApiError("VALIDATION_ERROR", "迁移文件不是有效 JSON") from error
    if not isinstance(payload, dict):
        raise ApiError("VALIDATION_ERROR", "迁移文件结构无效")
    return payload


def validate_v1_source(source: str):
    data = parse_source(source)
    array_fields = ("ingredients", "recipes", "batches", "progress", "cookingRecords", "shoppingList")
    for field in array_fields:
        if not isinstance(data.get(field), list) or any(not isinstance(row, dict) for row in data[field]):
            raise ApiError("VALIDATION_ERROR", f"迁移字段 {field} 必须是对象数组")
    if not isinstance(data.get("settings"), dict) or not isinstance(data.get("meta"), dict):
        raise ApiError("VALIDATION_ERROR", "迁移设置或元数据无效")

    def unique_ids(rows, field):
        ids = []
        for row in rows:
            value = row.get("id")
            if not isinstance(value, str) or not value.strip() or value in ids:
                raise ApiError("VALIDATION_ERROR", f"{field} 包含空 ID 或重复 ID")
            ids.append(value)
        return set(ids)

    ingredient_ids = unique_ids(data["ingredients"], "ingredients")
    recipe_ids = unique_ids(data["recipes"], "recipes")
    batch_ids = unique_ids(data["batches"], "batches")
    unique_ids(data["cookingRecords"], "cookingRecords")
    unique_ids(data["shoppingList"], "shoppingList")
    if (
        not ingredient_ids
        or not recipe_ids
        or not ingredient_ids.issubset(INGREDIENT_UNITS)
        or not recipe_ids.issubset(RECIPES)
    ):
        raise ApiError("VALIDATION_ERROR", "迁移目录包含未知食材或食谱")

    storage_modes = {"room", "chilled", "frozen"}
    batch_statuses = {"active", "consumed", "discarded"}
    progress_statuses = {"locked", "unlockable", "mastered"}
    for row in data["batches"]:
        if row.get("ingredientId") not in ingredient_ids or row.get("unit") != INGREDIENT_UNITS[row["ingredientId"]]:
            raise ApiError("VALIDATION_ERROR", "迁移批次引用未知食材或单位")
        quantity = decimal_value(row.get("quantity"), "批次数量", positive=False)
        if quantity < 0 or row.get("storageMode") not in storage_modes or row.get("status") not in batch_statuses:
            raise ApiError("VALIDATION_ERROR", "迁移批次数量、保存方式或状态无效")
        try:
            date.fromisoformat(row.get("purchasedAt", ""))
        except (TypeError, ValueError) as error:
            raise ApiError("VALIDATION_ERROR", "迁移批次购入日期无效") from error
    for row in data["progress"]:
        if row.get("recipeId") not in recipe_ids or row.get("status") not in progress_statuses:
            raise ApiError("VALIDATION_ERROR", "迁移食谱进度无效")
        if not isinstance(row.get("cookCount"), int) or row["cookCount"] < 0:
            raise ApiError("VALIDATION_ERROR", "迁移做菜次数无效")
    for row in data["shoppingList"]:
        ingredient = row.get("ingredientId")
        if ingredient not in ingredient_ids or row.get("unit") != INGREDIENT_UNITS[ingredient]:
            raise ApiError("VALIDATION_ERROR", "迁移购物项引用未知食材或单位")
        decimal_value(row.get("suggestedQuantity"), "购物建议数量")
        if not isinstance(row.get("checked"), bool):
            raise ApiError("VALIDATION_ERROR", "迁移购物项勾选状态无效")
    for record in data["cookingRecords"]:
        if record.get("recipeId") not in recipe_ids or not isinstance(record.get("consumptions"), list):
            raise ApiError("VALIDATION_ERROR", "迁移做菜记录无效")
        decimal_value(record.get("servings"), "做菜份数")
        for consumption in record["consumptions"]:
            if (
                not isinstance(consumption, dict)
                or consumption.get("pantryBatchId") not in batch_ids
                or consumption.get("ingredientId") not in ingredient_ids
            ):
                raise ApiError("VALIDATION_ERROR", "迁移做菜记录引用未知批次或食材")
            decimal_value(consumption.get("quantity"), "消耗数量")
    settings_value = data["settings"]
    if (
        not isinstance(settings_value.get("freshnessReminderDays"), int)
        or settings_value["freshnessReminderDays"] < 1
        or settings_value.get("defaultStorageMode") not in storage_modes
        or not isinstance(settings_value.get("favoriteRecipeIds", []), list)
        or not set(settings_value.get("favoriteRecipeIds", [])).issubset(recipe_ids)
    ):
        raise ApiError("VALIDATION_ERROR", "迁移偏好设置无效")
    summary = {
        "batchCount": len(data["batches"]),
        "shoppingItemCount": len(data["shoppingList"]),
        "cookingRecordCount": len(data["cookingRecords"]),
        "progressCount": len(data["progress"]),
    }
    return data, summary
