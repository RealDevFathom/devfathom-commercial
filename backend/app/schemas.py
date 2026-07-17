from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    name: str
    email: str
    role: str
    title: str | None = None
    department: str | None = None
    avatar: str | None = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class TwoFactorChallengeResponse(BaseModel):
    two_factor_required: bool = True
    challenge_token: str
    expires_in: int


class TwoFactorVerifyRequest(BaseModel):
    challenge_token: str
    code: str


class ResourcePayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    def values(self, *, for_patch: bool = False) -> dict[str, Any]:
        return self.model_dump(exclude_unset=for_patch, exclude_none=not for_patch)
