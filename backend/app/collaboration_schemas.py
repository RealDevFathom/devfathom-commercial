from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class CollaborationModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class NoteCreate(CollaborationModel):
    title: str = Field(default="Untitled", min_length=1)
    content_json: Any = Field(
        default_factory=lambda: {"type": "doc", "content": [{"type": "paragraph"}]},
        alias="contentJson",
    )
    visibility: Literal["PRIVATE", "SHARED", "TEAM"] = "PRIVATE"
    project_id: str | None = Field(default=None, alias="projectId")
    client_id: str | None = Field(default=None, alias="clientId")


class NoteUpdate(CollaborationModel):
    title: str | None = Field(default=None, min_length=1)
    content_json: Any | None = Field(default=None, alias="contentJson")
    visibility: Literal["PRIVATE", "SHARED", "TEAM"] | None = None
    project_id: str | None = Field(default=None, alias="projectId")
    client_id: str | None = Field(default=None, alias="clientId")

    @field_validator("title", "content_json", "visibility", mode="before")
    @classmethod
    def non_nullable_fields(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("field cannot be null")
        return value


class NoteShareInput(CollaborationModel):
    user_id: str = Field(alias="userId")
    permission: Literal["VIEW", "EDIT"]


class NoteSharesUpdate(CollaborationModel):
    shares: list[NoteShareInput]


class AttachmentInput(CollaborationModel):
    name: str
    url: str
    type: str | None = None
    size: int | None = Field(default=None, ge=0)
    duration: int | None = Field(default=None, ge=0)


class MessageCreate(CollaborationModel):
    content: str = Field(default="", max_length=8000)
    content_json: Any | None = Field(default=None, alias="contentJson")
    mention_ids: list[str] = Field(default_factory=list, alias="mentionIds")
    parent_id: str | None = Field(default=None, alias="parentId")
    attachments: list[AttachmentInput] = Field(default_factory=list, max_length=20)


class MessageUpdate(CollaborationModel):
    content: str = Field(default="", max_length=8000)
    content_json: Any | None = Field(default=None, alias="contentJson")
    mention_ids: list[str] = Field(default_factory=list, alias="mentionIds")


class ReactionToggle(CollaborationModel):
    emoji: str = Field(min_length=1, max_length=32)


class ChannelCreate(CollaborationModel):
    name: str = Field(min_length=1)
    description: str | None = None
    topic: str | None = None
    type: Literal["GROUP", "PROJECT"] = "GROUP"
    is_private: bool = Field(default=True, alias="isPrivate")
    member_ids: list[str] = Field(default_factory=list, alias="memberIds")


class ChannelUpdate(CollaborationModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    topic: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def name_cannot_be_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("name cannot be null")
        return value


class ChannelMembersUpdate(CollaborationModel):
    user_ids: list[str] = Field(min_length=1, alias="userIds")


class ChannelMuteUpdate(CollaborationModel):
    muted: bool


class DirectMessageCreate(CollaborationModel):
    user_id: str = Field(alias="userId")


Recurrence = Literal["daily", "weekly", "biweekly", "monthly"]


class MeetingCreate(CollaborationModel):
    title: str = Field(min_length=1)
    description: str | None = None
    start_time: datetime = Field(alias="startTime")
    end_time: datetime = Field(alias="endTime")
    location: str | None = None
    recurrence: Recurrence | None = None
    attendee_ids: list[str] = Field(default_factory=list, alias="attendeeIds")

    @model_validator(mode="after")
    def valid_window(self) -> "MeetingCreate":
        if self.end_time <= self.start_time:
            raise ValueError("endTime must be after startTime")
        return self


class MeetingUpdate(CollaborationModel):
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    start_time: datetime | None = Field(default=None, alias="startTime")
    end_time: datetime | None = Field(default=None, alias="endTime")
    location: str | None = None
    recurrence: Recurrence | None = None
    attendee_ids: list[str] | None = Field(default=None, alias="attendeeIds")

    @field_validator("title", "start_time", "end_time", "attendee_ids", mode="before")
    @classmethod
    def non_nullable_fields(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("field cannot be null")
        return value


class UserLite(CollaborationModel):
    id: str
    name: str
    avatar: str | None = None
    title: str | None = None


class ReactionOut(CollaborationModel):
    emoji: str
    count: int
    user_ids: list[str] = Field(alias="userIds")
    reacted_by_me: bool = Field(alias="reactedByMe")


class NotificationChannelPrefs(CollaborationModel):
    in_app: bool | None = Field(default=None, alias="inApp")
    email: bool | None = None


class NotificationPrefs(CollaborationModel):
    task: NotificationChannelPrefs | None = None
    mention: NotificationChannelPrefs | None = None
    meeting: NotificationChannelPrefs | None = None
    leave: NotificationChannelPrefs | None = None
    invoice: NotificationChannelPrefs | None = None
    project: NotificationChannelPrefs | None = None
    client: NotificationChannelPrefs | None = None
    resignation: NotificationChannelPrefs | None = None
    note: NotificationChannelPrefs | None = None


class SuccessOut(CollaborationModel):
    success: bool = True
