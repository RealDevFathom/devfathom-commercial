from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Currency = Literal["USD", "PKR"]
TransactionType = Literal["INCOME", "EXPENSE"]
InvoiceStatus = Literal["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED"]
ExpenseCategory = Literal[
    "SALARIES",
    "SUBSCRIPTIONS",
    "OFFICE",
    "MARKETING",
    "HOSTING",
    "SOFTWARE",
    "HARDWARE",
    "TRAVEL",
    "UTILITIES",
    "MISCELLANEOUS",
]

MAX_MONEY = Decimal("9999999999.99")


class InvoiceItemIn(BaseModel):
    description: str = Field(min_length=1, max_length=1000)
    quantity: Decimal = Field(gt=0)
    rate: Decimal = Field(gt=0, le=MAX_MONEY)


class InvoiceCreate(BaseModel):
    client_id: str
    project_id: str | None = None
    items: list[InvoiceItemIn] = Field(min_length=1)
    tax: Decimal = Field(default=Decimal("0"), ge=0, le=MAX_MONEY)
    currency: Currency = "USD"
    due_date: datetime
    notes: str | None = Field(default=None, max_length=5000)


class InvoiceUpdate(BaseModel):
    items: list[InvoiceItemIn] = Field(min_length=1)
    tax: Decimal = Field(default=Decimal("0"), ge=0, le=MAX_MONEY)
    due_date: datetime | None = None
    notes: str | None = Field(default=None, max_length=5000)
    status: Literal["DRAFT", "SENT"] | None = None


class InvoiceStatusUpdate(BaseModel):
    status: InvoiceStatus


class PaymentCreate(BaseModel):
    amount: Decimal = Field(gt=0, le=MAX_MONEY)
    method: str | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=1000)
    paid_at: datetime | None = None


class TransactionCreate(BaseModel):
    type: TransactionType
    amount: Decimal = Field(gt=0, le=MAX_MONEY)
    currency: Currency = "USD"
    category: str | None = None
    description: str = Field(min_length=1, max_length=2000)
    project_id: str | None = None
    client_id: str | None = None
    date: datetime


class TransactionUpdate(BaseModel):
    type: TransactionType | None = None
    amount: Decimal | None = Field(default=None, gt=0, le=MAX_MONEY)
    category: str | None = None
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    project_id: str | None = None
    client_id: str | None = None
    date: datetime | None = None

    @field_validator("category", "project_id", "client_id", mode="before")
    @classmethod
    def empty_to_none(cls, value: object) -> object:
        return None if value == "" else value


class RecurringExpenseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    amount: Decimal = Field(gt=0, le=MAX_MONEY)
    currency: Currency = "USD"
    category: ExpenseCategory = "SUBSCRIPTIONS"
    interval: Literal["monthly", "quarterly", "yearly"] = "monthly"
    next_due_date: datetime
    vendor_name: str | None = Field(default=None, max_length=300)
