#!/usr/bin/env python3
"""Harvest PDF links from the two TCP index pages -> pdf_links.csv"""
import csv, re
from html.parser import HTMLParser
from urllib.parse import urljoin

BASE = "https://www.tcpi.com/"

class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []          # (url, text)
        self._href = None
        self._text = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href", "")
            if ".pdf" in href.lower():
                self._href = href
                self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._href is not None:
            text = re.sub(r"\s+", " ", "".join(self._text)).strip()
            self.links.append((self._href, text))
            self._href = None

def harvest(path, source):
    p = LinkParser()
    p.feed(open(path, encoding="utf-8", errors="replace").read())
    out = []
    for href, text in p.links:
        url = urljoin(BASE, href.strip())
        out.append((url, text, source))
    return out

rows = harvest("index_active.html", "active") + harvest("index_discontinued.html", "discontinued")

# Dedupe by URL. If the same URL appears under both indexes, keep both source
# labels (comma-joined) — but per spec, record which index each came from.
seen = {}
for url, text, source in rows:
    if url not in seen:
        seen[url] = {"url": url, "link_text": text, "sources": set()}
    seen[url]["sources"].add(source)
    if text and not seen[url]["link_text"]:
        seen[url]["link_text"] = text

with open("pdf_links.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["url", "link_text", "index_source"])
    for r in sorted(seen.values(), key=lambda r: r["url"]):
        src = "+".join(sorted(r["sources"]))
        w.writerow([r["url"], r["link_text"], src])

srcs = {}
for r in seen.values():
    srcs["+".join(sorted(r["sources"]))] = srcs.get("+".join(sorted(r["sources"])), 0) + 1
print(f"unique PDFs: {len(seen)}  by source: {srcs}")
