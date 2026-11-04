// Subjects as orders@ received them (90-day sample, 2026-11-04), names removed.
import { describe, it, expect } from "vitest";
import { classifySubject } from "./order-email-classify";

const type = (s: string) => classifySubject(s).type;

describe("classifySubject", () => {
  it("confirmations across retailers", () => {
    for (const s of [
      "Your ShagTools order has been received!", "We've received your order!", "Your Zoro order #Z12345678 has been received",
      "Got it! Your order #1234567 confirmation", "Confirmation for your order #28686630", "Here’s your Staples order #7123456. Thanks for shopping with us.",
      "Thanks for shopping with us! Here's your order #:102003845702158.", "Order #1234 confirmed", "Your order (#12345) has been confirmed.",
      "Your Nordstrom Rack order #123456, confirmed!", "Confirmation of your Merle Norman order #123", "Thank you for ordering from Tractor Supply Co.!",
      "Order received", "Fwd: Thanks for your order.",
    ]) expect([s, type(s)]).toEqual([s, "order_confirmation"]);
  });

  it("invoices", () => {
    for (const s of ["[ShagTools] Invoice 4126643 for order 4126643 from November 2, 2026", "Zoro: Your receipt for order #Z12345678", "Order receipt from Mister Landscaper"])
      expect([s, type(s)]).toEqual([s, "invoice"]);
  });

  it("shipped", () => {
    for (const s of [
      "Your ShagTools order is now complete", "Your order has shipped", "Your order #123 is shipped!", "Your order #123 from globaltestsupply.com has left our warehouse",
      "Your shipment is heading your way shortly", "Shipment confirmation", "Shipping confirmation! Your order #123 is on the way", "B&H Photo order #123 shipped",
      "A shipment from order #1234 is on the way", "Your package is on the move! 🚚", "Your shipment is now with the carrier", "Your Pyramyd AIR order has shipped (#115450009)",
    ]) expect([s, type(s)]).toEqual([s, "shipped"]);
  });

  it("delivered", () => {
    for (const s of [
      "📦 Your order has arrived!", "Items have arrived from order #102003845702158!", "An item has arrived from order #102003845702158!",
      "Arrived: Your Febreze Spring & Renew... +2 items", "Delivered: Dr Teal's Epsom Salt M... +3 items", "Your item[s] have arrived! Order # 1234 5678",
      "Success! Order #12345678 has arrived.", "Your package has arrived!", "A shipment from order #1234 has been delivered", "Your order 123 is delivered!",
    ]) expect([s, type(s)]).toEqual([s, "delivered"]);
  });

  it("never a document: cancel / refund / return, cart, review, marketing arrivals, in-between notices", () => {
    for (const s of [
      "Your order was canceled", "Your refund is on its way", "Your return has been received", "Complete your order", "Ready to complete your order?",
      "How was your order?", "What did you think about Lavender Lotion", "New arrivals are here", "Holiday collection has arrived",
      "Out for delivery", "Items arrive tomorrow! Order #123", "Your package should arrive by 9pm📦", "Shipment delay on your Tetley order (#123)",
      "Your order is almost here!", "Heads up! Your replacement item is ready to ship.", "Your order is ready for purchase", "Opentip.com - coupon reminder",
    ]) expect([s, type(s)]).toEqual([s, "excluded"]);
  });

  it("no rule, no exclusion: unknown (the AI fallback's input)", () => {
    for (const s of ["Your Jellycat order #123456", "officesupply.com order #123456", "We’re preparing your order!", "Your order #123 has been processed"])
      expect([s, type(s)]).toEqual([s, "unknown"]);
  });

  it("the later stage wins: shipped over a thank-you, shipped over a receipt #", () => {
    expect(type("Thanks for your order — it has shipped")).toBe("shipped");
    expect(type("Your Order Shipped!: Receipt #CS2888677")).toBe("shipped");
  });
});
