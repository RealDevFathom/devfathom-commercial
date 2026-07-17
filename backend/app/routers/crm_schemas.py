from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl, model_validator

from .delivery_schemas import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )


class ClientStatus(StrEnum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    PROSPECT = "PROSPECT"


class ContractStatus(StrEnum):
    DRAFT = "DRAFT"
    SENT = "SENT"
    SIGNED = "SIGNED"
    EXPIRED = "EXPIRED"
    TERMINATED = "TERMINATED"


class Currency(StrEnum):
    USD = "USD"
    PKR = "PKR"


class ClientCreate(ApiModel):
    name: str = Field(min_length=1)
    logo: str | None = None
    website: str | None = None
    industry: str | None = None
    location: str | None = None
    timezone: str | None = None
    notes: str | None = None
    status: ClientStatus = ClientStatus.ACTIVE
    contacts: list["ContactCreate"] = Field(default_factory=list)


class ClientUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    logo: str | None = None
    website: str | None = None
    industry: str | None = None
    location: str | None = None
    timezone: str | None = None
    notes: str | None = None
    status: ClientStatus | None = None


class ContactCreate(ApiModel):
    name: str = Field(min_length=1)
    email: EmailStr | Literal[""] | None = None
    phone: str | None = None
    role: str | None = None
    is_primary: bool = False


class ContactUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1)
    email: EmailStr | Literal[""] | None = None
    phone: str | None = None
    role: str | None = None
    is_primary: bool | None = None


class ContractCreate(ApiModel):
    title: str = Field(min_length=1)
    file_url: str | None = None
    value: Decimal | None = Field(default=None, ge=0, le=9999999999.99)
    currency: Currency = Currency.USD
    status: ContractStatus = ContractStatus.DRAFT
    start_date: datetime | None = None
    end_date: datetime | None = None
    signed_at: datetime | None = None
    notes: str | None = None
    project_id: str | None = None

    @model_validator(mode="after")
    def dates_are_ordered(self) -> "ContractCreate":
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("End date must be on or after the start date.")
        return self


class ContractUpdate(ApiModel):
    title: str | None = Field(default=None, min_length=1)
    file_url: str | None = None
    value: Decimal | None = Field(default=None, ge=0, le=9999999999.99)
    currency: Currency | None = None
    status: ContractStatus | None = None
    start_date: datetime | None = None
    end_date: datetime | None = None
    signed_at: datetime | None = None
    notes: str | None = None
    project_id: str | None = None

    @model_validator(mode="after")
    def dates_are_ordered(self) -> "ContractUpdate":
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("End date must be on or after the start date.")
        return self


class ContractStatusUpdate(ApiModel):
    status: ContractStatus


class DocumentCreate(ApiModel):
    name: str = Field(min_length=1)
    url: HttpUrl
    type: str | None = None
    size: int | None = Field(default=None, ge=0)


class InvoiceFromContract(ApiModel):
    due_in_days: int = Field(default=30, gt=0, le=365)


ClientCreate.model_rebuild()
