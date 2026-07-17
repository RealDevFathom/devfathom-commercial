import base64
import hashlib
import hmac
import io
import json
from email import message_from_bytes
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from backend.app.config import Settings
from backend.app.routers import email_integration, integrations
from backend.app.security import Principal
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers


def principal(user_id: str = "user-1", role: str = "ADMIN") -> Principal:
    return Principal(
        id=user_id,
        name="Test User",
        email="test@example.com",
        role=role,
        status="ACTIVE",
        scopes=["*"],
    )


async def response_body(response) -> str:
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    return "".join(chunks)


class FakeDb:
    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1

    async def execute(self, *_args, **_kwargs):
        class Result:
            @staticmethod
            def scalar_one_or_none():
                return "consumed"

        return Result()


def test_ably_token_request_matches_the_official_canonical_hmac_contract() -> None:
    token = integrations._ably_token_request("app.key:top-secret", "user-1", {"channel:c1": ["subscribe"]})
    canonical = "\n".join(
        [
            token["keyName"],
            str(token["ttl"]),
            token["capability"],
            token["clientId"],
            str(token["timestamp"]),
            token["nonce"],
            "",
        ]
    )
    expected = base64.b64encode(hmac.new(b"top-secret", canonical.encode(), hashlib.sha256).digest()).decode()
    assert token["keyName"] == "app.key"
    assert token["ttl"] == 30 * 60 * 1000
    assert token["mac"] == expected


def test_upload_validation_requires_matching_allowlisted_mime_and_extension() -> None:
    valid = UploadFile(
        io.BytesIO(b"document"), filename="brief.pdf", headers=Headers({"content-type": "application/pdf"})
    )
    assert integrations._validate_upload(valid, b"document") == ("application/pdf", "pdf")
    disguised = UploadFile(
        io.BytesIO(b"document"), filename="brief.exe", headers=Headers({"content-type": "application/pdf"})
    )
    with pytest.raises(HTTPException) as error:
        integrations._validate_upload(disguised, b"document")
    assert error.value.status_code == 415


@pytest.mark.asyncio
async def test_private_file_capability_is_owner_path_bound_and_tamper_evident(tmp_path) -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        private_upload_dir=str(tmp_path),
    )
    first = tmp_path / "uploads" / "user-1" / "first.pdf"
    second = tmp_path / "uploads" / "user-1" / "second.pdf"
    first.parent.mkdir(parents=True)
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    path = "uploads/user-1/first.pdf"
    signed = integrations._signed_file_url(path, "user-1", settings)
    query = parse_qs(urlparse(signed).query)
    expires, signature = int(query["exp"][0]), query["sig"][0]

    response = await integrations.deliver_file(
        path,
        owner_id="user-1",
        expires=expires,
        signature=signature,
        principal=principal(),
        db=object(),
        settings=settings,
    )
    body = b"".join([chunk async for chunk in response.body_iterator])
    assert body == b"first"
    assert response.headers["cache-control"] == "private, no-store"

    with pytest.raises(HTTPException) as other_file:
        await integrations.deliver_file(
            "uploads/user-1/second.pdf",
            owner_id="user-1",
            expires=expires,
            signature=signature,
            principal=principal(),
            db=object(),
            settings=settings,
        )
    assert other_file.value.status_code == 403
    with pytest.raises(HTTPException) as tampered:
        await integrations.deliver_file(
            path,
            owner_id="user-2",
            expires=expires,
            signature=signature,
            principal=principal(),
            db=object(),
            settings=settings,
        )
    assert tampered.value.status_code == 403


@pytest.mark.asyncio
async def test_shared_file_requires_exact_database_association_and_resource_access(tmp_path, monkeypatch) -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        private_upload_dir=str(tmp_path),
    )
    path = "uploads/owner-1/shared.pdf"
    target = tmp_path / path
    target.parent.mkdir(parents=True)
    target.write_bytes(b"shared")
    signed = integrations._signed_file_url(path, "owner-1", settings)
    query = parse_qs(urlparse(signed).query)
    expires, signature = int(query["exp"][0]), query["sig"][0]

    async def denied(*_args, **_kwargs):
        return {"allowed": False}

    monkeypatch.setattr(integrations, "fetch_one", denied)
    with pytest.raises(HTTPException) as denied_error:
        await integrations.deliver_file(
            path,
            owner_id="owner-1",
            expires=expires,
            signature=signature,
            principal=principal("member-1"),
            db=object(),
            settings=settings,
        )
    assert denied_error.value.status_code == 403

    async def allowed(_db, _sql, params):
        assert params["url"] == signed
        assert params["user_id"] == "member-1"
        return {"allowed": True}

    monkeypatch.setattr(integrations, "fetch_one", allowed)
    response = await integrations.deliver_file(
        path,
        owner_id="owner-1",
        expires=expires,
        signature=signature,
        principal=principal("member-1"),
        db=object(),
        settings=settings,
    )
    assert b"".join([chunk async for chunk in response.body_iterator]) == b"shared"


def test_email_oauth_crypto_round_trip_and_tamper_rejection() -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        email_token_enc_key="email-encryption-key-for-tests",
    )
    encrypted = email_integration._encrypt("refresh-token", settings, purpose=b"mailbox-refresh-token")
    assert "refresh-token" not in encrypted
    assert email_integration._decrypt(encrypted, settings, purpose=b"mailbox-refresh-token") == "refresh-token"
    raw = bytearray(base64.urlsafe_b64decode(encrypted + "==="))
    raw[-1] ^= 1
    tampered = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    with pytest.raises(HTTPException):
        email_integration._decrypt(tampered, settings, purpose=b"mailbox-refresh-token")


@pytest.mark.asyncio
async def test_google_oauth_start_uses_state_pkce_offline_access_and_bound_identity() -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        email_token_enc_key="email-encryption-key-for-tests",
        google_oauth_client_id="client-id",
        google_oauth_client_secret="client-secret",
        google_oauth_redirect_uri="http://localhost:3000/email/oauth/callback",
    )

    class SchemaDb:
        async def execute(self, *_args, **_kwargs):
            class Result:
                @staticmethod
                def scalar_one():
                    return True

            return Result()

    result = await email_integration.oauth_start({"provider": "GMAIL"}, principal(), SchemaDb(), settings)
    query = parse_qs(urlparse(result["url"]).query)
    state = json.loads(email_integration._decrypt(query["state"][0], settings, purpose=b"email-oauth-state"))
    assert query["access_type"] == ["offline"]
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) >= 43
    assert state["userId"] == "user-1"
    assert state["provider"] == "GMAIL"
    assert state["verifier"]


def test_gmail_message_is_rfc822_base64url_encoded() -> None:
    raw = email_integration._mime_message(
        {"emailAddress": "sender@example.com"},
        {"to": ["one@example.com"], "subject": "Status", "text": "Filed."},
    )
    parsed = message_from_bytes(base64.urlsafe_b64decode(raw + "==="))
    assert parsed["From"] == "sender@example.com"
    assert parsed["To"] == "one@example.com"
    assert parsed["Subject"] == "Status"


def test_email_attachment_decoder_rejects_oversize_malformed_and_risky_mime() -> None:
    with pytest.raises(HTTPException) as oversized:
        email_integration._decode_attachment_data("YQ==", 26 * 1024 * 1024, urlsafe=False)
    assert oversized.value.status_code == 413
    with pytest.raises(HTTPException) as malformed:
        email_integration._decode_attachment_data("not%%%base64", 8, urlsafe=False)
    assert malformed.value.status_code == 502
    assert email_integration._safe_attachment_filename('../bad\r\n"name.svg') == "bad___name.svg"
    assert email_integration._safe_attachment_mime("image/svg+xml") == "application/octet-stream"
    assert email_integration._safe_attachment_mime("text/html") == "application/octet-stream"


@pytest.mark.asyncio
async def test_outlook_attachment_is_forced_download_and_handles_non_file_shapes(monkeypatch) -> None:
    settings = Settings(auth_secret="a-test-secret-long-enough-for-capabilities")

    async def owned(*_args, **_kwargs):
        return {"id": "mail-1", "type": "OUTLOOK", "emailAddress": "owner@example.com"}

    async def access(*_args, **_kwargs):
        return "access-token"

    monkeypatch.setattr(email_integration, "_owned_mailbox", owned)
    monkeypatch.setattr(email_integration, "_access_token", access)

    body = {
        "@odata.type": "#microsoft.graph.fileAttachment",
        "name": '../bad\r\n"name.html',
        "contentType": "text/html",
        "size": 8,
        "contentBytes": base64.b64encode(b"<script>").decode(),
    }

    class Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, *_args, **_kwargs):
            return httpx.Response(200, json=body)

    monkeypatch.setattr(email_integration.httpx, "AsyncClient", Client)
    response = await email_integration.get_attachment(
        "mail-1", "message-1", "attachment-1", principal(), object(), settings
    )
    assert response.body == b"<script>"
    assert response.media_type == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert "\r" not in response.headers["content-disposition"]
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"

    body.clear()
    body.update({"@odata.type": "#microsoft.graph.itemAttachment", "name": "message.eml", "size": 8})
    with pytest.raises(HTTPException) as unsupported:
        await email_integration.get_attachment("mail-1", "message-1", "attachment-2", principal(), object(), settings)
    assert unsupported.value.status_code == 415


@pytest.mark.asyncio
async def test_microsoft_rotated_refresh_token_is_compare_and_swap_persisted(monkeypatch) -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        email_token_enc_key="email-encryption-key-for-tests",
        ms_oauth_client_id="client-id",
        ms_oauth_client_secret="client-secret",
    )
    old_encrypted = email_integration._encrypt("old-refresh", settings, purpose=b"mailbox-refresh-token")
    mailbox = {"id": "mail-1", "type": "OUTLOOK", "credentials": old_encrypted}

    class Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return httpx.Response(200, json={"access_token": "access", "refresh_token": "rotated-refresh"})

    class Db:
        def __init__(self):
            self.params = None
            self.commits = 0

        async def execute(self, _sql, params):
            self.params = params

            class Result:
                rowcount = 1

            return Result()

        async def commit(self):
            self.commits += 1

    monkeypatch.setattr(email_integration.httpx, "AsyncClient", Client)
    db = Db()
    assert await email_integration._access_token(mailbox, settings, db) == "access"
    assert db.params["old_credentials"] == old_encrypted
    assert (
        email_integration._decrypt(db.params["new_credentials"], settings, purpose=b"mailbox-refresh-token")
        == "rotated-refresh"
    )
    assert db.commits == 1


@pytest.mark.asyncio
async def test_microsoft_refresh_keeps_existing_ciphertext_when_no_rotation_is_returned(monkeypatch) -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        email_token_enc_key="email-encryption-key-for-tests",
        ms_oauth_client_id="client-id",
        ms_oauth_client_secret="client-secret",
    )
    mailbox = {
        "id": "mail-1",
        "type": "OUTLOOK",
        "credentials": email_integration._encrypt("old-refresh", settings, purpose=b"mailbox-refresh-token"),
    }

    class Client:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return httpx.Response(200, json={"access_token": "access"})

    class Db:
        async def execute(self, *_args, **_kwargs):
            raise AssertionError("credentials changed without a rotated refresh token")

        async def commit(self):
            raise AssertionError("credentials committed without a rotated refresh token")

    monkeypatch.setattr(email_integration.httpx, "AsyncClient", Client)
    assert await email_integration._access_token(mailbox, settings, Db()) == "access"


@pytest.mark.asyncio
async def test_disconnect_reports_failed_revocation_but_removes_local_credentials(monkeypatch) -> None:
    settings = Settings(auth_secret="a-test-secret-long-enough-for-capabilities")
    mailbox = {"id": "mail-1", "type": "GMAIL", "emailAddress": "owner@example.com"}

    async def owned(*_args, **_kwargs):
        return mailbox

    async def revoke(*_args, **_kwargs):
        return {"attempted": True, "succeeded": False, "reason": "provider_unavailable"}

    async def audit(*_args, **_kwargs):
        return None

    class Db:
        def __init__(self):
            self.sql = []
            self.commits = 0

        async def execute(self, sql, *_args, **_kwargs):
            self.sql.append(str(sql))

        async def commit(self):
            self.commits += 1

    monkeypatch.setattr(email_integration, "_owned_mailbox", owned)
    monkeypatch.setattr(email_integration, "_revoke_mailbox_grant", revoke)
    monkeypatch.setattr(email_integration, "audit_event", audit)
    db = Db()
    result = await email_integration.disconnect_mailbox("mail-1", principal(), db, settings)
    assert result["success"] is True
    assert result["revocation"]["succeeded"] is False
    assert any("DELETE FROM mailboxes" in sql for sql in db.sql)
    assert db.commits == 1


@pytest.mark.asyncio
async def test_outlook_disconnect_requests_no_broad_scope_and_makes_no_graph_revoke_call(monkeypatch) -> None:
    assert "User.RevokeSessions.All" not in email_integration.MS_SCOPES

    class ForbiddenClient:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("Outlook disconnect must not call a provider-wide revocation endpoint")

    monkeypatch.setattr(email_integration.httpx, "AsyncClient", ForbiddenClient)
    result = await email_integration._revoke_mailbox_grant(
        {"id": "mail-1", "type": "OUTLOOK", "credentials": "local-ciphertext"},
        Settings(auth_secret="a-test-secret-long-enough-for-capabilities"),
        object(),
    )
    assert result["attempted"] is False
    assert result["succeeded"] is False
    assert result["status"] == "not_supported_app_scoped"
    assert "Apps and services permissions" in result["guidance"]


@pytest.mark.asyncio
async def test_assistant_approval_jti_is_consumed_once_before_write() -> None:
    settings = Settings(auth_secret="a-test-secret-long-enough-for-capabilities")
    args = {"title": "Write brief", "columnId": "column-1"}
    token = integrations._approval_token("create_task", args, principal(), settings)

    class Db:
        def __init__(self):
            self.seen = set()

        async def execute(self, _sql, params):
            jti = params["jti"]
            value = None if jti in self.seen else jti
            self.seen.add(jti)

            class Result:
                @staticmethod
                def scalar_one_or_none():
                    return value

            return Result()

    db = Db()
    await integrations._consume_approval(token, "create_task", args, principal(), settings, db)
    with pytest.raises(HTTPException) as replay:
        await integrations._consume_approval(token, "create_task", args, principal(), settings, db)
    assert replay.value.status_code == 409


def test_phase3_migration_contains_idempotent_approval_replay_storage() -> None:
    migration = Path("backend/migrations/20260712_phase3_email.sql").read_text()
    assert "CREATE TABLE IF NOT EXISTS assistant_approval_uses" in migration
    assert "jti text PRIMARY KEY" in migration


def test_assistant_approval_is_user_argument_and_signature_bound() -> None:
    settings = Settings(auth_secret="a-test-secret-long-enough-for-capabilities")
    args = {"title": "Write brief", "columnId": "column-1"}
    token = integrations._approval_token("create_task", args, principal(), settings)
    assert integrations._valid_approval(token, "create_task", args, principal(), settings)
    assert not integrations._valid_approval(token, "create_task", {**args, "title": "Other"}, principal(), settings)
    assert not integrations._valid_approval(token, "create_task", args, principal("user-2"), settings)
    body, signature = token.split(".", 1)
    tampered = f"{body}.{'0' if signature[0] != '0' else '1'}{signature[1:]}"
    assert not integrations._valid_approval(tampered, "create_task", args, principal(), settings)


@pytest.mark.asyncio
async def test_assistant_tool_loop_emits_approval_then_executes_only_with_bound_token(monkeypatch) -> None:
    settings = Settings(
        auth_secret="a-test-secret-long-enough-for-capabilities",
        google_generative_ai_api_key="gemini-test-key",
    )
    args = {"title": "Write brief", "columnId": "column-1"}
    call = {"name": "create_task", "args": args}
    model_content = {"role": "model", "parts": [{"functionCall": call}]}

    async def no_audit(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(integrations, "audit_event", no_audit)
    calls = 0

    async def first_turn(*_args, **_kwargs):
        return [], [call], model_content

    async def must_not_execute(*_args, **_kwargs):
        raise AssertionError("mutating tool executed without approval")

    monkeypatch.setattr(integrations, "_gemini_turn", first_turn)
    monkeypatch.setattr(integrations, "_execute_assistant_tool", must_not_execute)
    response = await integrations.assistant_stream(
        {"messages": [{"role": "user", "content": "Create the task"}]},
        principal(),
        FakeDb(),
        settings,
    )
    unapproved_body = await response_body(response)
    assert "event: approval_required" in unapproved_body
    assert "event: tool_result" not in unapproved_body

    approval = integrations._approval_token("create_task", args, principal(), settings)
    turns = iter((([], [call], model_content), (["Task created."], [], {"role": "model", "parts": []})))

    async def tool_loop(*_args, **_kwargs):
        return next(turns)

    async def execute(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return {"ok": True, "data": {"id": "task-1"}}

    monkeypatch.setattr(integrations, "_gemini_turn", tool_loop)
    monkeypatch.setattr(integrations, "_execute_assistant_tool", execute)
    response = await integrations.assistant_stream(
        {
            "messages": [{"role": "user", "content": "Create the task"}],
            "approvedTools": [approval],
        },
        principal(),
        FakeDb(),
        settings,
    )
    approved_body = await response_body(response)
    assert calls == 1
    assert "event: tool_result" in approved_body
    assert "Task created." in approved_body
    assert "event: done" in approved_body
