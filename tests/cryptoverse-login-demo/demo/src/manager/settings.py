import os


def get_docker_secret(
    scope, name, default=None, secrets_dir=None,
):
    value = None
    secrets_dir = secrets_dir or os.path.join(
        os.path.abspath(os.sep), "app", "secrets", scope
    )

    try:
        with open(os.path.join(secrets_dir, name), "r") as secret_file:
            value = secret_file.read().strip()
    except IOError:
        value = os.environ.get(f"{scope.upper()}_{name.upper()}")

    # set default value if no value found
    if value is None:
        value = default

    return value


# Build paths inside the project like this: os.path.join(BASE_DIR, ...)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/2.1/howto/deployment/checklist/

# SECURITY WARNING: keep the secret key used in production secret!
SECRET_KEY = get_docker_secret("demo", "django")

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = True

ALLOWED_HOSTS = ["*"]


# Application definition

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django_prometheus",
    "mozilla_django_oidc",
    "demo",
]

SITE_ID = 1

MIDDLEWARE = [
    "django_prometheus.middleware.PrometheusBeforeMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "mozilla_django_oidc.middleware.SessionRefresh",
    "request_logging.middleware.LoggingMiddleware",
    "django_prometheus.middleware.PrometheusAfterMiddleware",
]

ROOT_URLCONF = "manager.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

WSGI_APPLICATION = "manager.wsgi.application"

DATABASES = {
    "default": {
        "ENGINE": f"django_prometheus.db.backends.sqlite3",
        "NAME": "/tmp/demo.db",
    }
}

LANGUAGE_CODE = "en-us"

TIME_ZONE = "UTC"

USE_I18N = True

USE_L10N = True

USE_TZ = True

STATIC_URL = "/static/"

#####
# Issue with saving session quickly: https://github.com/mozilla/mozilla-django-oidc/issues/435#issuecomment-1036372844
SESSION_ENGINE = "django.contrib.sessions.backends.cache"
SESSION_COOKIE_AGE = 5 * 60 * 60
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

OIDC_RP_CLIENT_ID = get_docker_secret("oidc", "client_id")
OIDC_RP_CLIENT_SECRET = get_docker_secret("oidc", "client_secret")

OIDC_OP_AUTHORIZATION_ENDPOINT = os.environ["OIDC_OP_AUTHORIZATION_ENDPOINT"]
OIDC_OP_TOKEN_ENDPOINT = os.environ["OIDC_OP_TOKEN_ENDPOINT"]
OIDC_OP_USER_ENDPOINT = os.environ["OIDC_OP_USER_ENDPOINT"]
# OIDC_RP_SCOPES = "openid"
OIDC_STORE_ID_TOKEN = True

OIDC_RP_SIGN_ALGO = "RS256"
# Required for RS256 algorithm
OIDC_OP_JWKS_ENDPOINT = os.environ["OIDC_OP_JWKS_ENDPOINT"]

OIDC_USERNAME_ALGO = "manager.auth.get_username"

AUTHENTICATION_BACKENDS = ["manager.auth.OIDCAB"]

LOGIN_URL = "oidc_authentication_init"
LOGIN_REDIRECT_URL = "demo-app"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler", "level": "DEBUG"}},
    "loggers": {
        "django": {"handlers": ["console"], "level": "DEBUG", "propagate": True},
        'mozilla_django_oidc': {
            'handlers': ['console'],
            'level': 'DEBUG',
            "propagate": True,
        },
    },
}
