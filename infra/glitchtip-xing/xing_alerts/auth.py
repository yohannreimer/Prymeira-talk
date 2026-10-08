"""Use GlitchTip's OAuth token and current Django project permissions."""

import math
import time
from dataclasses import dataclass
from .config import RESOURCE


class Unauthorized(ValueError):
    def __init__(self):
        super().__init__("unauthorized")


@dataclass(frozen=True)
class Principal:
    owner: str
    expires: float


async def django_allowed(owner, config):
    from django.contrib.auth import get_user_model
    from apps.projects.api import get_projects_queryset

    if (
        not await get_user_model()
        .objects.filter(pk=int(owner), is_active=True)
        .aexists()
    ):
        return False
    return (
        await get_projects_queryset(int(owner), organization_slug=config.organization)
        .filter(pk=config.project_id, name=config.project_name)
        .aexists()
    )


class Authenticator:
    def __init__(self, provider, config, allowed=django_allowed, now=time.time):
        self.provider = provider
        self.config = config
        self.allowed = allowed
        self.now = now

    async def authenticate(self, bearer):
        if not isinstance(bearer, str) or not bearer or len(bearer) > 4096:
            raise Unauthorized()
        token = await self.provider.load_access_token(bearer)
        if token is None:
            raise Unauthorized()
        expiry = getattr(token, "expires_at", None)
        owner = getattr(token, "user_id", None)
        scopes = getattr(token, "scopes", None)
        if (
            getattr(token, "resource", None) != RESOURCE
            or not isinstance(scopes, list)
            or set(scopes) != {"event:read"}
            or not isinstance(expiry, (int, float))
            or isinstance(expiry, bool)
            or not math.isfinite(expiry)
            or expiry <= self.now()
            or not isinstance(owner, str)
            or not owner.isascii()
            or not owner.isdigit()
            or len(owner) > 19
            or int(owner) <= 0
        ):
            raise Unauthorized()
        if not await self.allowed(owner, self.config):
            raise Unauthorized()
        return Principal(owner, expiry)
