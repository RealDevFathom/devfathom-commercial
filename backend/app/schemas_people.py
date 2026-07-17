from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator

LeaveType = Literal["VACATION", "SICK", "REMOTE"]


def comparable_utc(value: datetime) -> datetime:
    return value if value.tzinfo is None else value.astimezone(UTC).replace(tzinfo=None)


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=100)
    bio: str | None = Field(default=None, max_length=5000)
    skills: list[str] | None = None


class MemberUpdate(ProfileUpdate):
    email: EmailStr | None = None
    role: Literal["ADMIN", "HR", "EMPLOYEE"] | None = None
    department: Literal["LEADERSHIP", "ENGINEERING", "PRODUCT", "QUALITY", "MARKETING", "DESIGN"] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)
    status: Literal["ACTIVE", "INACTIVE", "ON_LEAVE"] | None = None


class LeaveCreate(BaseModel):
    type: LeaveType
    start_date: datetime
    end_date: datetime
    reason: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def valid_range(self) -> "LeaveCreate":
        if comparable_utc(self.end_date) < comparable_utc(self.start_date):
            raise ValueError("End date must be on or after the start date.")
        return self


class LeaveDecision(BaseModel):
    status: Literal["APPROVED", "REJECTED"]


class LeaveBalanceSet(BaseModel):
    user_id: str
    year: int = Field(ge=2000, le=2100)
    type: LeaveType
    entitled_days: int = Field(ge=0, le=366)


class ResignationCreate(BaseModel):
    reason: str = Field(min_length=10, max_length=2000)
    proposed_last_day: datetime


class ResignationDecision(BaseModel):
    decision: Literal["APPROVED", "DECLINED"]
    review_note: str | None = Field(default=None, max_length=2000)
    last_working_day: datetime | None = None


class PerformanceNoteCreate(BaseModel):
    user_id: str
    content: str = Field(min_length=1, max_length=4000)


class ReviewCycleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    start_date: datetime
    end_date: datetime

    @model_validator(mode="after")
    def valid_range(self) -> "ReviewCycleCreate":
        if comparable_utc(self.end_date) < comparable_utc(self.start_date):
            raise ValueError("The end date must be on or after the start date.")
        return self


class ReviewAssignment(BaseModel):
    subject_id: str
    reviewer_id: str


class ReviewSubmit(BaseModel):
    rating: int = Field(ge=1, le=5)
    strengths: str | None = Field(default=None, max_length=5000)
    improvements: str | None = Field(default=None, max_length=5000)
    comments: str | None = Field(default=None, max_length=5000)
