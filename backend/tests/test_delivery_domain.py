from datetime import UTC, datetime

import pytest
from backend.app.routers import delivery, delivery_search, domain_common, trello_import
from backend.app.routers.delivery_schemas import (
    BulkTaskMove,
    ColumnOrder,
    ProjectCreate,
    TaskCreate,
    TaskUpdate,
    TrelloImport,
)
from backend.app.security import Principal
from fastapi import HTTPException
from pydantic import ValidationError


def principal(*, role: str = "EMPLOYEE") -> Principal:
    return Principal(
        id="user-1",
        name="User",
        email="user@example.com",
        role=role,
        status="ACTIVE",
        scopes=["*"],
    )


def route_methods(router) -> set[tuple[str, str]]:
    return {(method, route.path) for route in router.routes for method in route.methods}


def test_delivery_routes_cover_legacy_specific_paths() -> None:
    routes = route_methods(delivery.router)
    assert ("GET", "/api/v1/projects") in routes
    assert ("POST", "/api/v1/tasks") in routes
    assert ("POST", "/api/v1/tasks/{task_id}/move") in routes
    assert ("PUT", "/api/v1/columns/{column_id}/default-assignees") in routes
    assert ("POST", "/api/v1/tasks/{task_id}/comments") in routes
    assert ("GET", "/api/v1/search") in route_methods(delivery_search.router)
    assert ("POST", "/api/v1/trello-import") in route_methods(trello_import.router)


def test_extended_delivery_routes_cover_verified_parity_gaps() -> None:
    routes = route_methods(delivery.router)
    expected = {
        ("GET", "/api/v1/tasks"),
        ("GET", "/api/v1/tasks/{task_id}/comments"),
        ("PUT", "/api/v1/tasks/{task_id}/parent"),
        ("POST", "/api/v1/tasks/{task_id}/blockers"),
        ("POST", "/api/v1/tasks/{task_id}/attachments"),
        ("POST", "/api/v1/tasks/{task_id}/checklists"),
        ("POST", "/api/v1/projects/{project_id}/milestones"),
        ("POST", "/api/v1/projects/{project_id}/files"),
        ("POST", "/api/v1/time-entries"),
        ("GET", "/api/v1/projects/{project_id}/time-rollup"),
    }
    assert expected <= routes


def test_delivery_inputs_accept_camel_case_contract() -> None:
    project = ProjectCreate.model_validate(
        {
            "name": "Portal",
            "type": "CLIENT",
            "memberIds": ["user-2"],
            "createDefaultBoard": False,
            "techStack": ["Nuxt", "FastAPI"],
        }
    )
    task = TaskCreate.model_validate({"title": "Ship", "columnId": "column-1", "dueDate": "2026-07-12T10:00:00Z"})
    assert project.member_ids == ["user-2"]
    assert not project.create_default_board
    assert task.due_date and task.due_date.tzinfo == UTC


def test_task_write_contract_restores_labels_column_and_assignee_operations() -> None:
    create = TaskCreate.model_validate({"title": "Ship", "columnId": "c1", "assigneeIds": ["u1"], "labelIds": ["l1"]})
    update = TaskUpdate.model_validate({"columnId": "c2", "assigneeIds": ["u2"], "labelIds": ["l2"]})
    assert create.label_ids == ["l1"]
    assert update.column_id == "c2"
    assert update.assignee_ids == ["u2"]
    assert update.label_ids == ["l2"]


def test_order_and_bulk_payloads_reject_empty_lists() -> None:
    with pytest.raises(ValidationError):
        ColumnOrder(columnIds=[])
    with pytest.raises(ValidationError):
        BulkTaskMove(taskIds=[], targetColumnId="column-1")


@pytest.mark.asyncio
async def test_project_manage_requires_lead(monkeypatch: pytest.MonkeyPatch) -> None:
    async def member(*_args, **_kwargs):
        return {"role": "MEMBER"}

    monkeypatch.setattr(domain_common, "fetch_one", member)
    with pytest.raises(HTTPException) as denied:
        await domain_common.project_access(object(), principal(), "project-1", manage=True)
    assert denied.value.status_code == 403

    async def lead(*_args, **_kwargs):
        return {"role": "LEAD"}

    monkeypatch.setattr(domain_common, "fetch_one", lead)
    await domain_common.project_access(object(), principal(), "project-1", manage=True)


@pytest.mark.asyncio
async def test_admin_access_still_checks_project_existence(monkeypatch: pytest.MonkeyPatch) -> None:
    async def missing(*_args, **_kwargs):
        return None

    monkeypatch.setattr(domain_common, "fetch_one", missing)
    with pytest.raises(HTTPException) as missing_project:
        await domain_common.project_access(object(), principal(role="ADMIN"), "missing")
    assert missing_project.value.status_code == 404


def test_trello_helpers_are_lenient_and_deterministic() -> None:
    first = trello_import.board_key("Board", None, ["Todo", "Done"], 4)
    second = trello_import.board_key("Board", None, ["Todo", "Done"], 4)
    assert first == second
    assert first.startswith("local:")
    assert trello_import.safe_date("not-a-date") is None
    assert trello_import.value_text({"checked": True}) == "Yes"
    assert (
        trello_import.custom_field_text(
            {"idValue": "choice-1"},
            {"options": [{"id": "choice-1", "value": {"text": "Large"}}]},
        )
        == "Large"
    )


def test_trello_nested_export_objects_ignore_unknown_fields() -> None:
    payload = TrelloImport.model_validate(
        {
            "newProjectName": "Imported",
            "trelloJson": {
                "name": "Roadmap",
                "prefs": {"permissionLevel": "private"},
                "lists": [{"id": "list-1", "name": "Todo", "subscribed": True}],
                "cards": [
                    {
                        "id": "card-1",
                        "name": "Ship",
                        "idList": "list-1",
                        "badges": {"comments": 2},
                        "attachments": [{"name": "Spec", "url": "https://example.com/spec", "bytes": 100}],
                    }
                ],
            },
        }
    )
    assert payload.trello_json.cards[0].name == "Ship"


@pytest.mark.asyncio
async def test_task_listing_always_adds_project_membership_scope(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    async def fake_fetch_all(_db, sql, _values=None):
        seen.append(sql)
        return []

    monkeypatch.setattr(delivery, "fetch_all", fake_fetch_all)
    await delivery.list_tasks(principal=principal(), db=object())
    assert "project_members" in seen[0]


@pytest.mark.asyncio
async def test_task_delete_requests_manage_access(monkeypatch: pytest.MonkeyPatch) -> None:
    manage_values: list[bool] = []

    async def fake_access(*_args, manage=False, **_kwargs):
        manage_values.append(manage)
        return "project-1"

    async def fake_execute(*_args, **_kwargs):
        return None

    class Db:
        async def commit(self):
            return None

    monkeypatch.setattr(delivery, "related_access", fake_access)
    monkeypatch.setattr(delivery, "execute", fake_execute)
    await delivery.delete_task("task-1", principal=principal(), db=Db())
    assert manage_values == [True]


@pytest.mark.asyncio
async def test_member_removal_records_actor_attributed_activity(monkeypatch: pytest.MonkeyPatch) -> None:
    activities: list[dict] = []
    responses = iter(
        [
            {"id": "membership-1", "role": "MEMBER"},
            {"name": "Portal"},
            {"name": "Teammate"},
        ]
    )

    async def fake_project_access(*_args, **_kwargs):
        return None

    async def fake_fetch_one(*_args, **_kwargs):
        return next(responses)

    async def fake_execute(*_args, **_kwargs):
        return None

    async def fake_activity(_db, _principal, **kwargs):
        activities.append(kwargs)

    class Db:
        async def commit(self):
            return None

    monkeypatch.setattr(delivery, "project_access", fake_project_access)
    monkeypatch.setattr(delivery, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(delivery, "execute", fake_execute)
    monkeypatch.setattr(delivery, "log_activity", fake_activity)
    await delivery.remove_project_member("project-1", "user-2", principal=principal(role="ADMIN"), db=Db())
    assert activities[0]["type"] == "project_member_removed"
    assert activities[0]["entity_id"] == "project-1"


@pytest.mark.asyncio
async def test_search_groups_respect_scopes_and_expose_composable_full_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queries: list[str] = []

    async def fake_fetch_all(_db, sql, _values=None):
        queries.append(sql)
        return []

    monkeypatch.setattr(delivery_search, "fetch_all", fake_fetch_all)
    scoped = Principal("u", "U", "u@example.com", "EMPLOYEE", "ACTIVE", ["projects:read"])
    result = await delivery_search.search_groups("ship", scoped, object())
    assert result["tasks"] == result["clients"] == result["notes"] == result["team"] == []
    assert len(queries) == 1

    queries.clear()
    result = await delivery_search.search_groups("ship", principal(), object())
    assert set(result) == {"projects", "tasks", "clients", "notes", "team"}
    assert len(queries) == 5


def test_trello_import_requires_exactly_a_viable_target() -> None:
    board = {"name": "Roadmap", "lists": [], "cards": []}
    with pytest.raises(ValidationError):
        TrelloImport(trelloJson=board)
    payload = TrelloImport(trelloJson=board, newProjectName="Imported")
    assert payload.new_project_name == "Imported"


def test_update_statement_never_rewrites_primary_key() -> None:
    sql = delivery.update_sql(
        "projects",
        {"id": "project-1", "name": "Renamed", "updatedAt": "now"},
    )
    assert '"id" =' not in sql
    assert sql.count('"updatedAt" =') == 1


def test_database_bind_values_normalize_aware_timestamps() -> None:
    aware = datetime(2026, 7, 12, 10, 30, tzinfo=UTC)
    normalized = domain_common.bind_values({"at": aware, "nested": [aware]})
    assert normalized["at"].tzinfo is None
    assert normalized["nested"][0].tzinfo is None
