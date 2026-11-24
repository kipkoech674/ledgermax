import csv
import base64
import io
import json
import os
import secrets
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

import jwt
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from openai import AsyncOpenAI
from pwdlib import PasswordHash
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from database import SessionLocal
from models import AuditEvent, Invoice, ReconciliationMatch, Transaction, User, Workspace
from schemas import (InvoiceCreate, InvoiceRead, MatchCreate, PasswordChange, RegisterRequest,
                     TokenRead, TransactionCreate, TransactionRead, UserRead, WorkspaceUpdate)


app = FastAPI(title="LedgerLens API", version="0.2.0")
JWT_SECRET = os.getenv("JWT_SECRET") or secrets.token_urlsafe(48)
JWT_ALGORITHM = "HS256"
TOKEN_EXPIRE_MINUTES = int(os.getenv("TOKEN_EXPIRE_MINUTES", "60"))
password_hash = PasswordHash.recommended()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:8000,http://127.0.0.1:8000").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    auth_error = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                                detail="Invalid or expired sign-in. Please sign in again.",
                                headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = int(payload.get("sub", ""))
    except (jwt.InvalidTokenError, TypeError, ValueError) as exc:
        raise auth_error from exc
    user = db.get(User, user_id)
    if not user:
        raise auth_error
    return user


def require_writer(user: User):
    if user.role not in {"owner", "accountant"}:
        raise HTTPException(status_code=403, detail="Your workspace role does not allow changes")


def create_access_token(user: User) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": str(user.id), "workspace_id": user.workspace_id,
                       "role": user.role, "exp": expires}, JWT_SECRET, algorithm=JWT_ALGORITHM)


def token_payload(db: Session, user: User) -> dict:
    workspace = db.get(Workspace, user.workspace_id)
    return {"access_token": create_access_token(user), "token_type": "bearer",
            "user": {"id": user.id, "email": user.email, "role": user.role,
                     "workspace_id": user.workspace_id, "workspace_name": workspace.name}}


def record_audit(db: Session, user: User, action: str, entity_type: str, entity_id: int | None, changes: dict):
    """Write an audit event in the same database transaction as the change."""
    db.add(AuditEvent(workspace_id=user.workspace_id, actor_id=user.id, action=action,
                      entity_type=entity_type, entity_id=entity_id, changes=changes))


def paid_amount(db: Session, invoice_id: int) -> Decimal:
    value = db.scalar(select(func.coalesce(func.sum(ReconciliationMatch.amount), 0)).where(
        ReconciliationMatch.invoice_id == invoice_id
    ))
    return Decimal(value or 0)


def invoice_status(invoice: Invoice, paid: Decimal) -> str:
    if paid >= invoice.amount:
        return "paid"
    return "partial" if paid > 0 else "overdue" if invoice.due_date < date.today() else "open"


def invoice_payload(db: Session, invoice: Invoice) -> dict:
    paid = paid_amount(db, invoice.id)
    return {"id": invoice.id, "number": invoice.number, "customer": invoice.customer,
            "amount": invoice.amount, "due_date": invoice.due_date, "paid_amount": paid,
            "status": invoice_status(invoice, paid)}


def transaction_payload(db: Session, transaction: Transaction) -> dict:
    matched = Decimal(db.scalar(select(func.coalesce(func.sum(ReconciliationMatch.amount), 0)).where(
        ReconciliationMatch.transaction_id == transaction.id
    )) or 0)
    matches = db.scalars(select(ReconciliationMatch).where(
        ReconciliationMatch.transaction_id == transaction.id
    )).all()
    if transaction.amount <= 0:
        match_status, suggested, confidence = "unmatched", None, None
    elif matched >= abs(transaction.amount):
        match_status, suggested, confidence = "matched", None, None
    else:
        open_invoices = db.scalars(select(Invoice).where(Invoice.workspace_id == transaction.workspace_id)
                                   .order_by(Invoice.due_date)).all()
        remaining = [(invoice, invoice.amount - paid_amount(db, invoice.id)) for invoice in open_invoices]
        remaining = [(invoice, amount) for invoice, amount in remaining if amount > 0]
        customer = (transaction.customer or "").casefold()
        candidates = sorted(remaining, key=lambda item: (
            0 if customer and customer in item[0].customer.casefold() else 1,
            abs(item[1] - abs(transaction.amount)), item[0].due_date
        ))
        suggested, balance = candidates[0] if candidates else (None, Decimal(0))
        confidence = min(99, 70 + (20 if customer and customer in suggested.customer.casefold() else 0)
                         + (9 if balance == abs(transaction.amount) else 0)) if suggested else None
        match_status = "partial" if matches else "review" if suggested else "unmatched"
    return {"id": transaction.id, "date": transaction.date, "description": transaction.description,
            "amount": transaction.amount, "customer": transaction.customer, "account": transaction.account,
            "reference": transaction.reference, "matched_amount": matched, "match_status": match_status,
            "suggested_invoice_id": suggested.id if suggested else None,
            "suggested_invoice_number": suggested.number if suggested else None, "confidence": confidence}


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "ledgerlens-api"}


@app.post("/api/auth/register", response_model=TokenRead, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    email = payload.email.strip().casefold()
    if db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status_code=409, detail="An account with that email already exists")
    if os.getenv("CLAIM_ORPHANED_WORKSPACE", "false").lower() == "true" and not db.scalar(select(User.id).limit(1)):
        workspace = db.get(Workspace, 1)
        if workspace:
            workspace.name = payload.workspace_name.strip()
        else:
            workspace = Workspace(name=payload.workspace_name.strip())
            db.add(workspace)
            db.flush()
    else:
        workspace = Workspace(name=payload.workspace_name.strip())
        db.add(workspace)
        db.flush()
    user = User(workspace_id=workspace.id, email=email,
                password_hash=password_hash.hash(payload.password), role="owner")
    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with that email already exists") from exc
    db.refresh(user)
    return token_payload(db, user)


@app.post("/api/auth/login", response_model=TokenRead)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    email = form.username.strip().casefold()
    user = db.scalar(select(User).where(User.email == email))
    if not user or not password_hash.verify(form.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect",
                            headers={"WWW-Authenticate": "Bearer"})
    return token_payload(db, user)


@app.get("/api/auth/me", response_model=UserRead)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    workspace = db.get(Workspace, user.workspace_id)
    return {"id": user.id, "email": user.email, "role": user.role,
            "workspace_id": user.workspace_id, "workspace_name": workspace.name}


@app.post("/api/auth/change-password")
def change_password(payload: PasswordChange, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    if not password_hash.verify(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if password_hash.verify(payload.new_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Choose a different password")
    user.password_hash = password_hash.hash(payload.new_password)
    record_audit(db, user, "account.password_changed", "user", user.id, {})
    db.commit()
    return {"message": "Password updated"}


@app.patch("/api/workspace")
def update_workspace(payload: WorkspaceUpdate, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    if user.role != "owner":
        raise HTTPException(status_code=403, detail="Only a workspace owner can change workspace settings")
    workspace = db.get(Workspace, user.workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    new_name = payload.name.strip()
    if len(new_name) < 2:
        raise HTTPException(status_code=422, detail="Workspace name must contain at least 2 characters")
    old_name = workspace.name
    if new_name != old_name:
        workspace.name = new_name
        record_audit(db, user, "workspace.renamed", "workspace", workspace.id,
                     {"old_name": old_name, "new_name": new_name})
        db.commit()
    return {"id": workspace.id, "name": workspace.name}


@app.get("/api/audit")
def list_audit_events(limit: int = 50, offset: int = 0, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)
    events = db.execute(select(AuditEvent, User.email).join(User, User.id == AuditEvent.actor_id)
                        .where(AuditEvent.workspace_id == user.workspace_id)
                        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
                        .limit(limit).offset(offset)).all()
    return [{"id": event.id, "actor_id": event.actor_id, "actor_email": email, "action": event.action,
             "entity_type": event.entity_type, "entity_id": event.entity_id,
             "changes": event.changes, "created_at": event.created_at} for event, email in events]


@app.get("/api/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    transactions = db.scalars(select(Transaction).where(Transaction.workspace_id == user.workspace_id)).all()
    payloads = [transaction_payload(db, item) for item in transactions]
    matched_count = sum(row["match_status"] == "matched" for row in payloads)
    review_count = sum(row["match_status"] in {"review", "unmatched", "partial"} for row in payloads)
    invoices = db.scalars(select(Invoice).where(Invoice.workspace_id == user.workspace_id)).all()
    outstanding = sum((inv.amount - paid_amount(db, inv.id) for inv in invoices), Decimal(0))
    return {"transactions_reviewed": len(transactions), "matched": matched_count,
            "needs_review": review_count, "match_rate": round(100 * matched_count / len(transactions), 1) if transactions else 0,
            "outstanding_amount": outstanding, "invoices": len(invoices), "transactions": payloads}


@app.get("/api/invoices", response_model=list[InvoiceRead])
def list_invoices(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    invoices = db.scalars(select(Invoice).where(Invoice.workspace_id == user.workspace_id).order_by(Invoice.due_date)).all()
    return [invoice_payload(db, invoice) for invoice in invoices]


@app.post("/api/invoices", response_model=InvoiceRead, status_code=status.HTTP_201_CREATED)
def create_invoice(payload: InvoiceCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    require_writer(user)
    invoice = Invoice(workspace_id=user.workspace_id, **payload.model_dump())
    db.add(invoice)
    try:
        db.flush()
        record_audit(db, user, "invoice.created", "invoice", invoice.id, {
            "number": invoice.number, "customer": invoice.customer,
            "amount": str(invoice.amount), "due_date": invoice.due_date.isoformat(),
        })
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="Invoice number already exists") from exc
    db.refresh(invoice)
    return invoice_payload(db, invoice)


@app.post("/api/invoices/extract")
async def extract_invoice(file: UploadFile = File(...), user: User = Depends(get_current_user)):
    """Extract invoice fields for review; this endpoint never saves the invoice."""
    require_writer(user)
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Invoice extraction is not configured. Add OPENAI_API_KEY to the API environment.")
    filename = (file.filename or "invoice").strip()
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    allowed = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
    if suffix not in allowed:
        raise HTTPException(status_code=415, detail="Upload a PDF, PNG, JPG, or WEBP invoice")
    content = await file.read(10 * 1024 * 1024 + 1)
    if not content or len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Invoice files must be smaller than 10 MB")
    media_type = allowed[suffix]
    if file.content_type and file.content_type not in {media_type, "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="The file type does not match its extension")
    if (suffix == "pdf" and not content.startswith(b"%PDF-")) or (suffix != "pdf" and not content.startswith((b"\x89PNG", b"\xff\xd8\xff", b"RIFF"))):
        raise HTTPException(status_code=400, detail="The uploaded file does not look like a supported document")

    encoded = base64.b64encode(content).decode("ascii")
    if suffix == "pdf":
        document = {"type": "input_file", "filename": filename, "file_data": f"data:{media_type};base64,{encoded}"}
    else:
        document = {"type": "input_image", "image_url": f"data:{media_type};base64,{encoded}", "detail": "high"}
    schema = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "invoice_number": {"type": ["string", "null"]},
            "customer": {"type": ["string", "null"]},
            "amount_kes": {"type": ["number", "null"]},
            "due_date": {"type": ["string", "null"], "description": "ISO date YYYY-MM-DD"},
        },
        "required": ["invoice_number", "customer", "amount_kes", "due_date"],
    }
    try:
        client = AsyncOpenAI(api_key=api_key, timeout=45, max_retries=1)
        response = await client.responses.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
            input=[{"role": "user", "content": [
                {"type": "input_text", "text": "Extract the invoice number, billed customer, total amount due in KES, and due date from this invoice. Return null for fields not clearly present. Do not guess or calculate missing values. If the amount is in another currency, return null."},
                document,
            ]}],
            text={"format": {"type": "json_schema", "name": "invoice_fields", "strict": True, "schema": schema}},
        )
        fields = json.loads(response.output_text)
    except Exception as exc:
        # Do not pass provider error details or document contents back to the browser.
        raise HTTPException(status_code=502, detail="Invoice extraction failed. Check the document and API configuration, then try again.") from exc
    return {"invoice_number": fields.get("invoice_number"), "customer": fields.get("customer"),
            "amount": fields.get("amount_kes"), "due_date": fields.get("due_date"),
            "needs_review": any(fields.get(key) is None for key in ("invoice_number", "customer", "amount_kes", "due_date"))}


@app.get("/api/transactions", response_model=list[TransactionRead])
def list_transactions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    transactions = db.scalars(select(Transaction).where(Transaction.workspace_id == user.workspace_id)
                              .order_by(Transaction.date.desc(), Transaction.id.desc())).all()
    return [transaction_payload(db, item) for item in transactions]


@app.get("/api/transactions/{transaction_id}/candidates")
def match_candidates(transaction_id: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    transaction = db.get(Transaction, transaction_id)
    if not transaction or transaction.workspace_id != user.workspace_id:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if transaction.amount <= 0:
        return []
    matched = Decimal(db.scalar(select(func.coalesce(func.sum(ReconciliationMatch.amount), 0)).where(
        ReconciliationMatch.transaction_id == transaction.id)) or 0)
    available_payment = transaction.amount - matched
    if available_payment <= 0:
        return []
    invoices = db.scalars(select(Invoice).where(Invoice.workspace_id == user.workspace_id)
                          .order_by(Invoice.due_date)).all()
    transaction_words = set((transaction.customer or transaction.description or "").casefold().replace("&", " ").split())
    transaction_text = f"{transaction.description} {transaction.reference or ''}".casefold()
    candidates = []
    for invoice in invoices:
        balance = invoice.amount - paid_amount(db, invoice.id)
        if balance <= 0:
            continue
        invoice_words = set(invoice.customer.casefold().replace("&", " ").split())
        name_score = round(40 * len(transaction_words & invoice_words) / max(len(invoice_words), 1))
        if transaction.customer and transaction.customer.casefold() in invoice.customer.casefold():
            name_score = 40
        reference_score = 25 if invoice.number.casefold() in transaction_text else 0
        difference = abs(balance - available_payment)
        if difference == 0:
            amount_score = 40
        elif available_payment <= balance:
            amount_score = 24
        else:
            amount_score = max(0, round(24 * (1 - difference / max(balance, available_payment))))
        date_gap = abs((invoice.due_date - transaction.date).days)
        date_score = max(0, 10 - date_gap // 14)
        confidence = min(99, name_score + reference_score + amount_score + date_score)
        candidates.append({
            "invoice_id": invoice.id, "invoice_number": invoice.number, "customer": invoice.customer,
            "amount": invoice.amount, "paid_amount": invoice.amount - balance, "balance": balance,
            "due_date": invoice.due_date, "suggested_amount": min(available_payment, balance),
            "confidence": confidence,
        })
    candidates.sort(key=lambda row: (-row["confidence"], abs(row["balance"] - available_payment), row["due_date"]))
    return candidates


@app.post("/api/transactions", response_model=TransactionRead, status_code=status.HTTP_201_CREATED)
def create_transaction(payload: TransactionCreate, db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    require_writer(user)
    transaction = Transaction(workspace_id=user.workspace_id, **payload.model_dump())
    db.add(transaction)
    try:
        db.flush()
        record_audit(db, user, "transaction.created", "transaction", transaction.id, {
            "description": transaction.description, "amount": str(transaction.amount),
            "account": transaction.account, "reference": transaction.reference,
        })
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="That statement reference has already been imported") from exc
    db.refresh(transaction)
    return transaction_payload(db, transaction)


@app.post("/api/transactions/import", status_code=status.HTTP_201_CREATED)
async def import_transactions(file: UploadFile = File(...), db: Session = Depends(get_db),
                              user: User = Depends(get_current_user)):
    require_writer(user)
    if not (file.filename or "").lower().endswith((".csv", ".txt")):
        raise HTTPException(status_code=415, detail="Upload a CSV or TXT statement")
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Statement must be UTF-8 encoded") from exc
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    except csv.Error as exc:
        raise HTTPException(status_code=400, detail="Could not read CSV columns") from exc
    aliases = {
        "date": ("date", "transaction date", "value date"),
        "description": ("description", "details", "narration", "transaction details"),
        "amount": ("amount", "value", "transaction amount"),
        "reference": ("reference", "ref", "transaction reference", "receipt"),
        "customer": ("customer", "payer", "sender", "name"),
        "account": ("account", "channel", "source"),
    }
    columns = {name.casefold().strip(): name for name in (reader.fieldnames or [])}
    def get(row, key):
        column = next((columns[item] for item in aliases[key] if item in columns), None)
        return row.get(column, "").strip() if column else ""
    if not any(name in columns for name in aliases["date"]) or not any(name in columns for name in aliases["amount"]):
        raise HTTPException(status_code=400, detail="CSV needs at least date and amount columns")
    added, skipped = 0, 0
    imported_ids = []
    seen_references = set()
    for line_number, row in enumerate(reader, start=2):
        try:
            parsed_date = None
            for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y"):
                try:
                    parsed_date = datetime.strptime(get(row, "date"), fmt).date()
                    break
                except ValueError:
                    continue
            if not parsed_date:
                raise ValueError("invalid date")
            raw_amount = get(row, "amount").replace(",", "").replace("KES", "").replace("KSh", "").strip()
            amount = Decimal(raw_amount)
            if not amount:
                raise ValueError("zero amount")
        except (ValueError, InvalidOperation) as exc:
            raise HTTPException(status_code=400, detail=f"Invalid date or amount on CSV row {line_number}") from exc
        reference = get(row, "reference") or None
        account = get(row, "account") or "Imported statement"
        if reference:
            reference_key = (account, reference)
            if reference_key in seen_references or db.scalar(select(Transaction.id).where(
                Transaction.reference == reference, Transaction.account == account,
                Transaction.workspace_id == user.workspace_id,
            )):
                skipped += 1
                continue
            seen_references.add(reference_key)
        transaction = Transaction(workspace_id=user.workspace_id, date=parsed_date, amount=amount,
                                  description=get(row, "description") or "Imported transaction",
                                  customer=get(row, "customer") or None,
                                  account=account, reference=reference)
        db.add(transaction)
        db.flush()
        imported_ids.append(transaction.id)
        added += 1
    if added:
        record_audit(db, user, "transactions.imported", "statement_import", None, {
            "filename": file.filename, "added": added, "skipped_duplicates": skipped,
            "transaction_ids": imported_ids,
        })
    db.commit()
    return {"added": added, "skipped_duplicates": skipped}


@app.post("/api/matches", status_code=status.HTTP_201_CREATED)
def confirm_match(payload: MatchCreate, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    require_writer(user)
    transaction = db.get(Transaction, payload.transaction_id)
    invoice = db.get(Invoice, payload.invoice_id)
    if (not transaction or not invoice or transaction.workspace_id != user.workspace_id
            or invoice.workspace_id != user.workspace_id):
        raise HTTPException(status_code=404, detail="Transaction or invoice not found")
    if transaction.amount <= 0:
        raise HTTPException(status_code=422, detail="Only incoming payments can be matched to invoices")
    matched = Decimal(db.scalar(select(func.coalesce(func.sum(ReconciliationMatch.amount), 0)).where(
        ReconciliationMatch.transaction_id == transaction.id)) or 0)
    invoice_paid = paid_amount(db, invoice.id)
    amount = payload.amount or min(transaction.amount - matched, invoice.amount - invoice_paid)
    if amount <= 0 or amount > transaction.amount - matched or amount > invoice.amount - invoice_paid:
        raise HTTPException(status_code=422, detail="Match amount exceeds the available transaction or invoice balance")
    match = ReconciliationMatch(transaction=transaction, invoice=invoice, amount=amount,
                                confidence=100, note=payload.note)
    db.add(match)
    db.flush()
    record_audit(db, user, "match.confirmed", "reconciliation_match", match.id, {
        "transaction_id": transaction.id, "invoice_id": invoice.id,
        "invoice_number": invoice.number, "amount": str(amount),
        "note": payload.note,
    })
    db.commit()
    return {"id": match.id, "transaction_id": transaction.id, "invoice_id": invoice.id,
            "amount": amount, "transaction_status": transaction_payload(db, transaction)["match_status"],
            "invoice_status": invoice_status(invoice, paid_amount(db, invoice.id))}
