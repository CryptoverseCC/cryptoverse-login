import logging
import json
import base64

from django.contrib.auth.decorators import login_required
from django.shortcuts import render

logger = logging.getLogger("django")


def home(request):
    return render(request, "demo/home.html")


@login_required
def protected(request):
    id_token = request.session.get("oidc_id_token")
    if id_token:
        _, payload, _ = id_token.split(".")
        padded = payload + "=" * (4 - len(payload) % 4)
        decoded = base64.b64decode(padded)
        return json.loads(decoded)
    return render(
        request, "demo/protected.html", {"user": request.user, "data": id_token}
    )
