// The extension's fetches run in its service worker: a host in
// host_permissions bypasses CORS and carries the session cookie; any other
// host falls under CORS, which the server allows for no chrome-extension
// origin by design (auth v1, SPEC §25 decision 6). Production's custom domain
// was missing on 2026-11-01 and "Open in AF" failed with "Failed to fetch".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "chrome-extension", "manifest.json"), "utf8"));

describe("chrome-extension/manifest.json", () => {
  it("is v1.2.7 (the Capture PO panel redesign: buckets, selected address, per-tab captures, warm stone; 1.2.1 = the pre-parser fixes from the first real PO; 1.2.2 = table-row products and promo dedupe from a shagtools.com cart; 1.2.3 = plain-text / no-text quantities and the Copy page text debug action; 1.2.4 = Open in AF never gated, Qty: N derives the unit price; 1.2.5 = the Shipping bucket from form fields; 1.2.6 = availability lines are noise, a shipping-method list resolves by the checked radio or by Total; 1.2.7 = note lines inside a row, the cart table, buckets rebuilt from the pages on every capture)", () => {
    expect(manifest.version).toBe("1.2.7");
    expect(readFileSync(join(__dirname, "..", "chrome-extension", "sidepanel.html"), "utf8")).toMatch(/<script src="buckets\.js"><\/script>/);
  });
  it("lists every AsinFlow host the extension may be pointed at: localhost, the Render host and the custom domain", () => {
    for (const h of ["http://localhost:3000/*", "https://asinflow-cqg.onrender.com/*", "https://asinflow.coastalqualitygoods.com/*"]) {
      expect(manifest.host_permissions).toContain(h);
    }
  });
  it("can ask for any other https host at runtime (optional_host_permissions), which the options page does on save", () => {
    expect(manifest.optional_host_permissions).toContain("https://*/*");
    expect(readFileSync(join(__dirname, "..", "chrome-extension", "options.js"), "utf8")).toMatch(/chrome\.permissions\.request\(\{ origins:/);
  });
});
