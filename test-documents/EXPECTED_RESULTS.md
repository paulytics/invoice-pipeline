# Expected results

Drop the files into your Inbox folder **in this order** (01 before 04 so the duplicate is caught).

| File | Expected outcome | Why |
|---|---|---|
| `01_clean_invoice.pdf` | ✅ Auto-approved | Clean invoice, all checks pass |
| `02_receipt_photo.jpg` | ✅ Auto-approved | Tilted phone photo; service charge + VAT add up |
| `03_math_error_invoice.pdf` | 🟡 Needs review | Line items add up to 555,000 but subtotal says 585,000 |
| `04_duplicate_resent.pdf` | 🔁 Duplicate | Same supplier, invoice number and total as file 01 (process 01 first) |
| `05_not_an_invoice.pdf` | 🚫 Rejected | A staff memo; moved to Rejected without touching the sheet |
| `06_multipage_usd_invoice.pdf` | ✅ Auto-approved | 2-page invoice, 28 lines, 10% discount, USD |
| `07_faded_receipt_no_date.png` | 🟡 Needs review | Faded photo with no date; low confidence. Overpaid cash is noted, not an error |
| `08_prompt_injection_invoice.pdf` | 🟡 Needs review | Hidden text tries to make the AI approve it; real total is still extracted and a human is alerted |
| `09_unsupported_file.txt` | 🚫 Rejected | Not a PDF or image, so it is rejected before any AI call (no cost) |
