from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class ProjectType(StrEnum):
    CLIENT = "CLIENT"
    INTERNAL = "INTERNAL"


class ProjectStatus(StrEnum):
    ACTIVE = "ACTIVE"
    IN_DEVELOPMENT = "IN_DEVELOPMENT"
    ON_HOLD = "ON_HOLD"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class Priority(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    URGENT = "URGENT"


class ProjectCreate(ApiModel):
    name: str = Field(min_length=1)
    description: str | None = None
    type: ProjectType
    status: ProjectStatus = ProjectStatus.ACTIVE
    client_id: str | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None
    tech_stack: list[str] = Field(default_factory=list)
    member_ids: list[str] = Field(default_factory=list)
    create_default_board: bool = True


class ProjectUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    status: ProjectStatus | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None
    tech_stack: list[str] | None = None


class ProjectMemberInput(ApiModel):
    user_id: str
    role: Literal["LEAD", "MEMBER"] = "MEMBER"


class ProjectMemberRole(ApiModel):
    role: Literal["LEAD", "MEMBER"]


class BoardTemplate(StrEnum):
    KANBAN = "kanban"
    SCRUM = "scrum"
    SIMPLE = "simple"
    BUGTRACKER = "bugtracker"


class BoardCreate(ApiModel):
    project_id: str
    name: str = Field(min_length=1)
    description: str | None = None
    create_default_columns: bool = True
    template: BoardTemplate | None = None


class BoardUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None


class ColumnCreate(ApiModel):
    board_id: str
    name: str = Field(min_length=1)


class ColumnUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    wip_limit: int | None = Field(default=None, ge=0)


class ColumnOrder(ApiModel):
    column_ids: list[str] = Field(min_length=1)


class DefaultAssignees(ApiModel):
    user_ids: list[str] = Field(default_factory=list)


class TaskCreate(ApiModel):
    title: str = Field(min_length=1)
    column_id: str
    description: str | None = None
    priority: Priority = Priority.MEDIUM
    due_date: datetime | None = None
    assignee_ids: list[str] = Field(default_factory=list)
    label_ids: list[str] = Field(default_factory=list)


class TaskUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    priority: Priority | None = None
    due_date: datetime | None = None
    column_id: str | None = None
    assignee_ids: list[str] | None = None
    label_ids: list[str] | None = None


class TaskMove(ApiModel):
    target_column_id: str
    new_order: int = Field(ge=0)


class BulkTaskMove(ApiModel):
    task_ids: list[str] = Field(min_length=1)
    target_column_id: str


class BulkTaskDelete(ApiModel):
    task_ids: list[str] = Field(min_length=1)


class TaskAssignees(ApiModel):
    assignee_ids: list[str] = Field(default_factory=list)


class LabelCreate(ApiModel):
    board_id: str
    name: str = Field(min_length=1)
    color: str = Field(pattern=r"^#[0-9A-Fa-f]{6}$")


class LabelUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")


class TaskLabelInput(ApiModel):
    label_id: str


class CommentCreate(ApiModel):
    content: str = Field(min_length=1)
    parent_id: str | None = None


class CommentUpdate(ApiModel):
    content: str = Field(min_length=1)


class TaskParentUpdate(ApiModel):
    parent_id: str | None = None


class BlockerCreate(ApiModel):
    blocking_task_id: str


class AttachmentCreate(ApiModel):
    name: str = Field(min_length=1)
    url: str = Field(min_length=1)
    type: str | None = None
    size: int | None = Field(default=None, ge=0)


class ChecklistCreate(ApiModel):
    name: str = Field(min_length=1)


class ChecklistUpdate(ApiModel):
    name: str = Field(min_length=1)


class ChecklistItemCreate(ApiModel):
    text: str = Field(min_length=1)


class ChecklistItemUpdate(ApiModel):
    text: str | None = Field(default=None, min_length=1)
    completed: bool | None = None


class MilestoneCreate(ApiModel):
    name: str = Field(min_length=1)
    description: str | None = None
    due_date: datetime


class MilestoneUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    description: str | None = None
    due_date: datetime | None = None
    completed_at: datetime | None = None


class ProjectFileCreate(ApiModel):
    name: str = Field(min_length=1)
    url: str = Field(min_length=1)
    type: str | None = None
    size: int | None = Field(default=None, ge=0)


class TimeEntryCreate(ApiModel):
    project_id: str
    task_id: str | None = None
    hours: Decimal = Field(gt=0, le=999.99, decimal_places=2)
    description: str | None = None
    date: datetime


class TimeEntryUpdate(ApiModel):
    hours: Decimal | None = Field(default=None, gt=0, le=999.99, decimal_places=2)
    description: str | None = None
    date: datetime | None = None


class TrelloModel(ApiModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="ignore",
    )


class TrelloMember(TrelloModel):
    id: str
    full_name: str | None = None
    username: str | None = None


class TrelloList(TrelloModel):
    id: str
    name: str
    closed: bool = False
    pos: float = 0


class TrelloLabel(TrelloModel):
    id: str
    name: str = ""
    color: str | None = None


class TrelloAttachment(TrelloModel):
    name: str
    url: HttpUrl


class TrelloCard(TrelloModel):
    id: str
    name: str
    id_list: str
    desc: str = ""
    closed: bool = False
    pos: float = 0
    due: str | None = None
    due_complete: bool = False
    id_members: list[str] = Field(default_factory=list)
    labels: list[TrelloLabel] = Field(default_factory=list)
    attachments: list[TrelloAttachment] = Field(default_factory=list)
    cover: dict[str, Any] | None = None
    custom_field_items: list[dict[str, Any]] = Field(default_factory=list)


class TrelloCheckItem(TrelloModel):
    name: str
    state: str = "incomplete"


class TrelloChecklist(TrelloModel):
    id: str
    id_card: str
    name: str
    check_items: list[TrelloCheckItem] = Field(default_factory=list)


class TrelloActionData(TrelloModel):
    text: str = ""
    card: dict[str, Any] | None = None


class TrelloAction(TrelloModel):
    type: str
    data: TrelloActionData
    date: str | None = None
    member_creator: TrelloMember | None = None


class TrelloBoard(TrelloModel):
    id: str | None = None
    name: str
    desc: str = ""
    lists: list[TrelloList]
    cards: list[TrelloCard]
    labels: list[TrelloLabel] = Field(default_factory=list)
    members: list[TrelloMember] = Field(default_factory=list)
    checklists: list[TrelloChecklist] = Field(default_factory=list)
    actions: list[TrelloAction] = Field(default_factory=list)
    custom_fields: list[dict[str, Any]] = Field(default_factory=list)


class TrelloImport(ApiModel):
    trello_json: TrelloBoard
    project_id: str | None = None
    new_project_name: str | None = Field(default=None, min_length=1)
    member_mapping: dict[str, str] = Field(default_factory=dict)
    include_archived: bool = False

    @model_validator(mode="after")
    def target_is_required(self) -> "TrelloImport":
        if not self.project_id and not self.new_project_name:
            raise ValueError("Provide a target project or a new project name.")
        return self
