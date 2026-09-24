#!/usr/bin/env python3
"""Parse TCP spec-sheet PDFs -> tcp_sku_database.csv + tcp_sheet_inventory.csv"""
import csv, os, re, subprocess, sys, warnings

warnings.filterwarnings("ignore")
import pdfplumber

PDF_DIR = "tcp-specs"

# Item numbers: uppercase alphanumeric, letters+digits mixed. Spec says 8-20
# chars; allow >=5 when the column header says ITEM (e.g. 20B100 ballasts),
# require 8-20 when guessing without a header.
RX_ITEM_STRICT = re.compile(r"^[A-Z0-9][A-Z0-9-]{6,21}$")
RX_ITEM_LOOSE = re.compile(r"^[A-Z0-9][A-Z0-9-]{3,24}$")
# units masquerading as items (100W, 104.1MM) and TCP doc-control codes (WF162000)
RX_NOT_ITEM = re.compile(r"^\d+(\.\d+)?(MM|CM|IN|FT|W|V|A|K|LM|HZ|PK)$|^WF\d{4,}$")

def is_item(s, loose=False):
    s = s.strip().upper()
    if RX_NOT_ITEM.match(s):
        return False
    # legacy TCP items are pure digits (e.g. 18209); only trust these when the
    # column header said ITEM (loose mode)
    if loose and re.fullmatch(r"\d{4,8}", s):
        return True
    rx = RX_ITEM_LOOSE if loose else RX_ITEM_STRICT
    if not rx.match(s):
        return False
    if not re.search(r"\d", s) or not re.search(r"[A-Z]", s):
        return False
    if re.fullmatch(r"[A-Z0-9]*\d{2,4}K", s) and len(s) <= 6:  # "2700K" style
        return False
    return True

RX_NUMISH = re.compile(r"^[<>~.$]?\d[\d,./]*[A-Z\"%]{0,4}$", re.I)

FIELD_KEYWORDS = [
    # (field, must-contain keywords (any), must-NOT-contain)
    ("item", ["ITEM", "ORDER CODE", "CATALOG"], []),
    ("description", ["DESCRIPTION"], []),
    ("equiv_watts", ["EQUIV", "INCAN", "REPLACE"], []),
    ("watts", ["WATT", "WATTAGE"], ["EQUIV", "INCAN", "REPLACE"]),
    ("cri", ["CRI"], []),
    ("lpw", ["LPW", "LM/W", "EFFICACY", "LUMENS PER"], []),
    ("lumens", ["LUMEN"], ["PER", "LPW"]),
    ("cct", ["COLOR TEMP", "CCT", "KELVIN", "COLOR (K", "TEMP", "COLOR"], ["RATING", "RENDER"]),
    ("base", ["BASE"], []),
    ("hours", ["HOURS", "LIFE", "HRS"], []),
    ("mol_in", ["MOL", "LENGTH"], ["WAVELENGTH"]),
    ("dia_in", ["DIA"], []),
    ("warranty_years", ["WARRANT"], []),
    ("case_qty", ["CASE", "PACK"], []),
]

SPEC_FIELDS = ["watts", "equiv_watts", "lumens", "cct", "cri", "base", "hours",
               "mol_in", "dia_in", "warranty_years", "case_qty"]

def classify_header(cell):
    t = re.sub(r"\s+", " ", (cell or "")).upper().strip()
    if not t:
        return None
    for field, yes, no in FIELD_KEYWORDS:
        if any(k in t for k in yes) and not any(k in t for k in no):
            return field
    return None

def clean(s):
    return re.sub(r"\s+", " ", (s or "")).strip()

def norm_value(field, raw):
    v = clean(raw)
    if not v or v in ("-", "—", "N/A", "NA"):
        return ""
    if field == "warranty_years":
        m = re.search(r"(\d+(?:\.\d+)?)", v)
        return m.group(1) if m else v
    if field == "cct":
        m = re.fullmatch(r"(\d{4})\s*K?", v.replace(",", ""))
        return m.group(1) if m else v
    if field in ("watts", "equiv_watts", "lumens", "cri", "lpw", "hours",
                 "mol_in", "dia_in", "case_qty"):
        m = re.fullmatch(r"[~<>]?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:W|LM|HRS?|HOURS|IN|\")?\.?", v, re.I)
        return m.group(1).replace(",", "") if m else v
    return v

def parse_table(table, header_map=None):
    """Return (rows, header_map). header_map carries across tables because
    pdfplumber often splits a sheet's header row and data rows into separate
    tables; a header stays in force until a new one appears."""
    out = []
    for row in table:
        cells = [clean(c) for c in row]
        if not any(cells):
            continue
        # try to (re)detect a header row
        fields = [classify_header(c) for c in cells]
        n_named = len([f for f in fields if f])
        if n_named >= 2 and ("item" in fields or "description" in fields):
            header_map = {i: f for i, f in enumerate(fields) if f}
            continue
        # data row
        rec = {}
        if header_map and "item" in header_map.values():
            item_idx = [i for i, f in header_map.items() if f == "item"][0]
            cand = cells[item_idx].upper() if item_idx < len(cells) else ""
            cand = cand.split("\n")[0].split()[0] if cand else ""
            if not is_item(cand, loose=True):
                continue
            rec["item_number"] = cand
            for i, f in header_map.items():
                if f in ("item",) or i >= len(cells):
                    continue
                if f == "description":
                    rec["description"] = clean(cells[i])
                elif f != "lpw":
                    rec[f] = norm_value(f, cells[i])
        else:
            # no usable header: first strict item-looking cell wins
            cand = (cells[0] or "").upper().split()
            cand = cand[0] if cand else ""
            if not is_item(cand, loose=False):
                continue
            rec["item_number"] = cand
            rest = [c for c in cells[1:] if c]
            if rest:
                rec["description"] = rest[0]
        out.append(rec)
    return out, header_map

def parse_fallback_text(path):
    """pdftotext -layout fallback: item# at line start, rest = description."""
    try:
        txt = subprocess.run(["pdftotext", "-layout", path, "-"],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return []
    out = []
    for line in txt.splitlines():
        toks = line.split()
        if not toks:
            continue
        cand = toks[0].upper()
        ok = is_item(cand, loose=False)
        # legacy pure-digit item #s: only accept when the line looks like a
        # spec row (>=3 columns, most of them numeric-ish)
        if not ok and re.fullmatch(r"\d{4,8}", cand) and len(toks) >= 4:
            numish = len([t for t in toks[1:] if RX_NUMISH.match(t)])
            ok = numish >= 2
        if ok:
            out.append({"item_number": cand,
                        "description": clean(" ".join(toks[1:]))[:200]})
    return out

def sheet_title(pdf):
    try:
        txt = pdf.pages[0].extract_text() or ""
        for line in txt.splitlines():
            line = clean(line)
            if len(line) >= 4 and not line.upper().startswith(("WWW.", "HTTP", "TCP ")):
                return line[:100]
        return ""
    except Exception:
        return ""

def main():
    links = {r["filename"]: r for r in csv.DictReader(open("downloads.csv"))
             if r["filename"]}
    db_rows, inv_rows = [], []
    files = sorted(links.keys())
    for n, fname in enumerate(files, 1):
        meta = links[fname]
        path = os.path.join(PDF_DIR, fname)
        if not os.path.exists(path):
            inv_rows.append({"url": meta["url"], "filename": fname,
                             "index_source": meta["index_source"], "pages": 0,
                             "rows_extracted": 0, "parse_status": "failed"})
            continue
        pages = 0
        rows = []
        title = ""
        status = "ok"
        try:
            with pdfplumber.open(path) as pdf:
                pages = len(pdf.pages)
                title = sheet_title(pdf)
                hmap = None
                for page in pdf.pages:
                    try:
                        for table in page.extract_tables():
                            got, hmap = parse_table(table, hmap)
                            rows.extend(got)
                    except Exception:
                        status = "partial"
        except Exception:
            status = "failed"
        if not rows:
            fb = parse_fallback_text(path)
            if fb:
                rows = fb
                status = "partial"
        if not rows:
            # single-product sheets with a labeled SKU line, e.g.
            # "TCP Item Number: 31025841"
            try:
                txt = subprocess.run(["pdftotext", "-layout", path, "-"],
                                     capture_output=True, text=True,
                                     timeout=60).stdout
            except Exception:
                txt = ""
            labeled = re.findall(
                r"Item\s*(?:Number|#)\s*[:.]\s*([A-Z0-9-]{4,20})", txt, re.I)
            labeled = [t.upper() for t in labeled
                       if re.search(r"\d", t) and not RX_NOT_ITEM.match(t.upper())]
            if labeled:
                seen_l = set()
                rows = [{"item_number": t, "description": title}
                        for t in labeled if not (t in seen_l or seen_l.add(t))]
                status = "partial"
        if not rows:
            # single-product sheets (e.g. 20B100-Emerg-Ballast-...): the SKU
            # is the first filename token
            stem = re.split(r"[-.]", fname)[0].upper()
            if (re.fullmatch(r"[A-Z0-9]{5,20}", stem)
                    and not RX_NOT_ITEM.match(stem)
                    and re.search(r"\d", stem) and re.search(r"[A-Z]", stem)):
                rows = [{"item_number": stem, "description": title}]
                status = "partial"
            elif status != "failed":
                status = "failed"
        # dedupe identical item within this sheet (repeat headers/pages)
        seen = set()
        uniq = []
        for r in rows:
            key = r["item_number"]
            if key in seen:
                continue
            seen.add(key)
            uniq.append(r)
        family = clean(meta.get("link_text", "")) or title
        st = meta["index_source"]
        status_field = {"active": "active", "discontinued": "discontinued",
                        "active+discontinued": "active+discontinued"}[st]
        for r in uniq:
            row = {"item_number": r.get("item_number", ""),
                   "description": r.get("description", ""),
                   "family": family,
                   "spec_sheet_filename": fname,
                   "spec_sheet_url": meta["url"],
                   "status": status_field}
            for f in SPEC_FIELDS:
                row[f] = r.get(f, "")
            db_rows.append(row)
        inv_rows.append({"url": meta["url"], "filename": fname,
                         "index_source": st, "pages": pages,
                         "rows_extracted": len(uniq), "parse_status": status})
        if n % 50 == 0:
            print(f"{n}/{len(files)} parsed", flush=True)

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    db_path = os.path.join(root, "tcp_sku_database.csv")
    inv_path = os.path.join(root, "tcp_sheet_inventory.csv")
    with open(db_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["item_number", "description", "family",
                                          "spec_sheet_filename", "spec_sheet_url",
                                          "status"] + SPEC_FIELDS)
        w.writeheader()
        w.writerows(db_rows)
    with open(inv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["url", "filename", "index_source",
                                          "pages", "rows_extracted", "parse_status"])
        w.writeheader()
        w.writerows(inv_rows)

    n_ok = len([r for r in inv_rows if r["parse_status"] == "ok"])
    n_part = len([r for r in inv_rows if r["parse_status"] == "partial"])
    n_fail = len([r for r in inv_rows if r["parse_status"] == "failed"])
    uniq_items = len({r["item_number"] for r in db_rows})
    print(f"sheets: {len(inv_rows)} (ok {n_ok} / partial {n_part} / failed {n_fail})")
    print(f"db rows: {len(db_rows)}  unique item#s: {uniq_items}")
    print("failed sheets:")
    for r in inv_rows:
        if r["parse_status"] == "failed":
            print("  ", r["filename"])

if __name__ == "__main__":
    main()
