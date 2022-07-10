import logging

from django.contrib.auth.decorators import login_required
from django.shortcuts import render

logger = logging.getLogger("django")

def home(request):
    return render(request, "demo/home.html")


@login_required
def protected(request):
    return render(
        request, "demo/protected.html", {"user": request.user}
    )
