from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import get_settings
from .database import dispose_engine, engine
from .routers import (
    admin,
    auth,
    auth_management,
    chat,
    collaboration_search,
    crm,
    dashboard,
    delivery,
    delivery_search,
    email_integration,
    finance,
    integrations,
    meetings,
    notes,
    notifications,
    people,
    resources,
    trello_import,
)

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description="FastAPI backend for the DevFathom Nuxt company workspace.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth.router)
app.include_router(auth_management.router)
app.include_router(dashboard.router)
app.include_router(delivery.router)
app.include_router(crm.router)
app.include_router(trello_import.router)
app.include_router(delivery_search.router)
app.include_router(collaboration_search.router)
app.include_router(chat.router)
app.include_router(notes.router)
app.include_router(meetings.router)
app.include_router(notifications.router)
app.include_router(integrations.router)
app.include_router(email_integration.router)
app.include_router(finance.router)
app.include_router(people.router)
app.include_router(admin.router)
# Keep this dynamic compatibility router last: `/api/v1/{resource_name}`
# would otherwise shadow static domain routes such as `/api/v1/search`.
app.include_router(resources.router)


@app.get("/", tags=["system"])
async def root() -> dict:
    return {
        "name": settings.app_name,
        "status": "ok",
        "docs": "/docs",
        "frontend": "Nuxt 4",
        "backend": "FastAPI",
    }


@app.get("/health", tags=["system"])
async def health() -> dict:
    if engine is None:
        return {"status": "degraded", "database": "not configured"}
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception:
        return {"status": "degraded", "database": "unavailable"}
