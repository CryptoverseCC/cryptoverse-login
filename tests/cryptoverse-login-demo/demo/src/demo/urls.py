from django.urls import path
from .views import (
    home, protected
)

urlpatterns = [
    path("", home, name="home"),
    path("protected", protected, name="protected"),
]
