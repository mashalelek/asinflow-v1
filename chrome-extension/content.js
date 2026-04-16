// AsinFlow Chrome Extension — Amazon Product Page Scraper

(function () {
  "use strict";

  let lastUrl = location.href;
  let lastSentAsin = null;
  let lastSentTitle = null;
  let urlCheckTimer = null;
  let scrapeTimer = null;
  let scrapeAttempt = 0;
  const MAX_SCRAPE_ATTEMPTS = 8;

  function currentUrlAsin() {
    const m = location.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/);
    return m ? m[1] : null;
  }

  function extractAsin() {
    // Try URL first
    const urlMatch = location.href.match(/\/dp\/([A-Z0-9]{10})/);
    if (urlMatch) return urlMatch[1];

    const gpMatch = location.href.match(/\/gp\/product\/([A-Z0-9]{10})/);
    if (gpMatch) return gpMatch[1];

    // Try DOM
    const asinInput = document.querySelector('input[name="ASIN"]');
    if (asinInput) return asinInput.value;

    const asinDetail = document.getElementById("ASIN");
    if (asinDetail) return asinDetail.textContent.trim();

    // Try detail table
    const detailRows = document.querySelectorAll("#productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li");
    for (const row of detailRows) {
      const text = row.textContent || "";
      if (text.includes("ASIN")) {
        const match = text.match(/[A-Z0-9]{10}/);
        if (match) return match[0];
      }
    }

    return null;
  }

  function extractTitle() {
    const el = document.getElementById("productTitle");
    return el ? el.textContent.trim() : null;
  }

  function extractImage() {
    const selectors = ["#landingImage", "#imgTagWrapperId img", "#main-image-container img", "#imageBlock img"];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const src = el.getAttribute("data-old-hires") || el.getAttribute("src") || "";
        if (src && src.startsWith("http")) return src;
      }
    }
    return null;
  }

  function extractPrice() {
    const selectors = [
      "#corePrice_feature_div .a-price .a-offscreen",
      ".a-price[data-a-color='price'] .a-offscreen",
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#newBuyBoxPrice",
      "span.a-price .a-offscreen",
      "#price_inside_buybox",
      "#buyNewSection .a-price .a-offscreen",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.textContent || "").replace(/[^0-9.]/g, "");
        const price = parseFloat(text);
        if (!isNaN(price) && price > 0) return price;
      }
    }
    return null;
  }

  function extractBrand() {
    const byline = document.getElementById("bylineInfo");
    if (byline) {
      let text = byline.textContent.trim();
      text = text.replace(/^(Visit the |Brand: )/, "").replace(/ Store$/, "");
      return text || null;
    }
    return null;
  }

  function extractCategory() {
    const breadcrumbs = document.querySelector("#wayfinding-breadcrumbs_feature_div");
    if (breadcrumbs) {
      const links = breadcrumbs.querySelectorAll("a");
      if (links.length > 0) {
        return links[0].textContent.trim();
      }
    }
    return null;
  }

  function parseWeight(text) {
    // Handle formats: "1.5 pounds", "14 ounces", "500 grams", "0.5 Kilograms"
    const match = text.match(/([\d.]+)\s*(pound|lb|ounce|oz|gram|kilogram|kg)/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("pound") || unit === "lb") return value * 16; // to oz
    if (unit.startsWith("ounce") || unit === "oz") return value;
    if (unit.startsWith("gram")) return value / 28.3495;
    if (unit.startsWith("kilogram") || unit === "kg") return value * 35.274;
    return null;
  }

  function parseDimensions(text) {
    // Handle: "10 x 8 x 4 inches", "25.4 x 20.32 x 10.16 cm"
    const match = text.match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*(inch|in|cm|centimeter|mm|millimeter)?/i);
    if (!match) return null;
    let l = parseFloat(match[1]);
    let w = parseFloat(match[2]);
    let h = parseFloat(match[3]);
    const unit = (match[4] || "in").toLowerCase();
    if (unit.startsWith("cm") || unit.startsWith("centimeter")) {
      l /= 2.54; w /= 2.54; h /= 2.54;
    } else if (unit.startsWith("mm") || unit.startsWith("millimeter")) {
      l /= 25.4; w /= 25.4; h /= 25.4;
    }
    return { lengthIn: Math.round(l * 100) / 100, widthIn: Math.round(w * 100) / 100, heightIn: Math.round(h * 100) / 100 };
  }

  function extractWeightAndDimensions() {
    let weightOz = null;
    let dims = null;

    // Search product details tables
    const tableSelectors = [
      "#productDetails_detailBullets_sections1 tr",
      "#productDetails_techSpec_section_1 tr",
      ".prodDetTable tr",
      "#detailBullets_feature_div li",
    ];

    for (const sel of tableSelectors) {
      const rows = document.querySelectorAll(sel);
      for (const row of rows) {
        const text = row.textContent || "";
        const lower = text.toLowerCase();

        if ((lower.includes("item weight") || lower.includes("package weight")) && !weightOz) {
          weightOz = parseWeight(text);
        }
        if ((lower.includes("product dimensions") || lower.includes("package dimensions") || lower.includes("item dimensions")) && !dims) {
          dims = parseDimensions(text);
          // Also check for weight in the same row if dimensions contain weight
          if (!weightOz) {
            const weightInDimRow = text.match(/;\s*([\d.]+)\s*(pound|lb|ounce|oz|gram|kilogram|kg)/i);
            if (weightInDimRow) {
              weightOz = parseWeight(weightInDimRow[0]);
            }
          }
        }
      }
    }

    // Also try the "Product information" section
    const techRows = document.querySelectorAll(".a-keyvalue tr, #tech-specs-desktop tr");
    for (const row of techRows) {
      const label = row.querySelector("th, td:first-child");
      const value = row.querySelector("td:last-child");
      if (!label || !value) continue;
      const labelText = label.textContent.toLowerCase().trim();
      const valueText = value.textContent.trim();

      if ((labelText.includes("weight") || labelText.includes("item weight")) && !weightOz) {
        weightOz = parseWeight(valueText);
      }
      if ((labelText.includes("dimensions") || labelText.includes("product dimensions")) && !dims) {
        dims = parseDimensions(valueText);
      }
    }

    return { weightOz, ...(dims || { lengthIn: null, widthIn: null, heightIn: null }) };
  }

  function extractBsr() {
    // Try product details table
    const salesRankRow = document.getElementById("SalesRank");
    if (salesRankRow) {
      const match = salesRankRow.textContent.match(/#([\d,]+)/);
      if (match) return parseInt(match[1].replace(/,/g, ""), 10);
    }

    // Try detail bullets
    const detailSections = document.querySelectorAll(
      "#productDetails_detailBullets_sections1 tr, #detailBullets_feature_div li, .prodDetTable tr"
    );
    for (const row of detailSections) {
      const text = row.textContent || "";
      if (text.toLowerCase().includes("best sellers rank") || text.toLowerCase().includes("amazon best sellers")) {
        const match = text.match(/#([\d,]+)/);
        if (match) return parseInt(match[1].replace(/,/g, ""), 10);
      }
    }

    // Try the BSR widget
    const bsrWidget = document.querySelector("#detailBulletsWrapper_feature_div");
    if (bsrWidget) {
      const text = bsrWidget.textContent || "";
      if (text.toLowerCase().includes("best sellers rank")) {
        const match = text.match(/#([\d,]+)/);
        if (match) return parseInt(match[1].replace(/,/g, ""), 10);
      }
    }

    return null;
  }

  function scrapeProductData() {
    const asin = extractAsin();
    if (!asin) return null;

    const { weightOz, lengthIn, widthIn, heightIn } = extractWeightAndDimensions();

    return {
      asin,
      title: extractTitle(),
      imageUrl: extractImage(),
      price: extractPrice(),
      brand: extractBrand(),
      category: extractCategory(),
      weightOz,
      lengthIn,
      widthIn,
      heightIn,
      bsr: extractBsr(),
      url: location.href,
    };
  }

  function safeSendMessage(payload) {
    try {
      chrome.runtime.sendMessage(payload, () => {
        // Swallow "Receiving end does not exist" errors when no listener is present
        if (chrome.runtime.lastError) {
          // no-op
        }
      });
    } catch (e) {
      // Extension context may be invalidated during navigation — ignore
    }
  }

  // Scrape immediately and send. If DOM isn't ready yet, retry with backoff
  // until a valid ASIN + at least a title is found (or attempts exhausted).
  function scrapeAndSend(reason) {
    clearTimeout(scrapeTimer);
    const data = scrapeProductData();
    const urlAsin = currentUrlAsin();

    // If URL no longer points to a product page, clear state
    if (!urlAsin) {
      lastSentAsin = null;
      lastSentTitle = null;
      return;
    }

    // If DOM hasn't caught up yet (missing title/image), retry shortly
    const looksReady = data && data.asin === urlAsin && data.title;
    if (!looksReady && scrapeAttempt < MAX_SCRAPE_ATTEMPTS) {
      scrapeAttempt++;
      scrapeTimer = setTimeout(() => scrapeAndSend(reason), 300);
      // Still send a minimal ASIN-only payload on the first attempt so the
      // side panel can clear stale data immediately
      if (scrapeAttempt === 1 && urlAsin && urlAsin !== lastSentAsin) {
        lastSentAsin = urlAsin;
        safeSendMessage({
          type: "PRODUCT_DATA",
          data: {
            asin: urlAsin,
            title: null,
            imageUrl: null,
            price: null,
            brand: null,
            category: null,
            weightOz: null,
            lengthIn: null,
            widthIn: null,
            heightIn: null,
            bsr: null,
            url: location.href,
            _partial: true,
          },
        });
      }
      return;
    }

    if (!data) return;

    // Only suppress re-sends if BOTH asin and title are identical to the last
    // send (so the partial → full upgrade always goes through)
    if (data.asin === lastSentAsin && data.title === lastSentTitle) return;

    lastSentAsin = data.asin;
    lastSentTitle = data.title;
    scrapeAttempt = 0;
    safeSendMessage({ type: "PRODUCT_DATA", data });
  }

  function onUrlMaybeChanged(reason) {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    scrapeAttempt = 0;
    // Slight delay so Amazon can swap the DOM after a SPA nav
    clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(() => scrapeAndSend(reason), 250);
  }

  // Listen for requests from side panel
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "REQUEST_PRODUCT_DATA") {
      const data = scrapeProductData();
      sendResponse({ type: "PRODUCT_DATA", data });
      return true;
    }
  });

  // ── Initial scrape ───────────────────────────────────────────────────
  scrapeAndSend("initial");

  // ── Navigation detection (four redundant strategies) ────────────────
  // 1. URL polling — most reliable backup
  urlCheckTimer = setInterval(() => onUrlMaybeChanged("poll"), 500);

  // 2. MutationObserver on <html> — catches DOM mutations from SPA nav
  const rootNode = document.documentElement || document.body;
  if (rootNode) {
    const observer = new MutationObserver(() => onUrlMaybeChanged("mutation"));
    observer.observe(rootNode, { childList: true, subtree: true });
  }

  // 3. Back/forward navigation
  window.addEventListener("popstate", () => onUrlMaybeChanged("popstate"));
  window.addEventListener("hashchange", () => onUrlMaybeChanged("hashchange"));

  // 4. Patch pushState / replaceState to catch programmatic SPA navigation
  try {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const ret = origPush.apply(this, arguments);
      setTimeout(() => onUrlMaybeChanged("pushState"), 50);
      return ret;
    };
    history.replaceState = function () {
      const ret = origReplace.apply(this, arguments);
      setTimeout(() => onUrlMaybeChanged("replaceState"), 50);
      return ret;
    };
  } catch (e) {
    // ignore
  }
})();
