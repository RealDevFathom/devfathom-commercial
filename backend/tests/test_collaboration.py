from datetime import UTC, datetime, timedelta

import pytest
from backend.app.collaboration_schemas import (
    ChannelUpdate,
    MeetingCreate,
    MeetingUpdate,
    MessageCreate,
    NoteCreate,
    NoteUpdate,
    NotificationPrefs,
)
from backend.app.routers.chat import (
    MESSAGE_PAGE_SIZE,
    aggregate_reactions,
    extract_mention_ids,
    tiptap_to_plain_text,
)
from backend.app.routers.collaboration_common import (
    COLLABORATION_GRANTABLE_SCOPES,
    notification_channel_allowed,
)
from backend.app.routers.meetings import (
    find_relevant_occurrence,
    get_next_occurrence,
    punctuality_label,
)
from backend.app.routers.notes import (
    _can_edit,
    _can_view,
    compute_mention_targets,
    extract_linked_note_ids,
    extract_plain_text,
)
from backend.app.security import Principal
from fastapi import HTTPException
from pydantic import ValidationError


def test_note_tiptap_derivations_and_visibility_scoped_mentions() -> None:
    document = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Hi @johnsmith"},
                    {"type": "mention", "attrs": {"id": "u2"}},
                    {"type": "noteLink", "attrs": {"id": "n2"}},
                    {"type": "noteLink", "attrs": {"id": "n2"}},
                ],
            }
        ],
    }
    team = [
        {"id": "author", "name": "Author", "email": "author@example.com"},
        {"id": "u1", "name": "John Smith", "email": "john@example.com"},
        {"id": "u2", "name": "Jane Doe", "email": "jane@example.com"},
    ]

    assert extract_plain_text(document) == "Hi @johnsmith"
    assert extract_linked_note_ids(document) == ["n2"]
    assert set(
        compute_mention_targets(
            content_text=extract_plain_text(document),
            content_json=document,
            visibility="TEAM",
            author_id="author",
            share_user_ids=[],
            team=team,
        )
    ) == {"u1", "u2"}
    assert (
        compute_mention_targets(
            content_text=extract_plain_text(document),
            content_json=document,
            visibility="PRIVATE",
            author_id="author",
            share_user_ids=[],
            team=team,
        )
        == []
    )
    assert compute_mention_targets(
        content_text=extract_plain_text(document),
        content_json=document,
        visibility="SHARED",
        author_id="author",
        share_user_ids=["u2"],
        team=team,
    ) == ["u2"]


def test_note_access_and_edit_contract() -> None:
    private = {"authorId": "owner", "visibility": "PRIVATE", "shares": []}
    team = {"authorId": "owner", "visibility": "TEAM", "shares": []}
    shared_view = {
        "authorId": "owner",
        "visibility": "SHARED",
        "shares": [{"userId": "member", "permission": "VIEW"}],
    }
    shared_edit = {
        "authorId": "owner",
        "visibility": "SHARED",
        "shares": [{"userId": "member", "permission": "EDIT"}],
    }

    assert _can_view(private, "owner")
    assert not _can_view(private, "member")
    assert _can_edit(team, "member")
    assert _can_view(shared_view, "member") and not _can_edit(shared_view, "member")
    assert _can_edit(shared_edit, "member")


def test_chat_server_side_tiptap_and_reaction_contract() -> None:
    document = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "mention", "attrs": {"id": "u2"}},
                    {"type": "mention", "attrs": {"id": "u2"}},
                ],
            }
        ],
    }
    assert tiptap_to_plain_text(document) == "hello"
    assert extract_mention_ids(document) == ["u2"]
    assert aggregate_reactions(
        [
            {"emoji": "👍", "userId": "u1"},
            {"emoji": "👍", "userId": "u2"},
            {"emoji": "🎉", "userId": "u2"},
        ],
        "u1",
    ) == [
        {"emoji": "👍", "count": 2, "userIds": ["u1", "u2"], "reactedByMe": True},
        {"emoji": "🎉", "count": 1, "userIds": ["u2"], "reactedByMe": False},
    ]


def test_recurring_occurrence_contract_keeps_last_finished_occurrence() -> None:
    start = datetime(2026, 7, 1, 9, tzinfo=UTC)
    end = start + timedelta(hours=1)
    between = datetime(2026, 7, 2, 18, tzinfo=UTC)
    relevant = find_relevant_occurrence(start, end, "daily", between)
    assert relevant == {
        "start": datetime(2026, 7, 2, 9, tzinfo=UTC),
        "end": datetime(2026, 7, 2, 10, tzinfo=UTC),
    }
    next_occurrence = get_next_occurrence(start, end, "daily", between)
    assert next_occurrence == {
        "start": datetime(2026, 7, 3, 9, tzinfo=UTC),
        "end": datetime(2026, 7, 3, 10, tzinfo=UTC),
    }


def test_legacy_monthly_overflow_and_ten_minute_punctuality() -> None:
    start = datetime(2026, 1, 31, 9, tzinfo=UTC)
    end = start + timedelta(hours=1)
    occurrence = get_next_occurrence(start, end, "monthly", datetime(2026, 2, 1, tzinfo=UTC))
    assert occurrence == {
        "start": datetime(2026, 3, 3, 9, tzinfo=UTC),
        "end": datetime(2026, 3, 3, 10, tzinfo=UTC),
    }
    assert punctuality_label(start, start + timedelta(minutes=10)) == "on time"
    assert punctuality_label(start, start + timedelta(minutes=11)) == "11 min late"


def test_domain_payload_validation() -> None:
    note = NoteCreate.model_validate({"contentJson": {"type": "doc"}})
    assert note.title == "Untitled" and note.visibility == "PRIVATE"
    with pytest.raises(ValidationError):
        MessageCreate.model_validate({"attachments": [{"name": "voice", "url": "/uploads/a.webm", "duration": -1}]})


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (NoteUpdate, {"title": None}),
        (NoteUpdate, {"contentJson": None}),
        (NoteUpdate, {"visibility": None}),
        (ChannelUpdate, {"name": None}),
        (MeetingUpdate, {"startTime": None}),
        (MeetingUpdate, {"attendeeIds": None}),
    ],
)
def test_non_nullable_update_fields_reject_explicit_null(model, payload) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_notification_preferences_are_category_first_and_fail_open() -> None:
    prefs = NotificationPrefs.model_validate({"mention": {"inApp": False, "email": True}, "meeting": {"email": False}})
    rendered = prefs.model_dump(by_alias=True, exclude_none=True)
    assert rendered["mention"] == {"inApp": False, "email": True}
    assert not notification_channel_allowed(rendered, "mention", "inApp")
    assert notification_channel_allowed(rendered, "mention", "email")
    assert notification_channel_allowed(rendered, "unknown", "inApp")


def test_collaboration_scope_and_pagination_contracts() -> None:
    assert MESSAGE_PAGE_SIZE == 30
    assert {
        "notes:read",
        "notes:write",
        "chat:read",
        "chat:write",
        "meetings:read",
        "meetings:write",
        "notifications:read",
        "notifications:write",
        "search:read",
    } == COLLABORATION_GRANTABLE_SCOPES
    with pytest.raises(ValidationError):
        MeetingCreate.model_validate(
            {
                "title": "Invalid",
                "startTime": "2026-07-12T10:00:00Z",
                "endTime": "2026-07-12T09:00:00Z",
                "attendeeIds": [],
            }
        )


@pytest.mark.asyncio
async def test_realtime_abstraction_preserves_legacy_room_and_event_names(monkeypatch) -> None:
    from backend.app.routers import collaboration_common

    calls = []

    class Recorder:
        async def publish(self, room, event, payload):
            calls.append((room, event, payload))

    monkeypatch.setattr(collaboration_common, "realtime_publisher", Recorder())
    await collaboration_common.emit_to_channel("channel-1", collaboration_common.RT_MESSAGE_NEW, {"id": "m1"})
    await collaboration_common.emit_to_user("user-1", collaboration_common.RT_READ, {"id": "m1"})
    assert calls == [
        ("channel:channel-1", "chat:message", {"id": "m1"}),
        ("user:user-1", "chat:read", {"id": "m1"}),
    ]


@pytest.mark.asyncio
async def test_realtime_publish_failures_emit_structured_logs(caplog) -> None:
    from backend.app.routers import collaboration_common

    publisher = collaboration_common.AblyRealtimePublisher("invalid-key-without-separator")
    with caplog.at_level("WARNING", logger=collaboration_common.__name__):
        await publisher.publish("channel:one", "chat:message", {"id": "m1"})
    record = next(record for record in caplog.records if record.message == "realtime_publish_failed")
    assert record.room == "channel:one"
    assert record.event == "chat:message"
    assert record.error_type == "ValueError"


@pytest.mark.asyncio
async def test_notification_delivery_honors_category_first_in_app_opt_out(monkeypatch) -> None:
    from backend.app.routers import collaboration_common

    class FakeDb:
        async def execute(self, *_args, **_kwargs):
            raise AssertionError("notification insert must be suppressed")

    async def fake_fetch_one(*_args, **_kwargs):
        return {"id": "u2", "notificationPrefs": {"mention": {"inApp": False}}}

    monkeypatch.setattr(collaboration_common, "fetch_one", fake_fetch_one)
    delivered = await collaboration_common.insert_notifications(
        FakeDb(),
        ["u2"],
        title="Mention",
        message="Hello",
        type="mention",
    )
    assert delivered == []


@pytest.mark.asyncio
async def test_jaas_token_contract_and_log_join_shape(monkeypatch) -> None:
    from backend.app.routers import meetings

    principal = Principal(
        id="u1",
        name="User One",
        email="u1@example.com",
        role="ADMIN",
        status="ACTIVE",
        scopes=["*"],
    )

    async def fake_access(*_args, **_kwargs):
        return {"createdById": "u1"}

    async def fake_fetch(*_args, **_kwargs):
        return {"avatar": "/avatar.png"}

    captured = {}

    def fake_encode(payload, _key, **kwargs):
        captured.update(payload)
        captured["headers"] = kwargs["headers"]
        return "signed"

    monkeypatch.setattr(meetings, "require_meeting_access", fake_access)
    monkeypatch.setattr(meetings, "fetch_one", fake_fetch)
    monkeypatch.setattr(meetings.jwt, "encode", fake_encode)
    monkeypatch.setenv("NEXT_PUBLIC_JAAS_APP_ID", "app-id")
    monkeypatch.setenv("JAAS_KID", "kid-id")
    monkeypatch.setenv("JAAS_PRIVATE_KEY", "private-key")
    result = await meetings.get_call_token("meeting-1", principal, object())
    assert result == {"jwt": "signed", "roomName": "app-id/meeting-meeting-1"}
    assert captured["room"] == "meeting-meeting-1"
    assert captured["context"]["user"]["moderator"] is True
    assert captured["headers"] == {"alg": "RS256", "kid": "kid-id", "typ": "JWT"}

    async def fake_record(*_args, **_kwargs):
        return {"joinedAt": "now", "alreadyJoined": False, "occurrence": {"start": "now"}}

    monkeypatch.setattr(meetings, "_record_join", fake_record)
    assert await meetings.log_join("meeting-1", principal, object()) == {
        "joinedAt": "now",
        "alreadyJoined": False,
    }

    monkeypatch.delenv("JAAS_PRIVATE_KEY")
    with pytest.raises(HTTPException) as error:
        await meetings.get_call_token("meeting-1", principal, object())
    assert error.value.status_code == 412


def test_collaboration_routers_expose_expected_surface() -> None:
    from backend.app.routers.chat import router as chat_router
    from backend.app.routers.collaboration_search import router as search_router
    from backend.app.routers.meetings import router as meetings_router
    from backend.app.routers.notes import router as notes_router
    from backend.app.routers.notifications import router as notifications_router

    paths = {
        route.path
        for router in (
            notes_router,
            chat_router,
            meetings_router,
            notifications_router,
            search_router,
        )
        for route in router.routes
    }
    assert {
        "/api/v1/notes/{note_id}/shares",
        "/api/v1/notes/{note_id}/revisions",
        "/api/v1/chat/messages/{message_id}/reaction",
        "/api/v1/chat/messages/{message_id}/pin",
        "/api/v1/chat/saved",
        "/api/v1/meetings/{meeting_id}/attendance",
        "/api/v1/meetings/{meeting_id}/call-token",
        "/api/v1/notifications/read-all",
        "/api/v1/search/collaboration",
    } <= paths
