from django.core.management.base import BaseCommand
from django.db import transaction

from api.models import (
    AccountDeletionRequest,
    AuthIdentity,
    DeviceSession,
    Household,
    HouseholdMember,
    MemberPreferences,
    RecipeProgress,
)
from api.security import now_ms


class Command(BaseCommand):
    help = "执行已过冷静期的账号注销任务"

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=50)

    def handle(self, *args, **options):
        limit = options["limit"]
        if not 1 <= limit <= 1000:
            raise ValueError("limit 必须在 1–1000 之间")
        ids = list(
            AccountDeletionRequest.objects.filter(status="pending", execute_after__lte=now_ms())
            .order_by("execute_after")
            .values_list("id", flat=True)[:limit]
        )
        completed = blocked = 0
        for request_id in ids:
            with transaction.atomic():
                request = AccountDeletionRequest.objects.select_related("user").get(pk=request_id)
                if request.status != "pending":
                    continue
                user = request.user
                if Household.objects.filter(owner=user, status="active").exists():
                    request.status, request.blocked_reason = "blocked", "仍拥有有效家庭"
                    request.save(update_fields=["status", "blocked_reason"])
                    blocked += 1
                    continue
                current = now_ms()
                HouseholdMember.objects.filter(user=user).update(status="removed")
                MemberPreferences.objects.filter(user=user).delete()
                RecipeProgress.objects.filter(user=user).delete()
                AuthIdentity.objects.filter(user=user).delete()
                DeviceSession.objects.filter(user=user).update(revoked_at=current)
                user.display_name = "已注销成员"
                user.status = "deleted"
                user.deleted_at = current
                user.save(update_fields=["display_name", "status", "deleted_at"])
                request.status, request.completed_at = "completed", current
                request.save(update_fields=["status", "completed_at"])
                completed += 1
        self.stdout.write(f"completed={completed} blocked={blocked}")
