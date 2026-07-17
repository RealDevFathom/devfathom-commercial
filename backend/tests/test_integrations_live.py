import os
from uuid import uuid4

import pytest
from backend.app.database import engine, statement

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LIVE_INTEGRATION_TESTS") != "1",
    reason="set RUN_LIVE_INTEGRATION_TESTS=1 and run this file in a dedicated pytest process",
)


@pytest.mark.asyncio
async def test_mailbox_enum_and_ciphertext_transactional_ddl_rolls_back_without_residue() -> None:
    if engine is None:
        pytest.skip("DATABASE_URL is not configured")
    mailbox_id = f"codex-rollback-{uuid4().hex}"
    async with engine.connect() as db:
        transaction = await db.begin()
        try:
            await db.execute(statement("CREATE TYPE \"CodexMailboxType\" AS ENUM ('GMAIL', 'OUTLOOK')"))
            await db.execute(
                statement(
                    "CREATE TABLE codex_mailbox_rollback_probe (id text PRIMARY KEY, "
                    'type "CodexMailboxType" NOT NULL, credentials text NOT NULL)'
                )
            )
            await db.execute(
                statement(
                    "CREATE TABLE codex_assistant_approval_uses (jti text PRIMARY KEY, "
                    '"userId" text NOT NULL, "toolName" text NOT NULL, "createdAt" timestamp(3) NOT NULL)'
                )
            )
            await db.execute(
                statement(
                    "INSERT INTO codex_mailbox_rollback_probe (id, type, credentials) VALUES "
                    '(:id, CAST(:provider AS "CodexMailboxType"), :credentials)'
                ),
                {
                    "id": mailbox_id,
                    "provider": "GMAIL",
                    "credentials": "ciphertext-only-probe",
                },
            )
            row = (
                (
                    await db.execute(
                        statement(
                            "SELECT type::text type, credentials FROM codex_mailbox_rollback_probe WHERE id = :id"
                        ),
                        {"id": mailbox_id},
                    )
                )
                .mappings()
                .one()
            )
            assert dict(row) == {"type": "GMAIL", "credentials": "ciphertext-only-probe"}
            first_use = await db.execute(
                statement(
                    'INSERT INTO codex_assistant_approval_uses (jti, "userId", "toolName", "createdAt") '
                    "VALUES ('one-time-jti', 'user-1', 'create_task', now()) "
                    "ON CONFLICT (jti) DO NOTHING RETURNING jti"
                )
            )
            replay = await db.execute(
                statement(
                    'INSERT INTO codex_assistant_approval_uses (jti, "userId", "toolName", "createdAt") '
                    "VALUES ('one-time-jti', 'user-1', 'create_task', now()) "
                    "ON CONFLICT (jti) DO NOTHING RETURNING jti"
                )
            )
            assert first_use.scalar_one() == "one-time-jti"
            assert replay.scalar_one_or_none() is None
        finally:
            await transaction.rollback()

    async with engine.connect() as verification:
        table_residue = await verification.scalar(
            statement("SELECT to_regclass('public.codex_mailbox_rollback_probe')")
        )
        type_residue = await verification.scalar(statement("SELECT to_regtype('public.\"CodexMailboxType\"')"))
        approval_residue = await verification.scalar(
            statement("SELECT to_regclass('public.codex_assistant_approval_uses')")
        )
        assert table_residue is None
        assert type_residue is None
        assert approval_residue is None
