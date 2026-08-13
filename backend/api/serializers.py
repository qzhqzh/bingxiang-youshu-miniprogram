from decimal import Decimal


def number(value):
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral() else float(value)
    return value


def user(item):
    return {
        "id": item.id,
        "displayName": item.display_name,
        "status": item.status,
        "createdAt": item.created_at,
        **({"deletedAt": item.deleted_at} if item.deleted_at else {}),
    }


def household(item):
    return {
        "id": item.id,
        "name": item.name,
        "timezone": item.timezone,
        "ownerUserId": item.owner_id,
        "status": item.status,
        "version": item.version,
        "createdAt": item.created_at,
    }


def member(item):
    return {
        "householdId": item.household_id,
        "userId": item.user_id,
        "displayName": item.user.display_name,
        "role": item.role,
        "status": item.status,
        "joinedAt": item.joined_at,
        "version": item.version,
    }


def batch(item):
    result = {
        "id": item.id,
        "householdId": item.household_id,
        "ingredientId": item.ingredient_id,
        "quantity": number(item.quantity),
        "originalQuantity": number(item.original_quantity),
        "unit": item.unit,
        "purchasedAt": item.purchased_at,
        "storageMode": item.storage_mode,
        "status": item.status,
        "createdBy": item.created_by_id,
        "createdAt": item.created_at,
        "updatedAt": item.updated_at,
        "version": item.version,
    }
    if item.shelf_life_days_override is not None:
        result["shelfLifeDaysOverride"] = item.shelf_life_days_override
    if item.note:
        result["note"] = item.note
    if item.deleted_at:
        result["deletedAt"] = item.deleted_at
    return result


def movement(item):
    return {
        "id": item.id,
        "householdId": item.household_id,
        "pantryBatchId": item.pantry_batch_id,
        "ingredientId": item.ingredient_id,
        "type": item.type,
        "quantityDelta": number(item.quantity_delta),
        "unit": item.unit,
        "actorUserId": item.actor_id,
        "sourceMutationId": item.source_mutation_id,
        "occurredAt": item.occurred_at,
    }


def shopping(item):
    result = {
        "id": item.id,
        "householdId": item.household_id,
        "ingredientId": item.ingredient_id,
        "suggestedQuantity": number(item.suggested_quantity),
        "unit": item.unit,
        "checked": item.checked,
        "createdBy": item.created_by_id,
        "createdAt": item.created_at,
        "updatedAt": item.updated_at,
        "version": item.version,
    }
    if item.source_recipe_id:
        result["sourceRecipeId"] = item.source_recipe_id
    if item.deleted_at:
        result["deletedAt"] = item.deleted_at
    return result


def cooking(item):
    return {
        "id": item.id,
        "householdId": item.household_id,
        "recipeId": item.recipe_id,
        "cookedAt": item.cooked_at,
        "servings": number(item.servings),
        "consumptions": item.consumptions,
        "actorUserId": item.actor_id,
        "mutationId": item.mutation_id,
        "version": item.version,
    }


def progress(item):
    result = {
        "householdId": item.household_id,
        "userId": item.user_id,
        "recipeId": item.recipe_id,
        "status": item.status,
        "cookCount": item.cook_count,
        "version": item.version,
    }
    if item.unlocked_at:
        result["unlockedAt"] = item.unlocked_at
    if item.last_cooked_at:
        result["lastCookedAt"] = item.last_cooked_at
    return result


def preferences(item):
    return {
        "householdId": item.household_id,
        "userId": item.user_id,
        "freshnessReminderDays": item.freshness_reminder_days,
        "defaultStorageMode": item.default_storage_mode,
        "favoriteRecipeIds": item.favorite_recipe_ids,
        "version": item.version,
        "updatedAt": item.updated_at,
    }
