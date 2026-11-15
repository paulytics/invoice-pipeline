"""Builds templates/invoice-pipeline-template.xlsx.

Upload it to Google Drive and open it with Google Sheets (File > Save as Google Sheets).
Tab names and headers must stay exactly as they are: the workflows match on them.
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

from sheet_columns import DESCRIPTIONS, INVOICES, LOG, NUMERIC, REVIEW_HUMAN_COLUMNS, REVIEW_QUEUE

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "templates" / "invoice-pipeline-template.xlsx"

HEAD = PatternFill("solid", fgColor="0F766E")
HUMAN = PatternFill("solid", fgColor="B45309")
WHITE_BOLD = Font(bold=True, color="FFFFFF")
WIDE = {"line_items_json": 40, "issues": 60, "extraction_notes": 40, "file_link": 30, "supplier_name": 28,
        "resolution": 40, "reviewer_notes": 28, "dedupe_key": 30, "customer_name": 24, "file_name": 28}

wb = Workbook()
wb.remove(wb.active)


def tab(name, cols, human=frozenset()):
    ws = wb.create_sheet(name)
    ws.append(cols)
    for i, c in enumerate(cols, start=1):
        cell = ws.cell(row=1, column=i)
        cell.fill = HUMAN if c in human else HEAD
        cell.font = WHITE_BOLD
        cell.alignment = Alignment(vertical="center")
        if c in DESCRIPTIONS:
            cell.comment = Comment(DESCRIPTIONS[c], "pipeline")
        ws.column_dimensions[cell.column_letter].width = WIDE.get(c, 16 if c not in NUMERIC else 13)
    ws.freeze_panes = "A2"
    ws.row_dimensions[1].height = 22
    return ws


inv = tab("Invoices", INVOICES)
rev = tab("Review Queue", REVIEW_QUEUE, human={"decision", "reviewer_notes"})
dv = DataValidation(type="list", formula1='"APPROVE,REJECT"', allow_blank=True,
                    promptTitle="Decision", prompt="Correct the row first, then choose APPROVE or REJECT")
rev.add_data_validation(dv)
dv.add("A2:A2000")
# Highlight rows waiting for a decision
rev.conditional_formatting.add("A2:AD2000", FormulaRule(
    formula=['AND($C2<>"",$AC2="")'], fill=PatternFill("solid", fgColor="FEF3C7")))

log = tab("Log", LOG)
log.conditional_formatting.add("B2:B5000", FormulaRule(formula=['$B2="auto_approved"'], fill=PatternFill("solid", fgColor="DCFCE7")))
log.conditional_formatting.add("B2:B5000", FormulaRule(formula=['$B2="needs_review"'], fill=PatternFill("solid", fgColor="FEF3C7")))
log.conditional_formatting.add("B2:B5000", FormulaRule(formula=['$B2="duplicate"'], fill=PatternFill("solid", fgColor="E0E7FF")))
log.conditional_formatting.add("B2:B5000", FormulaRule(formula=['$B2="rejected"'], fill=PatternFill("solid", fgColor="FEE2E2")))

# Dashboard: plain formulas that work in Google Sheets and Excel
dash = wb.create_sheet("Dashboard")
dash.column_dimensions["A"].width = 34
dash.column_dimensions["B"].width = 18
dash["A1"] = "Invoice pipeline dashboard"
dash["A1"].font = Font(bold=True, size=16, color="0F766E")
rows = [
    ("Documents processed", '=COUNTA(\'Log\'!A2:A5000)'),
    ("Auto-approved", '=COUNTIF(\'Log\'!B2:B5000,"auto_approved")'),
    ("Sent to review", '=COUNTIF(\'Log\'!B2:B5000,"needs_review")'),
    ("Duplicates caught", '=COUNTIF(\'Log\'!B2:B5000,"duplicate")'),
    ("Rejected", '=COUNTIF(\'Log\'!B2:B5000,"rejected")'),
    ("Auto-approval rate", '=IFERROR(B4/B3,0)'),
    ("Waiting for review now", '=COUNTIFS(\'Review Queue\'!C2:C5000,"<>",\'Review Queue\'!AC2:AC5000,"")'),
    ("Average seconds per document", '=IFERROR(AVERAGE(\'Log\'!J2:J5000)/1000,0)'),
    ("Minutes of data entry saved (4 min/doc)", '=B4*4+B5*2'),
    ("Invoices recorded", '=COUNTA(\'Invoices\'!A2:A5000)'),
]
for i, (label, formula) in enumerate(rows, start=3):
    dash.cell(row=i, column=1, value=label).font = Font(color="374151")
    c = dash.cell(row=i, column=2, value=formula)
    c.font = Font(bold=True, size=12)
dash["B8"].number_format = "0%"
dash["B10"].number_format = "0.0"

guide = wb.create_sheet("How to use")
guide.column_dimensions["A"].width = 110
text = [
    ("How this sheet works", True),
    ("Invoices: every document that passed all checks (source = auto) or that a person approved (source = reviewed).", False),
    ("Review Queue: documents that need a human. Fix any wrong values in the row, then set 'decision' to APPROVE or REJECT.", False),
    ("   Within 5 minutes the Review Approvals workflow posts approved rows to Invoices and fills in resolved_at.", False),
    ("Log: one line per document processed, with its status, score and processing time.", False),
    ("Dashboard: live totals calculated from the other tabs.", False),
    ("", False),
    ("Do not rename the tabs or the header row. Orange headers are for people to fill in; teal headers are written by the workflow.", True),
]
for i, (t, bold) in enumerate(text, start=1):
    guide.cell(row=i, column=1, value=t).font = Font(bold=bold, size=12 if bold else 11)

wb.move_sheet("Dashboard", offset=-3)
OUT.parent.mkdir(exist_ok=True)
wb.save(OUT)
print("saved", OUT, [ws.title for ws in wb.worksheets])
