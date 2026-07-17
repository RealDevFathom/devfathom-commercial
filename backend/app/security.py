from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from sqlalchemy.ext.asyncio import AsyncConnection

from .config import Settings, get_settings
from .database import connection, statement

bearer = HTTPBearer(auto_error=False)


@dataclass(slots=True)
class Principal:
    id: str
    name: str
    email: str
    role: str
    status: str
    scopes: list[str]
    token_version: int = 0
    actor_type: str = "USER"
    token_id: str | None = None
    token_name: str | None = None

    def has_scope(self, required: str) -> bool:
        if "*" in self.scopes or required in self.scopes:
            return True
        if required.endswith(":read"):
            return required.replace(":read", ":write") in self.scopes
        return False


def verify_secret(value: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(value.encode(), hashed.encode())
    except (ValueError, TypeError):
        return False


def create_access_token(principal: Principal, settings: Settings) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": principal.id,
        "email": principal.email,
        "role": principal.role,
        "ver": principal.token_version,
        "purpose": "session",
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_minutes),
    }
    return jwt.encode(payload, settings.auth_secret, algorithm="HS256")


def create_two_factor_challenge(principal: Principal, settings: Settings) -> tuple[str, int]:
    """Mint a short-lived proof of password verification, never a session token."""
    lifetime_seconds = 5 * 60
    now = datetime.now(UTC)
    payload = {
        "sub": principal.id,
        "ver": principal.token_version,
        "purpose": "two_factor",
        "iat": now,
        "exp": now + timedelta(seconds=lifetime_seconds),
    }
    return jwt.encode(payload, settings.auth_secret, algorithm="HS256"), lifetime_seconds


def decode_two_factor_challenge(token: str, settings: Settings) -> tuple[str, int]:
    try:
        payload = jwt.decode(token, settings.auth_secret, algorithms=["HS256"])
        if payload.get("purpose") != "two_factor":
            raise InvalidTokenError("wrong token purpose")
        return str(payload["sub"]), int(payload["ver"])
    except (InvalidTokenError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired two-factor challenge") from exc


async def principal_from_session(token: str, db: AsyncConnection, settings: Settings) -> Principal:
    try:
        payload = jwt.decode(token, settings.auth_secret, algorithms=["HS256"])
        if payload.get("purpose") == "two_factor":
            raise InvalidTokenError("two-factor challenges are not sessions")
        user_id = payload["sub"]
    except (InvalidTokenError, KeyError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired session") from exc

    result = await db.execute(
        statement(
            "SELECT id, name, email, role::text AS role, status::text AS status, "
            '"tokenVersion" FROM users WHERE id = :id'
        ),
        {"id": user_id},
    )
    user = result.mappings().first()
    if not user or user["status"] not in {"ACTIVE", "ON_LEAVE"}:
        raise HTTPException(status_code=401, detail="Session user is inactive")
    if int(payload.get("ver", -1)) != user["tokenVersion"]:
        raise HTTPException(status_code=401, detail="Session has been revoked")
    return Principal(
        id=user["id"],
        name=user["name"],
        email=user["email"],
        role=user["role"],
        status=user["status"],
        scopes=["*"],
        token_version=user["tokenVersion"],
        actor_type="USER",
    )


async def principal_from_api_token(token: str, db: AsyncConnection) -> Principal:
    if not token.startswith("df_"):
        raise HTTPException(status_code=401, detail="Invalid token format")
    prefix = token[:12]
    result = await db.execute(
        statement(
            'SELECT t.id, t.name AS "tokenName", t."tokenHash", t.scopes, t."expiresAt", t."userId", '
            'u.name, u.email, u.role::text AS role, u.status::text AS status, u."tokenVersion" '
            'FROM api_tokens t JOIN users u ON u.id = t."userId" WHERE t.prefix = :prefix'
        ),
        {"prefix": prefix},
    )
    for candidate in result.mappings():
        if not verify_secret(token, candidate["tokenHash"]):
            continue
        expires_at = candidate["expiresAt"]
        now = datetime.now(UTC)
        if expires_at and expires_at.tzinfo is None:
            now = now.replace(tzinfo=None)
        if expires_at and expires_at < now:
            raise HTTPException(status_code=401, detail="Token has expired")
        if candidate["status"] not in {"ACTIVE", "ON_LEAVE"}:
            raise HTTPException(status_code=403, detail="User account is inactive")
        await db.execute(
            statement('UPDATE api_tokens SET "lastUsedAt" = now() WHERE id = :id'),
            {"id": candidate["id"]},
        )
        await db.commit()
        return Principal(
            id=candidate["userId"],
            name=candidate["name"],
            email=candidate["email"],
            role=candidate["role"],
            status=candidate["status"],
            scopes=list(candidate["scopes"]),
            token_version=candidate["tokenVersion"],
            actor_type="API_TOKEN",
            token_id=candidate["id"],
            token_name=candidate["tokenName"],
        )
    raise HTTPException(status_code=401, detail="Invalid token")


async def current_principal(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> Principal:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bearer token required")
    if credentials.credentials.startswith("df_"):
        return await principal_from_api_token(credentials.credentials, db)
    return await principal_from_session(credentials.credentials, db, settings)


def require_scope(scope: str):
    async def dependency(principal: Principal = Depends(current_principal)) -> Principal:
        if not principal.has_scope(scope):
            raise HTTPException(status_code=403, detail=f"Required scope: {scope}")
        if scope.startswith("finance") and principal.role != "ADMIN":
            raise HTTPException(status_code=403, detail="Finance access requires an admin account")
        return principal

    return dependency
