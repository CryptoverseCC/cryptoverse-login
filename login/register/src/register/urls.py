import json
import logging
import secrets

from django.http import (
    Http404,
    HttpRequest,
    HttpResponseBadRequest,
    JsonResponse,
    HttpResponseForbidden,
)
from django.urls import path
from django.views.decorators.csrf import csrf_exempt
import requests

SECRET_BYTES = 128

logger = logging.getLogger("register")

AUTH_SECRET = open("/run/secrets/register_auth_secret").read()


@csrf_exempt
def main(request: HttpRequest):
    if request.method == "GET":
        raise Http404()

    auth_header = request.META.get("HTTP_AUTHORIZATION", "")

    logger.info(f"AUTH {auth_header}")

    if not auth_header == AUTH_SECRET:
        return HttpResponseForbidden("HTTP Authorization missing or invalid")

    try:
        client_data = json.loads(request.body)
    except:
        return HttpResponseBadRequest()

    client_data["client_secret"] = secrets.token_hex(SECRET_BYTES)
    logger.info(client_data)

    response = requests.post(
        "https://hydra:4445/clients", json=client_data, verify=False  # nosec
    )
    logger.info(response)
    return JsonResponse(response.json(), status=201)


urlpatterns = [path("register", main)]
