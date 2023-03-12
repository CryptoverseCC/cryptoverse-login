import logging
import json
from jwt import decode

from base64 import b64decode
from django.contrib.auth.decorators import login_required
from django.shortcuts import render
from django.conf import settings

logger = logging.getLogger("django")


def home(request):
    return render(request, "demo/home.html")


@login_required
def protected(request):
    id_token = request.session.get("oidc_id_token")
    if id_token:
        id_token = decode(id_token, settings.OIDC_RP_CLIENT_SECRET)
    return render(
        request, "demo/protected.html", {"user": request.user, "data": id_token}
    )
