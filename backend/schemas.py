from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class InvoiceCreate(BaseModel):
    number: str = Field(min_length=1, max_length=40)
    customer: str = Field(min_length=1, max_length=160)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    due_date: date


class InvoiceRead(InvoiceCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    paid_amount: Decimal = Decimal("0")
    status: str = "open"


class TransactionCreate(BaseModel):
    date: date
    description: str = Field(min_length=1, max_length=240)
    amount: Decimal = Field(max_digits=14, decimal_places=2)
    customer: str | None = Field(default=None, max_length=160)
    account: str = Field(default="Manual", max_length=100)
    reference: str | None = Field(default=None, max_length=120)


class TransactionRead(TransactionCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    matched_amount: Decimal = Decimal("0")
    match_status: str = "unmatched"
    suggested_invoice_id: int | None = None
    suggested_invoice_number: str | None = None
    confidence: int | None = None


class MatchCreate(BaseModel):
    transaction_id: int
    invoice_id: int
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    note: str | None = Field(default=None, max_length=1000)


class RegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=12, max_length=128)
    workspace_name: str = Field(min_length=2, max_length=160)


class WorkspaceUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=160)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class UserRead(BaseModel):
    id: int
    email: str
    role: str
    workspace_id: int
    workspace_name: str


class TokenRead(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserRead
