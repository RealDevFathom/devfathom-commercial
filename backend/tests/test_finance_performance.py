from collections.abc import AsyncIterator

import pytest
from backend.app.database import connection
from backend.app.main import app
from backend.app.routers import finance
from backend.app.security import Principal, current_principal
from fastapi.testclient import TestClient


def principal(role: str = "ADMIN") -> Principal:
    return Principal(
        id=f"{role.lower()}-1",
        name=role.title(),
        email=f"{role.lower()}@example.com",
        role=role,
        status="ACTIVE",
        scopes=["*"],
    )


class BootstrapResult:
    def __init__(self) -> None:
        self.record = {
            "summary": [
                {
                    "currency": "USD",
                    "monthly_income": 100,
                    "monthly_expense": 25,
                    "monthly_profit": 75,
                    "yearly_income": 100,
                    "yearly_expense": 25,
                    "yearly_profit": 75,
                    "total_paid": 0,
                    "paid_count": 0,
                    "total_outstanding": 40,
                    "outstanding_count": 1,
                }
            ],
            "transactions": [{"id": "transaction-1", "description": "Opening balance"}],
            "nextCursor": None,
        }

    def mappings(self) -> "BootstrapResult":
        return self

    def one(self) -> dict:
        return self.record


class BootstrapDb:
    def __init__(self) -> None:
        self.calls = 0
        self.sql = ""
        self.params: dict = {}

    async def execute(self, sql, params=None) -> BootstrapResult:
        self.calls += 1
        self.sql = str(sql)
        self.params = params or {}
        return BootstrapResult()


@pytest.mark.asyncio
async def test_finance_bootstrap_uses_one_bounded_query() -> None:
    db = BootstrapDb()

    result = await finance.finance_bootstrap(limit=100, _=principal(), db=db)

    assert db.calls == 1
    assert db.params == {"limit": 100, "fetch_limit": 101}
    assert "WITH transaction_page AS MATERIALIZED" in db.sql
    assert "finance_summary" in db.sql
    assert db.sql.rstrip().endswith('END AS "nextCursor"')
    assert result["transactions"]["items"][0]["id"] == "transaction-1"
    assert result["summary"]["byCurrency"][0]["outstanding_count"] == 1
    assert set(result) == {"summary", "transactions"}


@pytest.mark.parametrize(("role", "status", "query_count"), [("ADMIN", 200, 1), ("EMPLOYEE", 403, 0)])
def test_finance_bootstrap_is_admin_only(role: str, status: int, query_count: int) -> None:
    db = BootstrapDb()

    async def override_principal() -> Principal:
        return principal(role)

    async def override_connection() -> AsyncIterator[BootstrapDb]:
        yield db

    app.dependency_overrides[current_principal] = override_principal
    app.dependency_overrides[connection] = override_connection
    try:
        response = TestClient(app).get("/api/finance/bootstrap")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == status
    assert db.calls == query_count


def test_finance_crud_routes_remain_available() -> None:
    exposed = {(method, route.path) for route in finance.router.routes for method in route.methods or set()}
    expected = {
        ("GET", "/api/finance/bootstrap"),
        ("GET", "/api/finance/client-choices"),
        ("GET", "/api/finance/transactions"),
        ("POST", "/api/finance/transactions"),
        ("PATCH", "/api/finance/transactions/{transaction_id}"),
        ("DELETE", "/api/finance/transactions/{transaction_id}"),
        ("GET", "/api/finance/invoices"),
        ("GET", "/api/finance/invoices/{invoice_id}"),
        ("POST", "/api/finance/invoices"),
        ("PATCH", "/api/finance/invoices/{invoice_id}"),
        ("PATCH", "/api/finance/invoices/{invoice_id}/status"),
        ("POST", "/api/finance/invoices/{invoice_id}/payments"),
        ("DELETE", "/api/finance/payments/{payment_id}"),
        ("POST", "/api/finance/invoices/mark-overdue"),
        ("GET", "/api/finance/recurring-expenses"),
        ("POST", "/api/finance/recurring-expenses"),
        ("DELETE", "/api/finance/recurring-expenses/{expense_id}"),
        ("POST", "/api/finance/recurring-expenses/post-due"),
        ("GET", "/api/finance/summary"),
    }
    assert expected <= exposed
