from datetime import datetime

import pytest
from backend.app.routers import chat, delivery, meetings
from backend.app.security import Principal


def principal(*, role: str = "ADMIN") -> Principal:
    return Principal(
        id="user-1",
        name="User",
        email="user@example.com",
        role=role,
        status="ACTIVE",
        scopes=["*"],
    )


@pytest.mark.asyncio
async def test_project_list_aggregates_relations_in_its_single_query(monkeypatch) -> None:
    queries: list[str] = []

    async def fake_fetch_all(_db, sql, _params=None):
        queries.append(sql)
        return [
            {
                "id": "project-1",
                "boardsCount": 2,
                "milestonesCount": 3,
                "filesCount": 4,
                "members": [],
                "milestones": [],
            }
        ]

    monkeypatch.setattr(delivery, "fetch_all", fake_fetch_all)
    result = await delivery.list_projects(limit=100, principal=principal(), db=object())
    assert len(queries) == 1
    assert queries[0].count("json_agg") >= 2
    assert result["data"][0]["_count"] == {"boards": 2, "milestones": 3, "files": 4}


@pytest.mark.asyncio
async def test_task_relation_hydration_is_one_query_for_any_batch_size(monkeypatch) -> None:
    queries: list[tuple[str, dict]] = []

    async def fake_fetch_all(_db, sql, params=None):
        queries.append((sql, params or {}))
        return []

    monkeypatch.setattr(delivery, "fetch_all", fake_fetch_all)
    assert await delivery.task_payloads(object(), [f"task-{index}" for index in range(200)]) == []
    assert len(queries) == 1
    assert "jsonb_array_elements_text" in queries[0][0]
    assert "task_checklist_items" in queries[0][0]


@pytest.mark.asyncio
async def test_message_relation_hydration_has_a_fixed_five_query_bound(monkeypatch) -> None:
    queries: list[str] = []

    async def fake_fetch_all(_db, sql, _params=None):
        queries.append(sql)
        return []

    rows = [
        {
            "id": f"message-{index}",
            "channelId": "channel-1",
            "content": "hello",
            "contentJson": None,
            "sender": {"id": "user-1"},
            "parentId": None,
            "isEdited": False,
            "editedAt": None,
            "deletedAt": None,
            "createdAt": datetime(2026, 7, 12),
        }
        for index in range(chat.MESSAGE_PAGE_SIZE)
    ]
    monkeypatch.setattr(chat, "fetch_all", fake_fetch_all)
    output = await chat._message_outs(object(), rows, "user-1")
    assert len(output) == chat.MESSAGE_PAGE_SIZE
    assert len(queries) == 5
    assert all("message_ids" in query for query in queries)


@pytest.mark.asyncio
async def test_channel_hydration_has_a_fixed_three_query_bound(monkeypatch) -> None:
    queries: list[str] = []

    async def fake_fetch_all(_db, sql, _params=None):
        queries.append(sql)
        return []

    channels = [
        {
            "id": f"channel-{index}",
            "name": f"Channel {index}",
            "type": "PUBLIC",
            "topic": None,
            "description": None,
            "isPrivate": False,
            "isArchived": False,
            "createdById": "user-1",
        }
        for index in range(100)
    ]
    monkeypatch.setattr(chat, "fetch_all", fake_fetch_all)
    output = await chat._channel_outs(object(), channels, "user-1")
    assert len(output) == 100
    assert len(queries) == 3
    assert all("channel_ids" in query for query in queries)


@pytest.mark.asyncio
async def test_meeting_attendee_hydration_is_one_query_for_any_batch(monkeypatch) -> None:
    queries: list[str] = []

    async def fake_fetch_all(_db, sql, _params=None):
        queries.append(sql)
        return []

    rows = [
        (
            {
                "id": f"meeting-{index}",
                "startTime": datetime(2026, 7, 12, 9),
                "endTime": datetime(2026, 7, 12, 10),
            },
            None,
        )
        for index in range(100)
    ]
    monkeypatch.setattr(meetings, "fetch_all", fake_fetch_all)
    output = await meetings._meeting_outs(object(), rows)
    assert len(output) == 100
    assert len(queries) == 1
    assert "jsonb_to_recordset" in queries[0]


@pytest.mark.asyncio
async def test_project_lead_removal_takes_transaction_lock_before_count(monkeypatch) -> None:
    events: list[str] = []
    responses = iter(
        [
            {"id": "membership-1", "role": "LEAD"},
            {"count": 2},
            {"name": "Portal"},
            {"name": "Lead"},
        ]
    )

    async def fake_access(*_args, **_kwargs):
        return None

    async def fake_fetch_one(_db, sql, _params=None):
        events.append("count" if "count(*)" in sql else "read")
        return next(responses)

    async def fake_execute(_db, sql, _params=None):
        events.append("lock" if "pg_advisory_xact_lock" in sql else "delete")

    async def fake_activity(*_args, **_kwargs):
        return None

    class Db:
        async def commit(self):
            events.append("commit")

    monkeypatch.setattr(delivery, "project_access", fake_access)
    monkeypatch.setattr(delivery, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(delivery, "execute", fake_execute)
    monkeypatch.setattr(delivery, "log_activity", fake_activity)
    await delivery.remove_project_member("project-1", "user-2", principal=principal(), db=Db())
    assert events.index("lock") < events.index("count") < events.index("delete")
