import json
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncConnection

from ..database import connection, row_dict, rows, statement
from ..schemas_finance import (
    InvoiceCreate,
    InvoiceStatusUpdate,
    InvoiceUpdate,
    PaymentCreate,
    RecurringExpenseCreate,
    TransactionCreate,
    TransactionUpdate,
)
from ..security import Principal, require_scope
from .firm_common import as_naive_utc, audit_event, invoice_totals, new_id, round_money, utcnow_naive

router = APIRouter(prefix="/api/finance", tags=["finance"])
finance_read = require_scope("finance:read")
finance_write = require_scope("finance:write")
PAYMENT_EPSILON = Decimal("0.005")


@router.get("/transactions")
async def list_transactions(
    type: str | None = None,
    category: str | None = None,
    start_date: datetime | None = None,
    end_date: datetime | None = None,
    limit: int = Query(50, ge=1, le=100),
    cursor: str | None = None,
    _: Principal = Depends(finance_read),
    db: AsyncConnection = Depends(connection),
) -> dict:
    clauses = []
    values: dict[str, object] = {"limit": limit}
    start_date = as_naive_utc(start_date) if start_date else None
    end_date = as_naive_utc(end_date) if end_date else None
    for key, value, column in (
        ("type", type, "t.type"),
        ("category", category, "t.category"),
        ("start_date", start_date, "t.date >="),
        ("end_date", end_date, "t.date <="),
    ):
        if value is not None:
            clauses.append(f"{column} :{key}" if column.endswith((">=", "<=")) else f"{column} = :{key}")
            values[key] = value
    if cursor:
        clauses.append("t.date < (SELECT date FROM transactions WHERE id = :cursor)")
        values["cursor"] = cursor
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    result = await db.execute(
        statement(
            'SELECT t.*, p.name AS "projectName", c.name AS "clientName" FROM transactions t '
            'LEFT JOIN projects p ON p.id = t."projectId" LEFT JOIN clients c ON c.id = t."clientId" '
            f"{where} ORDER BY t.date DESC LIMIT :limit"
        ),
        values,
    )
    return {"data": rows(result)}


@router.post("/transactions", status_code=status.HTTP_201_CREATED)
async def create_transaction(
    payload: TransactionCreate,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    values = payload.model_dump()
    values["date"] = as_naive_utc(payload.date)
    values.update({"id": new_id(), "created_at": utcnow_naive()})
    result = await db.execute(
        statement(
            'INSERT INTO transactions (id, type, amount, currency, category, description, "projectId", "clientId", '
            'date, "createdAt", "updatedAt") VALUES (:id, :type, :amount, :currency, :category, :description, '
            ":project_id, :client_id, :date, :created_at, :created_at) RETURNING *"
        ),
        values,
    )
    record = result.mappings().one()
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="CREATE",
        action="finance.createTransaction",
        target_type="Transaction",
        target_id=record["id"],
        target_label=record["description"],
        input_data=values,
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.patch("/transactions/{transaction_id}")
async def update_transaction(
    transaction_id: str,
    payload: TransactionUpdate,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    supplied = payload.model_fields_set
    if not supplied:
        raise HTTPException(status_code=422, detail="No fields were supplied")
    columns = {"project_id": '"projectId"', "client_id": '"clientId"'}
    values = payload.model_dump(include=supplied)
    if values.get("date") is not None:
        values["date"] = as_naive_utc(values["date"])
    values.update({"id": transaction_id, "updated_at": utcnow_naive()})
    assignments = [f"{columns.get(key, key)} = :{key}" for key in supplied]
    assignments.append('"updatedAt" = :updated_at')
    result = await db.execute(
        statement(f"UPDATE transactions SET {', '.join(assignments)} WHERE id = :id RETURNING *"), values
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Transaction not found")
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="UPDATE",
        action="finance.updateTransaction",
        target_type="Transaction",
        target_id=transaction_id,
        input_data=values,
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.delete("/transactions/{transaction_id}")
async def delete_transaction(
    transaction_id: str, principal: Principal = Depends(finance_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement("DELETE FROM transactions WHERE id = :id RETURNING id, description"), {"id": transaction_id}
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Transaction not found")
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="DELETE",
        action="finance.deleteTransaction",
        target_type="Transaction",
        target_id=transaction_id,
        target_label=record["description"],
    )
    await db.commit()
    return {"success": True}


@router.get("/recurring-expenses")
async def list_recurring_expenses(
    _: Principal = Depends(finance_read), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement('SELECT * FROM recurring_expenses WHERE active = true ORDER BY "nextDueDate", name')
    )
    return {"data": rows(result)}


@router.post("/recurring-expenses", status_code=status.HTTP_201_CREATED)
async def create_recurring_expense(
    payload: RecurringExpenseCreate,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    values = payload.model_dump()
    values.update({"id": new_id(), "next_due_date": as_naive_utc(payload.next_due_date)})
    result = await db.execute(
        statement(
            'INSERT INTO recurring_expenses (id, name, amount, currency, category, interval, "nextDueDate", '
            '"vendorName", active, "createdAt", "updatedAt") VALUES (:id, :name, :amount, :currency, '
            'CAST(:category AS "ExpenseCategory"), :interval, :next_due_date, :vendor_name, true, now(), now()) '
            "RETURNING *"
        ),
        values,
    )
    record = result.mappings().one()
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="CREATE",
        action="finance.createRecurringExpense",
        target_type="RecurringExpense",
        target_id=record["id"],
        target_label=record["name"],
        input_data=payload.model_dump(mode="json"),
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.delete("/recurring-expenses/{expense_id}")
async def delete_recurring_expense(
    expense_id: str,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    result = await db.execute(
        statement("DELETE FROM recurring_expenses WHERE id = :id RETURNING id, name"), {"id": expense_id}
    )
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Recurring expense not found")
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="DELETE",
        action="finance.deleteRecurringExpense",
        target_type="RecurringExpense",
        target_id=expense_id,
        target_label=record["name"],
    )
    await db.commit()
    return {"success": True}


@router.post("/recurring-expenses/post-due")
async def post_due_recurring_expenses(
    principal: Principal = Depends(finance_write), db: AsyncConnection = Depends(connection)
) -> dict:
    due_result = await db.execute(
        statement('SELECT * FROM recurring_expenses WHERE active = true AND "nextDueDate" <= now() FOR UPDATE')
    )
    due = rows(due_result)
    now = utcnow_naive()
    for expense in due:
        await db.execute(
            statement(
                'INSERT INTO transactions (id, type, amount, currency, category, description, date, "createdAt", '
                "\"updatedAt\") VALUES (:id, 'EXPENSE', :amount, :currency, :category, :description, :date, :date, :date)"
            ),
            {
                "id": new_id(),
                "amount": expense["amount"],
                "currency": expense["currency"],
                "category": expense["category"],
                "description": expense["name"],
                "date": now,
            },
        )
        await db.execute(
            statement(
                'UPDATE recurring_expenses SET "nextDueDate" = "nextDueDate" + CASE interval '
                "WHEN 'quarterly' THEN interval '3 months' WHEN 'yearly' THEN interval '1 year' "
                "ELSE interval '1 month' END, \"updatedAt\" = now() WHERE id = :id"
            ),
            {"id": expense["id"]},
        )
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="CREATE",
        action="finance.postDueRecurringExpenses",
        metadata={"posted": len(due)},
    )
    await db.commit()
    return {"posted": len(due)}


INVOICE_SELECT = """SELECT i.*, c.name AS "clientName", c.logo AS "clientLogo", p.name AS "projectName",
COALESCE(pay."amountPaid", 0) AS "amountPaid", (i.total - COALESCE(pay."amountPaid", 0)) AS balance
FROM invoices i JOIN clients c ON c.id = i."clientId" LEFT JOIN projects p ON p.id = i."projectId"
LEFT JOIN (SELECT "invoiceId", SUM(amount) AS "amountPaid" FROM payments GROUP BY "invoiceId") pay ON pay."invoiceId" = i.id"""


@router.get("/invoices")
async def list_invoices(
    limit: int = Query(100, ge=1, le=1000),
    _: Principal = Depends(finance_read),
    db: AsyncConnection = Depends(connection),
) -> dict:
    result = await db.execute(statement(f'{INVOICE_SELECT} ORDER BY i."createdAt" DESC LIMIT :limit'), {"limit": limit})
    return {"data": rows(result)}


@router.get("/invoices/{invoice_id}")
async def get_invoice(
    invoice_id: str, _: Principal = Depends(finance_read), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(statement(f"{INVOICE_SELECT} WHERE i.id = :id"), {"id": invoice_id})
    record = result.mappings().first()
    if not record:
        raise HTTPException(status_code=404, detail="Invoice not found")
    payment_rows = await db.execute(
        statement('SELECT * FROM payments WHERE "invoiceId" = :id ORDER BY "paidAt" DESC'), {"id": invoice_id}
    )
    data = row_dict(record)
    data["payments"] = rows(payment_rows)
    return {"data": data}


@router.post("/invoices", status_code=status.HTTP_201_CREATED)
async def create_invoice(
    payload: InvoiceCreate, principal: Principal = Depends(finance_write), db: AsyncConnection = Depends(connection)
) -> dict:
    items, subtotal, total = invoice_totals(payload.items, payload.tax)
    year = utcnow_naive().year
    count = await db.execute(
        statement('SELECT COUNT(*) FROM invoices WHERE "invoiceNumber" LIKE :prefix'), {"prefix": f"INV-{year}-%"}
    )
    invoice_number = f"INV-{year}-{int(count.scalar_one()) + 1:03d}"
    values = {
        "id": new_id(),
        "invoice_number": invoice_number,
        "client_id": payload.client_id,
        "project_id": payload.project_id,
        "items": json.dumps(items),
        "subtotal": subtotal,
        "tax": round_money(payload.tax),
        "total": total,
        "currency": payload.currency,
        "due_date": as_naive_utc(payload.due_date),
        "notes": payload.notes,
        "now": utcnow_naive(),
    }
    result = await db.execute(
        statement(
            'INSERT INTO invoices (id, "invoiceNumber", "clientId", "projectId", items, subtotal, tax, total, '
            'currency, status, "dueDate", notes, "createdAt", "updatedAt") VALUES (:id, :invoice_number, '
            ":client_id, :project_id, CAST(:items AS jsonb), :subtotal, :tax, :total, :currency, 'DRAFT', "
            ":due_date, :notes, :now, :now) RETURNING *"
        ),
        values,
    )
    record = result.mappings().one()
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="CREATE",
        action="finance.createInvoice",
        target_type="Invoice",
        target_id=record["id"],
        target_label=invoice_number,
        input_data=payload.model_dump(mode="json"),
        metadata={"currency": payload.currency, "total": float(total)},
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.patch("/invoices/{invoice_id}")
async def update_invoice(
    invoice_id: str,
    payload: InvoiceUpdate,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    current_result = await db.execute(
        statement("SELECT status FROM invoices WHERE id = :id FOR UPDATE"), {"id": invoice_id}
    )
    current = current_result.mappings().first()
    if not current:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if current["status"] not in {"DRAFT", "SENT"}:
        raise HTTPException(status_code=400, detail=f"A {str(current['status']).lower()} invoice cannot be edited")
    items, subtotal, total = invoice_totals(payload.items, payload.tax)
    sent_at = utcnow_naive() if payload.status == "SENT" else None if payload.status == "DRAFT" else "KEEP"
    result = await db.execute(
        statement(
            "UPDATE invoices SET items = CAST(:items AS jsonb), subtotal = :subtotal, tax = :tax, total = :total, "
            '"dueDate" = COALESCE(:due_date, "dueDate"), notes = :notes, '
            'status = COALESCE(CAST(:status AS "InvoiceStatus"), status), '
            '"sentAt" = CASE WHEN :sent_at_keep THEN "sentAt" ELSE :sent_at END, "updatedAt" = now() '
            "WHERE id = :id RETURNING *"
        ),
        {
            "id": invoice_id,
            "items": json.dumps(items),
            "subtotal": subtotal,
            "tax": round_money(payload.tax),
            "total": total,
            "due_date": as_naive_utc(payload.due_date) if payload.due_date else None,
            "notes": payload.notes.strip() if payload.notes else None,
            "status": payload.status,
            "sent_at_keep": sent_at == "KEEP",
            "sent_at": None if sent_at == "KEEP" else sent_at,
        },
    )
    record = result.mappings().one()
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="UPDATE",
        action="finance.updateInvoice",
        target_type="Invoice",
        target_id=invoice_id,
        target_label=record["invoiceNumber"],
        input_data=payload.model_dump(mode="json"),
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.patch("/invoices/{invoice_id}/status")
async def update_invoice_status(
    invoice_id: str,
    payload: InvoiceStatusUpdate,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    result = await db.execute(statement("SELECT status FROM invoices WHERE id = :id FOR UPDATE"), {"id": invoice_id})
    current = result.scalar_one_or_none()
    if current is None:
        raise HTTPException(status_code=404, detail="Invoice not found")
    allowed = {
        "DRAFT": {"SENT", "CANCELLED"},
        "SENT": {"PAID", "OVERDUE", "CANCELLED", "DRAFT"},
        "OVERDUE": {"PAID", "CANCELLED", "SENT"},
        "PAID": {"CANCELLED"},
        "CANCELLED": {"DRAFT"},
    }
    if current != payload.status and payload.status not in allowed.get(current, set()):
        raise HTTPException(status_code=400, detail=f"Cannot change an invoice from {current} to {payload.status}")
    updated = await db.execute(
        statement(
            'UPDATE invoices SET status = CAST(:status AS "InvoiceStatus"), "paidAt" = CASE '
            "WHEN CAST(:status AS \"InvoiceStatus\") = 'PAID' THEN now() "
            'WHEN CAST(:status AS "InvoiceStatus") = \'DRAFT\' THEN NULL ELSE "paidAt" END, '
            '"sentAt" = CASE WHEN CAST(:status AS "InvoiceStatus") = \'SENT\' THEN now() '
            'WHEN CAST(:status AS "InvoiceStatus") = \'DRAFT\' THEN NULL ELSE "sentAt" END, '
            '"updatedAt" = now() WHERE id = :id RETURNING *'
        ),
        {"id": invoice_id, "status": payload.status},
    )
    record = updated.mappings().one()
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="UPDATE",
        action="finance.updateInvoiceStatus",
        target_type="Invoice",
        target_id=invoice_id,
        changes={"status": {"before": current, "after": payload.status}},
    )
    await db.commit()
    return {"data": row_dict(record)}


@router.post("/invoices/{invoice_id}/payments", status_code=status.HTTP_201_CREATED)
async def add_payment(
    invoice_id: str,
    payload: PaymentCreate,
    principal: Principal = Depends(finance_write),
    db: AsyncConnection = Depends(connection),
) -> dict:
    invoice_result = await db.execute(
        statement("SELECT id, status, total, currency FROM invoices WHERE id = :id FOR UPDATE"), {"id": invoice_id}
    )
    invoice = invoice_result.mappings().first()
    if not invoice:
        raise HTTPException(status_code=404, detail="Invoice not found")
    if invoice["status"] == "DRAFT":
        raise HTTPException(status_code=400, detail="Send the invoice before recording a payment")
    if invoice["status"] in {"PAID", "CANCELLED"}:
        raise HTTPException(
            status_code=400, detail=f"Cannot record a payment against a {str(invoice['status']).lower()} invoice"
        )
    paid_result = await db.execute(
        statement('SELECT COALESCE(SUM(amount), 0) FROM payments WHERE "invoiceId" = :id'), {"id": invoice_id}
    )
    already_paid = round_money(paid_result.scalar_one())
    total = round_money(invoice["total"])
    new_paid = round_money(already_paid + payload.amount)
    if new_paid > total + PAYMENT_EPSILON:
        raise HTTPException(
            status_code=400,
            detail=f"Payment exceeds the outstanding balance of {round_money(total - already_paid):.2f}",
        )
    payment_id = new_id()
    payment = await db.execute(
        statement(
            'INSERT INTO payments (id, "invoiceId", amount, currency, method, note, "paidAt", "createdAt") VALUES (:id, :invoice_id, :amount, :currency, :method, :note, COALESCE(:paid_at, now()), now()) RETURNING *'
        ),
        {
            "id": payment_id,
            "invoice_id": invoice_id,
            "amount": round_money(payload.amount),
            "currency": invoice["currency"],
            "method": payload.method.strip() if payload.method else None,
            "note": payload.note.strip() if payload.note else None,
            "paid_at": as_naive_utc(payload.paid_at) if payload.paid_at else None,
        },
    )
    fully_paid = new_paid >= total - PAYMENT_EPSILON
    if fully_paid:
        await db.execute(
            statement('UPDATE invoices SET status = \'PAID\', "paidAt" = now(), "updatedAt" = now() WHERE id = :id'),
            {"id": invoice_id},
        )
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="CREATE",
        action="finance.addPayment",
        target_type="Payment",
        target_id=payment_id,
        metadata={"invoiceId": invoice_id, "currency": invoice["currency"], "amount": float(payload.amount)},
    )
    await db.commit()
    return {
        "data": row_dict(payment.mappings().one()),
        "amountPaid": float(new_paid),
        "balance": float(round_money(total - new_paid)),
        "status": "PAID" if fully_paid else invoice["status"],
    }


@router.delete("/payments/{payment_id}")
async def delete_payment(
    payment_id: str, principal: Principal = Depends(finance_write), db: AsyncConnection = Depends(connection)
) -> dict:
    deleted = await db.execute(
        statement('DELETE FROM payments WHERE id = :id RETURNING id, "invoiceId"'), {"id": payment_id}
    )
    payment = deleted.mappings().first()
    if not payment:
        raise HTTPException(status_code=404, detail="Payment not found")
    invoice_result = await db.execute(
        statement("SELECT total, status FROM invoices WHERE id = :id FOR UPDATE"), {"id": payment["invoiceId"]}
    )
    invoice = invoice_result.mappings().first()
    paid_result = await db.execute(
        statement('SELECT COALESCE(SUM(amount), 0) FROM payments WHERE "invoiceId" = :id'), {"id": payment["invoiceId"]}
    )
    amount_paid = round_money(paid_result.scalar_one())
    balance = Decimal("0")
    if invoice:
        total = round_money(invoice["total"])
        balance = round_money(total - amount_paid)
        if invoice["status"] == "PAID" and amount_paid < total - PAYMENT_EPSILON:
            await db.execute(
                statement('UPDATE invoices SET status = \'SENT\', "paidAt" = NULL, "updatedAt" = now() WHERE id = :id'),
                {"id": payment["invoiceId"]},
            )
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="DELETE",
        action="finance.deletePayment",
        target_type="Payment",
        target_id=payment_id,
    )
    await db.commit()
    return {"invoiceId": payment["invoiceId"], "amountPaid": float(amount_paid), "balance": float(balance)}


@router.post("/invoices/mark-overdue")
async def mark_overdue(
    principal: Principal = Depends(finance_write), db: AsyncConnection = Depends(connection)
) -> dict:
    result = await db.execute(
        statement(
            "UPDATE invoices SET status = 'OVERDUE', \"updatedAt\" = now() WHERE status = 'SENT' AND \"dueDate\" < now() RETURNING id"
        )
    )
    count = len(result.all())
    await audit_event(
        db,
        principal,
        category="FINANCE",
        operation="UPDATE",
        action="finance.markOverdueInvoices",
        metadata={"count": count},
    )
    await db.commit()
    return {"count": count}


@router.get("/summary")
async def financial_summary(_: Principal = Depends(finance_read), db: AsyncConnection = Depends(connection)) -> dict:
    result = await db.execute(
        statement(
            """WITH tx AS (
              SELECT currency::text currency,
                SUM(amount) FILTER (WHERE type = 'INCOME' AND date >= date_trunc('month', now()) AND date <= now()) monthly_income,
                SUM(amount) FILTER (WHERE type = 'EXPENSE' AND date >= date_trunc('month', now()) AND date <= now()) monthly_expense,
                SUM(amount) FILTER (WHERE type = 'INCOME' AND date >= date_trunc('year', now()) AND date <= now()) yearly_income,
                SUM(amount) FILTER (WHERE type = 'EXPENSE' AND date >= date_trunc('year', now()) AND date <= now()) yearly_expense
              FROM transactions GROUP BY currency
            ), inv AS (
              SELECT currency::text currency,
                SUM(total) FILTER (WHERE status = 'PAID') total_paid,
                COUNT(*) FILTER (WHERE status = 'PAID') paid_count,
                SUM(total) FILTER (WHERE status IN ('SENT','OVERDUE')) total_outstanding,
                COUNT(*) FILTER (WHERE status IN ('SENT','OVERDUE')) outstanding_count
              FROM invoices GROUP BY currency
            ), currencies AS (SELECT currency FROM tx UNION SELECT currency FROM inv)
            SELECT c.currency, COALESCE(t.monthly_income,0) monthly_income, COALESCE(t.monthly_expense,0) monthly_expense,
              COALESCE(t.yearly_income,0) yearly_income, COALESCE(t.yearly_expense,0) yearly_expense,
              COALESCE(i.total_paid,0) total_paid, COALESCE(i.paid_count,0) paid_count,
              COALESCE(i.total_outstanding,0) total_outstanding, COALESCE(i.outstanding_count,0) outstanding_count
            FROM currencies c LEFT JOIN tx t USING(currency) LEFT JOIN inv i USING(currency) ORDER BY c.currency"""
        )
    )
    data = []
    for row in result.mappings():
        item = row_dict(row)
        item["monthly_profit"] = round(float(item["monthly_income"]) - float(item["monthly_expense"]), 2)
        item["yearly_profit"] = round(float(item["yearly_income"]) - float(item["yearly_expense"]), 2)
        data.append(item)
    return {"byCurrency": data}
