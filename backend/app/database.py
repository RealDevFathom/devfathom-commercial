import ssl
from collections.abc import AsyncIterator, Mapping
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import Result, make_url, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from .config import Settings, get_settings


def _pool_options(settings: Settings) -> dict[str, Any]:
    if settings.database_pool_mode == "null":
        return {"poolclass": NullPool}
    return {
        "pool_pre_ping": settings.database_pool_pre_ping,
        "pool_recycle": settings.database_pool_recycle_seconds,
        "pool_size": settings.database_pool_size,
        "max_overflow": settings.database_pool_max_overflow,
    }


def _create_engine(settings: Settings) -> AsyncEngine | None:
    if not settings.async_database_url:
        return None

    database_url = make_url(settings.async_database_url)
    query = dict(database_url.query)
    ssl_mode = query.pop("sslmode", None)
    query.pop("channel_binding", None)
    connect_args: dict[str, Any] = {}
    if ssl_mode and ssl_mode != "disable":
        ssl_context = ssl.create_default_context()
        if ssl_mode in {"allow", "prefer", "require"}:
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
        connect_args["ssl"] = ssl_context
    database_url = database_url.set(query=query)
    return create_async_engine(
        database_url,
        connect_args=connect_args,
        **_pool_options(settings),
    )


settings = get_settings()
engine = _create_engine(settings)


async def connection() -> AsyncIterator[AsyncConnection]:
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DATABASE_URL is not configured for the FastAPI service.",
        )
    async with engine.connect() as conn:
        yield conn


def json_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date | datetime):
        return value.isoformat()
    return value


def row_dict(row: Mapping[str, Any]) -> dict[str, Any]:
    return {key: json_value(value) for key, value in row.items()}


def rows(result: Result[Any]) -> list[dict[str, Any]]:
    return [row_dict(row) for row in result.mappings().all()]


async def dispose_engine() -> None:
    if engine is not None:
        await engine.dispose()


def statement(sql: str):
    return text(sql)
