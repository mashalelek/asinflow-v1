// AsinFlow Chrome Extension — Side Panel Calculator

(function () {
  "use strict";

  // ── Category Mapping ──────────────────────────────────────────────────
  const CATEGORY_MAP = {
    "Pet Supplies": "Pet Supplies",
    "Grocery & Gourmet Food": "Grocery & Gourmet Food",
    "Grocery": "Grocery & Gourmet Food",
    "Health & Household": "Beauty, Health & Personal Care",
    "Health, Household & Baby Care": "Beauty, Health & Personal Care",
    "Beauty & Personal Care": "Beauty, Health & Personal Care",
    "Home & Kitchen": "Kitchen",
    "Kitchen & Dining": "Kitchen",
    "Tools & Home Improvement": "Tools & Home Improvement",
    "Toys & Games": "Toys & Games",
    "Sports & Outdoors": "Sports & Outdoors",
    "Office Products": "Office Products",
    "Electronics": "Consumer Electronics",
    "Computers & Accessories": "Computers",
    "Cell Phones & Accessories": "Electronics Accessories",
    "Clothing, Shoes & Jewelry": "Clothing & Accessories",
    "Automotive": "Automotive & Powersports",
    "Industrial & Scientific": "Business, Industrial & Scientific",
    "Baby": "Baby Products",
    "Books": "Books",
    "Arts, Crafts & Sewing": "Everything Else",
    "Garden & Outdoor": "Lawn & Garden",
    "Patio, Lawn & Garden": "Lawn & Garden",
    "Musical Instruments": "Musical Instruments & AV Production",
    "Movies & TV": "Media - Music & Video",
    "CDs & Vinyl": "Media - Music & Video",
    "Video Games": "Media - Software & Video Games",
    "Appliances": "Appliances - Compact",
    "Furniture": "Furniture",
    "Mattresses": "Mattresses",
  };

  function mapAmazonCategory(amazonCategory) {
    if (!amazonCategory) return "Everything Else";
    const trimmed = amazonCategory.trim();
    if (CATEGORY_MAP[trimmed]) return CATEGORY_MAP[trimmed];
    // Fuzzy match
    const lower = trimmed.toLowerCase();
    for (const [key, value] of Object.entries(CATEGORY_MAP)) {
      if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
        return value;
      }
    }
    return "Everything Else";
  }

  // ── Fallback Fee Estimation (mirrors server/spapi.ts) ─────────────────
  const CATEGORY_REFERRAL_PERCENTAGES = {
    "Amazon Device Accessories": 0.45,
    "Arts, Crafts & Sewing": 0.15,
    "Automotive": 0.12,
    "Automotive & Powersports": 0.12,
    "Baby Products": 0.08,
    "Beauty": 0.08,
    "Beauty, Health & Personal Care": 0.08,
    "Beauty & Personal Care": 0.08,
    "Books": 0.15,
    "Camera & Photo": 0.08,
    "Cell Phones & Accessories": 0.08,
    "Clothing": 0.17,
    "Clothing & Accessories": 0.17,
    "Consumer Electronics": 0.08,
    "Computers": 0.08,
    "Electronics": 0.08,
    "Electronics Accessories": 0.08,
    "Everything Else": 0.15,
    "Grocery & Gourmet Food": 0.08,
    "Health & Household": 0.08,
    "Health & Personal Care": 0.08,
    "Home & Garden": 0.15,
    "Home & Kitchen": 0.15,
    "Home Improvement": 0.15,
    "Industrial & Scientific": 0.12,
    "Business, Industrial & Scientific": 0.12,
    "Jewelry": 0.20,
    "Kitchen": 0.15,
    "Lawn & Garden": 0.15,
    "Luggage & Travel Accessories": 0.15,
    "Musical Instruments": 0.15,
    "Musical Instruments & AV Production": 0.15,
    "Media - Music & Video": 0.15,
    "Media - Software & Video Games": 0.15,
    "Office Products": 0.15,
    "Outdoors": 0.15,
    "Pet Supplies": 0.15,
    "Shoes": 0.15,
    "Software & Computer Games": 0.15,
    "Sports": 0.15,
    "Sports & Outdoors": 0.15,
    "Tools & Home Improvement": 0.15,
    "Toys & Games": 0.15,
    "Video Games": 0.15,
    "Watches": 0.16,
    "Appliances - Compact": 0.15,
    "Furniture": 0.15,
    "Mattresses": 0.15,
  };

  function getReferralPct(category) {
    if (!category) return 0.15;
    for (const [key, pct] of Object.entries(CATEGORY_REFERRAL_PERCENTAGES)) {
      if (category.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(category.toLowerCase())) {
        return pct;
      }
    }
    return 0.15;
  }

  function estimateFbaFee(weightOz, lengthIn, widthIn, heightIn) {
    const weightLbs = (weightOz || 16) / 16;
    const wOz = weightOz || 16;

    let isLargeStandard = false;
    if (lengthIn && widthIn && heightIn) {
      const sorted = [lengthIn, widthIn, heightIn].sort((a, b) => b - a);
      isLargeStandard = sorted[0] > 15 || sorted[1] > 12 || sorted[2] > 0.75 || weightLbs > 1;
    } else {
      isLargeStandard = weightLbs > 1;
    }

    let fbaFee;
    if (!isLargeStandard) {
      if (wOz <= 2) fbaFee = 3.06;
      else if (wOz <= 4) fbaFee = 3.15;
      else if (wOz <= 6) fbaFee = 3.24;
      else if (wOz <= 8) fbaFee = 3.33;
      else if (wOz <= 10) fbaFee = 3.43;
      else if (wOz <= 12) fbaFee = 3.53;
      else if (wOz <= 14) fbaFee = 3.60;
      else fbaFee = 3.65;
    } else {
      if (wOz <= 4) fbaFee = 3.68;
      else if (wOz <= 8) fbaFee = 3.86;
      else if (wOz <= 12) fbaFee = 4.08;
      else if (weightLbs <= 1) fbaFee = 4.46;
      else if (weightLbs <= 1.25) fbaFee = 4.95;
      else if (weightLbs <= 1.5) fbaFee = 5.19;
      else if (weightLbs <= 2) fbaFee = 5.28;
      else if (weightLbs <= 2.5) fbaFee = 5.42;
      else if (weightLbs <= 3) fbaFee = 5.77;
      else {
        const extraHalfLbs = Math.ceil((weightLbs - 3) * 2);
        fbaFee = 5.77 + extraHalfLbs * 0.16;
      }

      if (lengthIn && widthIn && heightIn) {
        const sorted = [lengthIn, widthIn, heightIn].sort((a, b) => b - a);
        if (sorted[0] > 18 || sorted[1] > 14 || sorted[2] > 8 || weightLbs > 20) {
          fbaFee = 9.73 + Math.max(0, weightLbs - 1) * 0.42;
        }
      }
    }

    return parseFloat(fbaFee.toFixed(2));
  }

  // ── State ─────────────────────────────────────────────────────────────
  let currentProduct = null;
  let settings = null;
  let feeEngine = null;
  let cogsDebounceTimer = null;
  let salePriceDebounceTimer = null;
  let originalScrapedPrice = null; // price from the listing, for the reset button
  let asinExistsInCatalog = false;
  let displayedAsin = null;      // ASIN currently shown in the panel
  let pendingCheckAsin = null;   // ASIN of the in-flight catalog check
  const DEBUG = true;
  function dbg() { if (DEBUG) console.log.apply(console, ["[AsinFlow]"].concat([].slice.call(arguments))); }

  // ── DOM Elements ──────────────────────────────────────────────────────
  const statusBar = document.getElementById("status-bar");
  const statusText = document.getElementById("status-text");
  const emptyState = document.getElementById("empty-state");
  const productContent = document.getElementById("product-content");
  const productImage = document.getElementById("product-image");
  const productAsin = document.getElementById("product-asin");
  const productTitle = document.getElementById("product-title");
  const productBrandCat = document.getElementById("product-brand-cat");
  const dimensionsInfo = document.getElementById("dimensions-info");
  const cogsInput = document.getElementById("cogs-input");
  const buyLinkInput = document.getElementById("buy-link-input");
  const salePriceInput = document.getElementById("sale-price-input");
  const salePriceResetBtn = document.getElementById("sale-price-reset");
  const salePricePrefix = salePriceInput ? salePriceInput.closest(".input-prefix") : null;
  const feeBreakdown = document.getElementById("fee-breakdown");
  const profitabilityIndicator = document.getElementById("profitability-indicator");
  const importBtn = document.getElementById("import-btn");
  const importFeedback = document.getElementById("import-feedback");

  // ── Fee Engine Initialization ─────────────────────────────────────────
  async function initFeeEngine() {
    try {
      const response = await fetch(chrome.runtime.getURL("fee-engine/feeData.json"));
      const feeData = await response.json();
      if (typeof FeeEngine !== "undefined" && !feeData._placeholder) {
        feeEngine = new FeeEngine(feeData);
      }
    } catch (err) {
      console.log("Fee engine not available, using fallback estimation:", err.message);
    }
  }

  // ── Settings & Connection ─────────────────────────────────────────────
  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (response) => {
        if (response) {
          settings = response.settings;
          updateConnectionStatus(response.connected);
        }
        resolve();
      });
    });
  }

  function updateConnectionStatus(connected) {
    statusBar.className = "status-bar " + (connected ? "connected" : "disconnected");
    statusText.textContent = connected ? "Connected to AsinFlow" : "AsinFlow offline";
  }

  // ── Product Display ───────────────────────────────────────────────────
  function displayProduct(product) {
    if (!product || !product.asin) {
      emptyState.style.display = "";
      productContent.style.display = "none";
      displayedAsin = null;
      return;
    }

    const isNewAsin = displayedAsin !== product.asin;
    dbg("displayProduct", product.asin, "isNewAsin:", isNewAsin, "partial:", !!product._partial);

    // If the ASIN changed, fully reset the UI state BEFORE painting anything.
    // This ensures stale data from a previous product is wiped immediately.
    if (isNewAsin) {
      displayedAsin = product.asin;
      asinExistsInCatalog = false;
      cogsInput.value = "";
      buyLinkInput.value = "";
      originalScrapedPrice = typeof product.price === "number" ? product.price : null;
      if (salePriceInput) {
        salePriceInput.value = originalScrapedPrice != null ? originalScrapedPrice.toFixed(2) : "";
      }
      if (salePricePrefix) salePricePrefix.classList.remove("edited");
      if (salePriceResetBtn) salePriceResetBtn.style.display = "none";
      updateImportButtonLabel();

      // Fire the catalog check for the new ASIN
      checkAsinInCatalog(product.asin);
    } else if (!product._partial && originalScrapedPrice == null && typeof product.price === "number") {
      // Late-arriving full data after a partial-first payload — seed the price now
      originalScrapedPrice = product.price;
      if (salePriceInput && !salePriceInput.value) {
        salePriceInput.value = product.price.toFixed(2);
      }
    }

    emptyState.style.display = "none";
    productContent.style.display = "";

    productAsin.textContent = product.asin;
    productAsin.href = product.url || `https://www.amazon.com/dp/${product.asin}`;
    productTitle.textContent = product.title || "Loading\u2026";
    productImage.src = product.imageUrl || "";
    productImage.style.display = product.imageUrl ? "" : "none";

    const parts = [];
    if (product.brand) parts.push(product.brand);
    if (product.category) parts.push(product.category);
    productBrandCat.textContent = parts.join(" \u2022 ");

    // Dimensions info
    if (product.weightOz || product.lengthIn) {
      const dimParts = [];
      if (product.lengthIn && product.widthIn && product.heightIn) {
        dimParts.push(`${product.lengthIn}" x ${product.widthIn}" x ${product.heightIn}"`);
      }
      if (product.weightOz) {
        const lbs = product.weightOz / 16;
        dimParts.push(lbs >= 1 ? `${lbs.toFixed(2)} lbs` : `${product.weightOz.toFixed(1)} oz`);
      }
      dimensionsInfo.textContent = dimParts.join(" \u2022 ");
      dimensionsInfo.className = "dimensions-info";
      dimensionsInfo.style.display = "";
    } else {
      dimensionsInfo.innerHTML = "\u26A0\uFE0F Dimensions not found \u2014 estimate used";
      dimensionsInfo.className = "dimensions-info warning";
      dimensionsInfo.style.display = "";
    }

    // Disable import until we have real data (not just the partial placeholder)
    importBtn.disabled = !!product._partial;
    calculateFees();
  }

  // ── Fee Calculation ───────────────────────────────────────────────────
  function getSettingValue(key, fallback) {
    if (settings && settings[key] != null) return settings[key];
    return fallback;
  }

  function getEffectiveSalePrice() {
    if (salePriceInput) {
      const parsed = parseFloat(salePriceInput.value);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return currentProduct && typeof currentProduct.price === "number" ? currentProduct.price : 0;
  }

  function calculateFees() {
    if (!currentProduct) {
      feeBreakdown.style.display = "none";
      profitabilityIndicator.style.display = "none";
      return;
    }

    const salePrice = getEffectiveSalePrice();
    if (!salePrice) {
      feeBreakdown.style.display = "none";
      profitabilityIndicator.style.display = "none";
      return;
    }

    const cogs = parseFloat(cogsInput.value) || 0;
    const mappedCategory = mapAmazonCategory(currentProduct.category);

    // Calculate fees using fee engine or fallback
    let fbaFee, referralFee, referralPct;
    let usingRealEngine = false;

    if (feeEngine) {
      try {
        const hasDims = currentProduct.lengthIn && currentProduct.widthIn && currentProduct.heightIn;
        const calcMethod = hasDims ? "calculate" : "estimateWithoutDimensions";
        const result = feeEngine[calcMethod]({
          salePrice: salePrice,
          category: mappedCategory,
          weightOz: currentProduct.weightOz || null,
          lengthIn: currentProduct.lengthIn || null,
          widthIn: currentProduct.widthIn || null,
          heightIn: currentProduct.heightIn || null,
        });
        fbaFee = result.fbaFee || 0;
        // Use totalReferralFee to include closing fee (Books/DVDs/Media) and correctly handle tiered rates
        referralFee = (result.totalReferralFee != null ? result.totalReferralFee : result.referralFee) || 0;
        // Derive effective rate from actual fee — reflects tiered blended rate (e.g. 9.2% for $18.16 Grocery)
        referralPct = salePrice > 0 ? referralFee / salePrice : 0;
        usingRealEngine = true;
      } catch (err) {
        console.log("Fee engine error, using fallback:", err);
        fbaFee = estimateFbaFee(currentProduct.weightOz, currentProduct.lengthIn, currentProduct.widthIn, currentProduct.heightIn);
        referralPct = getReferralPct(mappedCategory);
        referralFee = parseFloat((salePrice * referralPct).toFixed(2));
      }
    } else {
      fbaFee = estimateFbaFee(currentProduct.weightOz, currentProduct.lengthIn, currentProduct.widthIn, currentProduct.heightIn);
      referralPct = getReferralPct(mappedCategory);
      referralFee = parseFloat((salePrice * referralPct).toFixed(2));
    }

    const lowInvSurcharge = getSettingValue("low_inventory_surcharge", 0.26);
    const inboundPerLb = getSettingValue("inbound_shipping_per_lb", 0.50);
    const prepCost = getSettingValue("prep_cost", 1.00);
    const additionalFees = getSettingValue("additional_fees", 0);
    const hazmatShipping = getSettingValue("hazmat_shipping", 0);
    const hazmatPrep = getSettingValue("hazmat_prep", 0);

    const weightLbs = currentProduct.weightOz ? currentProduct.weightOz / 16 : null;
    const inboundShipping = weightLbs ? parseFloat((weightLbs * inboundPerLb).toFixed(2)) : 0;
    const totalPrep = prepCost + hazmatPrep;
    const totalAdditional = additionalFees + hazmatShipping;

    const profit = salePrice - cogs - fbaFee - lowInvSurcharge - referralFee - inboundShipping - totalPrep - totalAdditional;
    const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;
    const roi = cogs > 0 ? (profit / cogs) * 100 : 0;

    // Update DOM
    feeBreakdown.style.display = "";

    const rateDisplay = (referralPct * 100);
    // Show 1 decimal for tiered/blended rates (e.g. 9.2%), whole number for clean flat rates
    const rateLabel = Math.abs(rateDisplay - Math.round(rateDisplay)) < 0.05
      ? `${Math.round(rateDisplay)}%`
      : `${rateDisplay.toFixed(1)}%`;

    document.getElementById("fee-referral-pct").textContent = `(${rateLabel})`;
    document.getElementById("fee-referral").textContent = `-${fmt(referralFee)}`;
    document.getElementById("fee-fba").textContent = `-${fmt(fbaFee)}`;
    document.getElementById("fee-low-inv").textContent = `-${fmt(lowInvSurcharge)}`;
    document.getElementById("fee-inbound").textContent = weightLbs ? `-${fmt(inboundShipping)}` : "?";
    document.getElementById("fee-prep").textContent = `-${fmt(totalPrep)}`;

    const additionalRow = document.getElementById("fee-additional-row");
    if (totalAdditional > 0) {
      additionalRow.style.display = "";
      document.getElementById("fee-additional").textContent = `-${fmt(totalAdditional)}`;
    } else {
      additionalRow.style.display = "none";
    }

    const feeCogsEl = document.getElementById("fee-cogs");
    if (cogs > 0) {
      feeCogsEl.textContent = `-${fmt(cogs)}`;
      feeCogsEl.parentElement.style.display = "";
    } else {
      feeCogsEl.parentElement.style.display = "none";
    }

    const profitEl = document.getElementById("fee-profit");
    profitEl.textContent = `${profit >= 0 ? "" : "-"}${fmt(Math.abs(profit))}`;
    profitEl.className = "fee-value " + (profit >= 0 ? "positive" : "negative");

    const marginEl = document.getElementById("fee-margin");
    marginEl.textContent = `${margin.toFixed(1)}%`;
    marginEl.className = "fee-value " + (margin >= 0 ? "positive" : "negative");

    const roiEl = document.getElementById("fee-roi");
    roiEl.textContent = cogs > 0 ? `${roi.toFixed(1)}%` : "--";
    roiEl.className = "fee-value " + (roi >= 0 ? "positive" : "negative");

    // Profitability indicator
    if (cogs > 0) {
      const minRoi = getSettingValue("min_roi", 15);
      const minMargin = getSettingValue("min_margin", 10);
      const meetsRoi = roi >= minRoi;
      const meetsMargin = margin >= minMargin;

      profitabilityIndicator.style.display = "";

      if (meetsRoi && meetsMargin) {
        profitabilityIndicator.className = "profitability-indicator meets";
        profitabilityIndicator.innerHTML = "MEETS THRESHOLDS";
      } else {
        const failures = [];
        if (!meetsRoi) failures.push(`ROI ${roi.toFixed(1)}% < ${minRoi}%`);
        if (!meetsMargin) failures.push(`Margin ${margin.toFixed(1)}% < ${minMargin}%`);
        profitabilityIndicator.className = "profitability-indicator below";
        profitabilityIndicator.innerHTML = `BELOW THRESHOLDS<div class="threshold-detail">${failures.join(" \u2022 ")}</div>`;
      }
    } else {
      profitabilityIndicator.style.display = "none";
    }
  }

  function fmt(n) {
    return "$" + n.toFixed(2);
  }

  // ── AsinFlow Catalog Check ────────────────────────────────────────────
  function defaultImportButtonLabel() {
    return asinExistsInCatalog ? "Update in AsinFlow" : "Import to AsinFlow";
  }

  function updateImportButtonLabel() {
    importBtn.textContent = defaultImportButtonLabel();
    importBtn.className = "import-btn" + (asinExistsInCatalog ? " update" : "");
  }

  function checkAsinInCatalog(asin) {
    if (!asin) return;
    pendingCheckAsin = asin;
    dbg("checkAsinInCatalog sending CHECK_ASIN for", asin);
    chrome.runtime.sendMessage({ type: "CHECK_ASIN", asin }, (response) => {
      if (chrome.runtime.lastError) {
        dbg("CHECK_ASIN runtime error:", chrome.runtime.lastError.message);
        return;
      }
      dbg("CHECK_ASIN response for", asin, response);
      // Ignore stale responses (user has navigated to another ASIN since)
      if (pendingCheckAsin !== asin) {
        dbg("  stale response for", asin, "— current pending is", pendingCheckAsin);
        return;
      }
      // Also ignore if the displayed product has moved on
      if (displayedAsin !== asin) {
        dbg("  displayedAsin changed to", displayedAsin, "— ignoring");
        return;
      }
      if (response && response.exists) {
        asinExistsInCatalog = true;
        // Pre-fill COGS if the catalog has one and the user hasn't typed anything yet
        if (response.cogs != null && !cogsInput.value) {
          const cogsNum = Number(response.cogs);
          if (!isNaN(cogsNum) && cogsNum > 0) {
            dbg("  pre-filling COGS:", cogsNum);
            cogsInput.value = cogsNum.toFixed(2);
            calculateFees();
          }
        }
      } else {
        asinExistsInCatalog = false;
      }
      updateImportButtonLabel();
    });
  }

  // ── Sale Price Input ──────────────────────────────────────────────────
  function onSalePriceInput() {
    if (!salePriceInput) return;
    const edited = originalScrapedPrice != null && parseFloat(salePriceInput.value) !== originalScrapedPrice;
    if (salePricePrefix) salePricePrefix.classList.toggle("edited", !!edited);
    if (salePriceResetBtn) salePriceResetBtn.style.display = edited ? "" : "none";
    clearTimeout(salePriceDebounceTimer);
    salePriceDebounceTimer = setTimeout(calculateFees, 300);
  }

  function resetSalePrice() {
    if (!salePriceInput || originalScrapedPrice == null) return;
    salePriceInput.value = originalScrapedPrice.toFixed(2);
    if (salePricePrefix) salePricePrefix.classList.remove("edited");
    if (salePriceResetBtn) salePriceResetBtn.style.display = "none";
    calculateFees();
  }

  // ── Import ────────────────────────────────────────────────────────────
  async function handleImport() {
    if (!currentProduct) return;

    const wasUpdate = asinExistsInCatalog;
    importBtn.disabled = true;
    importBtn.textContent = wasUpdate ? "Updating..." : "Importing...";

    const data = {
      asin: currentProduct.asin,
      title: currentProduct.title,
      image_url: currentProduct.imageUrl,
      brand: currentProduct.brand,
      category: currentProduct.category,
      weight_oz: currentProduct.weightOz,
      length_in: currentProduct.lengthIn,
      width_in: currentProduct.widthIn,
      height_in: currentProduct.heightIn,
      bsr: currentProduct.bsr,
      sale_price: getEffectiveSalePrice() || currentProduct.price,
    };

    const cogs = parseFloat(cogsInput.value);
    if (!isNaN(cogs) && cogs > 0) {
      data.cogs = cogs;
    }

    const buyLink = buyLinkInput.value.trim();
    if (buyLink) {
      data.buy_link = buyLink;
    }

    chrome.runtime.sendMessage({ type: "IMPORT_ASIN", data }, (response) => {
      if (response?.success) {
        importBtn.textContent = wasUpdate ? "Updated!" : "Imported!";
        importBtn.className = "import-btn success";
        importFeedback.textContent = response.action === "created" ? "ASIN added to AsinFlow" : "ASIN updated in AsinFlow";
        importFeedback.style.display = "";
        // After a successful import, the ASIN definitely exists now
        asinExistsInCatalog = true;
      } else {
        importBtn.textContent = wasUpdate ? "Update Failed" : "Import Failed";
        importBtn.className = "import-btn error";
        importFeedback.textContent = response?.message || "Unknown error";
        importFeedback.style.display = "";
      }

      setTimeout(() => {
        importBtn.disabled = false;
        importFeedback.style.display = "none";
        updateImportButtonLabel();
      }, 3000);
    });
  }

  // ── Event Listeners ───────────────────────────────────────────────────
  cogsInput.addEventListener("input", () => {
    clearTimeout(cogsDebounceTimer);
    cogsDebounceTimer = setTimeout(calculateFees, 300);
  });

  if (salePriceInput) {
    salePriceInput.addEventListener("input", onSalePriceInput);
  }
  if (salePriceResetBtn) {
    salePriceResetBtn.addEventListener("click", resetSalePrice);
  }

  importBtn.addEventListener("click", handleImport);

  // Listen for product data updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "PRODUCT_DATA_UPDATED" && message.data) {
      dbg("received PRODUCT_DATA_UPDATED", message.data.asin);
      currentProduct = message.data;
      displayProduct(currentProduct);
    }
  });

  // ── Initialization ────────────────────────────────────────────────────
  function requestFreshFromTab() {
    chrome.runtime.sendMessage({ type: "REQUEST_PRODUCT_FROM_TAB" }, (tabResponse) => {
      if (chrome.runtime.lastError) {
        dbg("REQUEST_PRODUCT_FROM_TAB error:", chrome.runtime.lastError.message);
        return;
      }
      if (tabResponse?.data) {
        dbg("got fresh tab data for", tabResponse.data.asin);
        currentProduct = tabResponse.data;
        displayProduct(currentProduct);
      }
    });
  }

  async function init() {
    await Promise.all([loadSettings(), initFeeEngine()]);

    // Always prefer fresh data straight from the active tab's content script
    // so we don't paint stale state from a previous product's session storage.
    requestFreshFromTab();

    // Fallback: if the content script isn't loaded yet, use whatever was last
    // stored in session storage by the background worker.
    setTimeout(() => {
      if (!displayedAsin) {
        chrome.runtime.sendMessage({ type: "GET_CURRENT_PRODUCT" }, (response) => {
          if (response?.data && !displayedAsin) {
            dbg("fallback to session-stored product", response.data.asin);
            currentProduct = response.data;
            displayProduct(currentProduct);
          }
        });
      }
    }, 400);
  }

  // Refresh when the side panel regains focus (e.g. user switches tabs)
  window.addEventListener("focus", () => {
    dbg("window focus — re-requesting fresh tab data");
    requestFreshFromTab();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      dbg("visibility visible — re-requesting fresh tab data");
      requestFreshFromTab();
    }
  });

  init();
})();
