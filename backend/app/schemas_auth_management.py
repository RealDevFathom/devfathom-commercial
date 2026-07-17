import re
from typing import Any

from pydantic import BaseModel, EmailStr, Field, field_validator


def password_meets_policy(value: str) -> bool:
    return (
        len(value) >= 8
        and bool(re.search(r"[a-z]", value))
        and bool(re.search(r"[A-Z]", value))
        and bool(re.search(r"\d", value))
    )


class PasswordValue(BaseModel):
    password: str

    @field_validator("password")
    @classmethod
    def policy(cls, value: str) -> str:
        if not password_meets_policy(value):
            raise ValueError("Password must be at least 8 characters and include lowercase, uppercase, and a number")
        return value


class ChangePassword(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str

    @field_validator("new_password")
    @classmethod
    def policy(cls, value: str) -> str:
        return PasswordValue(password=value).password


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordResetApply(BaseModel):
    token: str = Field(min_length=1)
    new_password: str

    @field_validator("new_password")
    @classmethod
    def policy(cls, value: str) -> str:
        return PasswordValue(password=value).password


class InvitationAccept(BaseModel):
    token: str = Field(min_length=1)
    password: str
    phone: str = Field(min_length=1, max_length=100)
    bio: str | None = Field(default=None, max_length=5000)
    skills: list[str] | None = None

    @field_validator("password")
    @classmethod
    def policy(cls, value: str) -> str:
        return PasswordValue(password=value).password


class InvitationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr
    role: str = "EMPLOYEE"
    department: str
    title: str = Field(min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=100)
    bio: str | None = Field(default=None, max_length=5000)
    skills: list[str] = Field(default_factory=list)


class AdminPasswordReset(BaseModel):
    new_password: str

    @field_validator("new_password")
    @classmethod
    def policy(cls, value: str) -> str:
        return PasswordValue(password=value).password


class LayoffRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class TwoFactorCode(BaseModel):
    token: str = Field(min_length=6, max_length=20)


class NotificationPreferences(BaseModel):
    task: dict[str, bool] | None = None
    mention: dict[str, bool] | None = None
    meeting: dict[str, bool] | None = None
    leave: dict[str, bool] | None = None
    invoice: dict[str, bool] | None = None
    project: dict[str, bool] | None = None
    client: dict[str, bool] | None = None
    resignation: dict[str, bool] | None = None
    note: dict[str, bool] | None = None

    def json_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)
