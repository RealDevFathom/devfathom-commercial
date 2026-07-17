from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "DevFathom API"
    environment: str = "development"
    vercel_env: str | None = None
    database_url: str = ""
    database_pool_mode: Literal["bounded", "null"] = "bounded"
    database_pool_size: int = Field(default=5, ge=1, le=50)
    database_pool_max_overflow: int = Field(default=5, ge=0, le=50)
    database_pool_recycle_seconds: int = Field(default=1800, ge=30, le=86400)
    database_pool_pre_ping: bool = True
    auth_secret: str = Field(default="dev-only-change-me", min_length=16)
    access_token_minutes: int = 60 * 24 * 7
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    app_url: str = "http://localhost:3000"
    ably_api_key: str = ""
    google_generative_ai_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    blob_read_write_token: str = ""
    private_upload_dir: str = "private-uploads"
    email_token_enc_key: str = ""
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_oauth_redirect_uri: str = "http://localhost:3000/email/oauth/callback"
    ms_oauth_client_id: str = ""
    ms_oauth_client_secret: str = ""
    ms_oauth_redirect_uri: str = "http://localhost:3000/email/oauth/callback"
    ms_oauth_tenant: str = "common"

    @model_validator(mode="after")
    def secure_production_secret(self) -> "Settings":
        production = self.environment.casefold() == "production" or (self.vercel_env or "").casefold() == "production"
        weak = {
            "dev-only-change-me",
            "change-me",
            "changeme",
            "secret",
            "development-secret",
        }
        if production and (len(self.auth_secret) < 32 or self.auth_secret.casefold() in weak):
            raise ValueError("AUTH_SECRET must be a unique, random value of at least 32 characters in production")
        return self

    @property
    def async_database_url(self) -> str:
        url = self.database_url
        if url.startswith("postgresql+asyncpg://"):
            return url
        if url.startswith("postgresql://"):
            return url.replace("postgresql://", "postgresql+asyncpg://", 1)
        if url.startswith("postgres://"):
            return url.replace("postgres://", "postgresql+asyncpg://", 1)
        return url

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
