"""JWT authentication and role-based access.

Roles, matching the report's "role-based dashboards" enhancement:

  homeowner  own device: view everything, control appliances, edit own settings
  utility    read-only across all devices, plus billing and reports; no control
  admin      everything, including device and user management
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import db
from .config import settings

log = logging.getLogger("smartwatt.auth")

ROLES = ("homeowner", "utility", "admin")

PERMISSIONS: dict[str, set[str]] = {
    "homeowner": {"read", "control", "settings", "automate", "ingest"},
    "utility": {"read", "billing"},
    "admin": {"read", "control", "settings", "automate", "billing", "manage", "ingest"},
}

# Secrets that were ever shipped in docs or example files. A token signed with
# one of these can be forged by anyone who has read the repository.
_KNOWN_PLACEHOLDERS = {"", "change-me-in-production", "changeme", "secret"}
_MIN_SECRET_BYTES = 32

_bearer = HTTPBearer(auto_error=False)


@lru_cache(maxsize=1)
def _jwt_secret() -> str:
    """Configured secret if it is real, otherwise a persisted random one."""
    configured = settings.jwt_secret
    if configured not in _KNOWN_PLACEHOLDERS and len(configured.encode()) >= _MIN_SECRET_BYTES:
        return configured
    if configured not in _KNOWN_PLACEHOLDERS:
        log.warning("SW_JWT_SECRET is shorter than %d bytes; using a generated secret instead",
                    _MIN_SECRET_BYTES)

    path = settings.db_path.parent / ".jwt_secret"
    try:
        stored = path.read_text(encoding="utf-8").strip()
        if len(stored) >= _MIN_SECRET_BYTES:
            return stored
    except FileNotFoundError:
        pass
    generated = secrets.token_hex(_MIN_SECRET_BYTES)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(generated, encoding="utf-8")
    log.info("generated a new JWT signing secret at %s", path)
    return generated


# --------------------------------------------------------------- passwords

def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 120_000
    ).hex()


def create_user(username: str, password: str, role: str, display_name: str = "") -> int:
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    salt = os.urandom(16).hex()
    return db.execute(
        "INSERT INTO users(username, password_hash, salt, role, display_name, created_at) "
        "VALUES(?,?,?,?,?,?)",
        (username, _hash(password, salt), salt, role, display_name or username, db.now_ms()),
    )


def verify_user(username: str, password: str) -> dict | None:
    row = db.query_one("SELECT * FROM users WHERE username=?", (username,))
    if row is None:
        # Hash anyway so a missing user and a wrong password take the same time.
        _hash(password, "00" * 16)
        return None
    if not hmac.compare_digest(_hash(password, row["salt"]), row["password_hash"]):
        return None
    return {
        "id": row["id"], "username": row["username"], "role": row["role"],
        "display_name": row["display_name"],
    }


def seed_default_users() -> None:
    """Create the demo accounts on first run."""
    if db.query_one("SELECT COUNT(*) AS n FROM users")["n"] > 0:
        return
    create_user("admin", settings.admin_password, "admin", "Administrator")
    create_user("home", "home123", "homeowner", "Home Owner")
    create_user("utility", "utility123", "utility", "Utility Analyst")


# ------------------------------------------------------------------ tokens

def issue_token(user: dict) -> str:
    now = int(time.time())
    payload = {
        "sub": user["username"],
        "uid": user["id"],
        "role": user["role"],
        "name": user["display_name"],
        "iat": now,
        "exp": now + settings.jwt_ttl_hours * 3600,
    }
    return jwt.encode(payload, _jwt_secret(), algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        claims = jwt.decode(token, _jwt_secret(), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    return claims if claims.get("role") in ROLES else None


# -------------------------------------------------------------- dependencies

async def current_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    token = creds.credentials if creds else request.query_params.get("token")
    claims = decode_token(token) if token else None
    if not claims:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return claims


def require(permission: str):
    """Dependency factory: require a permission for this route."""
    async def _dep(user: dict = Depends(current_user)) -> dict:
        if permission not in PERMISSIONS.get(user.get("role", ""), set()):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{user.get('role')}' cannot {permission}",
            )
        return user
    return _dep


async def require_ingest(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """HTTP ingest: a matching X-Device-Key, or a user allowed to ingest."""
    key = request.headers.get("X-Device-Key", "")
    if settings.ingest_key and key and hmac.compare_digest(key, settings.ingest_key):
        return {"sub": "device-key", "role": "device"}
    user = await current_user(request, creds)
    if "ingest" not in PERMISSIONS.get(user.get("role", ""), set()):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{user.get('role')}' cannot ingest readings",
        )
    return user


def permissions_for(role: str) -> list[str]:
    return sorted(PERMISSIONS.get(role, set()))
