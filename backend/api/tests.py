import json
import sqlite3
import urllib.error
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.management import call_command
from django.db import connection
from django.test import Client, SimpleTestCase, TestCase, override_settings

from .middleware import SlidingWindowLimiter, limiter
from .models import AccountDeletionRequest, HouseholdMember, InventoryMovement, PantryBatch, ProcessedMutation, User
from .wechat import exchange_code


@override_settings(WECHAT_APP_ID="wx-test", WECHAT_CODE_EXCHANGER="api.testsupport.exchange_code")
class V2ApiTests(TestCase):
    def setUp(self):
        limiter.clear()
        self.client = Client()
        self.alice = self.login("alice", "alice-device-0001")
        self.token = self.alice["accessToken"]
        self.household_id = self.alice["households"][0]["id"]

    def login(self, code, device):
        response = self.client.post(
            "/v2/auth/wechat", data=json.dumps({"code": code, "deviceId": device}), content_type="application/json"
        )
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def headers(self, token=None):
        return {"HTTP_AUTHORIZATION": f"Bearer {token or self.token}"}

    def command(self, name, entity_id, payload, *, base_version=0, mutation_id=None):
        return {
            "mutationId": mutation_id or f"mutation-{name}-{entity_id}",
            "deviceId": "alice-device-0001",
            "householdId": self.household_id,
            "command": name,
            "entityId": entity_id,
            "baseVersion": base_version,
            "payload": payload,
            "clientOccurredAt": "2026-08-13T10:00:00.000Z",
        }

    def push(self, command, expected=200):
        response = self.client.post(
            "/v2/sync/push", data=json.dumps(command), content_type="application/json", **self.headers()
        )
        self.assertEqual(response.status_code, expected, response.content)
        return response.json()

    def purchase(self, entity_id, ingredient, quantity, unit, purchased_at="2026-08-01", storage="chilled"):
        return self.push(
            self.command(
                "PurchaseBatch",
                entity_id,
                {
                    "ingredientId": ingredient,
                    "quantity": quantity,
                    "unit": unit,
                    "purchasedAt": purchased_at,
                    "storageMode": storage,
                },
            )
        )

    def test_01_login_is_stable_and_creates_default_household(self):
        second = self.login("alice", "alice-device-0002")
        self.assertEqual(second["user"]["id"], self.alice["user"]["id"])
        self.assertEqual(second["households"][0]["id"], self.household_id)
        self.assertNotEqual(second["accessToken"], self.token)

    def test_02_strict_payload_and_bearer_auth(self):
        invalid = self.client.post(
            "/v2/auth/wechat",
            data=json.dumps({"code": "x", "deviceId": "valid-device", "extra": True}),
            content_type="application/json",
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["error"]["code"], "VALIDATION_ERROR")
        self.assertEqual(self.client.get("/v2/households").status_code, 401)

    def test_03_purchase_is_atomic_and_idempotent(self):
        command = self.command(
            "PurchaseBatch",
            "batch-egg",
            {
                "ingredientId": "egg",
                "quantity": 6,
                "unit": "piece",
                "purchasedAt": "2026-08-01",
                "storageMode": "chilled",
            },
        )
        first = self.push(command)
        replay = self.push(command)
        self.assertFalse(first["replayed"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(PantryBatch.objects.count(), 1)
        self.assertEqual(InventoryMovement.objects.count(), 1)
        self.assertEqual(ProcessedMutation.objects.count(), 1)

    def test_04_version_conflict_returns_server_canonical(self):
        created = self.push(
            self.command(
                "AddShoppingItem",
                "shopping-egg",
                {"ingredientId": "egg", "suggestedQuantity": 6, "unit": "piece"},
            )
        )
        self.assertEqual(created["canonical"]["version"], 1)
        conflict = self.push(
            self.command("CheckShoppingItem", "shopping-egg", {"checked": True}, base_version=0), expected=409
        )
        self.assertEqual(conflict["error"]["code"], "VERSION_CONFLICT")
        self.assertEqual(conflict["error"]["details"]["serverValue"]["version"], 1)

    def test_05_unlock_and_fefo_cooking_crosses_batches(self):
        self.purchase("egg-old", "egg", 1, "piece", "2026-08-01")
        self.purchase("egg-new", "egg", 3, "piece", "2026-08-02")
        self.purchase("salt", "salt", 10, "g", "2026-01-01", "room")
        self.push(self.command("UnlockRecipe", "steamed_egg", {"recipeId": "steamed_egg"}))
        cooked = self.push(self.command("CompleteCooking", "cooking-1", {"recipeId": "steamed_egg", "servings": 1}))
        consumptions = cooked["canonical"]["consumptions"]
        self.assertEqual([row["pantryBatchId"] for row in consumptions[:2]], ["egg-old", "egg-new"])
        self.assertEqual(PantryBatch.objects.get(pk="egg-old").status, "consumed")
        self.assertEqual(float(PantryBatch.objects.get(pk="egg-new").quantity), 2)

    def test_06_locked_inventory_recipe_rejects_unlock(self):
        response = self.push(self.command("UnlockRecipe", "onion_beef", {"recipeId": "onion_beef"}), expected=409)
        self.assertEqual(response["error"]["code"], "RECIPE_LOCKED")

    def test_07_cross_household_read_is_denied(self):
        bob = self.login("bob", "bob-device-000001")
        response = self.client.get(f"/v2/bootstrap?householdId={self.household_id}", **self.headers(bob["accessToken"]))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "MEMBERSHIP_CHANGED")

    def test_08_invitation_accept_and_viewer_cannot_write(self):
        invitation = self.client.post(
            f"/v2/households/{self.household_id}/invitations",
            data=json.dumps({"role": "viewer", "maxUses": 1}),
            content_type="application/json",
            **self.headers(),
        ).json()
        bob = self.login("bob", "bob-device-000001")
        accepted = self.client.post(f"/v2/invitations/{invitation['token']}/accept", **self.headers(bob["accessToken"]))
        self.assertEqual(accepted.status_code, 200, accepted.content)
        command = self.command(
            "PurchaseBatch",
            "viewer-batch",
            {
                "ingredientId": "egg",
                "quantity": 1,
                "unit": "piece",
                "purchasedAt": "2026-08-01",
                "storageMode": "chilled",
            },
        )
        denied = self.client.post(
            "/v2/sync/push",
            data=json.dumps(command),
            content_type="application/json",
            **self.headers(bob["accessToken"]),
        )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["error"]["code"], "FORBIDDEN")

    def test_09_pull_is_monotonic_and_paginated(self):
        self.purchase("egg-a", "egg", 1, "piece")
        self.purchase("egg-b", "egg", 1, "piece")
        first = self.client.get(
            f"/v2/sync/pull?householdId={self.household_id}&cursor=0&limit=2", **self.headers()
        ).json()
        self.assertEqual(len(first["changes"]), 2)
        self.assertTrue(first["hasMore"])
        second = self.client.get(
            f"/v2/sync/pull?householdId={self.household_id}&cursor={first['nextCursor']}&limit=20",
            **self.headers(),
        ).json()
        self.assertTrue(all(row["cursor"] > first["nextCursor"] for row in second["changes"]))

    def test_10_bootstrap_only_returns_current_users_progress(self):
        self.push(self.command("UnlockRecipe", "steamed_egg", {"recipeId": "steamed_egg"}))
        response = self.client.get(f"/v2/bootstrap?householdId={self.household_id}", **self.headers())
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["recipeProgress"][0]["userId"], self.alice["user"]["id"])
        self.assertIn("preferences", payload)

    def test_11_v1_prepare_and_commit_are_idempotent(self):
        source = json.dumps(
            {
                "ingredients": [{"id": "egg"}],
                "recipes": [{"id": "steamed_egg"}],
                "batches": [
                    {
                        "id": "legacy-egg",
                        "ingredientId": "egg",
                        "quantity": 2,
                        "unit": "piece",
                        "purchasedAt": "2026-08-01",
                        "storageMode": "chilled",
                        "status": "active",
                        "createdAt": 1,
                        "updatedAt": 1,
                    }
                ],
                "progress": [{"recipeId": "steamed_egg", "status": "mastered", "cookCount": 1}],
                "cookingRecords": [
                    {
                        "id": "legacy-cook",
                        "recipeId": "steamed_egg",
                        "cookedAt": 2,
                        "servings": 1,
                        "consumptions": [
                            {"pantryBatchId": "legacy-egg", "ingredientId": "egg", "quantity": 1, "unit": "piece"}
                        ],
                    }
                ],
                "shoppingList": [
                    {
                        "id": "legacy-shop",
                        "ingredientId": "egg",
                        "suggestedQuantity": 6,
                        "unit": "piece",
                        "checked": False,
                        "createdAt": 1,
                    }
                ],
                "settings": {
                    "freshnessReminderDays": 3,
                    "defaultStorageMode": "chilled",
                    "favoriteRecipeIds": ["steamed_egg"],
                },
                "meta": {"version": 1, "initializedAt": 1, "purchasedIngredientIds": ["egg"]},
            }
        )
        request = {"householdId": self.household_id, "importBatchId": "import-1", "source": source}
        prepared = self.client.post(
            "/v2/migrations/v1/prepare", data=json.dumps(request), content_type="application/json", **self.headers()
        )
        self.assertEqual(prepared.status_code, 200, prepared.content)
        committed = self.client.post(
            "/v2/migrations/v1/commit", data=json.dumps(request), content_type="application/json", **self.headers()
        )
        self.assertEqual(committed.status_code, 200, committed.content)
        self.assertEqual(committed.json()["status"], "committed")
        replay = self.client.post(
            "/v2/migrations/v1/commit", data=json.dumps(request), content_type="application/json", **self.headers()
        )
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(PantryBatch.objects.filter(pk="legacy-egg").count(), 1)
        self.assertEqual(float(PantryBatch.objects.get(pk="legacy-egg").original_quantity), 3)
        self.assertEqual(committed.json()["cookingRecordCount"], 1)
        self.assertEqual(committed.json()["shoppingItemCount"], 1)

    def test_12_export_never_contains_identity_or_token_hashes(self):
        response = self.client.post("/v2/me/export", **self.headers())
        self.assertEqual(response.status_code, 201, response.content)
        encoded = json.dumps(response.json())
        self.assertNotIn("providerSubject", encoded)
        self.assertNotIn("tokenHash", encoded)
        self.assertNotIn("deviceIdHash", encoded)

    def test_13_owner_must_transfer_before_account_deletion(self):
        response = self.client.post(
            "/v2/me/deletion-request",
            data=json.dumps({"confirmation": "注销账号"}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "OWNER_TRANSFER_REQUIRED")

    def test_14_sqlite_safety_pragmas_are_active(self):
        with connection.cursor() as cursor:
            cursor.execute("PRAGMA journal_mode")
            self.assertIn(cursor.fetchone()[0].lower(), {"wal", "memory"})
            cursor.execute("PRAGMA foreign_keys")
            self.assertEqual(cursor.fetchone()[0], 1)

    def test_15_exactly_one_owner_after_transfer(self):
        invitation = self.client.post(
            f"/v2/households/{self.household_id}/invitations",
            data=json.dumps({"role": "member"}),
            content_type="application/json",
            **self.headers(),
        ).json()
        bob = self.login("bob", "bob-device-000001")
        self.client.post(f"/v2/invitations/{invitation['token']}/accept", **self.headers(bob["accessToken"]))
        response = self.client.post(
            f"/v2/households/{self.household_id}/transfer-ownership",
            data=json.dumps({"userId": bob["user"]["id"]}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(response.status_code, 200, response.content)
        owners = HouseholdMember.objects.filter(household_id=self.household_id, status="active", role="owner")
        self.assertEqual(owners.count(), 1)
        self.assertEqual(owners.get().user_id, bob["user"]["id"])

    def test_16_profile_sessions_logout_and_revoke(self):
        renamed = self.client.patch(
            "/v2/me",
            data=json.dumps({"displayName": "小冰箱"}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()["displayName"], "小冰箱")
        second = self.login("alice", "alice-device-0002")
        logout = self.client.post("/v2/session/logout", **self.headers(second["accessToken"]))
        self.assertEqual(logout.status_code, 204)
        sessions = self.client.get("/v2/me/sessions", **self.headers()).json()
        target = next(row for row in sessions if not row.get("revokedAt"))
        revoked = self.client.delete(f"/v2/me/sessions/{target['id']}", **self.headers())
        self.assertEqual(revoked.status_code, 204)

    def test_17_household_update_member_role_and_remove(self):
        renamed = self.client.patch(
            f"/v2/households/{self.household_id}",
            data=json.dumps({"name": "我们的冰箱"}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(renamed.json()["name"], "我们的冰箱")
        invitation = self.client.post(
            f"/v2/households/{self.household_id}/invitations",
            data=json.dumps({"role": "member"}),
            content_type="application/json",
            **self.headers(),
        ).json()
        bob = self.login("bob", "bob-device-000001")
        self.client.post(f"/v2/invitations/{invitation['token']}/accept", **self.headers(bob["accessToken"]))
        changed = self.client.patch(
            f"/v2/households/{self.household_id}/members/{bob['user']['id']}",
            data=json.dumps({"role": "viewer"}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(changed.json()["role"], "viewer")
        removed = self.client.delete(
            f"/v2/households/{self.household_id}/members/{bob['user']['id']}", **self.headers()
        )
        self.assertEqual(removed.status_code, 204)

    def test_18_remaining_write_commands_and_preferences(self):
        shopping = self.push(
            self.command(
                "AddShoppingItem", "remove-me", {"ingredientId": "egg", "suggestedQuantity": 3, "unit": "piece"}
            )
        )["canonical"]
        removed = self.push(self.command("RemoveShoppingItem", "remove-me", {}, base_version=shopping["version"]))
        self.assertIn("deletedAt", removed["canonical"])
        batch = self.purchase("discard-me", "egg", 2, "piece")["canonical"]
        discarded = self.push(self.command("DiscardBatch", "discard-me", {}, base_version=batch["version"]))
        self.assertEqual(discarded["canonical"]["status"], "discarded")
        prefs = self.push(
            self.command(
                "UpdatePreferences",
                self.alice["user"]["id"],
                {"freshnessReminderDays": 5, "defaultStorageMode": "frozen", "favoriteRecipeIds": ["steamed_egg"]},
                base_version=1,
            )
        )
        self.assertEqual(prefs["canonical"]["freshnessReminderDays"], 5)

    def test_19_deletion_cooling_period_and_worker(self):
        invitation = self.client.post(
            f"/v2/households/{self.household_id}/invitations",
            data=json.dumps({"role": "member"}),
            content_type="application/json",
            **self.headers(),
        ).json()
        bob = self.login("bob", "bob-device-000001")
        self.client.post(f"/v2/invitations/{invitation['token']}/accept", **self.headers(bob["accessToken"]))
        self.client.post(
            f"/v2/households/{self.household_id}/transfer-ownership",
            data=json.dumps({"userId": bob["user"]["id"]}),
            content_type="application/json",
            **self.headers(),
        )
        requested = self.client.post(
            "/v2/me/deletion-request",
            data=json.dumps({"confirmation": "注销账号"}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(requested.status_code, 202, requested.content)
        AccountDeletionRequest.objects.update(execute_after=0)
        call_command("process_deletions", limit=10)
        self.assertEqual(User.objects.get(pk=self.alice["user"]["id"]).status, "deleted")

    def test_20_deletion_request_can_be_cancelled(self):
        HouseholdMember.objects.filter(household_id=self.household_id, user_id=self.alice["user"]["id"]).update(
            role="admin"
        )
        other_user = User.objects.create(id="owner-2", display_name="owner", status="active", created_at=1)
        household = self.alice["households"][0]
        from .models import Household

        Household.objects.filter(pk=household["id"]).update(owner=other_user)
        request = self.client.post(
            "/v2/me/deletion-request",
            data=json.dumps({"confirmation": "注销账号"}),
            content_type="application/json",
            **self.headers(),
        )
        self.assertEqual(request.status_code, 202)
        status = self.client.get("/v2/me/deletion-request", **self.headers())
        self.assertEqual(status.json()["status"], "pending")
        cancelled = self.client.delete("/v2/me/deletion-request", **self.headers())
        self.assertEqual(cancelled.json()["status"], "cancelled")

    def test_21_health_and_readiness(self):
        self.assertEqual(self.client.get("/v2/health").json()["database"], "sqlite3")
        self.assertEqual(self.client.get("/v2/health/ready").json()["status"], "ready")


class OperationalTests(TestCase):
    def test_22_sliding_window_limiter(self):
        limiter = SlidingWindowLimiter()
        self.assertEqual(limiter.allow("login:test", 2, 60), (True, 0))
        self.assertEqual(limiter.allow("login:test", 2, 60), (True, 0))
        allowed, retry_after = limiter.allow("login:test", 2, 60)
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry_after, 1)

    def test_23_consistent_sqlite_backup(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "database" / "db.sqlite3"
            source.parent.mkdir()
            with closing(sqlite3.connect(source)) as database:
                with database:
                    database.execute("CREATE TABLE proof (value TEXT NOT NULL)")
                    database.execute("INSERT INTO proof VALUES ('ok')")
            destination = root / "backup"
            with override_settings(DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": source}}):
                call_command("backup_sqlite", destination=str(destination))
            backups = list(destination.glob("*.sqlite3"))
            self.assertEqual(len(backups), 1)
            with closing(sqlite3.connect(backups[0])) as database:
                self.assertEqual(database.execute("SELECT value FROM proof").fetchone()[0], "ok")


class FakeWechatResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.payload


@override_settings(WECHAT_APP_ID="wx-safe", WECHAT_APP_SECRET="server-only-secret")  # noqa: S106 - fake test value
class WechatExchangeTests(SimpleTestCase):
    @patch("api.wechat.urllib.request.urlopen")
    def test_24_exchange_uses_official_https_and_returns_openid(self, urlopen):
        urlopen.return_value = FakeWechatResponse({"openid": "openid-1", "session_key": "must-not-persist"})
        self.assertEqual(exchange_code("temporary-code"), "openid-1")
        request = urlopen.call_args.args[0]
        self.assertTrue(request.full_url.startswith("https://api.weixin.qq.com/sns/jscode2session?"))

    @patch("api.wechat.urllib.request.urlopen")
    def test_25_exchange_maps_wechat_rejection(self, urlopen):
        urlopen.return_value = FakeWechatResponse({"errcode": 40029, "errmsg": "invalid code"})
        with self.assertRaisesMessage(Exception, "微信登录凭证无效"):
            exchange_code("invalid")

    @patch("api.wechat.urllib.request.urlopen", side_effect=urllib.error.URLError("offline"))
    def test_26_exchange_maps_network_failure(self, _urlopen):
        with self.assertRaisesMessage(Exception, "微信登录服务暂不可用"):
            exchange_code("temporary-code")
