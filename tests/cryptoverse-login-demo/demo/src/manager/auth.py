import logging

from mozilla_django_oidc.auth import OIDCAuthenticationBackend

logger = logging.getLogger("django")


def get_username(email):
    uid, _ = email.split("@")
    return uid


class OIDCAB(OIDCAuthenticationBackend):
    def create_user(self, claims):
        user = super(OIDCAB, self).create_user(claims)

        logger.info(f"Claims: {claims}")

        user.first_name = claims.get("given_name", "")[:30]
        user.last_name = claims.get("family_name", "")[:30]
        user.save()

        return user

    def update_user(self, user, claims):

        logger.info(f"Claims: {claims}")

        user.first_name = claims.get("given_name", "")[:30]
        user.last_name = claims.get("family_name", "")[:30]
        user.save()

        return user
