"""Single source of truth for the Google Sheet layout.

Used by build_workflows.py (column mappings) and build_template.py (the .xlsx template),
so the workflows and the sheet can never drift apart.
"""

NUMERIC = {
    "subtotal", "discount", "shipping", "tax_amount", "total", "amount_paid",
    "line_item_count", "score", "confidence", "duration_ms",
}

INVOICES = [
    "processed_at", "source", "document_type", "supplier_name", "supplier_tax_id", "customer_name",
    "invoice_number", "document_date", "due_date", "currency", "subtotal", "discount", "shipping",
    "tax_amount", "total", "amount_paid", "payment_method", "line_item_count", "line_items_json",
    "score", "confidence", "file_name", "file_link", "file_id", "dedupe_key",
]

REVIEW_QUEUE = [
    "decision", "reviewer_notes", "processed_at", "issues", "score", "confidence", "document_type",
    "supplier_name", "supplier_tax_id", "customer_name", "invoice_number", "document_date", "due_date",
    "currency", "subtotal", "discount", "shipping", "tax_amount", "total", "amount_paid",
    "payment_method", "line_item_count", "line_items_json", "extraction_notes", "file_name",
    "file_link", "file_id", "dedupe_key", "resolved_at", "resolution",
]
# Columns a person fills in; the pipeline never writes them on intake.
REVIEW_HUMAN_COLUMNS = {"decision", "reviewer_notes", "resolved_at", "resolution"}

LOG = [
    "processed_at", "status", "score", "file_name", "file_id", "supplier_name", "currency", "total",
    "issues", "duration_ms", "model", "execution_id",
]

DESCRIPTIONS = {
    "decision": "Type APPROVE or REJECT once the row is correct",
    "reviewer_notes": "Optional notes for your records",
    "issues": "Why this document needs a human",
    "score": "0-100 quality score from the validation rules",
    "confidence": "Model's own confidence (0-1)",
    "line_items_json": "Line items as JSON (edit carefully)",
    "dedupe_key": "Used to detect duplicates; do not edit",
    "resolved_at": "Filled in by the workflow",
    "resolution": "Filled in by the workflow",
    "source": "auto = no human needed; reviewed = approved in Review Queue",
}
