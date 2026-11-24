from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select

from database import SessionLocal
from models import Invoice, Transaction, Workspace


def seed():
    db = SessionLocal()
    try:
        if db.scalar(select(func.count()).select_from(Invoice)):
            print("Database already contains invoices; leaving existing data untouched.")
            return
        today = date.today()
        workspace = db.get(Workspace, 1)
        if not workspace:
            workspace = Workspace(name="Kifaru Studio")
            db.add(workspace)
            db.flush()
        invoices = [
            Invoice(workspace_id=workspace.id, number="INV-1042", customer="Wanjiku Designs", amount=Decimal("48000"), due_date=today + timedelta(days=8)),
            Invoice(workspace_id=workspace.id, number="INV-1051", customer="Kamau & Sons", amount=Decimal("65000"), due_date=today + timedelta(days=14)),
            Invoice(workspace_id=workspace.id, number="INV-1038", customer="Greenleaf Cafe", amount=Decimal("18750"), due_date=today + timedelta(days=2)),
            Invoice(workspace_id=workspace.id, number="INV-1031", customer="Kibo Logistics", amount=Decimal("76200"), due_date=today - timedelta(days=3)),
        ]
        transactions = [
            Transaction(workspace_id=workspace.id, date=today, description="M-Pesa · Safaricom", customer="Wanjiku Designs", account="M-Pesa", reference="QK72L9M", amount=Decimal("48000")),
            Transaction(workspace_id=workspace.id, date=today, description="Bank transfer · Equity", customer="Kamau & Sons", account="Equity Bank", reference="8820391", amount=Decimal("32500")),
            Transaction(workspace_id=workspace.id, date=today - timedelta(days=1), description="M-Pesa · Safaricom", customer="Greenleaf Cafe", account="M-Pesa", reference="QK69P1B", amount=Decimal("18750")),
            Transaction(workspace_id=workspace.id, date=today - timedelta(days=1), description="Cash deposit · Co-op", customer=None, account="Co-op Bank", reference="3028", amount=Decimal("12000")),
            Transaction(workspace_id=workspace.id, date=today - timedelta(days=2), description="Bank transfer · Equity", customer="Kibo Logistics", account="Equity Bank", reference="8812710", amount=Decimal("76200")),
            Transaction(workspace_id=workspace.id, date=today - timedelta(days=2), description="Transaction fee · M-Pesa", customer=None, account="M-Pesa", reference="QK60X3C", amount=Decimal("-185")),
        ]
        db.add_all(invoices + transactions)
        db.commit()
        print("Added four sample invoices and six sample transactions.")
    finally:
        db.close()


if __name__ == "__main__":
    seed()
