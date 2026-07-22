import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from backend.app.database import engine, statement
from backend.app.routers import finance
from backend.app.schemas_finance import (
    InvoiceCreate,
    InvoiceItemIn,
    InvoiceStatusUpdate,
    InvoiceUpdate,
    PaymentCreate,
    RecurringExpenseCreate,
    TransactionCreate,
    TransactionUpdate,
)
from backend.app.security import Principal

# Exercise the connected Finance CRUD implementation without persisting probe
# records. Run in a dedicated process with:
# RUN_LIVE_FINANCE_TESTS=1 .venv/bin/pytest -q backend/tests/test_finance_live.py
pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LIVE_FINANCE_TESTS") != "1",
    reason="set RUN_LIVE_FINANCE_TESTS=1 and run this file in a dedicated pytest process",
)


class RollbackConnection:
    """Keep endpoint-level commits inside the test's outer rollback."""

    def __init__(self, db) -> None:
        self.db = db

    async def execute(self, *args, **kwargs):
        return await self.db.execute(*args, **kwargs)

    async def commit(self) -> None:
        return None


@pytest.mark.asyncio
async def test_live_finance_crud_flows_rollback_cleanly() -> None:
    if engine is None:
        pytest.skip("DATABASE_URL is not configured")

    async with engine.connect() as raw_db:
        transaction = await raw_db.begin()
        db = RollbackConnection(raw_db)
        try:
            actor = (
                (
                    await raw_db.execute(
                        statement(
                            "SELECT id, name, email, role::text role, status::text status "
                            "FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' LIMIT 1"
                        )
                    )
                )
                .mappings()
                .first()
            )
            client_id = (
                await raw_db.execute(statement('SELECT id FROM clients ORDER BY "createdAt" LIMIT 1'))
            ).scalar_one_or_none()
            if not actor or not client_id:
                pytest.skip("Live Finance CRUD verification requires an active ADMIN and a client")

            principal = Principal(**actor, scopes=["*"])
            now = datetime.now(UTC)

            created_transaction = await finance.create_transaction(
                TransactionCreate(
                    type="EXPENSE",
                    amount=Decimal("12.34"),
                    currency="USD",
                    category="SOFTWARE",
                    description="Codex Finance rollback probe",
                    client_id=client_id,
                    date=now,
                ),
                principal,
                db,
            )
            transaction_id = created_transaction["data"]["id"]
            updated_transaction = await finance.update_transaction(
                transaction_id,
                TransactionUpdate(amount=Decimal("13.45"), description="Codex Finance updated rollback probe"),
                principal,
                db,
            )
            assert updated_transaction["data"]["amount"] == 13.45
            assert (await finance.list_transactions(limit=100, _=principal, db=db))["data"]
            assert (await finance.delete_transaction(transaction_id, principal, db))["success"]

            created_recurring = await finance.create_recurring_expense(
                RecurringExpenseCreate(
                    name="Codex Finance recurring rollback probe",
                    amount=Decimal("7.89"),
                    currency="USD",
                    category="SUBSCRIPTIONS",
                    interval="monthly",
                    next_due_date=now - timedelta(days=1),
                    vendor_name="Codex",
                ),
                principal,
                db,
            )
            recurring_id = created_recurring["data"]["id"]
            assert (await finance.list_recurring_expenses(_=principal, db=db))["data"]
            assert (await finance.post_due_recurring_expenses(principal, db))["posted"] >= 1
            assert (await finance.delete_recurring_expense(recurring_id, principal, db))["success"]

            item = InvoiceItemIn(
                description="Finance performance verification", quantity=Decimal("2"), rate=Decimal("50")
            )
            created_invoice = await finance.create_invoice(
                InvoiceCreate(
                    client_id=client_id,
                    items=[item],
                    tax=Decimal("10"),
                    currency="USD",
                    due_date=now - timedelta(days=1),
                    notes="Rollback-only connected verification",
                ),
                principal,
                db,
            )
            invoice_id = created_invoice["data"]["id"]
            updated_invoice = await finance.update_invoice(
                invoice_id,
                InvoiceUpdate(
                    items=[item],
                    tax=Decimal("10"),
                    notes="Updated rollback-only verification",
                    status="SENT",
                ),
                principal,
                db,
            )
            assert updated_invoice["data"]["status"] == "SENT"
            payment = await finance.add_payment(
                invoice_id,
                PaymentCreate(amount=Decimal("25"), method="test", note="Rollback probe"),
                principal,
                db,
            )
            payment_id = payment["data"]["id"]
            assert payment["amountPaid"] == 25.0
            assert (await finance.delete_payment(payment_id, principal, db))["amountPaid"] == 0.0
            assert (await finance.mark_overdue(principal, db))["count"] >= 1
            restored_invoice = await finance.update_invoice_status(
                invoice_id, InvoiceStatusUpdate(status="SENT"), principal, db
            )
            assert restored_invoice["data"]["status"] == "SENT"
            assert (await finance.get_invoice(invoice_id, _=principal, db=db))["data"]["id"] == invoice_id
            assert (await finance.list_invoices(limit=1000, _=principal, db=db))["data"]
            assert (await finance.list_finance_client_choices(_=principal, db=db))["data"]
            assert "byCurrency" in await finance.financial_summary(_=principal, db=db)
            assert set(await finance.finance_bootstrap(limit=100, _=principal, db=db)) == {"summary", "transactions"}
        finally:
            await transaction.rollback()
