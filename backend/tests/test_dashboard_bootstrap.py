from copy import deepcopy
from datetime import datetime

import pytest
from backend.app.main import app
from backend.app.security import Principal
from backend.app.services.dashboard_bootstrap import dashboard_bootstrap


def principal(
    *,
    role: str = "ADMIN",
    scopes: list[str] | None = None,
    actor_type: str = "USER",
) -> Principal:
    return Principal(
        id="user-1",
        name="Dashboard User",
        email="dashboard@example.com",
        role=role,
        status="ACTIVE",
        scopes=scopes or ["*"],
        actor_type=actor_type,
        token_id="token-1" if actor_type == "API_TOKEN" else None,
    )


ADMIN_INDIVIDUAL_RESPONSES = {
    "stats": {
        "data": {
            "activeProjects": 3,
            "totalTasks": 8,
            "completedTasksThisWeek": 2,
            "pendingLeaves": 1,
            "revenue": [{"currency": "USD", "amount": 1200}],
            "expenses": [{"currency": "USD", "amount": 300}],
            "outstandingInvoices": 4,
            "isAdmin": True,
        }
    },
    "activity": {
        "data": [
            {
                "id": "activity-1",
                "type": "project_updated",
                "message": "updated a project",
                "entityType": "Project",
                "entityId": "project-1",
                "createdAt": "2026-07-22T08:00:00",
                "userName": "Dashboard User",
                "avatar": None,
            }
        ]
    },
    "projects": {
        "data": [
            {
                "id": f"project-{index}",
                "name": f"Project {index}",
                "status": "ACTIVE",
                "type": "CLIENT",
                "members": [],
                "milestones": [],
                "_count": {"boards": 1, "milestones": 0, "files": 0},
            }
            for index in range(1, 6)
        ]
    },
    "meetings": [
        {
            "id": "meeting-1",
            "title": "Planning",
            "startTime": "2026-07-23T09:00:00",
            "endTime": "2026-07-23T09:30:00",
            "attendees": [],
        }
    ],
    "deadlines": {"data": [{"id": "deadline-1", "projectId": "project-1"}]},
    "tasks": {"data": [{"id": "task-1", "projectId": "project-1"}]},
}


def aggregate_individual_responses(responses: dict) -> dict:
    return {
        "stats": responses["stats"]["data"],
        "activity": responses["activity"]["data"],
        "projects": responses["projects"]["data"][:4],
        "meetings": responses["meetings"],
        "deadlines": responses["deadlines"]["data"],
        "tasks": responses["tasks"]["data"],
        "failedDatasets": [],
    }


class Result:
    def __init__(self, payload):
        self.payload = payload

    def scalar_one(self):
        return self.payload


class CountingDb:
    def __init__(self, payload):
        self.payload = payload
        self.execute_count = 0
        self.sql = ""
        self.params = {}

    async def execute(self, sql, params=None):
        self.execute_count += 1
        self.sql = str(sql)
        self.params = dict(params or {})
        return Result(deepcopy(self.payload))


@pytest.mark.asyncio
async def test_admin_bootstrap_matches_individual_endpoint_payloads_in_one_execute() -> None:
    expected = aggregate_individual_responses(ADMIN_INDIVIDUAL_RESPONSES)
    db = CountingDb(expected)

    response = await dashboard_bootstrap(db, principal())

    assert db.execute_count == 1
    assert response["stats"] == expected["stats"]
    assert response["activity"] == expected["activity"]
    assert response["projects"] == expected["projects"]
    assert response["deadlines"] == expected["deadlines"]
    assert response["tasks"] == expected["tasks"]
    assert response["meetings"][0]["id"] == expected["meetings"][0]["id"]
    assert isinstance(response["meetings"][0]["startTime"], datetime)
    assert response["failedDatasets"] == []
    assert all(
        db.params[key] is True
        for key in ("is_admin", "can_projects", "can_tasks", "can_team", "can_finance", "can_meetings")
    )
    assert "5 months" not in db.sql
    assert "byCurrency" not in db.sql


@pytest.mark.asyncio
async def test_non_admin_sql_preserves_membership_and_personal_filters() -> None:
    expected = aggregate_individual_responses(ADMIN_INDIVIDUAL_RESPONSES)
    expected["stats"] = {
        **expected["stats"],
        "revenue": [],
        "expenses": [],
        "outstandingInvoices": 0,
        "isAdmin": False,
    }
    db = CountingDb(expected)

    response = await dashboard_bootstrap(db, principal(role="EMPLOYEE"))

    assert db.execute_count == 1
    assert {key: value for key, value in response.items() if key != "meetings"} == {
        key: value for key, value in expected.items() if key != "meetings"
    }
    assert response["meetings"][0]["id"] == expected["meetings"][0]["id"]
    assert db.sql.count('visible."userId" = :user_id') >= 3
    assert 'a."userId" = :user_id' in db.sql
    assert 'ta."userId" = :user_id' in db.sql
    assert 'lr."userId" = :user_id' in db.sql


@pytest.mark.asyncio
async def test_restricted_api_token_cannot_receive_unscoped_dashboard_data() -> None:
    malicious_payload = aggregate_individual_responses(ADMIN_INDIVIDUAL_RESPONSES)
    malicious_payload["activity"].extend(
        [
            {"id": "finance-activity", "entityType": "Invoice"},
            {"id": "task-activity", "entityType": "Task"},
        ]
    )
    db = CountingDb(malicious_payload)
    token = principal(scopes=["tasks:read"], actor_type="API_TOKEN")

    response = await dashboard_bootstrap(db, token)

    assert db.execute_count == 1
    assert db.params["can_projects"] is False
    assert db.params["can_team"] is False
    assert db.params["can_finance"] is False
    assert db.params["can_meetings"] is False
    assert response["stats"] == {
        "activeProjects": 0,
        "totalTasks": 8,
        "completedTasksThisWeek": 2,
        "pendingLeaves": 0,
        "revenue": [],
        "expenses": [],
        "outstandingInvoices": 0,
        "isAdmin": True,
    }
    assert response["projects"] == []
    assert response["meetings"] == []
    assert response["deadlines"] == []
    assert response["tasks"] == ADMIN_INDIVIDUAL_RESPONSES["tasks"]["data"]
    assert response["activity"] == [{"id": "task-activity", "entityType": "Task"}]
    assert response["failedDatasets"] == ["projects", "meetings"]


@pytest.mark.asyncio
async def test_partial_optional_payloads_default_to_empty_collections() -> None:
    db = CountingDb({"stats": {"isAdmin": False}, "tasks": None})

    response = await dashboard_bootstrap(db, principal(role="EMPLOYEE"))

    assert db.execute_count == 1
    assert response["activity"] == []
    assert response["projects"] == []
    assert response["meetings"] == []
    assert response["deadlines"] == []
    assert response["tasks"] == []


def test_bootstrap_route_is_registered_and_revenue_chart_is_not_embedded() -> None:
    paths = {route.path for route in app.routes}

    assert "/api/dashboard/bootstrap" in paths
    assert "/api/dashboard/revenue-chart" in paths
    assert "revenueChart" not in aggregate_individual_responses(ADMIN_INDIVIDUAL_RESPONSES)
    assert "byCurrency" not in aggregate_individual_responses(ADMIN_INDIVIDUAL_RESPONSES)
