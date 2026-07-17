import base64
import hashlib
import hmac
import json
import mimetypes
import secrets
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncConnection

from ..config import Settings, get_settings
from ..database import connection, statement
from ..security import Principal, current_principal
from . import chat, crm, dashboard, delivery, finance, meetings, notes, people
from .collaboration_common import fetch_all, fetch_one, require_scope
from .delivery_schemas import TaskCreate
from .firm_common import audit_event

router = APIRouter(tags=["integrations"])
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
ALLOWED_UPLOADS = {
    "image/png": {"png"},
    "image/jpeg": {"jpg", "jpeg"},
    "image/gif": {"gif"},
    "image/webp": {"webp"},
    "application/pdf": {"pdf"},
    "text/plain": {"txt"},
    "audio/webm": {"webm"},
    "audio/ogg": {"ogg", "oga"},
    "audio/mp4": {"m4a", "mp4"},
    "audio/mpeg": {"mp3"},
}


def _ably_token_request(api_key: str, user_id: str, capability: dict[str, list[str]]) -> dict[str, Any]:
    try:
        key_name, key_secret = api_key.split(":", 1)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Realtime is not configured correctly.") from exc
    ttl = 30 * 60 * 1000
    timestamp = int(time.time() * 1000)
    nonce = secrets.token_hex(16)
    capability_text = json.dumps(capability, separators=(",", ":"), sort_keys=True)
    canonical = "\n".join([key_name, str(ttl), capability_text, user_id, str(timestamp), nonce, ""])
    mac = base64.b64encode(hmac.new(key_secret.encode(), canonical.encode(), hashlib.sha256).digest()).decode()
    return {
        "keyName": key_name,
        "ttl": ttl,
        "capability": capability_text,
        "clientId": user_id,
        "timestamp": timestamp,
        "nonce": nonce,
        "mac": mac,
    }


@router.get("/api/ably-token")
async def ably_token(
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    await require_scope(principal, "chat:read")
    if not settings.ably_api_key:
        raise HTTPException(status_code=503, detail="Realtime is not configured.")
    memberships = await fetch_all(
        db,
        'SELECT "channelId" FROM channel_members WHERE "userId" = :user_id',
        {"user_id": principal.id},
    )
    capability: dict[str, list[str]] = {
        f"user:{principal.id}": ["subscribe"],
        "presence:global": ["subscribe", "presence"],
    }
    for membership in memberships:
        channel_id = membership["channelId"]
        capability[f"channel:{channel_id}"] = ["subscribe"]
        capability[f"typing:{channel_id}"] = ["publish", "subscribe"]
    return _ably_token_request(settings.ably_api_key, principal.id, capability)


def _safe_upload_name(original: str) -> str:
    leaf = Path(original).name
    safe = "".join(char if char.isalnum() or char in "._-" else "_" for char in leaf)
    return safe[:180] or "file"


def _validate_upload(file: UploadFile, content: bytes) -> tuple[str, str]:
    content_type = (file.content_type or "").split(";", 1)[0].lower()
    extension = Path(file.filename or "").suffix.lower().lstrip(".")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_BYTES} bytes")
    if content_type not in ALLOWED_UPLOADS or extension not in ALLOWED_UPLOADS[content_type]:
        raise HTTPException(status_code=415, detail="Unsupported file type")
    return content_type, extension


def _file_signature(owner_id: str, file_path: str, expires: int, settings: Settings) -> str:
    value = f"{owner_id}\n{file_path}\n{expires}".encode()
    return hmac.new(settings.auth_secret.encode(), value, hashlib.sha256).hexdigest()


def _signed_file_url(file_path: str, owner_id: str, settings: Settings, *, expires: int | None = None) -> str:
    expires = expires or int(time.time()) + 7 * 24 * 60 * 60
    signature = _file_signature(owner_id, file_path, expires, settings)
    return f"/api/files/{quote(file_path, safe='/')}?owner={quote(owner_id, safe='')}&exp={expires}&sig={signature}"


@router.post("/api/upload", status_code=status.HTTP_201_CREATED)
async def upload_file(
    file: UploadFile = File(...),
    principal: Principal = Depends(current_principal),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    content_type, _ = _validate_upload(file, content)
    filename = f"{secrets.token_hex(16)}-{_safe_upload_name(file.filename or 'file')}"
    blob_path = f"uploads/{principal.id}/{filename}"
    if settings.blob_read_write_token and settings.environment.casefold() == "production":
        from vercel.blob import AsyncBlobClient

        client = AsyncBlobClient(token=settings.blob_read_write_token)
        uploaded = await client.put(
            blob_path,
            content,
            access="private",
            content_type=content_type,
            add_random_suffix=False,
        )
        stored_path = uploaded.pathname
    else:
        upload_dir = Path(settings.private_upload_dir).resolve()
        upload_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = upload_dir / blob_path
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(content)
        stored_path = blob_path
    return {
        "url": _signed_file_url(stored_path, principal.id, settings),
        "name": file.filename,
        "size": len(content),
        "type": content_type,
    }


async def _blob_stream(result: Any) -> AsyncIterator[bytes]:
    if result.stream:
        async for chunk in result.stream:
            yield chunk


@router.get("/api/files/{file_path:path}")
async def deliver_file(
    file_path: str,
    owner_id: str = Query(alias="owner", min_length=1, max_length=200),
    expires: int = Query(alias="exp"),
    signature: str = Query(alias="sig", min_length=64, max_length=64),
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    expected = _file_signature(owner_id, file_path, expires, settings)
    if expires < int(time.time()) or not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=403, detail="File capability is invalid or expired")
    if principal.id != owner_id:
        signed_url = _signed_file_url(file_path, owner_id, settings, expires=expires)
        access = await fetch_one(
            db,
            "SELECT ("
            'EXISTS(SELECT 1 FROM message_attachments ma JOIN messages m ON m.id = ma."messageId" '
            'JOIN channel_members cm ON cm."channelId" = m."channelId" '
            'WHERE ma.url = :url AND cm."userId" = :user_id) OR '
            'EXISTS(SELECT 1 FROM task_attachments ta JOIN tasks t ON t.id = ta."taskId" '
            'JOIN columns c ON c.id = t."columnId" JOIN boards b ON b.id = c."boardId" '
            "WHERE ta.url = :url AND (:is_admin OR EXISTS(SELECT 1 FROM project_members pm "
            'WHERE pm."projectId" = b."projectId" AND pm."userId" = :user_id))) OR '
            "EXISTS(SELECT 1 FROM project_files pf WHERE pf.url = :url AND "
            "(:is_admin OR EXISTS(SELECT 1 FROM project_members pm WHERE "
            'pm."projectId" = pf."projectId" AND pm."userId" = :user_id)))'
            ") AS allowed",
            {"url": signed_url, "user_id": principal.id, "is_admin": principal.role == "ADMIN"},
        )
        if not access or not access["allowed"]:
            raise HTTPException(status_code=403, detail="You do not have access to this file")
    headers = {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }
    if settings.blob_read_write_token and settings.environment.casefold() == "production":
        from vercel.blob import AsyncBlobClient

        result = await AsyncBlobClient(token=settings.blob_read_write_token).get(file_path, access="private")
        if result is None or result.status_code != 200:
            raise HTTPException(status_code=404, detail="File not found")
        return StreamingResponse(
            _blob_stream(result),
            media_type=result.blob.content_type or "application/octet-stream",
            headers=headers,
        )
    upload_dir = Path(settings.private_upload_dir).resolve()
    target = (upload_dir / file_path).resolve()
    if not target.is_relative_to(upload_dir):
        raise HTTPException(status_code=404, detail="File not found")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    async def local_stream() -> AsyncIterator[bytes]:
        with target.open("rb") as handle:
            while chunk := handle.read(64 * 1024):
                yield chunk

    return StreamingResponse(
        local_stream(),
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
        headers=headers,
    )


def _assistant_messages(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("messages")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=422, detail="messages must be a non-empty list")
    messages: list[dict[str, Any]] = []
    for message in raw[-20:]:
        if not isinstance(message, dict):
            continue
        role = "model" if message.get("role") == "assistant" else "user"
        content = message.get("content") or message.get("text")
        if isinstance(content, str) and content.strip():
            messages.append({"role": role, "parts": [{"text": content[:12000]}]})
    if not messages:
        raise HTTPException(status_code=422, detail="No usable messages were supplied")
    return messages


def _assistant_tool_declarations() -> list[dict[str, Any]]:
    empty = {"type": "OBJECT", "properties": {}}
    return [
        {
            "name": "workspace_insights",
            "description": "Read role-filtered workspace summary metrics.",
            "parameters": empty,
        },
        {"name": "list_projects", "description": "List projects visible to the acting user.", "parameters": empty},
        {
            "name": "list_tasks",
            "description": "List visible tasks, optionally for one project.",
            "parameters": {"type": "OBJECT", "properties": {"projectId": {"type": "STRING"}}},
        },
        {"name": "list_clients", "description": "List clients when the acting role permits it.", "parameters": empty},
        {"name": "list_people", "description": "List the team with normal privacy redaction.", "parameters": empty},
        {"name": "list_resignations", "description": "List resignations for HR or admin roles.", "parameters": empty},
        {
            "name": "list_chat_channels",
            "description": "List chat channels joined by the acting user.",
            "parameters": empty,
        },
        {"name": "list_notes", "description": "List notes visible to the acting user.", "parameters": empty},
        {"name": "list_meetings", "description": "List meetings visible to the acting user.", "parameters": empty},
        {"name": "list_invoices", "description": "List recent invoices for administrators.", "parameters": empty},
        {
            "name": "create_task",
            "description": "Create a task after explicit user approval. Never call speculatively.",
            "parameters": {
                "type": "OBJECT",
                "required": ["title", "columnId"],
                "properties": {
                    "title": {"type": "STRING"},
                    "columnId": {"type": "STRING"},
                    "description": {"type": "STRING"},
                    "priority": {"type": "STRING", "enum": ["LOW", "MEDIUM", "HIGH", "URGENT"]},
                    "dueDate": {"type": "STRING"},
                    "assigneeIds": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "labelIds": {"type": "ARRAY", "items": {"type": "STRING"}},
                },
            },
        },
    ]


def _approval_token(name: str, arguments: dict[str, Any], principal: Principal, settings: Settings) -> str:
    body = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "name": name,
                    "args": arguments,
                    "userId": principal.id,
                    "exp": int(time.time()) + 600,
                    "jti": secrets.token_urlsafe(24),
                },
                separators=(",", ":"),
                sort_keys=True,
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = hmac.new(settings.auth_secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _approval_claims(
    token: str, name: str, arguments: dict[str, Any], principal: Principal, settings: Settings
) -> dict[str, Any] | None:
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(settings.auth_secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return None
        data = json.loads(base64.urlsafe_b64decode(body + "==="))
        valid = (
            data.get("name") == name
            and data.get("args") == arguments
            and data.get("userId") == principal.id
            and int(data.get("exp", 0)) >= int(time.time())
            and isinstance(data.get("jti"), str)
            and len(data["jti"]) >= 24
        )
        return data if valid else None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def _valid_approval(token: str, name: str, arguments: dict[str, Any], principal: Principal, settings: Settings) -> bool:
    return _approval_claims(token, name, arguments, principal, settings) is not None


async def _consume_approval(
    token: str,
    name: str,
    arguments: dict[str, Any],
    principal: Principal,
    settings: Settings,
    db: AsyncConnection,
) -> None:
    claims = _approval_claims(token, name, arguments, principal, settings)
    if not claims:
        raise HTTPException(status_code=403, detail="Assistant approval is invalid or expired")
    result = await db.execute(
        statement(
            'INSERT INTO assistant_approval_uses (jti, "userId", "toolName", "createdAt") '
            "VALUES (:jti, :user_id, :tool_name, now()) ON CONFLICT (jti) DO NOTHING RETURNING jti"
        ),
        {"jti": claims["jti"], "user_id": principal.id, "tool_name": name},
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=409, detail="Assistant approval has already been used")


async def _execute_assistant_tool(
    name: str, arguments: dict[str, Any], principal: Principal, db: AsyncConnection
) -> dict[str, Any]:
    try:
        if name == "workspace_insights":
            result = await dashboard.stats(principal=principal, db=db)
        elif name == "list_projects":
            result = await delivery.list_projects(limit=25, principal=principal, db=db)
        elif name == "list_tasks":
            result = await delivery.list_tasks(
                project_id=arguments.get("projectId"),
                board_id=None,
                column_id=None,
                limit=40,
                principal=principal,
                db=db,
            )
        elif name == "list_clients":
            result = await crm.list_clients(principal=principal, db=db)
        elif name == "list_people":
            await require_scope(principal, "team:read")
            result = await people.list_team(principal=principal, db=db)
        elif name == "list_resignations":
            await require_scope(principal, "team:read")
            result = await people.list_resignations(status_filter=None, principal=principal, db=db)
        elif name == "list_chat_channels":
            result = await chat.get_channels(principal=principal, db=db)
        elif name == "list_notes":
            result = await notes.list_notes(
                scope="all",
                project_id=None,
                client_id=None,
                search=None,
                limit=40,
                cursor=None,
                principal=principal,
                db=db,
            )
        elif name == "list_meetings":
            result = await meetings.get_all(limit=40, cursor=None, principal=principal, db=db)
        elif name == "list_invoices":
            await require_scope(principal, "finance:read")
            if principal.role != "ADMIN":
                raise HTTPException(status_code=403, detail="Finance access requires an admin account")
            result = await finance.list_invoices(limit=40, _=principal, db=db)
        elif name == "create_task":
            result = await delivery.create_task(
                payload=TaskCreate.model_validate(arguments), principal=principal, db=db
            )
        else:
            return {"error": "Unknown assistant tool"}
        return {"ok": True, "data": jsonable_encoder(result)}
    except HTTPException as exc:
        return {"error": str(exc.detail), "status": exc.status_code}
    except ValidationError as exc:
        return {"error": "The proposed task is invalid", "details": jsonable_encoder(exc.errors())}


async def _gemini_turn(
    client: httpx.AsyncClient, endpoint: str, request_body: dict[str, Any], api_key: str
) -> tuple[list[str], list[dict[str, Any]], dict[str, Any] | None]:
    texts: list[str] = []
    calls: list[dict[str, Any]] = []
    model_content: dict[str, Any] | None = None
    async with client.stream(
        "POST",
        endpoint,
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
        json=request_body,
    ) as response:
        if response.status_code >= 400:
            raise httpx.HTTPStatusError("Gemini provider error", request=response.request, response=response)
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[6:])
                content = event.get("candidates", [{}])[0].get("content")
                if not isinstance(content, dict):
                    continue
                model_content = content
                for part in content.get("parts", []):
                    if isinstance(part.get("text"), str) and part["text"]:
                        texts.append(part["text"])
                    if isinstance(part.get("functionCall"), dict):
                        calls.append(part["functionCall"])
            except (json.JSONDecodeError, IndexError, TypeError):
                continue
    return texts, calls, model_content


@router.post("/api/assistant")
async def assistant_stream(
    payload: dict[str, Any],
    principal: Principal = Depends(current_principal),
    db: AsyncConnection = Depends(connection),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    if not settings.google_generative_ai_api_key:
        raise HTTPException(status_code=503, detail="The assistant is not configured.")
    contents = _assistant_messages(payload)
    approvals = [item for item in payload.get("approvedTools", []) if isinstance(item, str)]
    await audit_event(
        db,
        principal,
        category="AI",
        operation="EXECUTE",
        action="assistant.stream",
        target_type="Assistant",
        description="Started an assistant response",
        metadata={"model": settings.gemini_model, "messageCount": len(contents)},
    )
    await db.commit()
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{quote(settings.gemini_model, safe='')}:streamGenerateContent?alt=sse"
    )
    system_instruction = {
        "parts": [
            {
                "text": (
                    "You are the DevFathom company assistant. Use tools for workspace facts across "
                    "insights, people, resignations, projects, tasks, clients, finance, chat, notes, "
                    f"and meetings. Acting user: {principal.name} ({principal.role}). Tool access is "
                    "enforced by the server. Never claim a write occurred without a successful tool result."
                )
            }
        ]
    }

    async def stream() -> AsyncIterator[str]:
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                for _step in range(6):
                    request_body = {
                        "systemInstruction": system_instruction,
                        "contents": contents,
                        "tools": [{"functionDeclarations": _assistant_tool_declarations()}],
                        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
                    }
                    texts, calls, model_content = await _gemini_turn(
                        client,
                        endpoint,
                        request_body,
                        settings.google_generative_ai_api_key,
                    )
                    if not calls:
                        for text_chunk in texts:
                            yield f"event: text\ndata: {json.dumps({'text': text_chunk})}\n\n"
                        yield "event: done\ndata: {}\n\n"
                        return
                    if not model_content:
                        raise httpx.HTTPError("Gemini returned an invalid tool call")
                    response_parts: list[dict[str, Any]] = []
                    for call in calls:
                        name = str(call.get("name", ""))
                        arguments = call.get("args") if isinstance(call.get("args"), dict) else {}
                        if name == "create_task":
                            approval_id = next(
                                (
                                    item
                                    for item in approvals
                                    if _valid_approval(item, name, arguments, principal, settings)
                                ),
                                None,
                            )
                            if not approval_id:
                                approval_id = _approval_token(name, arguments, principal, settings)
                                yield (
                                    "event: approval_required\ndata: "
                                    + json.dumps({"approvalId": approval_id, "name": name, "arguments": arguments})
                                    + "\n\n"
                                )
                                yield "event: done\ndata: {}\n\n"
                                return
                            await _consume_approval(approval_id, name, arguments, principal, settings, db)
                        result = await _execute_assistant_tool(name, arguments, principal, db)
                        await audit_event(
                            db,
                            principal,
                            category="AI",
                            operation="CREATE" if name == "create_task" else "READ",
                            action=f"assistant.tool.{name}",
                            target_type="AssistantTool",
                            description=f"Assistant tool {name} completed",
                            metadata={"success": bool(result.get("ok"))},
                        )
                        await db.commit()
                        yield (
                            "event: tool_result\ndata: "
                            + json.dumps({"name": name, "result": jsonable_encoder(result)})
                            + "\n\n"
                        )
                        response_parts.append({"functionResponse": {"name": name, "response": {"result": result}}})
                    contents.extend(
                        [
                            {"role": "model", "parts": model_content.get("parts", [])},
                            {"role": "user", "parts": response_parts},
                        ]
                    )
                yield f"event: error\ndata: {json.dumps({'message': 'Assistant tool limit reached'})}\n\n"
                yield "event: done\ndata: {}\n\n"
        except HTTPException as exc:
            yield "event: error\ndata: " + json.dumps({"message": str(exc.detail), "status": exc.status_code}) + "\n\n"
            yield "event: done\ndata: {}\n\n"
        except (httpx.HTTPError, httpx.TimeoutException):
            yield f"event: error\ndata: {json.dumps({'message': 'Assistant provider unavailable'})}\n\n"
            yield "event: done\ndata: {}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
