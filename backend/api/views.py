import json
import logging
from decimal import Decimal
from functools import wraps

from django.conf import settings
from django.db import OperationalError, transaction
from django.http import HttpResponse, JsonResponse
from django.views.decorators.http import require_http_methods

from . import serializers
from .errors import ApiError
from .models import (
    AccountDeletionRequest,
    CookingRecord,
    DeviceSession,
    Household,
    HouseholdMember,
    InventoryMovement,
    Invitation,
    MemberPreferences,
    PantryBatch,
    RecipeProgress,
    ShoppingItem,
    SyncChange,
    V1Migration,
)
from .security import hash_secret, new_id, now_ms, opaque_token
from .services import (
    append_change,
    login_wechat,
    principal,
    push_command,
    require_fields,
    require_membership,
    source_checksum,
    validate_v1_source,
)

logger = logging.getLogger(__name__)


def endpoint(function):
    @wraps(function)
    def wrapped(request, *args, **kwargs):
        try:
            return function(request, *args, **kwargs)
        except ApiError as error:
            body = {
                "error": {"code": error.code, "message": error.message, "requestId": getattr(request, "request_id", "")}
            }
            if error.details is not None:
                body["error"]["details"] = error.details
            return JsonResponse(body, status=error.status)
        except OperationalError:
            logger.warning("sqlite operation failed request_id=%s", getattr(request, "request_id", ""))
            return JsonResponse(
                {
                    "error": {
                        "code": "SERVICE_BUSY",
                        "message": "服务繁忙，请稍后重试",
                        "requestId": getattr(request, "request_id", ""),
                    }
                },
                status=503,
            )
        except Exception:
            logger.exception("unhandled api error request_id=%s", getattr(request, "request_id", ""))
            return JsonResponse(
                {
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": "服务暂不可用",
                        "requestId": getattr(request, "request_id", ""),
                    }
                },
                status=500,
            )

    return wrapped


def body(request):
    if not request.body:
        return {}
    if len(request.body) > 2_000_000:
        raise ApiError("PAYLOAD_TOO_LARGE", "请求内容超过 2 MiB", 413)
    try:
        value = json.loads(request.body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ApiError("VALIDATION_ERROR", "请求必须是 JSON") from error
    if not isinstance(value, dict):
        raise ApiError("VALIDATION_ERROR", "请求 JSON 必须是对象")
    return value


def bearer(request):
    value = request.headers.get("Authorization", "")
    return value[7:] if value.startswith("Bearer ") else ""


def status_response(payload, status=200):
    return JsonResponse(payload, status=status, safe=not isinstance(payload, list))


@endpoint
@require_http_methods(["GET"])
def health(_request):
    return JsonResponse({"status": "ok", "version": "2.0.0-alpha.12", "database": "sqlite3"})


@endpoint
@require_http_methods(["GET"])
def ready(_request):
    Household.objects.only("id").first()
    return JsonResponse({"status": "ready", "database": "ok"})


@endpoint
@require_http_methods(["POST"])
def auth_wechat(request):
    payload = body(request)
    require_fields(payload, {"code", "deviceId"}, {"code", "deviceId"})
    return JsonResponse(login_wechat(payload["code"], payload["deviceId"]))


@endpoint
@require_http_methods(["POST"])
def logout(request):
    user, session = principal(bearer(request))
    del user
    session.revoked_at = now_ms()
    session.save(update_fields=["revoked_at"])
    return HttpResponse(status=204)


@endpoint
@require_http_methods(["GET", "PATCH"])
def me(request):
    user, _ = principal(bearer(request))
    if request.method == "PATCH":
        payload = body(request)
        require_fields(payload, {"displayName"}, {"displayName"})
        name = payload["displayName"].strip() if isinstance(payload["displayName"], str) else ""
        if not 1 <= len(name) <= 30:
            raise ApiError("VALIDATION_ERROR", "昵称长度应为 1–30 个字符")
        user.display_name = name
        user.save(update_fields=["display_name"])
    return JsonResponse(serializers.user(user))


@endpoint
@require_http_methods(["GET"])
def sessions(request):
    user, _ = principal(bearer(request))
    result = [
        {
            "id": item.id,
            "userId": item.user_id,
            "createdAt": item.created_at,
            "expiresAt": item.expires_at,
            "lastSeenAt": item.last_seen_at,
            **({"revokedAt": item.revoked_at} if item.revoked_at else {}),
        }
        for item in DeviceSession.objects.filter(user=user).order_by("-last_seen_at")
    ]
    return status_response(result)


@endpoint
@require_http_methods(["DELETE"])
def revoke_session(request, session_id):
    user, _ = principal(bearer(request))
    updated = DeviceSession.objects.filter(pk=session_id, user=user).update(revoked_at=now_ms())
    if not updated:
        raise ApiError("NOT_FOUND", "没有找到设备会话", 404)
    return HttpResponse(status=204)


@endpoint
@require_http_methods(["GET", "POST"])
def households(request):
    user, _ = principal(bearer(request))
    if request.method == "GET":
        rows = Household.objects.filter(householdmember__user=user, householdmember__status="active", status="active")
        return status_response([serializers.household(item) for item in rows])
    payload = body(request)
    require_fields(payload, {"name"}, {"name", "timezone"})
    name = payload["name"].strip() if isinstance(payload["name"], str) else ""
    if not 1 <= len(name) <= 30:
        raise ApiError("VALIDATION_ERROR", "家庭名称长度应为 1–30 个字符")
    if HouseholdMember.objects.filter(user=user, status="active").count() >= 10:
        raise ApiError("QUOTA_EXCEEDED", "每个账号最多加入 10 个家庭", 409)
    with transaction.atomic():
        current = now_ms()
        item = Household.objects.create(
            id=new_id("hh"),
            name=name,
            timezone=payload.get("timezone", "Asia/Shanghai"),
            owner=user,
            created_at=current,
        )
        HouseholdMember.objects.create(household=item, user=user, role="owner", joined_at=current)
        MemberPreferences.objects.create(household=item, user=user, updated_at=current)
        append_change(item, "household", item.id, "upsert", item.version, serializers.household(item))
    return JsonResponse(serializers.household(item), status=201)


@endpoint
@require_http_methods(["GET", "PATCH"])
def household_detail(request, household_id):
    user, _ = principal(bearer(request))
    membership = require_membership(user, household_id, "read" if request.method == "GET" else "settings")
    item = membership.household
    if request.method == "PATCH":
        payload = body(request)
        require_fields(payload, set(), {"name", "timezone"})
        if "name" in payload:
            name = payload["name"].strip() if isinstance(payload["name"], str) else ""
            if not 1 <= len(name) <= 30:
                raise ApiError("VALIDATION_ERROR", "家庭名称无效")
            item.name = name
        if "timezone" in payload:
            item.timezone = payload["timezone"]
        item.version += 1
        item.save()
        append_change(item, "household", item.id, "upsert", item.version, serializers.household(item))
    return JsonResponse(serializers.household(item))


@endpoint
@require_http_methods(["POST"])
def create_invitation(request, household_id):
    user, _ = principal(bearer(request))
    membership = require_membership(user, household_id, "invite")
    payload = body(request)
    require_fields(payload, set(), {"role", "maxUses"})
    role, max_uses = payload.get("role", "member"), payload.get("maxUses", 1)
    if role not in {"admin", "member", "viewer"} or not isinstance(max_uses, int) or not 1 <= max_uses <= 10:
        raise ApiError("VALIDATION_ERROR", "邀请角色或使用次数无效")
    token = opaque_token()
    current = now_ms()
    item = Invitation.objects.create(
        id=new_id("inv"),
        household=membership.household,
        token_hash=hash_secret(token),
        role=role,
        expires_at=current + 7 * 86400 * 1000,
        max_uses=max_uses,
        created_by=user,
        created_at=current,
    )
    return JsonResponse(
        {
            "invitation": {
                "id": item.id,
                "householdId": item.household_id,
                "role": role,
                "expiresAt": item.expires_at,
                "maxUses": max_uses,
                "usedCount": 0,
            },
            "token": token,
        },
        status=201,
    )


@endpoint
@require_http_methods(["DELETE"])
def revoke_invitation(request, household_id, invitation_id):
    user, _ = principal(bearer(request))
    require_membership(user, household_id, "invite")
    updated = Invitation.objects.filter(pk=invitation_id, household_id=household_id, revoked_at__isnull=True).update(
        revoked_at=now_ms()
    )
    if not updated:
        raise ApiError("NOT_FOUND", "邀请不存在", 404)
    return HttpResponse(status=204)


@endpoint
@require_http_methods(["POST"])
def accept_invitation(request, token):
    user, _ = principal(bearer(request))
    with transaction.atomic():
        item = Invitation.objects.select_related("household").filter(token_hash=hash_secret(token)).first()
        if not item or item.revoked_at or item.expires_at <= now_ms() or item.used_count >= item.max_uses:
            raise ApiError("INVITATION_INVALID", "邀请已失效", 409)
        membership = HouseholdMember.objects.filter(household=item.household, user=user).first()
        if membership and membership.status == "active":
            return JsonResponse(
                serializers.member(HouseholdMember.objects.select_related("user").get(pk=membership.pk))
            )
        if HouseholdMember.objects.filter(household=item.household, status="active").count() >= 20:
            raise ApiError("QUOTA_EXCEEDED", "家庭成员已达上限", 409)
        current = now_ms()
        if membership:
            membership.role, membership.status, membership.version = item.role, "active", membership.version + 1
            membership.joined_at = current
            membership.save()
        else:
            membership = HouseholdMember.objects.create(
                household=item.household, user=user, role=item.role, joined_at=current
            )
        MemberPreferences.objects.get_or_create(household=item.household, user=user, defaults={"updated_at": current})
        item.used_count += 1
        item.save(update_fields=["used_count"])
        value = serializers.member(HouseholdMember.objects.select_related("user").get(pk=membership.pk))
        append_change(item.household, "member", user.id, "upsert", membership.version, value)
        return JsonResponse(value)


@endpoint
@require_http_methods(["PATCH", "DELETE"])
def member_detail(request, household_id, user_id):
    actor, _ = principal(bearer(request))
    require_membership(actor, household_id, "members")
    try:
        target = HouseholdMember.objects.select_related("household", "user").get(
            household_id=household_id, user_id=user_id, status="active"
        )
    except HouseholdMember.DoesNotExist as error:
        raise ApiError("NOT_FOUND", "成员不存在", 404) from error
    if target.role == "owner":
        raise ApiError("OWNER_REQUIRED", "请先转移家庭所有权", 409)
    target.version += 1
    if request.method == "PATCH":
        payload = body(request)
        require_fields(payload, {"role"}, {"role"})
        if payload["role"] not in {"admin", "member", "viewer"}:
            raise ApiError("VALIDATION_ERROR", "成员角色无效")
        target.role = payload["role"]
        target.save()
        value = serializers.member(target)
        append_change(target.household, "member", target.user_id, "upsert", target.version, value)
        return JsonResponse(value)
    target.status = "removed"
    target.save()
    append_change(target.household, "member", target.user_id, "delete", target.version, serializers.member(target))
    return HttpResponse(status=204)


@endpoint
@require_http_methods(["POST"])
def transfer_ownership(request, household_id):
    actor, _ = principal(bearer(request))
    actor_membership = require_membership(actor, household_id, "transfer")
    payload = body(request)
    require_fields(payload, {"userId"}, {"userId"})
    try:
        target = HouseholdMember.objects.select_related("user").get(
            household_id=household_id, user_id=payload["userId"], status="active"
        )
    except HouseholdMember.DoesNotExist as error:
        raise ApiError("NOT_FOUND", "目标成员不存在", 404) from error
    with transaction.atomic():
        actor_membership.role, actor_membership.version = "admin", actor_membership.version + 1
        target.role, target.version = "owner", target.version + 1
        actor_membership.save()
        target.save()
        item = actor_membership.household
        item.owner, item.version = target.user, item.version + 1
        item.save()
        append_change(
            item, "member", actor.id, "upsert", actor_membership.version, serializers.member(actor_membership)
        )
        append_change(item, "member", target.user_id, "upsert", target.version, serializers.member(target))
        append_change(item, "household", item.id, "upsert", item.version, serializers.household(item))
    return JsonResponse(serializers.household(item))


@endpoint
@require_http_methods(["GET"])
def bootstrap(request):
    user, _ = principal(bearer(request))
    household_id = request.GET.get("householdId", "")
    membership = require_membership(user, household_id)
    item = membership.household
    prefs, _ = MemberPreferences.objects.get_or_create(household=item, user=user, defaults={"updated_at": now_ms()})
    payload = {
        "household": serializers.household(item),
        "members": [
            serializers.member(row)
            for row in HouseholdMember.objects.select_related("user").filter(household=item, status="active")
        ],
        "batches": [
            serializers.batch(row) for row in PantryBatch.objects.filter(household=item, deleted_at__isnull=True)
        ],
        "movements": [serializers.movement(row) for row in InventoryMovement.objects.filter(household=item)],
        "shoppingItems": [
            serializers.shopping(row) for row in ShoppingItem.objects.filter(household=item, deleted_at__isnull=True)
        ],
        "cookingRecords": [serializers.cooking(row) for row in CookingRecord.objects.filter(household=item)],
        "recipeProgress": [
            serializers.progress(row) for row in RecipeProgress.objects.filter(household=item, user=user)
        ],
        "preferences": serializers.preferences(prefs),
        "cursor": item.current_cursor,
        "catalogVersion": settings.CATALOG_VERSION,
    }
    return JsonResponse(payload)


@endpoint
@require_http_methods(["POST"])
def sync_push(request):
    user, _ = principal(bearer(request))
    return JsonResponse(push_command(user, body(request)))


@endpoint
@require_http_methods(["GET"])
def sync_pull(request):
    user, _ = principal(bearer(request))
    household_id = request.GET.get("householdId", "")
    require_membership(user, household_id)
    try:
        cursor = int(request.GET.get("cursor", "0"))
        limit = min(500, max(1, int(request.GET.get("limit", "200"))))
    except ValueError as error:
        raise ApiError("VALIDATION_ERROR", "同步游标无效") from error
    item = Household.objects.get(pk=household_id)
    if cursor < item.minimum_cursor:
        raise ApiError(
            "FULL_RESYNC_REQUIRED", "本地游标过旧，需要完整同步", 409, {"minimumCursor": item.minimum_cursor}
        )
    rows = list(SyncChange.objects.filter(household=item, cursor__gt=cursor).order_by("cursor")[: limit + 1])
    has_more = len(rows) > limit
    page = rows[:limit]
    changes = [
        {
            "householdId": row.household_id,
            "cursor": row.cursor,
            "entityType": row.entity_type,
            "entityId": row.entity_id,
            "operation": row.operation,
            "version": row.version,
            "payload": row.payload,
            "serverTime": row.server_time,
        }
        for row in page
    ]
    return JsonResponse(
        {
            "changes": changes,
            "nextCursor": page[-1].cursor if page else cursor,
            "hasMore": has_more,
            "catalogVersion": settings.CATALOG_VERSION,
        }
    )


def migration_summary(source):
    return validate_v1_source(source)[1]


@endpoint
@require_http_methods(["POST"])
def migration(request, action):
    user, _ = principal(bearer(request))
    payload = body(request)
    require_fields(payload, {"householdId", "importBatchId", "source"}, {"householdId", "importBatchId", "source"})
    membership = require_membership(user, payload["householdId"], "inventory")
    checksum = source_checksum(payload["source"])
    summary = migration_summary(payload["source"])
    current = now_ms()
    with transaction.atomic():
        item = V1Migration.objects.filter(user=user, import_batch_id=payload["importBatchId"]).first()
        if item and (item.checksum != checksum or item.household_id != payload["householdId"]):
            raise ApiError("MIGRATION_CONFLICT", "同一迁移批次的数据不一致", 409)
        if not item:
            item = V1Migration.objects.create(
                user=user,
                import_batch_id=payload["importBatchId"],
                household=membership.household,
                checksum=checksum,
                summary=summary,
                source=payload["source"],
                status="prepared",
                created_at=current,
            )
        if action == "commit" and item.status != "committed":
            occupied = (
                PantryBatch.objects.filter(household=membership.household).exists()
                or ShoppingItem.objects.filter(household=membership.household).exists()
                or CookingRecord.objects.filter(household=membership.household).exists()
            )
            if occupied:
                raise ApiError("MIGRATION_TARGET_NOT_EMPTY", "目标家庭已有数据，请创建新家庭后迁移", 409)
            data, _ = validate_v1_source(item.source)
            consumed_by_batch = {}
            for record in data["cookingRecords"]:
                for consumption in record["consumptions"]:
                    batch_id = consumption["pantryBatchId"]
                    consumed_by_batch[batch_id] = consumed_by_batch.get(batch_id, Decimal(0)) + Decimal(
                        str(consumption["quantity"])
                    )
            for source_batch in data["batches"]:
                quantity = Decimal(str(source_batch["quantity"]))
                original_quantity = quantity + consumed_by_batch.get(source_batch["id"], Decimal(0))
                if original_quantity <= 0:
                    raise ApiError("VALIDATION_ERROR", f"批次 {source_batch['id']} 无法还原原始数量")
                batch = PantryBatch.objects.create(
                    id=source_batch["id"],
                    household=membership.household,
                    ingredient_id=source_batch["ingredientId"],
                    quantity=quantity,
                    original_quantity=original_quantity,
                    unit=source_batch["unit"],
                    purchased_at=source_batch["purchasedAt"],
                    storage_mode=source_batch["storageMode"],
                    shelf_life_days_override=source_batch.get("shelfLifeDaysOverride"),
                    note=source_batch.get("note", ""),
                    status=source_batch.get("status", "active"),
                    created_by=user,
                    created_at=source_batch.get("createdAt", current),
                    updated_at=source_batch.get("updatedAt", current),
                )
                append_change(
                    membership.household, "pantryBatch", batch.id, "upsert", batch.version, serializers.batch(batch)
                )
                purchase = InventoryMovement.objects.create(
                    id=new_id("mov"),
                    household=membership.household,
                    pantry_batch=batch,
                    ingredient_id=batch.ingredient_id,
                    type="purchase",
                    quantity_delta=original_quantity,
                    unit=batch.unit,
                    actor=user,
                    source_mutation_id=item.import_batch_id,
                    occurred_at=batch.created_at,
                )
                append_change(
                    membership.household,
                    "inventoryMovement",
                    purchase.id,
                    "upsert",
                    1,
                    serializers.movement(purchase),
                )
            for source_record in data["cookingRecords"]:
                record = CookingRecord.objects.create(
                    id=source_record["id"],
                    household=membership.household,
                    recipe_id=source_record["recipeId"],
                    cooked_at=source_record["cookedAt"],
                    servings=source_record["servings"],
                    consumptions=source_record["consumptions"],
                    actor=user,
                    mutation_id=f"{item.import_batch_id}:{source_record['id']}",
                )
                for consumption in source_record["consumptions"]:
                    batch = PantryBatch.objects.get(pk=consumption["pantryBatchId"])
                    movement = InventoryMovement.objects.create(
                        id=new_id("mov"),
                        household=membership.household,
                        pantry_batch=batch,
                        ingredient_id=consumption["ingredientId"],
                        type="cook_consume",
                        quantity_delta=-Decimal(str(consumption["quantity"])),
                        unit=consumption["unit"],
                        actor=user,
                        source_mutation_id=item.import_batch_id,
                        occurred_at=record.cooked_at,
                    )
                    append_change(
                        membership.household,
                        "inventoryMovement",
                        movement.id,
                        "upsert",
                        1,
                        serializers.movement(movement),
                    )
                append_change(
                    membership.household, "cookingRecord", record.id, "upsert", 1, serializers.cooking(record)
                )
            for source_item in data["shoppingList"]:
                shopping_item = ShoppingItem.objects.create(
                    id=source_item["id"],
                    household=membership.household,
                    ingredient_id=source_item["ingredientId"],
                    suggested_quantity=source_item["suggestedQuantity"],
                    unit=source_item["unit"],
                    source_recipe_id=source_item.get("sourceRecipeId", ""),
                    checked=source_item["checked"],
                    created_by=user,
                    created_at=source_item["createdAt"],
                    updated_at=source_item["createdAt"],
                )
                append_change(
                    membership.household,
                    "shoppingItem",
                    shopping_item.id,
                    "upsert",
                    1,
                    serializers.shopping(shopping_item),
                )
            for source_progress in data["progress"]:
                progress = RecipeProgress.objects.create(
                    household=membership.household,
                    user=user,
                    recipe_id=source_progress["recipeId"],
                    status=source_progress["status"],
                    unlocked_at=source_progress.get("unlockedAt"),
                    cook_count=source_progress["cookCount"],
                    last_cooked_at=source_progress.get("lastCookedAt"),
                )
                append_change(
                    membership.household,
                    "recipeProgress",
                    f"{user.id}:{progress.recipe_id}",
                    "upsert",
                    1,
                    serializers.progress(progress),
                )
            source_settings = data["settings"]
            preferences, _ = MemberPreferences.objects.get_or_create(
                household=membership.household, user=user, defaults={"updated_at": current}
            )
            preferences.freshness_reminder_days = source_settings["freshnessReminderDays"]
            preferences.default_storage_mode = source_settings["defaultStorageMode"]
            preferences.favorite_recipe_ids = list(dict.fromkeys(source_settings.get("favoriteRecipeIds", [])))
            preferences.version = 1
            preferences.updated_at = current
            preferences.save()
            append_change(
                membership.household, "preferences", user.id, "upsert", 1, serializers.preferences(preferences)
            )
            item.status, item.committed_at = "committed", current
            item.save(update_fields=["status", "committed_at"])
    result = {
        "importBatchId": item.import_batch_id,
        "householdId": item.household_id,
        **item.summary,
        "checksum": item.checksum,
        "status": item.status,
    }
    return JsonResponse(result)


@endpoint
@require_http_methods(["GET"])
def migration_status(request, import_batch_id):
    user, _ = principal(bearer(request))
    try:
        item = V1Migration.objects.get(user=user, import_batch_id=import_batch_id)
    except V1Migration.DoesNotExist as error:
        raise ApiError("NOT_FOUND", "迁移任务不存在", 404) from error
    return JsonResponse(
        {
            "importBatchId": item.import_batch_id,
            "householdId": item.household_id,
            **item.summary,
            "checksum": item.checksum,
            "status": item.status,
        }
    )


@endpoint
@require_http_methods(["POST"])
def data_export(request):
    user, _ = principal(bearer(request))
    current = now_ms()
    memberships = HouseholdMember.objects.select_related("household").filter(user=user, status="active")
    payload = {
        "format": "bingxiang-v2-user-export",
        "exportedAt": current,
        "user": serializers.user(user),
        "households": [],
    }
    for membership in memberships:
        item = membership.household
        prefs, _ = MemberPreferences.objects.get_or_create(household=item, user=user, defaults={"updated_at": current})
        payload["households"].append(
            {
                "household": serializers.household(item),
                "batches": [
                    serializers.batch(row)
                    for row in PantryBatch.objects.filter(household=item, deleted_at__isnull=True)
                ],
                "shoppingItems": [
                    serializers.shopping(row)
                    for row in ShoppingItem.objects.filter(household=item, deleted_at__isnull=True)
                ],
                "cookingRecords": [serializers.cooking(row) for row in CookingRecord.objects.filter(household=item)],
                "recipeProgress": [
                    serializers.progress(row) for row in RecipeProgress.objects.filter(household=item, user=user)
                ],
                "preferences": serializers.preferences(prefs),
            }
        )
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return JsonResponse(
        {
            "id": new_id("exp"),
            "userId": user.id,
            "status": "ready",
            "createdAt": current,
            "expiresAt": current + settings.DATA_EXPORT_TTL_SECONDS * 1000,
            "checksum": source_checksum(encoded),
            "payload": payload,
        },
        status=201,
    )


@endpoint
@require_http_methods(["GET", "POST", "DELETE"])
def deletion_request(request):
    user, session = principal(bearer(request), allow_deletion_pending=True)
    latest = AccountDeletionRequest.objects.filter(user=user).order_by("-requested_at").first()
    if request.method == "GET":
        if not latest:
            raise ApiError("NOT_FOUND", "没有注销申请", 404)
    elif request.method == "POST":
        payload = body(request)
        require_fields(payload, {"confirmation"}, {"confirmation"})
        if payload["confirmation"] != "注销账号":
            raise ApiError("VALIDATION_ERROR", "请输入“注销账号”确认")
        if Household.objects.filter(owner=user, status="active").exists():
            raise ApiError("OWNER_TRANSFER_REQUIRED", "请先转移或删除名下家庭", 409)
        current = now_ms()
        latest = AccountDeletionRequest.objects.create(
            id=new_id("del"),
            user=user,
            status="pending",
            requested_at=current,
            execute_after=current + settings.ACCOUNT_DELETION_COOLING_SECONDS * 1000,
            restricted_session=session,
        )
        user.status = "deletionPending"
        user.save(update_fields=["status"])
        DeviceSession.objects.filter(user=user).exclude(pk=session.pk).update(revoked_at=current)
    else:
        if not latest or latest.status != "pending":
            raise ApiError("DELETION_NOT_CANCELLABLE", "当前注销申请不能取消", 409)
        latest.status, latest.cancelled_at = "cancelled", now_ms()
        latest.save(update_fields=["status", "cancelled_at"])
        user.status = "active"
        user.save(update_fields=["status"])
    result = {
        "id": latest.id,
        "userId": latest.user_id,
        "status": latest.status,
        "requestedAt": latest.requested_at,
        "executeAfter": latest.execute_after,
        "restrictedSessionId": latest.restricted_session_id,
    }
    if latest.cancelled_at:
        result["cancelledAt"] = latest.cancelled_at
    return JsonResponse(result, status=202 if request.method == "POST" else 200)
