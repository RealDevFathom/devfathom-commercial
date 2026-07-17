import hashlib
import json
import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncConnection

from ..config import Settings, get_settings
from ..database import connection, row_dict, statement
from ..schemas import (
    LoginRequest,
    LoginResponse,
    TwoFactorChallengeResponse,
    TwoFactorVerifyRequest,
    UserOut,
)
from ..security import (
    Principal,
    create_access_token,
    create_two_factor_challenge,
    current_principal,
    decode_two_factor_challenge,
    verify_secret,
)
from .firm_common import claim_totp_counter, consume_recovery_code, matching_totp_counter, new_id

router = APIRouter(prefix="/api/auth", tags=["authentication"])
_login_attempts: dict[str, deque[float]] = defaultdict(deque)
DUMMY_PASSWORD_HASH = "$2b$10$7Jh22HC1lxzaVDwJSaJVp./wPe52BukW8KMrtnZfsoTMNsvJxWclS"


def request_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def login_rate_limit(key: str, limit: int, window_seconds: int = 5 * 60) -> bool:
    now = time.monotonic()
    attempts = _login_attempts[key]
    while attempts and attempts[0] <= now - window_seconds:
        attempts.popleft()
    if len(attempts) >= limit:
        return False
    attempts.append(now)
    return True


async def record_auth_audit(
    db: AsyncConnection,
    *,
    success: bool,
    email: str | None,
    ip: str,
    user_agent: str | None,
    user=None,
    reason: str | None = None,
) -> None:
    operation = "LOGIN" if success else "LOGIN_FAILED"
    await db.execute(
        statement(
            'INSERT INTO audit_logs (id, "createdAt", "actorType", "actorId", "actorName", "actorEmail", '
            '"actorRole", source, category, operation, action, description, "targetType", "targetId", '
            '"targetLabel", metadata, ip, "userAgent", outcome, "errorMessage") VALUES '
            '( :id, now(), CAST(:actor_type AS "AuditActorType"), :actor_id, :actor_name, :actor_email, '
            ":actor_role, 'AUTH', 'AUTH', CAST(:operation AS \"AuditOperation\"), :action, :description, "
            ":target_type, :target_id, :target_label, CAST(:metadata AS jsonb), :ip, :user_agent, "
            'CAST(:outcome AS "AuditOutcome"), :error_message)'
        ),
        {
            "id": new_id(),
            "actor_type": "USER" if user else "ANONYMOUS",
            "actor_id": user["id"] if user else None,
            "actor_name": user["name"] if user else None,
            "actor_email": user["email"] if user else email,
            "actor_role": user["role"] if user else None,
            "operation": operation,
            "action": "auth.login" if success else "auth.loginFailed",
            "description": "Signed in" if success else f"Failed login for {email or 'unknown'}",
            "target_type": "User" if user else None,
            "target_id": user["id"] if user else None,
            "target_label": (user["name"] if user else email),
            "metadata": json.dumps({"reason": reason}) if reason else None,
            "ip": ip,
            "user_agent": user_agent,
            "outcome": "SUCCESS" if success else "FAILURE",
            "error_message": None if success else (reason or "Invalid credentials"),
        },
    )


def principal_for_user(user) -> Principal:
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


def login_response(user, settings: Settings) -> LoginResponse:
    principal = principal_for_user(user)
    return LoginResponse(
        access_token=create_access_token(principal, settings),
        user=UserOut.model_validate(row_dict(user)),
    )


@router.post("/login", response_model=LoginResponse | TwoFactorChallengeResponse)
async def login(
    credentials: LoginRequest,
    request: Request,
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> LoginResponse | TwoFactorChallengeResponse:
    email = str(credentials.email).lower()
    ip = request_ip(request)
    user_agent = request.headers.get("user-agent")
    if not login_rate_limit(f"login:ip:{ip}", 30) or not login_rate_limit(f"login:email:{email}", 10):
        await record_auth_audit(db, success=False, email=email, ip=ip, user_agent=user_agent, reason="Rate limited")
        await db.commit()
        raise HTTPException(status_code=429, detail="Too many login attempts. Please try again later")
    result = await db.execute(
        statement(
            "SELECT id, name, email, password, role::text AS role, department::text AS department, "
            'title, avatar, status::text AS status, "tokenVersion", '
            '"twoFactorEnabledAt", "twoFactorSecret" FROM users '
            "WHERE lower(email) = lower(:email) LIMIT 1"
        ),
        {"email": email},
    )
    user = result.mappings().first()
    password_valid = verify_secret(credentials.password, user["password"] if user else DUMMY_PASSWORD_HASH)
    if not user or not password_valid:
        await record_auth_audit(
            db,
            success=False,
            email=email,
            ip=ip,
            user_agent=user_agent,
            user=user,
            reason="Incorrect password" if user else "No such account",
        )
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user["status"] not in {"ACTIVE", "ON_LEAVE"}:
        await record_auth_audit(
            db,
            success=False,
            email=email,
            ip=ip,
            user_agent=user_agent,
            user=user,
            reason=f"Account is {user['status']}",
        )
        await db.commit()
        raise HTTPException(status_code=403, detail="This account is inactive")

    principal = principal_for_user(user)
    if user["twoFactorEnabledAt"]:
        challenge_token, expires_in = create_two_factor_challenge(principal, settings)
        return TwoFactorChallengeResponse(challenge_token=challenge_token, expires_in=expires_in)
    await db.execute(statement('UPDATE users SET "lastActiveAt" = now() WHERE id = :id'), {"id": user["id"]})
    await record_auth_audit(db, success=True, email=email, ip=ip, user_agent=user_agent, user=user)
    await db.commit()
    return login_response(user, settings)


@router.post("/login/verify", response_model=LoginResponse)
async def verify_login_two_factor(
    payload: TwoFactorVerifyRequest,
    request: Request,
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> LoginResponse:
    ip = request_ip(request)
    user_agent = request.headers.get("user-agent")
    challenge_key = hashlib.sha256(payload.challenge_token.encode()).hexdigest()
    if not login_rate_limit(f"2fa:ip:{ip}", 30) or not login_rate_limit(f"2fa:challenge:{challenge_key}", 10):
        await record_auth_audit(db, success=False, email=None, ip=ip, user_agent=user_agent, reason="2FA rate limited")
        await db.commit()
        raise HTTPException(status_code=429, detail="Too many two-factor attempts. Please try again later")
    try:
        user_id, challenge_version = decode_two_factor_challenge(payload.challenge_token, settings)
    except HTTPException:
        await record_auth_audit(
            db, success=False, email=None, ip=ip, user_agent=user_agent, reason="Invalid 2FA challenge"
        )
        await db.commit()
        raise
    result = await db.execute(
        statement(
            "SELECT id, name, email, role::text AS role, department::text AS department, "
            'title, avatar, status::text AS status, "tokenVersion", '
            '"twoFactorEnabledAt", "twoFactorSecret" FROM users WHERE id = :id FOR UPDATE'
        ),
        {"id": user_id},
    )
    user = result.mappings().first()
    if (
        not user
        or user["status"] not in {"ACTIVE", "ON_LEAVE"}
        or user["tokenVersion"] != challenge_version
        or not user["twoFactorEnabledAt"]
        or not user["twoFactorSecret"]
    ):
        await record_auth_audit(
            db,
            success=False,
            email=user["email"] if user else None,
            ip=ip,
            user_agent=user_agent,
            user=user,
            reason="2FA challenge no longer valid",
        )
        await db.commit()
        raise HTTPException(status_code=401, detail="Two-factor challenge is no longer valid")

    code = payload.code.strip()
    counter = matching_totp_counter(user["twoFactorSecret"], code)
    valid = counter is not None and await claim_totp_counter(db, user["id"], counter)
    if counter is None:
        valid = await consume_recovery_code(db, user["id"], code)
    if not valid:
        await record_auth_audit(
            db,
            success=False,
            email=user["email"],
            ip=ip,
            user_agent=user_agent,
            user=user,
            reason="Invalid or replayed 2FA code",
        )
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid two-factor code")
    await db.execute(statement('UPDATE users SET "lastActiveAt" = now() WHERE id = :id'), {"id": user["id"]})
    await record_auth_audit(db, success=True, email=user["email"], ip=ip, user_agent=user_agent, user=user)
    await db.commit()
    return login_response(user, settings)


@router.get("/me")
async def me(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
) -> dict:
    result = await db.execute(
        statement(
            "SELECT id, name, email, role::text AS role, department::text AS department, "
            "title, avatar FROM users WHERE id = :id"
        ),
        {"id": principal.id},
    )
    user = result.mappings().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {"data": row_dict(user)}
