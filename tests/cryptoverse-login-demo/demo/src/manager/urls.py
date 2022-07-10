from django.urls import path, include
from demo import urls as demo_urls

urlpatterns = [
    path("oidc/", include("mozilla_django_oidc.urls")),
    path("", include('django_prometheus.urls')),
    path("", include(demo_urls)),
]
