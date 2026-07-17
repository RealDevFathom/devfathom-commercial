import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from urllib.parse import quote

import bcrypt
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import statement
from ..security import Principal

CENT = Decimal("0.01")
AUDIT_MAX_DEPTH = 8
AUDIT_MAX_ITEMS = 100
AUDIT_MAX_STRING = 4096
AUDIT_MAX_BYTES = 64 * 1024
SENSITIVE_KEY_PARTS = (
    "password",
    "passwd",
    "token",
    "secret",
    "authorization",
    "credential",
    "apikey",
    "api_key",
    "privatekey",
    "private_key",
)


def require_roles(principal: Principal, *roles: str) -> None:
    if principal.role not in roles:
        raise HTTPException(status_code=403, detail=f"Requires one of these roles: {', '.join(roles)}")


async def lock_active_admin_invariant(db: AsyncConnection) -> None:
    """Serialize transactions that can remove an active administrator."""
    await db.execute(statement("SELECT pg_advisory_xact_lock(hashtext('devfathom:active-admin'))"))


def new_id() -> str:
    return secrets.token_urlsafe(18).replace("-", "").replace("_", "")


def round_money(value: Decimal | int | float | str) -> Decimal:
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def invoice_totals(items: list[Any], tax: Decimal) -> tuple[list[dict[str, Any]], Decimal, Decimal]:
    line_items: list[dict[str, Any]] = []
    for item in items:
        amount = round_money(item.quantity * item.rate)
        line_items.append(
            {
                "description": item.description,
                "quantity": float(item.quantity),
                "rate": float(item.rate),
                "amount": float(amount),
            }
        )
    subtotal = round_money(sum((Decimal(str(item["amount"])) for item in line_items), Decimal("0")))
    return line_items, subtotal, round_money(subtotal + tax)


def sha256_token(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def generate_api_token() -> tuple[str, str, str]:
    token = f"df_{secrets.token_urlsafe(24)}"
    return token, token[:12], bcrypt.hashpw(token.encode(), bcrypt.gensalt(rounds=10)).decode()


def generate_link_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, sha256_token(token)


def hash_password(value: str) -> str:
    return bcrypt.hashpw(value.encode(), bcrypt.gensalt(rounds=12)).decode()


def is_sensitive_key(key: str) -> bool:
    normalized = "".join(character for character in key.casefold() if character.isalnum() or character == "_")
    return any(part in normalized for part in SENSITIVE_KEY_PARTS)


def redact(value: Any, key: str | None = None, *, depth: int = 0) -> Any:
    if key and is_sensitive_key(key):
        return "[REDACTED]"
    if depth >= AUDIT_MAX_DEPTH:
        return "[TRUNCATED:MAX_DEPTH]"
    if isinstance(value, dict):
        items = list(value.items())
        result = {str(k): redact(v, str(k), depth=depth + 1) for k, v in items[:AUDIT_MAX_ITEMS]}
        if len(items) > AUDIT_MAX_ITEMS:
            result["_truncated_items"] = len(items) - AUDIT_MAX_ITEMS
        return result
    if isinstance(value, list | tuple | set):
        items = list(value)
        result = [redact(item, depth=depth + 1) for item in items[:AUDIT_MAX_ITEMS]]
        if len(items) > AUDIT_MAX_ITEMS:
            result.append(f"[TRUNCATED:{len(items) - AUDIT_MAX_ITEMS}_ITEMS]")
        return result
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return f"[BYTES:{len(value)}]"
    if isinstance(value, str) and len(value) > AUDIT_MAX_STRING:
        return f"{value[:AUDIT_MAX_STRING]}[TRUNCATED:{len(value) - AUDIT_MAX_STRING}_CHARS]"
    if value is not None and not isinstance(value, str | int | float | bool):
        return str(value)[:AUDIT_MAX_STRING]
    return value


def serialize_audit_json(value: Any) -> str | None:
    if value is None:
        return None
    encoded = json.dumps(redact(value), ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) <= AUDIT_MAX_BYTES:
        return encoded
    # JSON escaping can roughly double a preview full of quotes/backslashes, so
    # cap well below the byte ceiling rather than slicing at the ceiling itself.
    preview = encoded.encode("utf-8")[: AUDIT_MAX_BYTES // 3].decode("utf-8", errors="ignore")
    return json.dumps({"_truncated": True, "preview": preview}, ensure_ascii=False, separators=(",", ":"))


async def audit_event(
    db: AsyncConnection,
    principal: Principal,
    *,
    category: str,
    operation: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    target_label: str | None = None,
    description: str | None = None,
    input_data: Any = None,
    changes: Any = None,
    metadata: Any = None,
    actor_type: str | None = None,
    token_id: str | None = None,
    token_name: str | None = None,
) -> None:
    resolved_token_id = token_id or principal.token_id
    resolved_token_name = token_name or principal.token_name
    resolved_actor_type = actor_type or ("API_TOKEN" if resolved_token_id else principal.actor_type)
    await db.execute(
        statement(
            'INSERT INTO audit_logs (id, "createdAt", "actorType", "actorId", "actorName", "actorEmail", '
            '"actorRole", "tokenId", "tokenName", source, category, operation, action, "targetType", "targetId", "targetLabel", '
            "description, input, changes, metadata, outcome) VALUES "
            '( :id, now(), CAST(:actor_type AS "AuditActorType"), :actor_id, :actor_name, :actor_email, :actor_role, '
            ":token_id, :token_name, 'REST_API', :category, "
            'CAST(:operation AS "AuditOperation"), :action, :target_type, :target_id, :target_label, :description, CAST(:input AS jsonb), '
            "CAST(:changes AS jsonb), CAST(:metadata AS jsonb), 'SUCCESS')"
        ),
        {
            "id": new_id(),
            "actor_id": principal.id,
            "actor_name": principal.name,
            "actor_email": principal.email,
            "actor_role": principal.role,
            "actor_type": resolved_actor_type,
            "token_id": resolved_token_id,
            "token_name": resolved_token_name,
            "category": category,
            "operation": operation,
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "target_label": target_label,
            "description": description,
            "input": serialize_audit_json(input_data),
            "changes": serialize_audit_json(changes),
            "metadata": serialize_audit_json(metadata),
        },
    )


def generate_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _totp(secret: str, counter: int) -> str:
    padding = "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(secret.upper() + padding)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    binary = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{binary % 1_000_000:06d}"


def verify_totp(secret: str, token: str, *, at: int | None = None, window: int = 1) -> bool:
    return matching_totp_counter(secret, token, at=at, window=window) is not None


def matching_totp_counter(secret: str, token: str, *, at: int | None = None, window: int = 1) -> int | None:
    normalized = "".join(token.split())
    if len(normalized) != 6 or not normalized.isdigit():
        return None
    counter = (at if at is not None else int(time.time())) // 30
    for skew in range(-window, window + 1):
        candidate = counter + skew
        if hmac.compare_digest(_totp(secret, candidate), normalized):
            return candidate
    return None


def totp_uri(email: str, secret: str) -> str:
    label = quote(f"DevFathom:{email}", safe="")
    return f"otpauth://totp/{label}?secret={secret}&issuer=DevFathom&algorithm=SHA1&digits=6&period=30"


def generate_recovery_codes(count: int = 10) -> tuple[list[str], list[str]]:
    codes = []
    hashes = []
    for _ in range(count):
        raw = secrets.token_hex(5)
        code = f"{raw[:5]}-{raw[5:]}"
        codes.append(code)
        hashes.append(hash_recovery_code(code))
    return codes, hashes


def hash_recovery_code(code: str) -> str:
    return sha256_token("".join(code.lower().split()))


async def consume_recovery_code(db: AsyncConnection, user_id: str, code: str) -> bool:
    """Atomically consume one matching recovery code."""
    result = await db.execute(
        statement(
            'UPDATE two_factor_recovery_codes SET "usedAt" = now() WHERE id = '
            '(SELECT id FROM two_factor_recovery_codes WHERE "userId" = :user_id '
            'AND "codeHash" = :code_hash AND "usedAt" IS NULL LIMIT 1 FOR UPDATE SKIP LOCKED) '
            'AND "usedAt" IS NULL RETURNING id'
        ),
        {"user_id": user_id, "code_hash": hash_recovery_code(code)},
    )
    return bool(result.first())


async def claim_totp_counter(db: AsyncConnection, user_id: str, counter: int) -> bool:
    """Persist a strictly increasing accepted TOTP step in the reserved preferences namespace."""
    result = await db.execute(
        statement(
            "UPDATE users SET preferences = COALESCE(preferences, '{}'::jsonb) || "
            "jsonb_build_object('_security', COALESCE(preferences->'_security', '{}'::jsonb) || "
            "jsonb_build_object('totpLastCounter', CAST(:counter AS bigint))) "
            "WHERE id = :user_id AND COALESCE(CASE WHEN "
            "preferences #>> '{_security,totpLastCounter}' ~ '^[0-9]+$' THEN "
            "(preferences #>> '{_security,totpLastCounter}')::bigint ELSE -1 END, -1) < :counter "
            "RETURNING id"
        ),
        {"user_id": user_id, "counter": counter},
    )
    return bool(result.first())


def as_naive_utc(value: datetime) -> datetime:
    """Normalize API datetimes for Prisma's PostgreSQL timestamp(3) columns."""
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def utcnow_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def utcnow() -> datetime:
    """Backward-compatible alias for shared integration code."""
    return utcnow_naive()
