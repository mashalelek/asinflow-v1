// Carrier notices (SPEC §26, Maria 2026-11-04): a UPS / FedEx / USPS email sent "at the request of" the shipper, with no order #.
// The text is transcribed from the two Zara UPS notices (the recipient's name replaced).
import { describe, it, expect } from "vitest";
import { parseTrackingEmail, extractShipper, extractCarrierRefs, isCarrierSender } from "./tracking-parse";
import { rowsFromEmail } from "./tracking-ingest";
import { matchRow, supplierForShipper, carrierCandidates, shipToKind, type PoRef } from "./tracking-match";
import { suggestPos } from "./tracking-routes";

const UPS_SHIP = `You have a package coming.
Scheduled Delivery Date: Tuesday,  09/22/2026
This message was sent to you at the request of ZARA DEL AMO FASHION CENTER to notify you that the shipment information below has been transmitted to UPS.
Shipment Details
From: ZARA DEL AMO FASHION CENTER
Tracking Number: 1ZV5503JYW00243199
https://www.ups.com/track?loc=en_US&Requester=DAN&tracknum=1ZV5503JYW00243199&AgreeToTermsAndConditions=yes
Ship To:
ZZ RECIPIENT
805 GRANDY AVENUE
LA GRANDE, OR 97850
US
Number of Packages: 1
UPS Service: UPS Ground Saver®
Weight: 4.0 LBS
Reference Number 1: 212355503949
Reference Number 2: 21235550394900100038
Merchandise Description:  APPAREL AND ACCESSORIES`;
const UPS_UPDATE = UPS_SHIP.replace("This message was sent to you at the request of ZARA DEL AMO FASHION CENTER to notify you that the shipment information below has been transmitted to UPS.\n", "")
  .replace("Weight: 4.0 LBS\nReference Number 1:", "Shipment Type: LetterReference Number 1:");

const STREETS = { velocityStreet: "805 grandy", homeStreets: ["65 rivercrest"] };
const ZARA: PoRef[] = [
  { id: "z0817", supplier: "zara.com", order_id: "54423046297", order_date: "2026-08-17", ships_to: "velocity" },
  { id: "z0913", supplier: "zara.com", order_id: "54452653087", order_date: "2026-09-13", ships_to: "velocity" },
  { id: "z0919", supplier: "zara.com", order_id: "54460855729", order_date: "2026-09-19", ships_to: "velocity" },
  { id: "z1005", supplier: "zara.com", order_id: "54480940897", order_date: "2026-10-05", ships_to: "velocity" },
  { id: "w1", supplier: "walmart.com", order_id: "200015468871641", order_date: "2026-09-14", ships_to: "velocity" },
];
const ALIASES = new Map([["zara del amo fashion center", "zara.com"], ["zara", "zara.com"]]);
const SUPPLIERS = ["zara.com", "walmart.com"];
const EMAIL_AT = new Date("2026-09-16T16:39:05Z");

describe("carrier notices: the parse", () => {
  it("the shipper, the carrier's reference numbers (never a tracking number) and the one UPS number — both notices", () => {
    for (const text of [UPS_SHIP, UPS_UPDATE]) {
      const p = parseTrackingEmail({ subject: "UPS Ship Notification, Tracking Number 1ZV5503JYW00243199", text, fromDomain: "ups.com" });
      expect(p.shipments.map((s) => [s.carrier, s.trackingNumber])).toEqual([["UPS", "1ZV5503JYW00243199"]]);
      expect(p.shipperName).toBe("ZARA DEL AMO FASHION CENTER");
      expect(p.carrierRefs).toEqual(["212355503949", "21235550394900100038"]);
      expect(p.shipToStreet).toBe("805 grandy");
      const rows = rowsFromEmail({ id: "m1", threadId: "t1", date: EMAIL_AT, subject: "UPS Ship Notification" }, p);
      expect(rows[0]).toMatchObject({ shipper_name: "ZARA DEL AMO FASHION CENTER", carrier_refs: ["212355503949", "21235550394900100038"] });
    }
  });
  it("only a carrier's email gets a shipper; FedEx's 'Shipper information' block and PO / invoice references read too", () => {
    expect(isCarrierSender("pkginfo.ups.com")).toBe(true);
    expect(isCarrierSender("fedex.com")).toBe(true);
    expect(isCarrierSender("zara.com")).toBe(false);
    expect(parseTrackingEmail({ subject: "Your order is on its way", text: "From: Zara\nTracking Number: 1ZV5505CYW00333781", fromDomain: "zara.com" }).shipperName).toBeUndefined();
    expect(extractShipper("Shipper information\nACME TOOLS FARGO\n123 Main St")).toBe("ACME TOOLS FARGO");
    expect(extractCarrierRefs("Purchase order number: 4411\nInvoice number: INV-77\nReference: 4411")).toEqual(["4411", "INV-77"]);
    expect(extractShipper("Your package is on its way")).toBeNull();
  });
});

describe("carrier notices: the supplier and the PO", () => {
  it("supplierForShipper: an alias equal to the name, else the one supplier whose alias is a word prefix (4+ characters), else by name", () => {
    expect(supplierForShipper("ZARA DEL AMO FASHION CENTER", ALIASES, SUPPLIERS)).toBe("zara.com");
    expect(supplierForShipper("ZARA SOUTH COAST PLAZA", ALIASES, SUPPLIERS)).toBe("zara.com"); // "zara" is a word prefix
    expect(supplierForShipper("ZARAGOZA IMPORTS", ALIASES, SUPPLIERS)).toBeNull(); // a prefix of a word is not a word prefix
    expect(supplierForShipper("WALMART", new Map(), SUPPLIERS)).toBe("walmart.com"); // supplierByName
    expect(supplierForShipper("AB CO", new Map([["ab", "x.com"]]), ["x.com"])).toBeNull(); // too short to prefix
    expect(supplierForShipper(null, ALIASES, SUPPLIERS)).toBeNull();
  });
  it("candidates: that supplier's POs ordered 0–30 Eastern days before the email, ships_to matching, not closed, not fully shipped", () => {
    expect(shipToKind("805 grandy", STREETS)).toBe("velocity");
    expect(shipToKind("65 rivercrest", STREETS)).toBe("home");
    expect(shipToKind(null, STREETS)).toBeNull();
    expect(carrierCandidates("zara.com", EMAIL_AT, "velocity", ZARA).map((p) => p.id)).toEqual(["z0817", "z0913"]); // 9/19 is after the email
    expect(carrierCandidates("zara.com", EMAIL_AT, "velocity", ZARA.map((p) => (p.id === "z0817" ? { ...p, fully_shipped: true } : p))).map((p) => p.id)).toEqual(["z0913"]);
    expect(carrierCandidates("zara.com", EMAIL_AT, "velocity", ZARA.map((p) => (p.id === "z0817" ? { ...p, closed: true } : p))).map((p) => p.id)).toEqual(["z0913"]);
    expect(carrierCandidates("zara.com", EMAIL_AT, "home", ZARA)).toEqual([]);
    expect(carrierCandidates("zara.com", EMAIL_AT, null, ZARA).map((p) => p.id)).toEqual(["z0817", "z0913"]); // unknown ship-to excludes nothing
    expect(carrierCandidates("zara.com", new Date("2026-09-17T04:00:00Z"), "velocity", ZARA).map((p) => p.id)).toEqual(["z0913"]); // 9/17 ET 00:00 → 8/17 is 31 days back
  });
  it("matchRow: several candidates → ambiguous with them (queued, shown); exactly one → matched via carrier_shipper; never an obvious pair (ups.com is not seeded)", () => {
    const row = { sender_domain: "ups.com", retailer_order_id: null, shipper_name: "ZARA DEL AMO FASHION CENTER", ship_to_kind: "velocity" as const, shipped_at: EMAIL_AT };
    expect(matchRow(row, {}, SUPPLIERS, ZARA, undefined, ALIASES)).toMatchObject({ status: "unmatched", reason: "ambiguous", candidates: ["z0817", "z0913"], supplier: "zara.com", obvious: false });
    const one = ZARA.map((p) => (p.id === "z0817" ? { ...p, fully_shipped: true } : p));
    expect(matchRow(row, {}, SUPPLIERS, one, undefined, ALIASES)).toMatchObject({ status: "matched", po_id: "z0913", via: "carrier_shipper", obvious: false });
    expect(matchRow({ ...row, shipped_at: new Date("2026-12-01T12:00:00Z") }, {}, SUPPLIERS, ZARA, undefined, ALIASES)).toMatchObject({ status: "unmatched", reason: "no_po", supplier: "zara.com" });
    // with an order # the usual rule applies under the shipper's supplier
    expect(matchRow({ ...row, retailer_order_id: "54452653087" }, {}, SUPPLIERS, ZARA, undefined, ALIASES)).toMatchObject({ status: "matched", po_id: "z0913" });
    // no shipper → as before
    expect(matchRow({ ...row, shipper_name: null }, {}, SUPPLIERS, ZARA, undefined, ALIASES)).toMatchObject({ status: "unmatched", reason: "unknown_sender" });
  });
  it("the queue panel shows the candidates as suggestions", () => {
    expect(suggestPos({ retailer_order_id: null, supplier_guess: "zara.com", sender_domain: "ups.com", shipped_at: EMAIL_AT, ship_to_kind: "velocity" }, ZARA).map((s) => s.order_id)).toEqual(["54423046297", "54452653087"]);
    expect(suggestPos({ retailer_order_id: null, supplier_guess: "zara.com", sender_domain: "zara.com" }, ZARA)).toEqual([]);
  });
});

describe("carrier notices: matchTrackingRows", () => {
  it("a row stored before the shipper was read gets it (and the references) from the email; live writes them, a dry run does not", async () => {
    const { matchTrackingRows } = await import("./tracking-match");
    const run = async (dryRun: boolean) => {
      const writes: Array<{ sql: string; params: any[] }> = [];
      const rows = [{ id: 417, carrier: "UPS", tracking_number: "1ZV5503JYW00243199", sender_domain: "ups.com", retailer_order_id: null, email_subject: "UPS Ship Notification", gmail_message_id: "abc12345", shipper_name: null, carrier_refs: null, ship_to_street: "805 grandy", shipped_at: EMAIL_AT }];
      const query = async (sql: string, params?: any[]) => {
        if (sql.includes("FROM po_tracking") && sql.trimStart().startsWith("SELECT")) return { rows };
        if (sql.startsWith("SELECT value FROM settings")) return { rows: [] };
        if (sql.startsWith("SELECT key, value FROM settings")) return { rows: [] };
        if (sql.includes("FROM purchase_orders")) return { rows: ZARA.map((p) => ({ ...p, closed: false, fully_shipped: p.id === "z0817" })) };
        if (sql.startsWith("SELECT alias, supplier FROM supplier_aliases")) return { rows: Array.from(ALIASES, ([alias, supplier]) => ({ alias, supplier })) };
        writes.push({ sql, params: params ?? [] });
        return { rows: [] };
      };
      const r = await matchTrackingRows(query as any, { dryRun, textFor: async () => ({ text: UPS_SHIP, date: EMAIL_AT }) });
      return { r, writes };
    };
    const dry = await run(true);
    expect(dry.writes).toHaveLength(0);
    expect(dry.r.links).toEqual([{ id: 417, po_id: "z0913", supplier: "zara.com", via: "carrier_shipper" }]);
    const live = await run(false);
    expect(live.writes[0].params).toEqual([417, "ZARA DEL AMO FASHION CENTER", ["212355503949", "21235550394900100038"]]);
    expect(live.writes[1].params.slice(0, 5)).toEqual([417, "zara.com", "z0913", "matched", "carrier_shipper"]);
    expect(live.writes.some((w) => /supplier_domain_map|INSERT INTO settings/.test(w.sql))).toBe(false); // ups.com never seeded
  });
});

describe("carrier window: a PO's order date is its calendar day on any host", () => {
  it("a pg DATE (local midnight) and a YYYY-MM-DD string read the same day — 30 days before the email is still in", () => {
    const at = "2026-09-16T16:39:05Z"; // 12:39 ET on 9/16
    const asText: PoRef = { id: "t", supplier: "zara.com", order_id: "1", order_date: "2026-08-17", ships_to: "velocity" };
    const asDate: PoRef = { ...asText, id: "d", order_date: new Date(2026, 7, 17) }; // how pg hands a DATE back, in this process's zone
    expect(carrierCandidates("zara.com", at, "velocity", [asText, asDate]).map((p) => p.id)).toEqual(["t", "d"]);
    expect(carrierCandidates("zara.com", at, "velocity", [{ ...asText, order_date: "2026-08-16" }])).toEqual([]); // 31 days
  });
});
