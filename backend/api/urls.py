from django.urls import path

from . import views

urlpatterns = [
    path("health", views.health),
    path("health/ready", views.ready),
    path("auth/wechat", views.auth_wechat),
    path("session/logout", views.logout),
    path("me", views.me),
    path("me/sessions", views.sessions),
    path("me/sessions/<str:session_id>", views.revoke_session),
    path("me/export", views.data_export),
    path("me/deletion-request", views.deletion_request),
    path("households", views.households),
    path("households/<str:household_id>", views.household_detail),
    path("households/<str:household_id>/invitations", views.create_invitation),
    path("households/<str:household_id>/invitations/<str:invitation_id>", views.revoke_invitation),
    path("invitations/<str:token>/accept", views.accept_invitation),
    path("households/<str:household_id>/members/<str:user_id>", views.member_detail),
    path("households/<str:household_id>/transfer-ownership", views.transfer_ownership),
    path("bootstrap", views.bootstrap),
    path("sync/push", views.sync_push),
    path("sync/pull", views.sync_pull),
    path("migrations/v1/prepare", views.migration, {"action": "prepare"}),
    path("migrations/v1/commit", views.migration, {"action": "commit"}),
    path("migrations/v1/<str:import_batch_id>", views.migration_status),
]
