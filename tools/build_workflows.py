"""Builds the importable n8n workflow JSON files from the source in src/.

Run:  python3 tools/build_workflows.py
Edit the JavaScript in src/ (it is unit-tested), never the generated JSON.
"""
import json
import re
import uuid
from pathlib import Path

from sheet_columns import INVOICES, LOG, NUMERIC, REVIEW_HUMAN_COLUMNS, REVIEW_QUEUE

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "workflows"
NS = uuid.UUID("6b1f3c2e-9a0d-4c55-8e44-2f6a1d7c9b10")  # stable node IDs between builds


def lib(name):
    """Library file without its Node.js export footer."""
    text = (SRC / name).read_text()
    return text.split("if (typeof module !== 'undefined')")[0].rstrip() + "\n"


def main_js(name):
    return (SRC / "nodes" / name).read_text()


PROMPT = (ROOT / "prompts" / "extraction-prompt.md").read_text().strip()


def code(*libs, main, header):
    parts = [f"// {header}\n// Generated from src/ by tools/build_workflows.py. Edit the source, not this node.\n"]
    for l in libs:
        parts.append(f"// ---- {l} ----\n" + lib(l))
    parts.append("// ---- node logic ----\n" + main_js(main))
    return "\n".join(parts)


# ---------------------------------------------------------------- node helpers
class WF:
    def __init__(self, name):
        self.name = name
        self.nodes = []
        self.conns = {}

    def add(self, name, ntype, version, pos, params, **extra):
        node = {
            "parameters": params,
            "id": str(uuid.uuid5(NS, f"{self.name}/{name}")),
            "name": name,
            "type": ntype,
            "typeVersion": version,
            "position": list(pos),
        }
        node.update(extra)
        self.nodes.append(node)
        return name

    def link(self, src, dst, out=0, inp=0):
        main = self.conns.setdefault(src, {}).setdefault("main", [])
        while len(main) <= out:
            main.append([])
        main[out].append({"node": dst, "type": "main", "index": inp})

    def sticky(self, name, pos, content, width=400, height=300, color=None):
        p = {"content": content, "height": height, "width": width}
        if color:
            p["color"] = color
        self.add(name, "n8n-nodes-base.stickyNote", 1, pos, p)

    def dump(self, filename, settings=None):
        wf = {
            "name": self.name,
            "nodes": self.nodes,
            "connections": self.conns,
            "pinData": {},
            "settings": {"executionOrder": "v1", "saveManualExecutions": True, **(settings or {})},
            "meta": {"templateCredsSetupCompleted": False},
            "tags": [],
        }
        OUT.mkdir(exist_ok=True)
        (OUT / filename).write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")
        return wf


CFG = "$('Settings').first().json.cfg"


def rl_id(value):
    return {"__rl": True, "value": value, "mode": "id"}


def rl_sheet(tab):
    return {"__rl": True, "value": tab, "mode": "name"}


def sheet_doc():
    return rl_id(f"={{{{ {CFG}.SPREADSHEET_ID }}}}")


def schema(cols):
    return [{
        "id": c, "displayName": c, "required": False, "defaultMatch": False, "display": True,
        "type": "number" if c in NUMERIC else "string", "canBeUsedToMatch": True,
    } for c in cols]


def append_params(tab, cols, value_expr):
    return {
        "operation": "append",
        "documentId": sheet_doc(),
        "sheetName": rl_sheet(tab),
        "columns": {
            "mappingMode": "defineBelow",
            "value": {c: value_expr(c) for c in cols},
            "matchingColumns": [],
            "schema": schema(cols),
            "attemptToConvertTypes": False,
            "convertFieldsToString": False,
        },
        # RAW stops spreadsheet formula injection from text inside documents.
        "options": {"cellFormat": "RAW"},
    }


def read_params(tab):
    return {"operation": "read", "documentId": sheet_doc(), "sheetName": rl_sheet(tab), "options": {}}


def move_params(file_expr, folder_key):
    return {
        "operation": "move",
        "fileId": rl_id(file_expr),
        "driveId": {"__rl": True, "value": "My Drive", "mode": "list", "cachedResultName": "My Drive",
                    "cachedResultUrl": "https://drive.google.com/drive/my-drive"},
        "folderId": rl_id(f"={{{{ {CFG}.FOLDERS.{folder_key} }}}}"),
    }


def telegram_params(chat_expr=f"={{{{ {CFG}.TELEGRAM_CHAT_ID }}}}"):
    return {
        "chatId": chat_expr,
        "text": "={{ $json.alert_text }}",
        "additionalFields": {"appendAttribution": False, "parse_mode": "HTML", "disable_web_page_preview": True},
    }


def condition(left, op_type, operation, right="", single=False):
    op = {"type": op_type, "operation": operation}
    if single:
        op["singleValue"] = True
    return {"id": str(uuid.uuid5(NS, left + operation + str(right))), "leftValue": left, "rightValue": right, "operator": op}


def conditions(*conds):
    return {
        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
        "conditions": list(conds),
        "combinator": "and",
    }


def switch_params(field_expr, outputs):
    return {
        "rules": {"values": [
            {"conditions": conditions(condition(field_expr, "string", "equals", value)),
             "renameOutput": True, "outputKey": label}
            for label, value in outputs
        ]},
        "options": {},
    }


CODE = ("n8n-nodes-base.code", 2)
SHEETS = ("n8n-nodes-base.googleSheets", 4.5)
DRIVE = ("n8n-nodes-base.googleDrive", 3)
TELEGRAM = ("n8n-nodes-base.telegram", 1.2)
SOFT_FAIL = {"onError": "continueRegularOutput"}

# Make the prompt available to the Prepare node as a JS constant.
PROMPT_JS = "const EXTRACTION_PROMPT = " + json.dumps(PROMPT) + ";\n"


# ================================================================ 1. main pipeline
def build_main():
    w = WF("Invoice Pipeline · 1 · Extract & Validate")

    w.sticky("Note: overview", (-760, -420), (
        "## 🧾 AI Invoice & Receipt Pipeline\n"
        "Drop a PDF or photo into the **Inbox** Drive folder. Gemini reads it, the rules check the maths, "
        "and it lands in the right tab of your Google Sheet:\n\n"
        "- ✅ **Auto-approved** → Invoices tab\n- 🟡 **Needs review** → Review Queue + Telegram alert\n"
        "- 🔁 **Duplicate** → skipped + alert\n- 🚫 **Not an invoice / unsupported** → Rejected\n\n"
        "**Setup:** set the Inbox folder in the trigger, then edit the ⚙️ **Settings** node. "
        "Full guide: README.md"), width=520, height=380)
    w.sticky("Note: extract", (-40, -300), (
        "### 1 · Read the document\nFiles are sent to Gemini with a strict JSON schema "
        "(`responseJsonSchema`), so the answer always has the same fields. Requests are throttled "
        "and retried 3× for rate limits."), width=700, height=220, color=5)
    w.sticky("Note: validate", (1000, -300), (
        "### 2 · Check it like an accountant\nLine items vs subtotal, subtotal + tax − discount vs total, "
        "dates, currency, model confidence, and duplicates against both tabs. Every check adds to a 0–100 score."),
        width=760, height=220, color=4)
    w.sticky("Note: route", (1880, -300), (
        "### 3 · Route\nEach outcome writes a sheet row, moves the file to its folder, and is logged. "
        "Humans only see what needs them."), width=760, height=220, color=6)

    trig = w.add("New file in Inbox", "n8n-nodes-base.googleDriveTrigger", 1, (-640, 60), {
        "pollTimes": {"item": [{"mode": "everyMinute"}]},
        "triggerOn": "specificFolder",
        "folderToWatch": rl_id("PASTE_INBOX_FOLDER_ID"),
        "event": "fileCreated",
        "options": {},
    })
    settings = w.add("Settings", *CODE, (-420, 60), {
        "jsCode": code(main="settings.main.js", header="Settings")})
    download = w.add("Download file", *DRIVE, (-200, 60), {
        "operation": "download", "fileId": rl_id("={{ $json.id }}"), "options": {}}, **SOFT_FAIL)
    prepare = w.add("Prepare file", *CODE, (20, 60), {
        "jsCode": code("extraction-schema.js", "gemini.js", main="prepare.main.js",
                       header="Prepare file: build the Gemini request").replace(
            "// ---- node logic ----\n", "// ---- prompt (prompts/extraction-prompt.md) ----\n" + PROMPT_JS + "\n// ---- node logic ----\n")})
    supported = w.add("Supported file?", "n8n-nodes-base.if", 2.2, (240, 60), {
        "conditions": conditions(condition("={{ $json.supported }}", "boolean", "true", single=True)),
        "options": {}})
    gemini = w.add("Gemini: extract data", "n8n-nodes-base.httpRequest", 4.2, (480, -60), {
        "method": "POST",
        "url": "={{ $json.gemini_url }}",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.gemini_request) }}",
        "options": {"timeout": 120000, "batching": {"batch": {"batchSize": 1, "batchInterval": 2000}}},
    }, retryOnFail=True, maxTries=3, waitBetweenTries=5000, **SOFT_FAIL)
    merge = w.add("Merge", "n8n-nodes-base.merge", 3, (720, 60), {})
    validate = w.add("Validate & score", *CODE, (940, 60), {
        "jsCode": code("gemini.js", "validate.js", main="validate.main.js", header="Validate & score")})
    read_inv = w.add("Read Invoices keys", *SHEETS, (1160, 60), read_params("Invoices"),
                     executeOnce=True, alwaysOutputData=True)
    read_rev = w.add("Read Review Queue keys", *SHEETS, (1380, 60), read_params("Review Queue"),
                     executeOnce=True, alwaysOutputData=True)
    dedupe = w.add("Check duplicates", *CODE, (1600, 60), {
        "jsCode": code("format.js", main="dedupe.main.js", header="Check duplicates & format")})
    route = w.add("Route by status", "n8n-nodes-base.switch", 3.2, (1840, 40), switch_params(
        "={{ $json.validation.status }}",
        [("Approved", "auto_approved"), ("Needs review", "needs_review"),
         ("Duplicate", "duplicate"), ("Rejected", "rejected")]))

    row = lambda c: f"={{{{ $json.row.{c} }}}}"
    inv_value = lambda c: "auto" if c == "source" else row(c)
    add_inv = w.add("Add to Invoices", *SHEETS, (2160, -260), append_params("Invoices", INVOICES, inv_value))
    mv_proc = w.add("Move to Processed", *DRIVE, (2160, -100), move_params("={{ $json.file.id }}", "PROCESSED"), **SOFT_FAIL)

    rev_cols = [c for c in REVIEW_QUEUE if c not in REVIEW_HUMAN_COLUMNS]
    add_rev = w.add("Add to Review Queue", *SHEETS, (2160, 60), append_params("Review Queue", rev_cols, row))
    mv_rev = w.add("Move to Needs Review", *DRIVE, (2160, 220), move_params("={{ $json.file.id }}", "NEEDS_REVIEW"), **SOFT_FAIL)
    tg_rev = w.add("Alert: needs review", *TELEGRAM, (2400, 140), telegram_params(), **SOFT_FAIL)

    mv_dup = w.add("Move to Duplicates", *DRIVE, (2160, 380), move_params("={{ $json.file.id }}", "DUPLICATES"), **SOFT_FAIL)
    tg_dup = w.add("Alert: duplicate", *TELEGRAM, (2400, 380), telegram_params(), **SOFT_FAIL)

    mv_rej = w.add("Move to Rejected", *DRIVE, (2160, 540), move_params("={{ $json.file.id }}", "REJECTED"), **SOFT_FAIL)
    tg_rej = w.add("Alert: rejected", *TELEGRAM, (2400, 540), telegram_params(), **SOFT_FAIL)

    log_value = lambda c: "={{ $json.validation.status }}" if c == "status" else row(c)
    log = w.add("Write to Log", *SHEETS, (2640, 160), append_params("Log", LOG, log_value), **SOFT_FAIL)

    for a, b in [(trig, settings), (settings, download), (download, prepare), (prepare, supported),
                 (gemini, merge), (validate, read_inv), (read_inv, read_rev), (read_rev, dedupe), (dedupe, route)]:
        w.link(a, b)
    w.link(supported, gemini, out=0)
    w.link(supported, merge, out=1, inp=1)
    w.link(merge, validate)
    for out, targets in enumerate([[add_inv, mv_proc], [add_rev, mv_rev, tg_rev], [mv_dup, tg_dup], [mv_rej, tg_rej]]):
        for t in targets + [log]:
            w.link(route, t, out=out)
    return w.dump("1-invoice-pipeline.json")


# ================================================================ 2. review approvals
def build_review():
    w = WF("Invoice Pipeline · 2 · Review Approvals")
    w.sticky("Note: review", (-560, -320), (
        "## 👀 Human-in-the-loop approvals\nEvery 5 minutes this reads the **Review Queue** tab. "
        "When someone corrects a row and types **APPROVE** or **REJECT** in `decision`:\n\n"
        "- APPROVE → corrected values go to **Invoices** (source = reviewed), file → Processed\n"
        "- REJECT → file → Rejected\n- Missing key fields → approval is blocked and you get a Telegram message\n\n"
        "Edit the ⚙️ **Settings** node after import."), width=520, height=320)

    sched = w.add("Every 5 minutes", "n8n-nodes-base.scheduleTrigger", 1.2, (-560, 80), {
        "rule": {"interval": [{"field": "minutes", "minutesInterval": 5}]}})
    settings = w.add("Settings", *CODE, (-340, 80), {"jsCode": code(main="review-settings.main.js", header="Settings")})
    read = w.add("Read Review Queue", *SHEETS, (-120, 80), read_params("Review Queue"))
    pick = w.add("Pick decided rows", *CODE, (100, 80), {
        "jsCode": code("validate.js", "format.js", main="review-pick.main.js", header="Pick decided rows")})
    route = w.add("Route by decision", "n8n-nodes-base.switch", 3.2, (320, 60), switch_params(
        "={{ $json.action }}", [("Post", "post"), ("Reject", "reject"), ("Blocked", "blocked")]))

    add_inv = w.add("Add to Invoices", *SHEETS, (600, -140), append_params(
        "Invoices", INVOICES, lambda c: f"={{{{ $json.invoice_row.{c} }}}}"))
    mv_proc = w.add("Move to Processed", *DRIVE, (600, 20), move_params("={{ $json.file.id }}", "PROCESSED"), **SOFT_FAIL)
    mv_rej = w.add("Move to Rejected", *DRIVE, (600, 200), move_params("={{ $json.file.id }}", "REJECTED"), **SOFT_FAIL)
    tg = w.add("Alert: approval blocked", *TELEGRAM, (600, 360), telegram_params(), **SOFT_FAIL)

    upd_cols = ["row_number", "decision", "resolved_at", "resolution"]
    upd_schema = schema(upd_cols)
    upd_schema[0].update({"type": "number", "readOnly": True, "removed": False})
    update = w.add("Mark row resolved", *SHEETS, (880, 120), {
        "operation": "update",
        "documentId": sheet_doc(),
        "sheetName": rl_sheet("Review Queue"),
        "columns": {
            "mappingMode": "defineBelow",
            # $('Pick decided rows').item works on every path, including after "Add to Invoices".
            "value": {"row_number": "={{ $('Pick decided rows').item.json.row_number }}",
                      "decision": "={{ $('Pick decided rows').item.json.new_decision }}",
                      "resolved_at": "={{ $('Pick decided rows').item.json.resolved_at }}",
                      "resolution": "={{ $('Pick decided rows').item.json.resolution }}"},
            "matchingColumns": ["row_number"],
            "schema": upd_schema,
            "attemptToConvertTypes": False,
            "convertFieldsToString": False,
        },
        "options": {"cellFormat": "RAW"},
    })

    for a, b in [(sched, settings), (settings, read), (read, pick), (pick, route)]:
        w.link(a, b)
    # Write to Invoices first, then mark resolved, so a failed append is retried next run.
    w.link(route, add_inv, out=0)
    w.link(add_inv, update)
    w.link(route, mv_proc, out=0)
    w.link(route, update, out=1)
    w.link(route, mv_rej, out=1)
    w.link(route, update, out=2)
    w.link(route, tg, out=2)
    return w.dump("2-review-approvals.json")


# ================================================================ 3. daily digest
def build_digest():
    w = WF("Invoice Pipeline · 3 · Daily Summary")
    w.sticky("Note: digest", (-560, -260), (
        "## 📊 Daily summary\nAt 18:00 every day, sends a Telegram summary: documents processed, "
        "auto-approval rate, duplicates caught, value recorded, time saved, and what is waiting for review."),
        width=460, height=220)
    sched = w.add("Every day at 18:00", "n8n-nodes-base.scheduleTrigger", 1.2, (-560, 60), {
        "rule": {"interval": [{"triggerAtHour": 18}]}})
    settings = w.add("Settings", *CODE, (-340, 60), {"jsCode": code(main="digest-settings.main.js", header="Settings")})
    rlog = w.add("Read Log", *SHEETS, (-120, 60), read_params("Log"), executeOnce=True, alwaysOutputData=True)
    rrev = w.add("Read Review Queue", *SHEETS, (100, 60), read_params("Review Queue"), executeOnce=True, alwaysOutputData=True)
    build = w.add("Build summary", *CODE, (320, 60), {"jsCode": code(main="digest.main.js", header="Build summary")})
    tg = w.add("Send summary", *TELEGRAM, (540, 60), telegram_params())
    for a, b in [(sched, settings), (settings, rlog), (rlog, rrev), (rrev, build), (build, tg)]:
        w.link(a, b)
    return w.dump("3-daily-summary.json")


# ================================================================ 4. error alerts
def build_error():
    w = WF("Invoice Pipeline · 0 · Error Alerts")
    w.sticky("Note: errors", (-480, -240), (
        "## 🔥 Error alerts\nSet this as the **Error Workflow** in the settings of workflows 1, 2 and 3. "
        "Any failure sends a Telegram message with the node, the error and a link to the execution.\n\n"
        "Put your chat ID in the **Format alert** node."), width=440, height=220)
    trig = w.add("On workflow error", "n8n-nodes-base.errorTrigger", 1, (-480, 60), {})
    fmt = w.add("Format alert", *CODE, (-260, 60), {"jsCode": code(main="error.main.js", header="Format alert")})
    tg = w.add("Send alert", *TELEGRAM, (-40, 60), telegram_params("={{ $json.chat_id }}"))
    w.link(trig, fmt)
    w.link(fmt, tg)
    return w.dump("0-error-alerts.json")


if __name__ == "__main__":
    for wf in (build_error(), build_main(), build_review(), build_digest()):
        real = [n for n in wf["nodes"] if n["type"] != "n8n-nodes-base.stickyNote"]
        print(f"{wf['name']}: {len(real)} nodes")
