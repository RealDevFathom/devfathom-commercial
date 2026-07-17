from datetime import UTC, datetime
from decimal import Decimal

import pytest
from backend.app.routers import crm
from backend.app.routers.crm_schemas import (
    ClientCreate,
    ContractCreate,
    ContractStatus,
    ContractUpdate,
    InvoiceFromContract,
)
from backend.app.security import Principal
from fastapi import HTTPException
from pydantic import ValidationError


def route_methods(router) -> set[tuple[str, str]]:
    return {(method, route.path) for route in router.routes for method in route.methods}


def test_crm_routes_cover_clients_contacts_contracts_and_documents() -> None:
    routes = route_methods(crm.router)
    assert ("GET", "/api/v1/clients") in routes
    assert ("POST", "/api/v1/clients/{client_id}/contacts") in routes
    assert ("POST", "/api/v1/clients/{client_id}/contracts") in routes
    assert ("PUT", "/api/v1/contracts/{contract_id}/status") in routes
    assert ("POST", "/api/v1/clients/{client_id}/documents") in routes
    assert ("GET", "/api/v1/clients/{client_id}/activity") in routes
    assert ("POST", "/api/v1/contracts/{contract_id}/invoice") in routes


def test_client_create_accepts_nested_contacts() -> None:
    payload = ClientCreate.model_validate(
        {
            "name": "Acme",
            "contacts": [
                {
                    "name": "Amina",
                    "email": "amina@example.com",
                    "isPrimary": True,
                }
            ],
        }
    )
    assert payload.contacts[0].is_primary


def test_contract_schema_matches_legacy_statuses_and_money_bound() -> None:
    assert {status.value for status in ContractStatus} == {
        "DRAFT",
        "SENT",
        "SIGNED",
        "EXPIRED",
        "TERMINATED",
    }
    payload = ContractCreate(title="Support", value=Decimal("9999999999.99"), currency="PKR")
    assert payload.value == Decimal("9999999999.99")
    with pytest.raises(ValidationError):
        ContractCreate(title="Too large", value=Decimal("10000000000"))


def test_contract_dates_cannot_run_backwards() -> None:
    start = datetime(2026, 8, 1, tzinfo=UTC)
    end = datetime(2026, 7, 1, tzinfo=UTC)
    with pytest.raises(ValidationError):
        ContractCreate(title="Bad dates", startDate=start, endDate=end)
    with pytest.raises(ValidationError):
        ContractUpdate(startDate=start, endDate=end)


def test_crm_update_statement_binds_enums_without_updating_id() -> None:
    sql = crm.update_statement(
        "contracts",
        {"id": "contract-1", "status": "SIGNED", "updatedAt": "now"},
        {"status": '::"ContractStatus"'},
    )
    assert '"status" = :status' in sql
    assert '"id" =' not in sql
    assert sql.count('"updatedAt" =') == 1


def employee() -> Principal:
    return Principal("u1", "User", "u@example.com", "EMPLOYEE", "ACTIVE", ["*"])


@pytest.mark.asyncio
async def test_client_rest_directory_is_admin_only() -> None:
    with pytest.raises(HTTPException) as denied:
        await crm.list_clients(principal=employee(), db=object())
    assert denied.value.status_code == 403


@pytest.mark.asyncio
async def test_contract_invoice_operational_failure_rolls_back_and_remains_5xx(monkeypatch: pytest.MonkeyPatch) -> None:
    responses = iter(
        [
            {
                "id": "contract-1",
                "title": "Support",
                "value": Decimal("100"),
                "currency": "USD",
                "clientId": "client-1",
                "projectId": None,
                "clientName": "Acme",
            },
            {"count": 0},
        ]
    )

    async def fake_fetch_one(*_args, **_kwargs):
        return next(responses)

    async def fail_execute(*_args, **_kwargs):
        raise RuntimeError("database failure")

    class Db:
        rolled_back = False

        async def rollback(self):
            self.rolled_back = True

    db = Db()
    admin = Principal("a1", "Admin", "a@example.com", "ADMIN", "ACTIVE", ["*"])
    monkeypatch.setattr(crm, "fetch_one", fake_fetch_one)
    monkeypatch.setattr(crm, "execute", fail_execute)
    with pytest.raises(RuntimeError, match="database failure"):
        await crm.generate_invoice_from_contract(
            "contract-1",
            InvoiceFromContract(dueInDays=30),
            principal=admin,
            db=db,
        )
    assert db.rolled_back
