#!/usr/bin/env python3
"""Download all PDFs from pdf_links.csv into tcp-specs/ at ~1 req/sec."""
import csv, hashlib, os, time, urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
OUT = "tcp-specs"
os.makedirs(OUT, exist_ok=True)

rows = list(csv.DictReader(open("pdf_links.csv")))
used = {}
results = []
for i, r in enumerate(rows):
    url = r["url"]
    base = os.path.basename(url.split("?")[0])
    # resolve filename collisions across distinct URLs
    if base in used and used[base] != url:
        stem, ext = os.path.splitext(base)
        base = f"{stem}-{hashlib.md5(url.encode()).hexdigest()[:6]}{ext}"
    used[base] = url
    dest = os.path.join(OUT, base)
    status = "ok"
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        status = "cached"
    else:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
                f.write(resp.read())
        except Exception as e:
            status = f"error: {e}"
            if os.path.exists(dest):
                os.remove(dest)
        time.sleep(1.0)
    results.append({"url": url, "filename": base if not status.startswith("error") else "",
                    "index_source": r["index_source"], "download_status": status})
    if (i + 1) % 25 == 0:
        print(f"{i+1}/{len(rows)} done", flush=True)

with open("downloads.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["url", "filename", "index_source", "download_status"])
    w.writeheader()
    w.writerows(results)

errs = [r for r in results if r["download_status"].startswith("error")]
print(f"done: {len(results)} total, {len(errs)} errors")
for r in errs:
    print(" ", r["url"], "->", r["download_status"])
