import asyncio
import json
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection, row_dict, rows, statement
from ..schemas_auth_management import (
    AdminPasswordReset,
    ChangePassword,
    InvitationAccept,
    InvitationCreate,
    LayoffRequest,
    NotificationPreferences,
    PasswordResetApply,
    PasswordResetRequest,
    TwoFactorCode,
)
from ..security import Principal, current_principal, verify_secret
from .firm_common import (
    audit_event,
    claim_totp_counter,
    consume_recovery_code,
    generate_link_token,
    generate_recovery_codes,
    generate_totp_secret,
    hash_password,
    lock_active_admin_invariant,
    matching_totp_counter,
    new_id,
    require_roles,
    sha256_token,
    totp_uri,
    utcnow_naive,
)

router = APIRouter(prefix="/api/auth", tags=["authentication management"])
_reset_attempts: dict[str, deque[float]] = defaultdict(deque)
TOTP_REPLAY_PROTECTION = "atomic last accepted TOTP counter stored in User.preferences._security"


def principal_scope(scope: str, *roles: str):
    async def dependency(principal: Principal = Depends(current_principal)) -> Principal:
        if roles:
            require_roles(principal, *roles)
        if not principal.has_scope(scope):
            raise HTTPException(status_code=403, detail=f"Required scope: {scope}")
        return principal

    return dependency


auth_read = principal_scope("auth:read")
auth_write = principal_scope("auth:write")
team_write_admin = principal_scope("team:write", "ADMIN")
team_write_hr = principal_scope("team:write", "ADMIN", "HR")


async def send_password_reset_email(email: str, token: str) -> None:
    """Best-effort parity with the legacy Brevo transactional mailer."""
    api_key = os.getenv("BREVO_API_KEY")
    sender_email = os.getenv("BREVO_SENDER_EMAIL")
    if not api_key or not sender_email:
        return
    app_url = os.getenv("APP_URL", "http://localhost:3000").rstrip("/")
    reset_url = f"{app_url}/reset-password/{token}"
    payload = {
        "sender": {"email": sender_email, "name": os.getenv("BREVO_SENDER_NAME", "DevFathom")},
        "to": [{"email": email}],
        "subject": "Reset your DevFathom password",
        "textContent": f"Use this link to reset your password within one hour: {reset_url}",
        "htmlContent": f'<p>Use this link to reset your password within one hour:</p><p><a href="{reset_url}">Reset password</a></p>',
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                "https://api.brevo.com/v3/smtp/email",
                headers={"api-key": api_key, "accept": "application/json"},
                json=payload,
            )
            response.raise_for_status()
    except httpx.HTTPError:
        # Account enumeration resistance requires the external response to stay
        # identical even when the provider is unavailable.
        return


def reset_rate_limit(key: str, limit: int, window_seconds: int = 900) -> bool:
    now = time.monotonic()
    bucket = _reset_attempts[key]
    while bucket and bucket[0] <= now - window_seconds:
        bucket.popleft()
    if len(bucket) >= limit:
        return False
    bucket.append(now)
    return True


@router.patch("/password")
async def change_password(
    payload: ChangePassword,
    principal: Principal = Depends(auth_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    result = await db.execute(statement("SELECT password FROM users WHERE id = :id FOR UPDATE"), {"id": principal.id})
    password_hash = result.scalar_one_or_none()
    if not password_hash or not verify_secret(payload.current_password, password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    await db.execute(
        statement(
            'UPDATE users SET password = :password, "passwordChangedAt" = now(), "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id'
        ),
        {"id": principal.id, "password": hash_password(payload.new_password)},
    )
    await audit_event(
        db,
        principal,
        category="AUTH",
        operation="UPDATE",
        action="auth.changePassword",
        target_type="User",
        target_id=principal.id,
        description="Changed account password",
        input_data=payload.model_dump(),
    )
    await db.commit()
    return {"success": True}


@router.post("/sign-out-everywhere")
async def sign_out_everywhere(
    principal: Principal = Depends(auth_write), db: AsyncConnection = Depends(connection)
) -> dict:
    await db.execute(
        statement('UPDATE users SET "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id'),
        {"id": principal.id},
    )
    await audit_event(
        db,
        principal,
        category="AUTH",
        operation="LOGOUT",
        action="auth.signOutEverywhere",
        target_type="User",
        target_id=principal.id,
    )
    await db.commit()
    return {"success": True}


@router.get("/sessions")
async def recent_sign_ins(principal: Principal = Depends(auth_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            'SELECT id, "createdAt", ip, "userAgent" FROM audit_logs WHERE "actorId" = :id AND operation = \'LOGIN\' AND outcome = \'SUCCESS\' ORDER BY "createdAt" DESC LIMIT 15'
        ),
        {"id": principal.id},
    )
    return {
        "data": rows(result),
        "revocation": "Use sign-out-everywhere; JWT sessions are stateless and cannot be revoked individually.",
    }


@router.get("/preferences")
async def get_preferences(principal: Principal = Depends(auth_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement('SELECT preferences, "notificationPrefs" FROM users WHERE id = :id'), {"id": principal.id}
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="User not found")
    preferences = dict(record["preferences"] or {})
    preferences.pop("_security", None)
    return {"preferences": preferences, "notificationPreferences": record["notificationPrefs"]}


@router.put("/preferences")
async def update_preferences(
    payload: dict[str, Any],
    principal: Principal = Depends(auth_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    await db.execute(
        statement(
            "UPDATE users SET preferences = CAST(:payload AS jsonb) || "
            "jsonb_build_object('_security', COALESCE(preferences->'_security', '{}'::jsonb)), "
            '"updatedAt" = now() WHERE id = :id'
        ),
        {"id": principal.id, "payload": json.dumps(payload)},
    )
    await db.commit()
    return {"success": True}


@router.put("/notification-preferences")
async def update_notification_preferences(
    payload: NotificationPreferences,
    principal: Principal = Depends(auth_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    prefs = payload.json_payload()
    for category, channels in prefs.items():
        if set(channels) - {"inApp", "email"}:
            raise HTTPException(status_code=422, detail=f"Unknown notification channel in {category}")
    await db.execute(
        statement('UPDATE users SET "notificationPrefs" = CAST(:payload AS jsonb), "updatedAt" = now() WHERE id = :id'),
        {"id": principal.id, "payload": json.dumps(prefs)},
    )
    await db.commit()
    return {"success": True}


@router.post("/password-reset/request")
async def request_password_reset(
    payload: PasswordResetRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: AsyncConnection = Depends(connection),
) -> dict:
    started_at = time.monotonic()
    email = str(payload.email).lower()
    ip = request.client.host if request.client else "unknown"
    if not reset_rate_limit(f"ip:{ip}", 10) or not reset_rate_limit(f"email:{email}", 5):
        raise HTTPException(status_code=429, detail="Too many reset requests. Please try again later")
    raw_token, token_hash = generate_link_token()
    result = await db.execute(
        statement("SELECT id, password, status::text status FROM users WHERE lower(email) = :email"), {"email": email}
    )
    user = result.mappings().first()
    if user and user["password"] and user["status"] in {"ACTIVE", "ON_LEAVE"}:
        await db.execute(
            statement(
                'INSERT INTO password_reset_tokens (id, "userId", "tokenHash", "expiresAt", "createdAt") VALUES (:id, :user_id, :token_hash, :expires_at, now())'
            ),
            {
                "id": new_id(),
                "user_id": user["id"],
                "token_hash": token_hash,
                "expires_at": utcnow_naive() + timedelta(hours=1),
            },
        )
        await db.commit()
        background_tasks.add_task(send_password_reset_email, email, raw_token)
    # Equalize the externally observable path. Token generation happens for both
    # hits and misses; provider delivery is detached from the response entirely.
    response_floor = 0.250 + secrets.randbelow(31) / 1000
    await asyncio.sleep(max(0.0, response_floor - (time.monotonic() - started_at)))
    return {"success": True}


async def usable_reset(token: str, db: AsyncConnection) -> dict[str, Any] | None:
    result = await db.execute(
        statement(
            'SELECT id, "userId" FROM password_reset_tokens WHERE "tokenHash" = :hash AND "usedAt" IS NULL AND "expiresAt" > now() FOR UPDATE'
        ),
        {"hash": sha256_token(token)},
    )
    record = result.mappings().first()
    return dict(record) if record else None


@router.get("/password-reset/{token}/validate")
async def validate_password_reset(token: str, db: AsyncConnection = Depends(connection)) -> dict:
    return {"valid": bool(await usable_reset(token, db))}


@router.post("/password-reset")
async def apply_password_reset(payload: PasswordResetApply, db: AsyncConnection = Depends(connection)) -> dict:
    record = await usable_reset(payload.token, db)
    if not record:
        raise HTTPException(
            status_code=400, detail="This reset link is invalid or has expired. Please request a new one"
        )
    await db.execute(
        statement(
            'UPDATE users SET password = :password, "passwordChangedAt" = now(), "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id'
        ),
        {"id": record["userId"], "password": hash_password(payload.new_password)},
    )
    consumed = await db.execute(
        statement('UPDATE password_reset_tokens SET "usedAt" = now() WHERE id = :id AND "usedAt" IS NULL RETURNING id'),
        {"id": record["id"]},
    )
    if not consumed.first():
        await db.rollback()
        raise HTTPException(
            status_code=400, detail="This reset link is invalid or has expired. Please request a new one"
        )
    await db.commit()
    return {"success": True}


@router.post("/invitations", status_code=status.HTTP_201_CREATED)
async def create_invitation(
    payload: InvitationCreate,
    principal: Principal = Depends(team_write_admin),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN")
    if payload.role not in {"ADMIN", "HR", "EMPLOYEE"}:
        raise HTTPException(status_code=422, detail="Invalid role")
    email = str(payload.email).lower()
    existing_result = await db.execute(
        statement("SELECT id, status::text status FROM users WHERE lower(email) = :email FOR UPDATE"), {"email": email}
    )
    existing = existing_result.mappings().first()
    if existing and existing["status"] != "INVITED":
        raise HTTPException(status_code=409, detail="A user with this email already exists")
    user_id = existing["id"] if existing else new_id()
    values = {
        "id": user_id,
        "name": payload.name,
        "email": email,
        "role": payload.role,
        "department": payload.department,
        "title": payload.title,
        "phone": payload.phone,
        "bio": payload.bio,
        "skills": payload.skills,
    }
    if existing:
        await db.execute(
            statement(
                "UPDATE users SET name = :name, role = :role, department = :department, title = :title, phone = :phone, bio = :bio, skills = :skills, password = NULL, status = 'INVITED', \"updatedAt\" = now() WHERE id = :id"
            ),
            values,
        )
    else:
        await db.execute(
            statement(
                'INSERT INTO users (id, name, email, password, role, department, title, phone, bio, skills, status, "startDate", "createdAt", "updatedAt") VALUES (:id, :name, :email, NULL, :role, :department, :title, :phone, :bio, :skills, \'INVITED\', now(), now(), now())'
            ),
            values,
        )
    raw_token, token_hash = generate_link_token()
    invite_id = new_id()
    await db.execute(
        statement(
            'INSERT INTO invitations (id, "userId", email, "tokenHash", "invitedById", "expiresAt", "createdAt", "updatedAt") VALUES (:invite_id, :user_id, :email, :token_hash, :invited_by, :expires_at, now(), now()) ON CONFLICT ("userId") DO UPDATE SET "tokenHash" = EXCLUDED."tokenHash", "invitedById" = EXCLUDED."invitedById", "expiresAt" = EXCLUDED."expiresAt", "acceptedAt" = NULL, "updatedAt" = now()'
        ),
        {
            "invite_id": invite_id,
            "user_id": user_id,
            "email": email,
            "token_hash": token_hash,
            "invited_by": principal.id,
            "expires_at": utcnow_naive() + timedelta(days=7),
        },
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="CREATE",
        action="team.inviteMember",
        target_type="User",
        target_id=user_id,
        target_label=payload.name,
        metadata={"email": email, "role": payload.role},
    )
    await db.commit()
    return {"id": user_id, "inviteToken": raw_token, "inviteUrl": f"/invite/{raw_token}"}


async def pending_invitation(token: str, db: AsyncConnection, *, lock: bool = False) -> dict[str, Any] | None:
    suffix = " FOR UPDATE" if lock else ""
    result = await db.execute(
        statement(
            'SELECT i.id, i."userId", i.email, i."acceptedAt", i."expiresAt", u.name, u.title, u.department::text department, u.role::text role FROM invitations i JOIN users u ON u.id = i."userId" WHERE i."tokenHash" = :hash'
            + suffix
        ),
        {"hash": sha256_token(token)},
    )
    record = result.mappings().first()
    if not record or record["acceptedAt"] or record["expiresAt"] < utcnow_naive():
        return None
    return dict(record)


@router.get("/invitations/{token}")
async def get_invitation(token: str, db: AsyncConnection = Depends(connection)) -> dict:
    record = await pending_invitation(token, db)
    if not record:
        raise HTTPException(status_code=404, detail="This invitation is invalid, expired, or has already been used")
    return {key: row_dict(record)[key] for key in ("name", "email", "title", "department", "role")}


@router.post("/invitations/accept")
async def accept_invitation(payload: InvitationAccept, db: AsyncConnection = Depends(connection)) -> dict:
    invitation = await pending_invitation(payload.token, db, lock=True)
    if not invitation:
        raise HTTPException(status_code=404, detail="This invitation is invalid, expired, or has already been used")
    await db.execute(
        statement(
            'UPDATE users SET password = :password, status = \'ACTIVE\', phone = :phone, bio = :bio, skills = COALESCE(:skills, skills), "passwordChangedAt" = now(), "updatedAt" = now() WHERE id = :id'
        ),
        {
            "id": invitation["userId"],
            "password": hash_password(payload.password),
            "phone": payload.phone,
            "bio": payload.bio,
            "skills": payload.skills,
        },
    )
    consumed = await db.execute(
        statement(
            'UPDATE invitations SET "acceptedAt" = now(), "updatedAt" = now() WHERE id = :id AND "acceptedAt" IS NULL RETURNING id'
        ),
        {"id": invitation["id"]},
    )
    if not consumed.first():
        await db.rollback()
        raise HTTPException(status_code=409, detail="This invitation has already been used")
    await db.commit()
    return {"email": invitation["email"]}


@router.post("/members/{user_id}/reset-password")
async def admin_reset_password(
    user_id: str,
    payload: AdminPasswordReset,
    principal: Principal = Depends(team_write_admin),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN")
    result = await db.execute(
        statement(
            'UPDATE users SET password = :password, "passwordChangedAt" = now(), "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id RETURNING name'
        ),
        {"id": user_id, "password": hash_password(payload.new_password)},
    )
    name = result.scalar_one_or_none()
    if not name:
        raise HTTPException(status_code=404, detail="Member not found")
    await audit_event(
        db,
        principal,
        category="AUTH",
        operation="UPDATE",
        action="team.adminResetPassword",
        target_type="User",
        target_id=user_id,
        target_label=name,
        description=f"Reset password for {name}",
        input_data=payload.model_dump(),
        metadata={"passwordReset": True},
    )
    await db.commit()
    return {"success": True}


@router.post("/members/{user_id}/layoff")
async def layoff_member(
    user_id: str,
    payload: LayoffRequest,
    principal: Principal = Depends(team_write_hr),
    db: AsyncConnection = Depends(connection),
) -> dict:
    require_roles(principal, "ADMIN", "HR")
    if user_id == principal.id:
        raise HTTPException(status_code=400, detail="You cannot lay off yourself")
    await lock_active_admin_invariant(db)
    result = await db.execute(
        statement("SELECT name, role::text role, status::text status FROM users WHERE id = :id FOR UPDATE"),
        {"id": user_id},
    )
    target = result.mappings().first()
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")
    if principal.role == "HR" and target["role"] == "ADMIN":
        raise HTTPException(status_code=403, detail="HR cannot lay off an admin")
    if target["role"] == "ADMIN":
        count = await db.execute(
            statement("SELECT COUNT(*) FROM users WHERE id <> :id AND role = 'ADMIN' AND status = 'ACTIVE'"),
            {"id": user_id},
        )
        if count.scalar_one() == 0:
            raise HTTPException(status_code=400, detail="You cannot lay off the last active admin")
    await db.execute(
        statement(
            'UPDATE users SET status = \'INACTIVE\', "tokenVersion" = "tokenVersion" + 1, "updatedAt" = now() WHERE id = :id'
        ),
        {"id": user_id},
    )
    await audit_event(
        db,
        principal,
        category="TEAM",
        operation="UPDATE",
        action="team.layOffMember",
        target_type="User",
        target_id=user_id,
        target_label=target["name"],
        changes={"status": {"before": target["status"], "after": "INACTIVE"}},
        metadata={"laidOff": True, "reason": payload.reason.strip()},
    )
    await db.commit()
    return {"success": True}


@router.get("/two-factor/status")
async def two_factor_status(
    principal: Principal = Depends(auth_read), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(statement('SELECT "twoFactorEnabledAt" FROM users WHERE id = :id'), {"id": principal.id})
    return {"enabled": bool(result.scalar_one_or_none())}


@router.post("/two-factor/enrollment")
async def begin_two_factor(
    principal: Principal = Depends(auth_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement('SELECT email, "twoFactorEnabledAt" FROM users WHERE id = :id FOR UPDATE'), {"id": principal.id}
    )
    user = result.mappings().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user["twoFactorEnabledAt"]:
        raise HTTPException(status_code=400, detail="2FA is already enabled")
    secret = generate_totp_secret()
    await db.execute(
        statement(
            'UPDATE users SET "twoFactorSecret" = :secret, '
            "preferences = COALESCE(preferences, '{}'::jsonb) #- '{_security,totpLastCounter}', "
            '"updatedAt" = now() WHERE id = :id'
        ),
        {"id": principal.id, "secret": secret},
    )
    await db.commit()
    return {"secret": secret, "otpauthUri": totp_uri(user["email"], secret)}


@router.post("/two-factor/enrollment/confirm")
async def confirm_two_factor(
    payload: TwoFactorCode, principal: Principal = Depends(auth_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement('SELECT "twoFactorSecret", "twoFactorEnabledAt" FROM users WHERE id = :id FOR UPDATE'),
        {"id": principal.id},
    )
    user = result.mappings().first()
    if not user or not user["twoFactorSecret"]:
        raise HTTPException(status_code=400, detail="Start enrolment first")
    if user["twoFactorEnabledAt"]:
        raise HTTPException(status_code=400, detail="2FA is already enabled")
    counter = matching_totp_counter(user["twoFactorSecret"], payload.token)
    if counter is None:
        raise HTTPException(status_code=400, detail="That code is incorrect. Try again")
    if not await claim_totp_counter(db, principal.id, counter):
        raise HTTPException(status_code=400, detail="That code has already been used")
    codes, hashes = generate_recovery_codes()
    await db.execute(
        statement('UPDATE users SET "twoFactorEnabledAt" = now(), "updatedAt" = now() WHERE id = :id'),
        {"id": principal.id},
    )
    await db.execute(statement('DELETE FROM two_factor_recovery_codes WHERE "userId" = :id'), {"id": principal.id})
    for code_hash in hashes:
        await db.execute(
            statement(
                'INSERT INTO two_factor_recovery_codes (id, "userId", "codeHash", "createdAt") VALUES (:id, :user_id, :code_hash, now())'
            ),
            {"id": new_id(), "user_id": principal.id, "code_hash": code_hash},
        )
    await audit_event(
        db,
        principal,
        category="AUTH",
        operation="UPDATE",
        action="twoFactor.confirmEnrollment",
        target_type="User",
        target_id=principal.id,
        description="Enabled two-factor authentication",
        metadata={"twoFactor": "enabled"},
    )
    await db.commit()
    return {"recoveryCodes": codes}


@router.delete("/two-factor")
async def disable_two_factor(
    payload: TwoFactorCode, principal: Principal = Depends(auth_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement('SELECT "twoFactorSecret", "twoFactorEnabledAt" FROM users WHERE id = :id FOR UPDATE'),
        {"id": principal.id},
    )
    user = result.mappings().first()
    if not user or not user["twoFactorSecret"] or not user["twoFactorEnabledAt"]:
        raise HTTPException(status_code=400, detail="2FA is not enabled")
    counter = matching_totp_counter(user["twoFactorSecret"], payload.token)
    valid_totp = counter is not None and await claim_totp_counter(db, principal.id, counter)
    if not valid_totp and not await consume_recovery_code(db, principal.id, payload.token):
        raise HTTPException(status_code=400, detail="Invalid code")
    await db.execute(
        statement(
            'UPDATE users SET "twoFactorSecret" = NULL, "twoFactorEnabledAt" = NULL, '
            "preferences = COALESCE(preferences, '{}'::jsonb) #- '{_security,totpLastCounter}', "
            '"updatedAt" = now() WHERE id = :id'
        ),
        {"id": principal.id},
    )
    await db.execute(statement('DELETE FROM two_factor_recovery_codes WHERE "userId" = :id'), {"id": principal.id})
    await audit_event(
        db,
        principal,
        category="AUTH",
        operation="UPDATE",
        action="twoFactor.disable",
        target_type="User",
        target_id=principal.id,
        description="Disabled two-factor authentication",
        metadata={"twoFactor": "disabled"},
    )
    await db.commit()
    return {"success": True}


@router.get("/two-factor/recovery-codes")
async def recovery_code_status(
    principal: Principal = Depends(auth_read), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement('SELECT COUNT(*) FROM two_factor_recovery_codes WHERE "userId" = :id AND "usedAt" IS NULL'),
        {"id": principal.id},
    )
    return {"remaining": result.scalar_one()}
