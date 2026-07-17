from datetime import datetime
from typing import Literal

from pydantic import AnyHttpUrl, BaseModel, Field, field_validator

from .scopes import GRANTABLE_SCOPES


class ApiTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    scopes: list[str] = Field(min_length=1)
    expires_in_days: int | None = Field(default=None, gt=0, le=3650)
    user_id: str | None = None

    @field_validator("scopes")
    @classmethod
    def known_unique_scopes(cls, scopes: list[str]) -> list[str]:
        unique = list(dict.fromkeys(scopes))
        unknown = sorted(set(unique) - GRANTABLE_SCOPES - {"*"})
        if unknown:
            raise ValueError(f"Unknown API token scopes: {', '.join(unknown)}")
        return unique


class WebhookCreate(BaseModel):
    url: AnyHttpUrl
    events: list[str] = Field(min_length=1)
    active: bool = True


class WebhookUpdate(BaseModel):
    url: AnyHttpUrl | None = None
    events: list[str] | None = Field(default=None, min_length=1)
    active: bool | None = None


class AuditFilters(BaseModel):
    search: str | None = None
    actor_id: str | None = None
    actor_type: Literal["USER", "API_TOKEN", "ANONYMOUS", "SYSTEM"] | None = None
    category: str | None = None
    operation: str | None = None
    source: Literal["TRPC", "REST_API", "AUTH", "SYSTEM"] | None = None
    outcome: Literal["SUCCESS", "FAILURE"] | None = None
    action: str | None = None
    assistant_only: bool = False
    target_type: str | None = None
    target_id: str | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None
    limit: int = Field(default=50, ge=1, le=200)
    cursor: str | None = None
