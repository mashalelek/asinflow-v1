// PO tracking: the regex parser against real (scrubbed) orders@ emails
// (SPEC §26, patch po-tracking-velocity commit 2). Order / tracking numbers
// are digit-shifted after their shape-defining prefix; people are scrubbed.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseTrackingEmail, normalizeStreet, extractShipTo, stripZipPrefix, extractOrderIds } from "./tracking-parse";
import { rowsFromEmail } from "./tracking-ingest";

const DIR = join(__dirname, "__fixtures__", "tracking-emails");
const fx = (name: string) => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
const parse = (name: string) => parseTrackingEmail(fx(name));
const sh = (name: string) => parse(name).shipments.map((s) => `${s.carrier}:${s.trackingNumber}`);

describe("tracking parser on mailbox fixtures", () => {
  it("there are at least 10 fixtures", () => {
    expect(readdirSync(DIR).filter((f) => f.endsWith(".json")).length).toBeGreaterThanOrEqual(10);
  });
  it("Macy's: two UPS shipments in one email, each with its own items; order #; Velocity ship-to", () => {
    const p = parse("macys-two-shipments");
    expect(p.orderIds).toEqual(["4800990541"]);
    expect(p.shipToStreet).toBe("805 grandy");
    expect(p.shipments.map((s) => s.trackingNumber)).toEqual(["1ZE3985C3677512769", "1ZXH51993644511848"]);
    expect(p.shipments.map((s) => s.items.map((i) => i.qty))).toEqual([[10], [7]]);
    expect(p.shipments[0].items[0].name).toMatch(/Wrapped Box of Mint Milk Chocolates/);
  });
  it("Target: FedEx label created; the 15-digit order # in the subject is NOT taken as tracking", () => {
    const p = parse("target-label-created");
    expect(p.orderIds).toEqual(["102036109641675"]);
    expect(sh("target-label-created")).toEqual(["FEDEX:546865659044"]);
    expect(p.shipments[0].items).toEqual([expect.objectContaining({ qty: 10 })]);
  });
  it("Michaels: shipped, but only its own 33-digit shipment ids — no tracking; queued as one ai_disabled placeholder", () => {
    const m = fx("michaels-shipped-no-tracking");
    const p = parseTrackingEmail(m);
    expect(p.shipments).toEqual([]);
    expect(p.orderIds).toEqual(["3500432322101240"]);
    const rows = rowsFromEmail({ id: "m1", threadId: null, date: new Date(m.date), subject: m.subject }, p);
    expect(rows).toEqual([expect.objectContaining({ carrier: "OTHER", tracking_number: "email:michaels.com:3500432322101240", match_reason: "ai_disabled" })]);
  });
  it("Community Coffee (Shopify): FedEx from the labelled line and the fedex.com URL, one row", () => {
    expect(sh("communitycoffee-shopify")).toEqual(["FEDEX:878676214245"]);
    expect(parse("communitycoffee-shopify").orderIds).toEqual(["51643"]);
  });
  it("Walmart: hyphenated order #, FedEx", () => {
    expect(parse("walmart-shipped").orderIds).toEqual(["2000486-51306393"]);
    expect(sh("walmart-shipped")).toEqual(["FEDEX:878884093476"]);
  });
  it("Home Depot / Staples / Zoro: the number on the line after its label", () => {
    expect(sh("homedepot-shipped")).toEqual(["FEDEX:538881682901"]);
    expect(sh("staples-multi-box")).toEqual(["FEDEX:535446778898"]);
    expect(sh("zoro-shipped")).toEqual(["FEDEX:490168404378599"]);
  });
  it("ShipStation: USPS 22-digit — carrier phone numbers in the footer are ignored", () => {
    expect(sh("shipstation-usps")).toEqual(["USPS:9434983439484493725639"]);
  });
  it("Narvar prints UPS lower-case; Amazon Logistics only inside a URL; USPS 420+ZIP prefix stripped", () => {
    expect(sh("narvar-lowercase-ups")).toEqual(["UPS:1Z6Y9F153655765375"]);
    expect(sh("amazon-logistics-url")).toEqual(["AMAZON:TBA368033668010"]);
    expect(sh("parcelpanel-usps-420")).toEqual(["USPS:9594523744834500670200"]);
  });
  it("UPS notification: the tracking number, not 'Reference Number 1'", () => {
    expect(sh("ups-notification-reference")).toEqual(["UPS:1ZV5838CYW33666014"]);
  });
  it("a forward from our own mailbox reports the ORIGINAL sender; an order confirmation queues nothing", () => {
    const m = fx("kohls-forward-no-tracking");
    const p = parseTrackingEmail(m);
    expect(p.senderDomain).toBe("t.kohls.com");
    expect(rowsFromEmail({ id: "k", threadId: null, date: new Date(m.date), subject: m.subject }, p)).toEqual([]);
  });
  it("Bath & Body Works (self-prep): the Ship To block parses as the home street", () => {
    const p = parse("bathandbodyworks-home-ship-to");
    expect(p.shipToStreet).toBe("65 rivercrest");
    expect(sh("bathandbodyworks-home-ship-to")).toEqual(["USPS:9339812091092559280522"]);
  });
  it("Walmart: a bare 'Delivery' heading line is a ship-to label; 'Delivery method' alone is not", () => {
    expect(extractShipTo("What to expect\nDelivery\n \n \nArrives Thu, Sep 3\n \n805 Grandy Ave, La Grande, OR, 97850, USA\n")).toBe("805 grandy");
    expect(extractShipTo("Delivery method: Standard\n151 West 34th Street, New York")).toBeNull();
  });
  it("a promo yields no rows", () => {
    const m = fx("promo-not-shipping");
    expect(rowsFromEmail({ id: "g", threadId: null, date: new Date(m.date), subject: m.subject }, parseTrackingEmail(m))).toEqual([]);
  });
});

describe("parser pieces", () => {
  it("street normalization: Ave / Avenue / suite / zip all collapse to number + first word", () => {
    expect(normalizeStreet("805 Grandy Ave")).toBe("805 grandy");
    expect(normalizeStreet("805 Grandy Avenue, Suite 2")).toBe("805 grandy");
    expect(extractShipTo("Ship To:\nTest Buyer\n65 Rivercrest Dr\nLa Grande")).toBe("65 rivercrest");
    expect(extractShipTo("Billing address: 805 Grandy Ave")).toBeNull();
  });
  it("USPS 420+ZIP barcodes reduce to the tracking number; others untouched", () => {
    expect(stripZipPrefix("420978509261290411501277347977")).toBe("9261290411501277347977");
    expect(stripZipPrefix("9261290411501277347977")).toBe("9261290411501277347977");
  });
  it("order #: a lower-case word run-on after the digits is cut; dates are not order #s", () => {
    expect(extractOrderIds("Items from order #102003876318342are about to ship", "")).toEqual(["102003876318342"]);
    expect(extractOrderIds("", "Order Date: 10/8/2026\nOrder Number: WB5741517959")).toEqual(["WB5741517959"]);
  });
  it("an all-digit number without a tracking label or carrier word is not tracking (UPC, phone)", () => {
    const p = parseTrackingEmail({ subject: "Your order #123456 has shipped", fromDomain: "x.com", text: "UPC: 720227468499\nCall 1-800-742-5877\nTracking #: 1ZE3652C0344289436" });
    expect(p.shipments.map((s) => s.trackingNumber)).toEqual(["1ZE3652C0344289436"]);
  });
});
