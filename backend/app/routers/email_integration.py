import base64
import hashlib
import json
import re
import secrets
import time
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlencode

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncConnection

from ..config import Settings, get_settings
from ..database import connection, row_dict, rows, statement
from ..security import Principal, current_principal
from .firm_common import audit_event, new_id

router = APIRouter(prefix="/api/email", tags=["email"])
Provider = Literal["GMAIL", "OUTLOOK"]
GMAIL_SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
]
MS_SCOPES = [
    "offline_access",
    "openid",
    "email",
    "User.Read",
    "Mail.Read",
    "Mail.Send",
]
MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024
SAFE_ATTACHMENT_MIME_TYPES = {
    "application/pdf",
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/webm",
}


def _json_body(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


def _crypto(settings: Settings) -> AESGCM:
    if not settings.email_token_enc_key:
        raise HTTPException(status_code=503, detail="Email credential encryption is not configured.")
    try:
        decoded = base64.urlsafe_b64decode(settings.email_token_enc_key + "===")
    except ValueError:
        decoded = b""
    key = decoded if len(decoded) == 32 else hashlib.sha256(settings.email_token_enc_key.encode()).digest()
    return AESGCM(key)


def _encrypt(value: str, settings: Settings, *, purpose: bytes) -> str:
    nonce = secrets.token_bytes(12)
    encrypted = _crypto(settings).encrypt(nonce, value.encode(), purpose)
    return base64.urlsafe_b64encode(nonce + encrypted).decode().rstrip("=")


def _decrypt(value: str, settings: Settings, *, purpose: bytes) -> str:
    try:
        raw = base64.urlsafe_b64decode(value + "===")
        return _crypto(settings).decrypt(raw[:12], raw[12:], purpose).decode()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="OAuth state or credential is invalid.") from exc


def _provider_configured(provider: Provider, settings: Settings) -> bool:
    if not settings.email_token_enc_key:
        return False
    if provider == "GMAIL":
        return bool(
            settings.google_oauth_client_id
            and settings.google_oauth_client_secret
            and settings.google_oauth_redirect_uri
        )
    return bool(settings.ms_oauth_client_id and settings.ms_oauth_client_secret and settings.ms_oauth_redirect_uri)


async def _mailbox_schema_ready(db: AsyncConnection) -> bool:
    result = await db.execute(statement("SELECT to_regclass('public.mailboxes') IS NOT NULL"))
    return bool(result.scalar_one())


def _pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


@router.get("/providers")
async def email_providers(
    _: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    schema_ready = await _mailbox_schema_ready(db)
    return {provider: schema_ready and _provider_configured(provider, settings) for provider in ("GMAIL", "OUTLOOK")}


@router.post("/oauth/start")
async def oauth_start(
    payload: dict[str, Any],
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    provider = str(payload.get("provider", "")).upper()
    if provider not in {"GMAIL", "OUTLOOK"}:
        raise HTTPException(status_code=422, detail="Unknown email provider")
    typed_provider: Provider = provider  # type: ignore[assignment]
    if not await _mailbox_schema_ready(db):
        raise HTTPException(status_code=503, detail="Connected mailbox storage is not provisioned.")
    if not _provider_configured(typed_provider, settings):
        raise HTTPException(status_code=412, detail=f"{provider.title()} connection is not configured.")
    verifier, challenge = _pkce()
    state_payload = json.dumps(
        {"provider": provider, "userId": principal.id, "verifier": verifier, "exp": int(time.time()) + 600},
        separators=(",", ":"),
    )
    state = _encrypt(state_payload, settings, purpose=b"email-oauth-state")
    if provider == "GMAIL":
        params = {
            "client_id": settings.google_oauth_client_id,
            "redirect_uri": settings.google_oauth_redirect_uri,
            "response_type": "code",
            "scope": " ".join(GMAIL_SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        url = f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"
    else:
        params = {
            "client_id": settings.ms_oauth_client_id,
            "redirect_uri": settings.ms_oauth_redirect_uri,
            "response_type": "code",
            "response_mode": "query",
            "scope": " ".join(MS_SCOPES),
            "prompt": "select_account",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        url = f"https://login.microsoftonline.com/{settings.ms_oauth_tenant}/oauth2/v2.0/authorize?{urlencode(params)}"
    return {"url": url, "state": state}


async def _exchange_code(provider: Provider, code: str, verifier: str, settings: Settings) -> tuple[str, str]:
    if provider == "GMAIL":
        url = "https://oauth2.googleapis.com/token"
        form = {
            "client_id": settings.google_oauth_client_id,
            "client_secret": settings.google_oauth_client_secret,
            "redirect_uri": settings.google_oauth_redirect_uri,
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
        }
    else:
        url = f"https://login.microsoftonline.com/{settings.ms_oauth_tenant}/oauth2/v2.0/token"
        form = {
            "client_id": settings.ms_oauth_client_id,
            "client_secret": settings.ms_oauth_client_secret,
            "redirect_uri": settings.ms_oauth_redirect_uri,
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "scope": " ".join(MS_SCOPES),
        }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, data=form)
        data = _json_body(response)
        if response.status_code >= 400 or not data.get("refresh_token"):
            raise HTTPException(status_code=400, detail=data.get("error_description", "OAuth exchange failed"))
        access_token = data.get("access_token")
        if not access_token:
            raise HTTPException(status_code=400, detail="OAuth provider did not return an access token")
        headers = {"Authorization": f"Bearer {access_token}"}
        if provider == "GMAIL":
            profile = await client.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", headers=headers)
            email_address = _json_body(profile).get("emailAddress") if profile.status_code == 200 else None
        else:
            profile = await client.get(
                "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", headers=headers
            )
            profile_data = _json_body(profile) if profile.status_code == 200 else {}
            email_address = profile_data.get("mail") or profile_data.get("userPrincipalName")
    if not email_address:
        raise HTTPException(status_code=400, detail="Could not read the mailbox address")
    return str(data["refresh_token"]), str(email_address)


@router.post("/oauth/callback")
async def oauth_callback(
    payload: dict[str, Any],
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    code, state = str(payload.get("code", "")), str(payload.get("state", ""))
    if not code or not state:
        raise HTTPException(status_code=422, detail="OAuth code and state are required")
    state_data = json.loads(_decrypt(state, settings, purpose=b"email-oauth-state"))
    if state_data.get("userId") != principal.id or int(state_data.get("exp", 0)) < int(time.time()):
        raise HTTPException(status_code=400, detail="OAuth state is invalid or expired")
    provider = state_data.get("provider")
    if provider not in {"GMAIL", "OUTLOOK"}:
        raise HTTPException(status_code=400, detail="OAuth provider is invalid")
    refresh_token, email_address = await _exchange_code(provider, code, str(state_data["verifier"]), settings)
    encrypted = _encrypt(refresh_token, settings, purpose=b"mailbox-refresh-token")
    existing = await db.execute(
        statement(
            'SELECT id FROM mailboxes WHERE "userId" = :user_id AND type::text = :provider '
            'AND lower("emailAddress") = lower(:email)'
        ),
        {"user_id": principal.id, "provider": provider, "email": email_address},
    )
    mailbox_id = existing.scalar_one_or_none() or new_id()
    await db.execute(
        statement(
            'INSERT INTO mailboxes (id, "userId", type, "emailAddress", credentials, status, '
            '"createdAt", "updatedAt") VALUES (:id, :user_id, CAST(:provider AS "MailboxType"), :email, :credentials, '
            "'active', now(), now()) ON CONFLICT (id) DO UPDATE SET credentials = EXCLUDED.credentials, "
            "status = 'active', \"updatedAt\" = now()"
        ),
        {
            "id": mailbox_id,
            "user_id": principal.id,
            "provider": provider,
            "email": email_address,
            "credentials": encrypted,
        },
    )
    await audit_event(
        db,
        principal,
        category="EMAIL",
        operation="CREATE",
        action="email.connect",
        target_type="Mailbox",
        target_id=mailbox_id,
        target_label=email_address,
        metadata={"provider": provider},
    )
    await db.commit()
    return {"mailboxId": mailbox_id, "emailAddress": email_address, "provider": provider}


async def _owned_mailbox(db: AsyncConnection, principal: Principal, mailbox_id: str) -> dict[str, Any]:
    result = await db.execute(
        statement(
            'SELECT id, type::text type, "emailAddress", "displayName", credentials, status, '
            '"lastSyncedAt", "createdAt" FROM mailboxes WHERE id = :id AND "userId" = :user_id'
        ),
        {"id": mailbox_id, "user_id": principal.id},
    )
    mailbox = result.mappings().first()
    if not mailbox:
        raise HTTPException(status_code=404, detail="Mailbox not found")
    return row_dict(mailbox)


@router.get("/mailboxes")
async def list_mailboxes(
    principal: Principal = Depends(current_principal), db: AsyncConnection = Depends(connection)
) -> list[dict[str, Any]]:
    if not await _mailbox_schema_ready(db):
        return []
    result = await db.execute(
        statement(
            'SELECT id, type::text type, "emailAddress", "displayName", status, "lastSyncedAt", '
            '"createdAt" FROM mailboxes WHERE "userId" = :user_id ORDER BY "createdAt"'
        ),
        {"user_id": principal.id},
    )
    return rows(result)


@router.delete("/mailboxes/{mailbox_id}")
async def disconnect_mailbox(
    mailbox_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    mailbox = await _owned_mailbox(db, principal, mailbox_id)
    revocation = await _revoke_mailbox_grant(mailbox, settings, db)
    await db.execute(statement("DELETE FROM mailboxes WHERE id = :id"), {"id": mailbox_id})
    await audit_event(
        db,
        principal,
        category="EMAIL",
        operation="DELETE",
        action="email.disconnect",
        target_type="Mailbox",
        target_id=mailbox_id,
        target_label=mailbox["emailAddress"],
        metadata={
            "provider": mailbox["type"],
            "provider_revocation": revocation.get("status") or ("revoked" if revocation.get("succeeded") else "failed"),
            "revocation": revocation,
        },
    )
    await db.commit()
    return {"success": True, "revocation": revocation}


async def _access_token(mailbox: dict[str, Any], settings: Settings, db: AsyncConnection) -> str:
    refresh = _decrypt(mailbox["credentials"], settings, purpose=b"mailbox-refresh-token")
    provider = mailbox["type"]
    if provider == "GMAIL":
        url = "https://oauth2.googleapis.com/token"
        form = {
            "client_id": settings.google_oauth_client_id,
            "client_secret": settings.google_oauth_client_secret,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        }
    else:
        url = f"https://login.microsoftonline.com/{settings.ms_oauth_tenant}/oauth2/v2.0/token"
        form = {
            "client_id": settings.ms_oauth_client_id,
            "client_secret": settings.ms_oauth_client_secret,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
            "scope": " ".join(MS_SCOPES),
        }
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, data=form)
    data = _json_body(response)
    if response.status_code >= 400 or not data.get("access_token"):
        raise HTTPException(status_code=502, detail="Mailbox authorization needs to be renewed")
    rotated = data.get("refresh_token")
    if provider == "OUTLOOK" and isinstance(rotated, str) and rotated:
        encrypted = _encrypt(rotated, settings, purpose=b"mailbox-refresh-token")
        result = await db.execute(
            statement(
                'UPDATE mailboxes SET credentials = :new_credentials, "updatedAt" = now() '
                "WHERE id = :id AND credentials = :old_credentials"
            ),
            {
                "id": mailbox["id"],
                "new_credentials": encrypted,
                "old_credentials": mailbox["credentials"],
            },
        )
        if result.rowcount:
            mailbox["credentials"] = encrypted
        await db.commit()
    return str(data["access_token"])


async def _revoke_mailbox_grant(mailbox: dict[str, Any], settings: Settings, db: AsyncConnection) -> dict[str, Any]:
    if mailbox["type"] == "OUTLOOK":
        return {
            "attempted": False,
            "succeeded": False,
            "status": "not_supported_app_scoped",
            "guidance": (
                "DevFathom removed its local mailbox credentials. Microsoft does not provide a safe "
                "app-scoped revocation endpoint for this flow; remove DevFathom under your Microsoft "
                "account's Apps and services permissions if you also want to withdraw the provider grant."
            ),
        }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            refresh = _decrypt(mailbox["credentials"], settings, purpose=b"mailbox-refresh-token")
            response = await client.post(
                "https://oauth2.googleapis.com/revoke",
                params={"token": refresh},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        return {
            "attempted": True,
            "succeeded": 200 <= response.status_code < 300,
            "statusCode": response.status_code,
        }
    except (HTTPException, httpx.HTTPError, ValueError):
        return {"attempted": True, "succeeded": False, "reason": "provider_unavailable"}


def _gmail_header(payload: dict[str, Any], name: str) -> str:
    for header in payload.get("headers", []):
        if str(header.get("name", "")).casefold() == name.casefold():
            return str(header.get("value", ""))
    return ""


def _gmail_normalize(message: dict[str, Any]) -> dict[str, Any]:
    payload = message.get("payload") or {}
    return {
        "id": message.get("id"),
        "threadId": message.get("threadId"),
        "fromAddr": _gmail_header(payload, "From"),
        "toAddrs": [item.strip() for item in _gmail_header(payload, "To").split(",") if item.strip()],
        "subject": _gmail_header(payload, "Subject") or None,
        "snippet": message.get("snippet"),
        "isRead": "UNREAD" not in message.get("labelIds", []),
        "hasAttachments": any(part.get("filename") for part in payload.get("parts", [])),
        "sentAt": int(message.get("internalDate", "0") or 0),
    }


def _graph_normalize(message: dict[str, Any]) -> dict[str, Any]:
    def address(value: dict[str, Any] | None) -> str:
        return str((value or {}).get("emailAddress", {}).get("address", ""))

    return {
        "id": message.get("id"),
        "threadId": message.get("conversationId"),
        "fromAddr": address(message.get("from")),
        "toAddrs": [address(item) for item in message.get("toRecipients", []) if address(item)],
        "subject": message.get("subject"),
        "snippet": message.get("bodyPreview"),
        "isRead": bool(message.get("isRead")),
        "hasAttachments": bool(message.get("hasAttachments")),
        "sentAt": message.get("receivedDateTime"),
    }


@router.get("/messages")
async def list_messages(
    mailbox_id: str = Query(alias="mailboxId"),
    query: str | None = None,
    limit: int = Query(30, ge=1, le=50),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> list[dict[str, Any]]:
    mailbox = await _owned_mailbox(db, principal, mailbox_id)
    token = await _access_token(mailbox, settings, db)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as client:
        if mailbox["type"] == "GMAIL":
            params: dict[str, Any] = {"maxResults": limit, "labelIds": "INBOX"}
            if query:
                params["q"] = query
            listed = await client.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages", headers=headers, params=params
            )
            if listed.status_code >= 400:
                raise HTTPException(status_code=502, detail="Gmail could not be read")
            messages = []
            for item in _json_body(listed).get("messages", []):
                response = await client.get(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{item['id']}",
                    headers=headers,
                    params={"format": "metadata", "metadataHeaders": ["From", "To", "Subject", "Date"]},
                )
                if response.status_code == 200:
                    messages.append(_gmail_normalize(_json_body(response)))
        else:
            params = {
                "$top": limit,
                "$select": "id,conversationId,subject,bodyPreview,isRead,hasAttachments,receivedDateTime,from,toRecipients",
                "$orderby": "receivedDateTime DESC",
            }
            graph_headers = dict(headers)
            if query:
                params = {"$top": limit, "$search": f'"{query}"'}
                graph_headers["ConsistencyLevel"] = "eventual"
            response = await client.get(
                "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
                headers=graph_headers,
                params=params,
            )
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail="Outlook could not be read")
            messages = [_graph_normalize(item) for item in _json_body(response).get("value", [])]
    return [
        dict(message, mailboxId=mailbox_id, mailbox={"type": mailbox["type"], "emailAddress": mailbox["emailAddress"]})
        for message in messages
    ]


def _walk_gmail_parts(part: dict[str, Any], output: dict[str, Any]) -> None:
    body = part.get("body") or {}
    data = body.get("data")
    mime = part.get("mimeType")
    if data and mime in {"text/plain", "text/html"}:
        decoded = base64.urlsafe_b64decode(str(data) + "===").decode(errors="replace")
        output["bodyHtml" if mime == "text/html" else "bodyText"] = decoded
    for child in part.get("parts", []):
        _walk_gmail_parts(child, output)


@router.get("/messages/{mailbox_id}/{message_id}")
async def get_message(
    mailbox_id: str,
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    mailbox = await _owned_mailbox(db, principal, mailbox_id)
    token = await _access_token(mailbox, settings, db)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as client:
        if mailbox["type"] == "GMAIL":
            response = await client.get(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}", headers=headers
            )
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="Message not found")
            raw = _json_body(response)
            message = _gmail_normalize(raw)
            bodies = {"bodyHtml": None, "bodyText": None}
            _walk_gmail_parts(raw.get("payload") or {}, bodies)
            message.update(bodies)
        else:
            response = await client.get(f"https://graph.microsoft.com/v1.0/me/messages/{message_id}", headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="Message not found")
            raw = _json_body(response)
            message = _graph_normalize(raw)
            body = raw.get("body") or {}
            message["bodyHtml" if str(body.get("contentType", "")).casefold() == "html" else "bodyText"] = body.get(
                "content"
            )
    return dict(
        message, mailboxId=mailbox_id, mailbox={"type": mailbox["type"], "emailAddress": mailbox["emailAddress"]}
    )


@router.patch("/messages/{mailbox_id}/{message_id}/read")
async def mark_message_read(
    mailbox_id: str,
    message_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, bool]:
    mailbox = await _owned_mailbox(db, principal, mailbox_id)
    token = await _access_token(mailbox, settings, db)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        if mailbox["type"] == "GMAIL":
            response = await client.post(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}/modify",
                headers=headers,
                json={"removeLabelIds": ["UNREAD"]},
            )
        else:
            response = await client.patch(
                f"https://graph.microsoft.com/v1.0/me/messages/{message_id}",
                headers=headers,
                json={"isRead": True},
            )
    if response.status_code not in {200, 204}:
        raise HTTPException(status_code=502, detail="The provider could not mark the message read")
    return {"success": True}


@router.post("/refresh")
async def refresh_mailbox(
    payload: dict[str, Any],
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    mailbox_id = str(payload.get("mailboxId", ""))
    await _owned_mailbox(db, principal, mailbox_id)
    messages = await list_messages(
        mailbox_id=mailbox_id,
        query=None,
        limit=30,
        principal=principal,
        db=db,
        settings=settings,
    )
    await db.execute(
        statement('UPDATE mailboxes SET "lastSyncedAt" = now(), "updatedAt" = now() WHERE id = :id'),
        {"id": mailbox_id},
    )
    await audit_event(
        db,
        principal,
        category="EMAIL",
        operation="READ",
        action="email.refresh",
        target_type="Mailbox",
        target_id=mailbox_id,
        metadata={"messageCount": len(messages)},
    )
    await db.commit()
    return {"success": True, "count": len(messages)}


def _mime_message(mailbox: dict[str, Any], payload: dict[str, Any]) -> str:
    message = EmailMessage()
    message["From"] = mailbox["emailAddress"]
    message["To"] = ", ".join(payload.get("to") or [])
    if payload.get("cc"):
        message["Cc"] = ", ".join(payload["cc"])
    message["Subject"] = str(payload.get("subject", ""))
    message.set_content(str(payload.get("text") or payload.get("html") or ""))
    return base64.urlsafe_b64encode(message.as_bytes()).decode().rstrip("=")


async def _send_or_draft(
    *,
    mailbox: dict[str, Any],
    payload: dict[str, Any],
    settings: Settings,
    db: AsyncConnection,
    draft: bool,
) -> dict[str, Any]:
    token = await _access_token(mailbox, settings, db)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        if mailbox["type"] == "GMAIL":
            raw = _mime_message(mailbox, payload)
            url = (
                "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
                if draft
                else "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
            )
            body = {"message": {"raw": raw}} if draft else {"raw": raw}
            response = await client.post(url, headers=headers, json=body)
        else:
            message = {
                "subject": payload.get("subject", ""),
                "body": {"contentType": "HTML", "content": payload.get("html") or payload.get("text") or ""},
                "toRecipients": [{"emailAddress": {"address": item}} for item in payload.get("to", [])],
                "ccRecipients": [{"emailAddress": {"address": item}} for item in payload.get("cc", [])],
            }
            url = (
                "https://graph.microsoft.com/v1.0/me/messages"
                if draft
                else "https://graph.microsoft.com/v1.0/me/sendMail"
            )
            body = message if draft else {"message": message, "saveToSentItems": True}
            response = await client.post(url, headers=headers, json=body)
    if response.status_code not in ({200, 201} if draft else {200, 202}):
        raise HTTPException(status_code=502, detail="The provider rejected the message")
    return _json_body(response) if response.content else {"success": True}


@router.post("/send")
async def send_message(
    payload: dict[str, Any],
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    mailbox = await _owned_mailbox(db, principal, str(payload.get("mailboxId", "")))
    if not payload.get("to"):
        raise HTTPException(status_code=422, detail="At least one recipient is required")
    result = await _send_or_draft(mailbox=mailbox, payload=payload, settings=settings, db=db, draft=False)
    await audit_event(
        db,
        principal,
        category="EMAIL",
        operation="CREATE",
        action="email.send",
        target_type="Mailbox",
        target_id=mailbox["id"],
        metadata={"recipientCount": len(payload.get("to", []))},
    )
    await db.commit()
    return result


@router.post("/drafts")
async def create_draft(
    payload: dict[str, Any],
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    mailbox = await _owned_mailbox(db, principal, str(payload.get("mailboxId", "")))
    return await _send_or_draft(mailbox=mailbox, payload=payload, settings=settings, db=db, draft=True)


def _safe_attachment_filename(value: Any) -> str:
    leaf = Path(str(value or "attachment.bin")).name
    cleaned = re.sub(r"[\x00-\x1f\x7f\r\n\"]", "_", leaf).strip(". ")
    return cleaned[:180] or "attachment.bin"


def _safe_attachment_mime(value: Any) -> str:
    mime = str(value or "application/octet-stream").split(";", 1)[0].strip().lower()
    return mime if mime in SAFE_ATTACHMENT_MIME_TYPES else "application/octet-stream"


def _decode_attachment_data(value: Any, declared_size: Any, *, urlsafe: bool) -> bytes:
    try:
        size = int(declared_size) if declared_size is not None else None
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="The provider returned invalid attachment metadata") from exc
    if size is not None and size > MAX_EMAIL_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Attachment exceeds the 25 MiB download limit")
    if not isinstance(value, str) or not value:
        raise HTTPException(status_code=415, detail="This provider attachment type cannot be downloaded")
    maximum_encoded = ((MAX_EMAIL_ATTACHMENT_BYTES + 2) // 3) * 4 + 4
    if len(value) > maximum_encoded:
        raise HTTPException(status_code=413, detail="Attachment exceeds the 25 MiB download limit")
    try:
        padded = value + "=" * (-len(value) % 4)
        data = base64.b64decode(padded, altchars=b"-_" if urlsafe else None, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="The provider returned malformed attachment data") from exc
    if len(data) > MAX_EMAIL_ATTACHMENT_BYTES:
        raise HTTPException(status_code=413, detail="Attachment exceeds the 25 MiB download limit")
    return data


def _gmail_attachment_metadata(part: dict[str, Any], attachment_id: str) -> dict[str, Any] | None:
    body = part.get("body") if isinstance(part.get("body"), dict) else {}
    if body.get("attachmentId") == attachment_id:
        return {
            "filename": part.get("filename"),
            "contentType": part.get("mimeType"),
            "size": body.get("size"),
        }
    for child in part.get("parts", []):
        if isinstance(child, dict) and (found := _gmail_attachment_metadata(child, attachment_id)):
            return found
    return None


@router.get("/attachments/{mailbox_id}/{message_id}/{attachment_id}")
async def get_attachment(
    mailbox_id: str,
    message_id: str,
    attachment_id: str,
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> Response:
    mailbox = await _owned_mailbox(db, principal, mailbox_id)
    token = await _access_token(mailbox, settings, db)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as client:
        if mailbox["type"] == "GMAIL":
            message_response = await client.get(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}",
                headers=headers,
                params={"format": "full"},
            )
            if message_response.status_code != 200:
                raise HTTPException(status_code=404, detail="Message not found")
            metadata = _gmail_attachment_metadata(_json_body(message_response).get("payload") or {}, attachment_id)
            if not metadata:
                raise HTTPException(status_code=404, detail="Attachment not found")
            response = await client.get(
                f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}/attachments/{attachment_id}",
                headers=headers,
            )
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="Attachment not found")
            body = _json_body(response)
            data = _decode_attachment_data(body.get("data"), body.get("size", metadata.get("size")), urlsafe=True)
            filename = _safe_attachment_filename(metadata.get("filename"))
            content_type = _safe_attachment_mime(metadata.get("contentType"))
        else:
            response = await client.get(
                f"https://graph.microsoft.com/v1.0/me/messages/{message_id}/attachments/{attachment_id}",
                headers=headers,
            )
            if response.status_code != 200:
                raise HTTPException(status_code=404, detail="Attachment not found")
            body = _json_body(response)
            data = _decode_attachment_data(body.get("contentBytes"), body.get("size"), urlsafe=False)
            filename = _safe_attachment_filename(body.get("name"))
            content_type = _safe_attachment_mime(body.get("contentType"))
    return Response(
        data,
        media_type=content_type,
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}",
        },
    )
