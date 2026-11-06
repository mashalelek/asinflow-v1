import { describe, it, expect } from "vitest";
import { classifyEmail, ingestDocuments, linkExistingDocuments, reviewCsv, DOCS_WATERMARK_KEY, DOCS_FAILURES_KEY, DOCS_UNMATCHED_KEY } from "./po-documents";
import { poDocuments, documentsDeps } from "./scheduler/components/29-po-documents";
import { ComponentError } from "./scheduler/types";
import { renderableHtml } from "./gmail-client";
import { INVOICES_ROOT_ID } from "./drive-client";
import { componentsForJob } from "./scheduler/runner";
import type { JobRow } from "./scheduler/types";

/** An in-memory stand-in for the SQL the module runs. */
function fakeDb(pos: any[]) {
  const docs: any[] = [];
  const settings: Record<string, any> = {};
  const aiLog: any[] = [];
  const query = async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT to_regclass")) return { rows: [{ t: "po_documents" }], rowCount: 1 };
    if (s.startsWith("SELECT id, order_date, supplier, order_id FROM purchase_orders") || s.startsWith("SELECT p.id, p.supplier")) return { rows: pos, rowCount: pos.length };
    if (s.startsWith("SELECT MIN(order_date)")) { const d = pos.filter((x) => p[0].includes(x.source)).map((x) => x.order_date).sort()[0]; return { rows: [{ d: d ?? null }], rowCount: 1 }; }
    if (s.startsWith("SELECT drive_file_id FROM po_documents")) return { rows: docs, rowCount: docs.length };
    if (s.startsWith("SELECT id, type, file_name FROM po_documents WHERE source = 'linked_existing'")) { const r = docs.map((d, i) => ({ ...d, id: d.id ?? i })).filter((d) => d.source === "linked_existing"); return { rows: r, rowCount: r.length }; }
    if (s.startsWith("UPDATE po_documents SET type")) { const d = docs.find((x, i) => (x.id ?? i) === p[0]); if (d) d.type = p[1]; return { rows: [], rowCount: d ? 1 : 0 }; }
    if (s.startsWith("SELECT 1 FROM po_documents WHERE gmail_message_id")) { const r = docs.filter((d) => d.gmail_message_id === p[0] && (p.length < 2 || d.type === p[1])); return { rows: r, rowCount: r.length }; }
    if (s.startsWith("SELECT alias, supplier FROM supplier_aliases")) return { rows: [], rowCount: 0 };
    if (s.startsWith("INSERT INTO po_prefill_log")) { aiLog.push({ kind: p[1], retailer: p[2], schema_ok: p[9], error: p[10] }); return { rows: [{ id: aiLog.length }], rowCount: 1 }; }
    if (s.startsWith("SELECT file_name FROM po_documents WHERE po_id")) { const r = docs.filter((d) => d.po_id === p[0]); return { rows: r, rowCount: r.length }; }
    if (s.startsWith("SELECT value FROM settings")) return { rows: settings[p[0]] ? [{ value: settings[p[0]] }] : [], rowCount: 0 };
    if (s.startsWith("INSERT INTO settings")) { settings[p[0]] = JSON.parse(p[1]); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO po_documents") && s.includes("'linked_existing'")) { docs.push({ po_id: p[0], type: p[1], drive_file_id: p[2], file_name: p[3], source: "linked_existing" }); return { rows: [], rowCount: 1 }; }
    if (s.startsWith("INSERT INTO po_documents")) { docs.push({ po_id: p[0], type: p[1], gmail_message_id: p[2], drive_file_id: p[3], file_name: p[4], source: "email" }); return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
  };
  return { query: query as any, docs, settings, aiLog };
}

/** Drive with the 2026 year folder and its October month folder; records uploads and folder creates. */
function fakeDrive() {
  const folders = [{ id: "y26", name: "Invoices - 2026", parent: INVOICES_ROOT_ID }, { id: "m10", name: "Invoices 2026-10", parent: "y26" }];
  const files: Array<{ id: string; name: string; parent: string }> = [{ id: "x", name: "2026-10-30_walmart.com_200015000000001.pdf", parent: "m10" }];
  const uploads: string[] = [], createdFolders: string[] = [];
  let n = 0;
  const drive: any = {
    files: {
      list: async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        const wantFolders = q.includes("mimeType = 'application/vnd.google-apps.folder'"), wantFiles = q.includes("mimeType != ");
        const f = folders.filter((x) => x.parent === parent).map((x) => ({ id: x.id, name: x.name, mimeType: "application/vnd.google-apps.folder" }));
        const g = files.filter((x) => x.parent === parent).map((x) => ({ id: x.id, name: x.name, mimeType: "application/pdf" }));
        return { data: { files: wantFolders ? f : wantFiles ? g : [...f, ...g] } };
      },
      create: async ({ requestBody }: any) => {
        const id = `n${++n}`;
        if (requestBody.mimeType === "application/vnd.google-apps.folder") { folders.push({ id, name: requestBody.name, parent: requestBody.parents[0] }); createdFolders.push(requestBody.name); }
        else { files.push({ id, name: requestBody.name, parent: requestBody.parents[0] }); uploads.push(requestBody.name); }
        return { data: { id, size: "1234" } };
      },
    },
  };
  return { drive, uploads, createdFolders };
}

const confirmation = (id: string, orderId: string, date: string) => ({
  id, threadId: null, date: new Date(date), from: "Walmart <help@walmart.com>", fromDomain: "walmart.com",
  subject: `Thanks for your order`, text: `Order# ${orderId}\nOrder total $10.00`, labelIds: [],
});

describe("classifyEmail", () => {
  it("a confirmation, a shipped and a delivered email; marketing and cancellations are none", () => {
    expect(classifyEmail({ subject: "Thanks for your order", text: "Order# 200015000000001", fromDomain: "walmart.com" })?.type).toBe("order_confirmation");
    expect(classifyEmail({ subject: "Your order has shipped", text: "Order# 200015000000001 UPS 1Z999AA10123456784", fromDomain: "walmart.com" })?.type).toBe("shipped");
    expect(classifyEmail({ subject: "Delivered: your package", text: "Order# 200015000000001", fromDomain: "walmart.com" })?.type).toBe("delivered");
    expect(classifyEmail({ subject: "Your order was canceled", text: "Order# 200015000000001", fromDomain: "walmart.com" })).toBeNull();
    // No rule and no exclusion: unknown — the AI fallback's input, asked only once the email names one PO.
    expect(classifyEmail({ subject: "Big savings this week", text: "Shop now", fromDomain: "walmart.com" })?.type).toBe("unknown");
    expect(classifyEmail({ subject: "Complete your order and save 10%", text: "", fromDomain: "walmart.com" })).toBeNull();
  });
});

describe("ingestDocuments", () => {
  const pos = [
    { id: "af1", supplier: "walmart.com", order_id: "200015000000001", order_date: "2026-10-30", source: "extension", order_total: 10 },
    { id: "sh1", supplier: "walmart.com", order_id: "200015000000002", order_date: "2026-11-01", source: "sheet_import", order_total: 10 },
  ];
  const msgs: Record<string, any> = { m1: confirmation("m1", "200015000000001", "2026-10-30T15:00:00Z"), m2: confirmation("m2", "200015000000002", "2026-11-01T15:00:00Z") };
  const deps = (drive: any) => ({
    gmail: {} as any, drive, list: async () => Object.keys(msgs), get: async (_g: any, id: string) => msgs[id],
    getRenderable: async (_g: any, id: string) => ({ id, html: "<p>x</p>", subject: "", from: "", to: "", date: new Date() }),
    render: async () => Buffer.from("%PDF-1.4 fake"), ai: null,
  });
  const now = new Date("2026-11-04T20:00:00Z");

  it("a dry run writes nothing and counts what it would save", async () => {
    const db = fakeDb(pos), d = fakeDrive();
    const r = await ingestDocuments({ query: db.query, deps: deps(d.drive), now, dryRun: true });
    expect(r.items.map((i) => i.po_id)).toEqual(["af1"]);
    expect(r.sheet_era_skipped).toBe(1);
    expect(r.folders_created).toEqual([]);
    expect(db.docs).toEqual([]); expect(d.uploads).toEqual([]); expect(db.settings[DOCS_WATERMARK_KEY]).toBeUndefined();
  });

  it("D4: the backfill saves AF-created POs only; the §2 name skips a name already in the folder; a re-run adds nothing", async () => {
    const db = fakeDb(pos), d = fakeDrive();
    const r = await ingestDocuments({ query: db.query, deps: deps(d.drive), now });
    expect(r.sheet_era_skipped).toBe(1);
    expect(d.uploads).toEqual(["2026-10-30_walmart.com_200015000000001-2.pdf"]);
    expect(db.docs).toMatchObject([{ po_id: "af1", type: "order_confirmation", gmail_message_id: "m1", source: "email" }]);
    expect(db.settings[DOCS_WATERMARK_KEY].live_since).toBe(now.toISOString());
    const again = await ingestDocuments({ query: db.query, deps: deps(d.drive), now: new Date("2026-11-04T21:00:00Z"), since: null });
    expect(again.already).toBe(1);
    expect(d.uploads).toHaveLength(1);
  });

  it("after going live, a sheet-era PO's new email is saved, into a month folder created for it", async () => {
    const db = fakeDb(pos), d = fakeDrive();
    db.settings[DOCS_WATERMARK_KEY] = { last_scanned_at: "2026-10-31T00:00:00Z", live_since: "2026-10-31T00:00:00Z" };
    const r = await ingestDocuments({ query: db.query, deps: deps(d.drive), now });
    expect(r.items.map((i) => i.po_id)).toEqual(["af1", "sh1"]);
    expect(d.createdFolders).toEqual(["Invoices 2026-11"]);
    expect(d.uploads).toContain("2026-11-01_walmart.com_200015000000002.pdf");
  });

  it("a failed render is counted and keeps the watermark, so the next pass retries", async () => {
    const db = fakeDb(pos), d = fakeDrive();
    const r = await ingestDocuments({ query: db.query, deps: { ...deps(d.drive), render: async () => { throw new Error("chrome died"); } }, now });
    expect(r.failed).toBe(1);
    expect(db.settings[DOCS_WATERMARK_KEY]).toBeUndefined();
    expect(db.docs).toEqual([]);
    // The PO's reason for "No invoice saved" (2026-11-05); a later pass that saves it clears the entry.
    expect(r.failures).toMatchObject([{ po_id: "af1", order_id: "200015000000001", type: "order_confirmation", error: "chrome died" }]);
    expect(db.settings[DOCS_FAILURES_KEY]).toEqual({ af1: { error: "chrome died", at: now.toISOString(), type: "order_confirmation", message_id: "m1" } });
    await ingestDocuments({ query: db.query, deps: deps(d.drive), now: new Date("2026-11-04T21:00:00Z") });
    expect(db.settings[DOCS_FAILURES_KEY]).toEqual({});
    expect(db.docs).toHaveLength(1);
  });
  it("a dry run never touches the failure map", async () => {
    const db = fakeDb(pos), d = fakeDrive();
    await ingestDocuments({ query: db.query, deps: { ...deps(d.drive), render: async () => { throw new Error("x"); } }, now, dryRun: true });
    expect(db.settings[DOCS_FAILURES_KEY]).toBeUndefined();
  });
});

describe("linkExistingDocuments", () => {
  it("links by name, dry run writes nothing, a re-run links nothing more", async () => {
    const pos = [{ id: "p1", order_date: "2026-10-18", supplier: "walmart.com", order_id: "200015383864738" }];
    const tree = { folders: [], files: [{ id: "f1", name: "2026-10-18_walmart.com_200015383864738.pdf", mimeType: "application/pdf", size: 10, parentId: "m", path: "Invoices - 2026/Invoices 2026-10" }] };
    const db = fakeDb(pos);
    const dry = await linkExistingDocuments({ query: db.query, drive: {} as any, tree, dryRun: true });
    expect(dry.linked).toEqual({ name: 1, loose: 0 }); expect(db.docs).toEqual([]);
    await linkExistingDocuments({ query: db.query, drive: {} as any, tree });
    expect(db.docs).toMatchObject([{ po_id: "p1", drive_file_id: "f1", source: "linked_existing", type: "order_confirmation" }]);
    expect((await linkExistingDocuments({ query: db.query, drive: {} as any, tree })).linked).toEqual({ name: 0, loose: 0 });
  });
  it("an _invoice file links as an invoice; one already linked as a confirmation is retyped, once (2026-11-05)", async () => {
    const pos = [{ id: "w", order_date: "2026-11-04", supplier: "walmart.com", order_id: "200015701166371" }, { id: "s", order_date: "2026-11-05", supplier: "supplyhouse.com", order_id: "29549674" }];
    const tree = { folders: [], files: [
      { id: "f1", name: "2026-11-04_walmart.com_200015701166371_invoice.pdf", mimeType: "application/pdf", size: 10, parentId: "m", path: "Invoices - 2026/Invoices 2026-11" },
      { id: "f2", name: "2026-11-05_supplyhouse.com_29549674_invoice.pdf", mimeType: "application/pdf", size: 10, parentId: "m", path: "Invoices - 2026/Invoices 2026-11" },
    ] };
    const db = fakeDb(pos);
    db.docs.push({ id: "old", po_id: "w", type: "order_confirmation", drive_file_id: "f1", file_name: tree.files[0].name, source: "linked_existing" });
    const dry = await linkExistingDocuments({ query: db.query, drive: {} as any, tree, dryRun: true });
    expect([dry.retyped, dry.links.map((l) => [l.file.id, l.type])]).toEqual([1, [["f2", "invoice"]]]);
    expect(db.docs[0].type).toBe("order_confirmation");
    const live = await linkExistingDocuments({ query: db.query, drive: {} as any, tree });
    expect(live.retyped).toBe(1);
    expect(db.docs.map((d) => [d.drive_file_id, d.type])).toEqual([["f1", "invoice"], ["f2", "invoice"]]);
    expect((await linkExistingDocuments({ query: db.query, drive: {} as any, tree })).retyped).toBe(0);
  });
  it("the review CSV lists each candidate", () => {
    const csv = reviewCsv([{ po: { id: "p", order_date: "2025-07-14", supplier: "esslinger.com", order_id: "1236750" }, reason: "several_files", candidates: [{ id: "a", name: "A.pdf", path: "x" }, { id: "b", name: "B.pdf", path: "y" }] }]);
    expect(csv.split("\n")[1]).toBe(`"p","2025-07-14","esslinger.com","1236750","several_files","A.pdf | B.pdf","x | y","a | b"`);
  });
});

describe("renderableHtml", () => {
  it("inlines cid images, adds the header, wraps plain text", () => {
    const html = renderableHtml({ html: `<html><head></head><body><img src="cid:logo@x"></body></html>`, plain: null, subject: "S <1>", from: "a@b.c", to: "o@x", date: new Date("2026-11-04T00:00:00Z") }, { "logo@x": "data:image/png;base64,AA" });
    expect(html).toContain(`src="data:image/png;base64,AA"`);
    expect(html).toContain("<b>Subject:</b> S &lt;1&gt;");
    expect(html).toMatch(/<meta charset="utf-8">/);
    expect(renderableHtml({ html: null, plain: "a < b", subject: "", from: "", to: "", date: new Date() })).toContain("<pre");
  });
});

describe("component 29", () => {
  it("runs in every scheduled pass (hourly tier) and never in a manual job", () => {
    expect(componentsForJob({ trigger: "scheduled", include_daily: false } as JobRow).map((c) => c.n)).toContain(29);
    expect(componentsForJob({ trigger: "scheduled", include_daily: true } as JobRow).map((c) => c.n)).toContain(29);
    expect(componentsForJob({ trigger: "manual", include_daily: true } as JobRow).map((c) => c.n)).not.toContain(29);
    expect(componentsForJob({ trigger: "manual", components: [29] } as JobRow).map((c) => c.n)).toEqual([]);
  });

  const ctx = (include_daily: boolean) => ({ job: { include_daily } as JobRow, query: (async () => ({ rows: [], rowCount: 0 })) as any, log: () => {} } as any);
  const okLink = async () => ({ linked: { name: 2, loose: 0 }, review: [] } as any);
  const ingestResult = (failures: any[]) => ({ scanned: 3, documents: 3, matched: 3, unmatched: 0, ambiguous: 0, already: 0, sheet_era_skipped: 0, items: [], failed: failures.length, failures, folders_created: [], since: null, until: "now" } as any);
  const withDeps = async (d: Partial<typeof documentsDeps>, fn: () => Promise<void>) => {
    const saved = { ...documentsDeps };
    Object.assign(documentsDeps, { gmail: () => ({}) as any, drive: () => ({}) as any }, d);
    try { await fn(); } finally { Object.assign(documentsDeps, saved); }
  };

  it("links PDFs saved by hand on every pass, the hourly ones too (2026-11-05)", async () => {
    let links = 0;
    await withDeps({ ingest: async () => ingestResult([]), link: async () => { links++; return okLink(); } }, async () => {
      const r = await poDocuments.run(ctx(false));
      expect(r.counts.linked_name).toBe(2);
      await poDocuments.run(ctx(true));
    });
    expect(links).toBe(2);
  });
  it("a document that was not saved fails the component with the reason and keeps the counts; linking still runs", async () => {
    let links = 0;
    const chrome = "Could not find Chrome (ver. 156.0.8078.47). This can occur if either\n 1. you did not perform an installation";
    await withDeps({ ingest: async () => ingestResult([{ message_id: "m1", po_id: "p", supplier: "acmetools.com", order_id: "42838131", type: "order_confirmation", error: chrome }, { message_id: "m2", po_id: "q", supplier: "walmart.com", order_id: "1", type: "shipped", error: chrome }]), link: async () => { links++; return okLink(); } }, async () => {
      const err = await poDocuments.run(ctx(false)).catch((e) => e);
      expect(err).toBeInstanceOf(ComponentError);
      expect(err.message).toBe("2 documents not saved (Could not find Chrome (ver. 156.0.8078.47). This can occur if either)");
      expect(err.partial.counts).toMatchObject({ failed: 2, linked_name: 2 });
      expect(err.partial.outcomes["failed acmetools.com 42838131 order_confirmation m1"]).toBe(chrome);
    });
    expect(links).toBe(1);
  });
  it("a Gmail failure fails the component too (it was recorded and swallowed before)", async () => {
    await withDeps({ ingest: async () => { throw new Error("invalid_grant"); }, link: okLink }, async () => {
      await expect(poDocuments.run(ctx(false))).rejects.toThrow("order emails: invalid_grant");
    });
  });
});

describe("ingestDocuments — the 2026-11-04 rules (ShagTools PO 4126643)", () => {
  const shag = { id: "shag", supplier: "shagtools.com", order_id: "4126643", order_date: "2026-11-02", source: "extension", order_total: 10 };
  const other = { id: "zoro", supplier: "zoro.com", order_id: "Z8812345AB", order_date: "2026-11-01", source: "extension", order_total: 10 };
  const mail = (id: string, subject: string, text: string, fromDomain = "shagtools.com", labelIds: string[] = []) =>
    ({ id, threadId: null, date: new Date("2026-11-03T15:00:00Z"), from: `x <x@${fromDomain}>`, fromDomain, subject, text, labelIds });
  const msgs: Record<string, any> = {
    // Filed under Promotions by Gmail — read all the same.
    a: mail("a", "Your ShagTools order has been received!", "Order #4126643\nTotal $10.00", "shagtools.com", ["CATEGORY_PROMOTIONS"]),
    b: mail("b", "[ShagTools] Invoice 4126643 for order 4126643 from November 2, 2026", "Invoice 4126643"),
    c: mail("c", "Your ShagTools order is now complete", "Order #4126643 shipped via UPS 1Z999AA10123456784"),
    // A carrier notice: no labelled order #, but AF's order # in the text.
    d: mail("d", "Your package has been delivered!", "Reference: Z8812345AB\nThanks for shopping", "ups.com"),
    // No subject rule: the AI types it, because it names exactly one PO.
    e: mail("e", "Your Zoro order Z8812345AB", "Order # Z8812345AB — the details", "zoro.com"),
    // No rule and no PO: the AI is never asked.
    f: mail("f", "Fall favorites are here", "Shop now", "zoro.com"),
  };
  const deps = (drive: any, ai: any) => ({
    gmail: {} as any, drive, list: async (_g: any, q: string) => { lastQ = q; return Object.keys(msgs); }, get: async (_g: any, id: string) => msgs[id],
    getRenderable: async (_g: any, id: string) => ({ id, html: "<p>x</p>", subject: "", from: "", to: "", date: new Date() }),
    render: async () => Buffer.from("%PDF-1.4 fake"), ai,
  });
  let lastQ = "";
  const now = new Date("2026-11-04T20:00:00Z");

  it("confirmation, invoice and shipped for one PO; the Promotions filter is gone; a PO named in a carrier's text; the AI types a subject no rule names", async () => {
    const db = fakeDb([shag, other]), d = fakeDrive();
    const calls: string[] = [];
    const ai = async (subject: string) => { calls.push(subject); return { type: "order_confirmation" as const, input_tokens: 900, output_tokens: 20 }; };
    const r = await ingestDocuments({ query: db.query, deps: deps(d.drive, ai), now, since: new Date("2026-11-01T00:00:00Z") });
    expect(lastQ).not.toMatch(/promotions/);
    expect(r.items.map((i) => [i.po_id, i.type, i.rule])).toEqual([
      ["shag", "order_confirmation", "received"], ["shag", "invoice", "invoice_for_order"], ["shag", "shipped", "order_complete"],
      ["zoro", "delivered", "delivered"], ["zoro", "order_confirmation", "ai"],
    ]);
    expect(d.uploads.filter((u) => u.includes("4126643"))).toEqual([
      "2026-11-02_shagtools.com_4126643.pdf", "2026-11-02_shagtools.com_4126643_invoice.pdf", "2026-11-02_shagtools.com_4126643_shipped.pdf",
    ]);
    expect(calls).toEqual(["Your Zoro order Z8812345AB"]);
    expect(r.ai).toMatchObject({ calls: 1, typed: 1, off: false });
    expect(db.aiLog).toEqual([{ kind: "doc_classify", retailer: "zoro.com", schema_ok: true, error: null }]);
  });

  it("without AI (no key) an unknown subject is counted, never filed; a dry run never calls it; the cap stops calls; an AI 'none' files nothing", async () => {
    const off = await ingestDocuments({ query: fakeDb([shag, other]).query, deps: deps(fakeDrive().drive, null), now, since: null, dryRun: true });
    expect(off.ai).toMatchObject({ calls: 0, off: true });
    expect(off.untyped).toBe(1);
    expect(off.items.map((i) => i.rule)).not.toContain("ai");
    let called = 0;
    const dry = await ingestDocuments({ query: fakeDb([shag, other]).query, deps: deps(fakeDrive().drive, async () => { called++; return { type: "invoice", input_tokens: 1, output_tokens: 1 }; }), now, since: null, dryRun: true });
    expect([called, dry.ai.dry_run]).toEqual([0, 1]);
    const capped = await ingestDocuments({ query: fakeDb([shag, other]).query, deps: deps(fakeDrive().drive, async () => { called++; return { type: "invoice", input_tokens: 1, output_tokens: 1 }; }), now, since: null, aiMaxCalls: 0 });
    expect([called, capped.ai.skipped_cap]).toEqual([0, 1]);
    const db = fakeDb([shag, other]);
    const none = await ingestDocuments({ query: db.query, deps: deps(fakeDrive().drive, async () => ({ type: "none", input_tokens: 1, output_tokens: 1 })), now, since: null });
    expect(none.ai).toMatchObject({ calls: 1, none: 1 });
    expect(none.items).toHaveLength(4);
    expect(db.aiLog).toHaveLength(1);
  });
});


describe("ingestDocuments: an email that arrives before its PO (2026-11-06, Michaels 4300109060826629)", () => {
  const conf = confirmation("mc", "4300109060826629", "2026-11-05T22:20:02Z");
  const michaels = { ...conf, from: "Michaels <no-reply@michaels.com>", fromDomain: "michaels.com", subject: "We've received your order!", text: "Order 4300109060826629\nThank you" };
  const po = { id: "mi1", supplier: "michaels.com", order_id: "4300109060826629", order_date: "2026-11-05", source: "extension", order_total: 188.6 };
  const deps = (drive: any, window: () => string[]) => ({
    gmail: {} as any, drive, list: async () => window(), get: async (_g: any, id: string) => ({ mc: michaels } as any)[id],
    getRenderable: async (_g: any, id: string) => ({ id, html: "<p>x</p>", subject: "", from: "", to: "", date: new Date() }),
    render: async () => Buffer.from("%PDF-1.4 fake"), ai: null,
  });

  it("matched no PO → kept on the list; a later pass, the email long out of its window, saves it and takes it off", async () => {
    const pos: any[] = [];
    const db = fakeDb(pos), d = fakeDrive();
    let window = ["mc"];
    const first = await ingestDocuments({ query: db.query, deps: deps(d.drive, () => window), now: new Date("2026-11-05T22:48:00Z") });
    expect(first.unmatched).toBe(1);
    expect(db.settings[DOCS_UNMATCHED_KEY]).toEqual({ mc: "2026-11-05T22:20:02.000Z" });
    // Two days later: the PO exists, the email is far behind the watermark's 6 h overlap.
    pos.push(po); window = [];
    const later = await ingestDocuments({ query: db.query, deps: deps(d.drive, () => window), now: new Date("2026-11-07T10:00:00Z") });
    expect(later).toMatchObject({ scanned: 1, rechecked: 1, matched: 1 });
    expect(db.docs).toMatchObject([{ po_id: "mi1", type: "order_confirmation", gmail_message_id: "mc" }]);
    expect(db.settings[DOCS_UNMATCHED_KEY]).toEqual({});
  });

  it("a new PO's recheck (onlyStored) reads the list only and leaves the watermark; after 14 days an entry ages out", async () => {
    const pos: any[] = [po];
    const db = fakeDb(pos), d = fakeDrive();
    db.settings[DOCS_UNMATCHED_KEY] = { mc: "2026-11-05T22:20:02.000Z", old: "2026-10-01T00:00:00.000Z" };
    let listed = 0;
    const r = await ingestDocuments({ query: db.query, deps: deps(d.drive, () => { listed++; return ["mc"]; }), now: new Date("2026-11-05T22:33:00Z"), onlyStored: true, onlyPoId: "mi1" });
    expect(listed).toBe(0);
    expect(r).toMatchObject({ scanned: 1, rechecked: 1, since: null });
    expect(r.items.map((i) => i.po_id)).toEqual(["mi1"]);
    expect(db.settings[DOCS_WATERMARK_KEY]).toBeUndefined();
    expect(db.settings[DOCS_UNMATCHED_KEY]).toEqual({});
  });

  it("a dry run leaves the list as it was", async () => {
    const db = fakeDb([]), d = fakeDrive();
    await ingestDocuments({ query: db.query, deps: deps(d.drive, () => ["mc"]), now: new Date("2026-11-05T22:48:00Z"), dryRun: true });
    expect(db.settings[DOCS_UNMATCHED_KEY]).toBeUndefined();
  });
});
