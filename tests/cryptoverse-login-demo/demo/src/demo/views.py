import logging
import json
from jwt import JWT
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
        id_token = JWT().decode(id_token, settings.OIDC_RP_CLIENT_SECRET)
        id_token = json.dumps(JWT)
    return render(
        request, "demo/protected.html", {"user": request.user, "data": id_token}
    )
