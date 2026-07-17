import asyncio
import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from backend.app.database import engine, statement
from backend.app.routers.auth import record_auth_audit
from backend.app.routers.firm_common import (
    as_naive_utc,
    audit_event,
    claim_totp_counter,
    lock_active_admin_invariant,
    new_id,
)
from backend.app.security import Principal

# Keep pooled asyncpg connections out of the ordinary pytest event loop. Run in
# a dedicated process with:
# RUN_LIVE_FIRM_TESTS=1 .venv/bin/pytest -q backend/tests/test_firm_live.py
pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LIVE_FIRM_TESTS") != "1",
    reason="set RUN_LIVE_FIRM_TESTS=1 and run this file in a dedicated pytest process",
)


@pytest.mark.asyncio
async def test_active_admin_advisory_lock_serializes_competing_transactions() -> None:
    if engine is None:
        pytest.skip("DATABASE_URL is not configured")
    async with engine.connect() as first, engine.connect() as second:
        first_tx = await first.begin()
        second_tx = await second.begin()
        waiter = None
        try:
            await lock_active_admin_invariant(first)
            waiter = asyncio.create_task(lock_active_admin_invariant(second))
            await asyncio.sleep(0.1)
            assert not waiter.done()
            await first_tx.rollback()
            await asyncio.wait_for(waiter, timeout=2)
        finally:
            if first_tx.is_active:
                await first_tx.rollback()
            if waiter and not waiter.done():
                waiter.cancel()
            if second_tx.is_active:
                await second_tx.rollback()


@pytest.mark.asyncio
async def test_live_rollback_timestamp_enum_and_audit_dml() -> None:
    if engine is None:
        pytest.skip("DATABASE_URL is not configured")

    async with engine.connect() as db:
        transaction = await db.begin()
        try:
            # Prisma DateTime maps to timestamp(3), so aware datetime binds must
            # be normalized before asyncpg sees them.
            await db.execute(
                statement("CREATE TEMP TABLE codex_firm_timestamp_probe (value timestamp(3)) ON COMMIT DROP")
            )
            aware = datetime(2026, 7, 12, 8, 30, tzinfo=UTC) + timedelta(hours=5)
            normalized = as_naive_utc(aware)
            await db.execute(
                statement("INSERT INTO codex_firm_timestamp_probe (value) VALUES (:value)"), {"value": normalized}
            )
            stored = (await db.execute(statement("SELECT value FROM codex_firm_timestamp_probe"))).scalar_one()
            assert stored.tzinfo is None

            # Regression for asyncpg's ambiguous varchar/InvoiceStatus bind.
            enum_result = await db.execute(
                statement(
                    'UPDATE invoices SET status = CAST(:status AS "InvoiceStatus") '
                    "WHERE id = :missing RETURNING status::text"
                ),
                {"status": "SENT", "missing": "__codex_missing_invoice__"},
            )
            assert enum_result.first() is None
            coalesce_result = await db.execute(
                statement(
                    'UPDATE invoices SET status = COALESCE(CAST(:status AS "InvoiceStatus"), status) '
                    "WHERE id = :missing RETURNING status::text"
                ),
                {"status": None, "missing": "__codex_missing_invoice__"},
            )
            assert coalesce_result.first() is None

            actor_row = (
                (
                    await db.execute(
                        statement(
                            'SELECT id, name, email, role::text role, status::text status FROM users ORDER BY "createdAt" LIMIT 1'
                        )
                    )
                )
                .mappings()
                .first()
            )
            if not actor_row:
                pytest.skip("Live database has no user for the audit foreign key")
            principal = Principal(
                id=actor_row["id"],
                name=actor_row["name"],
                email=actor_row["email"],
                role=actor_row["role"],
                status=actor_row["status"],
                scopes=["audit:write"],
            )
            await record_auth_audit(
                db,
                success=True,
                email=principal.email,
                ip="127.0.0.1",
                user_agent="pytest-live",
                user=actor_row,
            )
            auth_audit = (
                (
                    await db.execute(
                        statement(
                            "SELECT source::text source, operation::text operation, outcome::text outcome "
                            "FROM audit_logs WHERE action = 'auth.login' AND \"userAgent\" = 'pytest-live' "
                            'ORDER BY "createdAt" DESC LIMIT 1'
                        )
                    )
                )
                .mappings()
                .one()
            )
            assert dict(auth_audit) == {"source": "AUTH", "operation": "LOGIN", "outcome": "SUCCESS"}
            await lock_active_admin_invariant(db)
            replay_counter = 9_000_000_000
            assert await claim_totp_counter(db, principal.id, replay_counter)
            assert not await claim_totp_counter(db, principal.id, replay_counter)
            audit_id = new_id()
            # Pin new_id so the row can be read before the transaction rolls back.
            from backend.app.routers import firm_common

            original_new_id = firm_common.new_id
            firm_common.new_id = lambda: audit_id
            try:
                await audit_event(
                    db,
                    principal,
                    category="AUTH",
                    operation="UPDATE",
                    action="tests.liveRollback",
                    input_data={"invoiceTotal": Decimal("12.34"), "accessToken": "never-store"},
                    metadata={"at": datetime(2026, 7, 12, tzinfo=UTC)},
                    token_id="test-token-id",
                    token_name="rollback probe",
                )
            finally:
                firm_common.new_id = original_new_id
            audit_row = (
                (
                    await db.execute(
                        statement(
                            'SELECT "actorType"::text AS "actorType", "tokenId", "tokenName", input, metadata '
                            "FROM audit_logs WHERE id = :id"
                        ),
                        {"id": audit_id},
                    )
                )
                .mappings()
                .one()
            )
            assert audit_row["actorType"] == "API_TOKEN"
            assert audit_row["tokenId"] == "test-token-id"
            assert audit_row["tokenName"] == "rollback probe"
            assert audit_row["input"]["accessToken"] == "[REDACTED]"
            assert audit_row["input"]["invoiceTotal"] == "12.34"
            assert audit_row["metadata"]["at"].startswith("2026-07-12")
        finally:
            await transaction.rollback()
