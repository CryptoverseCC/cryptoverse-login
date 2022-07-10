from .settings import *

DEBUG = True

DATABASES = {
    "default": {
        "ENGINE": f"django.db.backends.sqlite3",
        "NAME": "/tmp/tests.db",  # nosec
    }
}
