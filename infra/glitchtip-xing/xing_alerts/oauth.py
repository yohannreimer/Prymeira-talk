"""Durably bind native refresh secrets to this resource without upstream schema edits."""

import base64
import hashlib
import hmac
import json
import math
from cryptography.fernet import Fernet, InvalidToken
from .config import RESOURCE
from .outbox import canonical


class InvalidRefresh(ValueError):
    def __init__(self):
        super().__init__("invalid_refresh_binding")


def read_access_data(raw, now):
    """Validate native OAuth cache data, keeping client and user identities distinct."""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError, UnicodeError):
        return None
    if not isinstance(value, dict):
        return None
    owner = value.get("user_id")
    expiry = value.get("expires_at")
    scopes = value.get("scopes")
    if (
        isinstance(owner, bool)
        or not isinstance(owner, (int, str))
        or not str(owner).isascii()
        or not str(owner).isdigit()
        or len(str(owner)) > 19
        or int(owner) <= 0
        or not isinstance(value.get("client_id"), str)
        or not value["client_id"]
        or value.get("resource") != RESOURCE
        or not isinstance(scopes, list)
        or scopes != ["event:read"]
        or isinstance(expiry, bool)
        or not isinstance(expiry, (int, float))
        or not math.isfinite(expiry)
        or expiry <= now
    ):
        return None
    return {**value, "user_id": str(owner)}


class RefreshCodec:
    def __init__(self, django_secret):
        key = hmac.new(
            django_secret.encode(),
            b"glitchtip-xing-refresh-resource:v1",
            hashlib.sha256,
        ).digest()
        self.cipher = Fernet(base64.urlsafe_b64encode(key))

    def wrap(self, token, client, expires):
        value = {
            "token": token,
            "client": client,
            "resource": RESOURCE,
            "expires": expires,
        }
        return "xing_rt_" + self.cipher.encrypt(canonical(value).encode()).decode()

    def unwrap(self, wire, client, now):
        if (
            not isinstance(wire, str)
            or not wire.startswith("xing_rt_")
            or len(wire) > 4096
        ):
            raise InvalidRefresh()
        try:
            value = json.loads(self.cipher.decrypt(wire[8:].encode()))
        except (InvalidToken, ValueError, UnicodeError):
            raise InvalidRefresh() from None
        if (
            not isinstance(value, dict)
            or set(value) != {"token", "client", "resource", "expires"}
            or value["resource"] != RESOURCE
            or value["client"] != client
            or not isinstance(value["token"], str)
            or not value["token"]
            or not isinstance(value["expires"], (int, float))
            or isinstance(value["expires"], bool)
            or not math.isfinite(value["expires"])
            or value["expires"] <= now
        ):
            raise InvalidRefresh()
        return value["token"]
