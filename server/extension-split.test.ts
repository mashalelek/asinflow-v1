// Two Chrome extensions from one repo (v2.0, Maria 2026-11-05; SPEC §11): AsinFlow Capture PO at chrome-extension/
// (the original folder — an unpacked extension's ID comes from its path, so its ID, captures and options survive) and
// AsinFlow Analyzer at chrome-extension/analyzer/ (a new load). They share core/ (AF client, options, scrubber, panel
// CSS, the routes list); Chrome loads nothing outside an extension's folder, so analyzer/core is a copy kept by
// `npm run ext:sync-core` and checked here byte for byte.
//
// The fetches run in each service worker: a host in host_permissions bypasses CORS and carries the session cookie;
// any other host falls under CORS, which the server allows for no chrome-extension origin by design (auth v1, SPEC §25
// decision 6). Production's custom domain was missing on 2026-11-01 and "Open in AF" failed with "Failed to fetch".
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "chrome-extension");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const capture = JSON.parse(read("manifest.json"));
const analyzer = JSON.parse(read("analyzer", "manifest.json"));
const SERVERS = ["http://localhost:3000/*", "https://asinflow-cqg.onrender.com/*", "https://asinflow.coastalqualitygoods.com/*"];
const isAmazon = (h: string) => /amazon\./i.test(h);

describe("two extensions: names, versions, icons", () => {
  it("Capture PO 2.0.0 and Analyzer 1.0.0 (2.0.0 = the split; 1.4.0 = the structured reader above the AI; 1.3.x = the AI preview, captures survive navigation; 1.2.x = the bucket pre-parser)", () => {
    expect(capture).toMatchObject({ name: "AsinFlow Capture PO", version: "2.0.0", side_panel: { default_path: "sidepanel.html" }, background: { service_worker: "background.js" } });
    expect(analyzer).toMatchObject({ name: "AsinFlow Analyzer", version: "1.0.0", side_panel: { default_path: "sidepanel.html" }, background: { service_worker: "background.js" } });
    expect(capture.key).toBeUndefined(); // the ID stays the folder's
  });
  it("distinguishable toolbar icons", () => {
    for (const s of ["16", "48", "128"]) expect(readFileSync(join(root, capture.icons[s])).equals(readFileSync(join(root, "analyzer", analyzer.icons[s])))).toBe(false);
  });
});

describe("Capture PO never runs on Amazon", () => {
  it("no amazon host, no content script; the server hosts; any other host asked for at capture time", () => {
    expect(capture.host_permissions.filter(isAmazon)).toEqual([]);
    expect(capture.content_scripts).toBeUndefined();
    for (const h of SERVERS) expect(capture.host_permissions).toContain(h);
    expect(capture.optional_host_permissions).toContain("https://*/*");
  });
  it("its panel is disabled on an Amazon tab and a capture there is refused (optional permissions cannot exclude a host)", () => {
    const bg = read("background.js");
    expect(bg).toMatch(/enabled: !AfCore\.isAmazonUrl\(url\)/);
    expect(bg).toMatch(/CAPTURE_PAGE[\s\S]{0,600}AfCore\.isAmazonUrl\(tab\.url\)/);
    expect(read("sidepanel.html")).not.toMatch(/product-content|fee-engine|sidepanel\.js/);
  });
});

describe("Analyzer runs only on Amazon and Seller Central", () => {
  it("amazon hosts and the AF servers, nothing else; the product page content script", () => {
    expect(analyzer.host_permissions.filter((h: string) => !SERVERS.includes(h)).every(isAmazon)).toBe(true);
    expect(analyzer.host_permissions).toContain("https://sellercentral.amazon.com/*");
    expect(analyzer.optional_host_permissions).toBeUndefined();
    expect(analyzer.content_scripts[0].matches.every(isAmazon)).toBe(true);
    for (const h of SERVERS) expect(analyzer.host_permissions).toContain(h);
  });
  it("its panel is off by default and enabled per Amazon tab; it has no capture code", () => {
    const bg = read("analyzer", "background.js");
    expect(bg).toMatch(/enabled: AfCore\.isAmazonUrl\(url\)/);
    expect(bg).not.toMatch(/CAPTURE_PAGE|AfBuckets|capture-preview/);
    expect(read("analyzer", "sidepanel.html")).not.toMatch(/capture-content|buckets\.js|capture-panel/);
  });
});

describe("shared core", () => {
  it("analyzer/core is an exact copy of core/ (npm run ext:sync-core)", () => {
    const files = readdirSync(join(root, "core")).sort();
    expect(readdirSync(join(root, "analyzer", "core")).sort()).toEqual(files);
    for (const f of files) expect({ f, same: read("core", f) === read("analyzer", "core", f) }).toEqual({ f, same: true });
  });
  it("both options pages use the shared script, which asks for a non-listed server host on save", () => {
    for (const p of [["options.html"], ["analyzer", "options.html"]]) expect(read(...p)).toMatch(/core\/af-client\.js[\s\S]*core\/options\.js/);
    expect(read("core", "options.js")).toMatch(/chrome\.permissions\.request\(\{ origins:/);
  });
  it("isAmazonUrl: amazon.* only", async () => {
    const { isAmazonUrl } = await import("../chrome-extension/core/af-client.js" as any).then((m: any) => m.default ?? m);
    for (const u of ["https://www.amazon.com/dp/B0X", "https://sellercentral.amazon.com/", "https://amazon.co.uk/x", "https://smile.amazon.ca"]) expect({ u, a: isAmazonUrl(u) }).toEqual({ u, a: true });
    for (const u of ["https://www.walmart.com/checkout", "https://notamazon.com/", "https://amazon-deals.example.com/", "chrome://extensions", undefined]) expect({ u, a: isAmazonUrl(u) }).toEqual({ u, a: false });
  });
});
