import logging
import json

from base64 import b64decode
from django.contrib.auth.decorators import login_required
from django.shortcuts import render

logger = logging.getLogger("django")


def home(request):
    return render(request, "demo/home.html")


@login_required
def protected(request):
    id_token = request.session.get("oidc_id_token")
    if id_token:
        _, payload_data, _ = id_token.split(".")
        # id_token = b64decode(payload_data)
        # id_token = json.dumps(id_token)
    return render(
        request, "demo/protected.html", {"user": request.user, "data": payload_data}
    )
