from django.urls import include, path

urlpatterns = [path("v2/", include("api.urls"))]
