class FeeEngine {
  constructor(feeData) {
    this.data = feeData;
  }

  classifySizeTier(lengthIn, widthIn, heightIn, weightOz) {
    const dims = [lengthIn || 0, widthIn || 0, heightIn || 0].sort((a, b) => b - a);
    const [longest, median, shortest] = dims;
    const weightLb = weightOz / 16;

    if (longest <= 15 && median <= 12 && shortest <= 0.75 && weightOz <= 16)
      return 'Small Standard';
    if (longest <= 18 && median <= 14 && shortest <= 8 && weightLb <= 20)
      return 'Large Standard';
    if (longest <= 37 && median <= 26 && shortest <= 26 && weightLb <= 50)
      return 'Small Bulky';
    if (longest <= 59 && median <= 33 && shortest <= 33 && weightLb <= 50)
      return 'Large Bulky';
    if (weightLb <= 50) return 'Extra-Large 0-50lb';
    if (weightLb <= 70) return 'Extra-Large 50-70lb';
    if (weightLb <= 150) return 'Extra-Large 70-150lb';
    return 'Extra-Large 150+lb';
  }

  getShippingWeight(sizeTier, weightOz, lengthIn, widthIn, heightIn) {
    const weightLb = weightOz / 16;
    if (sizeTier === 'Small Standard' || sizeTier === 'Large Standard') {
      return { weightOz: Math.ceil(weightOz), weightLb };
    }
    const dimWeightLb = ((lengthIn || 0) * (widthIn || 0) * (heightIn || 0)) / 139;
    const shippingWeightLb = Math.max(weightLb, dimWeightLb);
    return { weightOz: Math.ceil(shippingWeightLb * 16), weightLb: shippingWeightLb };
  }

  getPriceTier(salePrice) {
    if (salePrice < 10) return 'under10';
    if (salePrice <= 50) return '10to50';
    return 'over50';
  }

  getFbaFee(sizeTier, shippingWeightOz, salePrice) {
    const tierData = this.data.fbaFulfillmentFees[sizeTier];
    if (!tierData) return { fee: 0, error: 'Unknown size tier: ' + sizeTier };

    const priceTier = this.getPriceTier(salePrice);

    // Weight bracket lookup (Small Standard, Large Standard, Small Bulky)
    if (tierData.weightBrackets) {
      const isOzBased = tierData.weightBrackets[0].hasOwnProperty('maxOz');
      const weightForLookup = isOzBased ? shippingWeightOz : shippingWeightOz / 16;
      const maxKey = isOzBased ? 'maxOz' : 'maxLb';

      for (const bracket of tierData.weightBrackets) {
        if (weightForLookup <= bracket[maxKey]) {
          return { fee: bracket[priceTier], sizeTier, priceTier, weightBracket: bracket[maxKey] + (isOzBased ? 'oz' : 'lb') };
        }
      }

      // Over max bracket: overweight surcharge
      if (tierData.overweightSurcharge) {
        const s = tierData.overweightSurcharge;
        const baseFee = s.baseFee[priceTier];
        if (s.thresholdOz) {
          const excessLb = Math.ceil((shippingWeightOz - s.thresholdOz) / 16);
          return { fee: baseFee + excessLb * s.perLbAbove, sizeTier, priceTier, overweight: true };
        } else if (s.thresholdLb) {
          const excessLb = Math.ceil(shippingWeightOz / 16 - s.thresholdLb);
          return { fee: baseFee + Math.max(0, excessLb) * s.perLbAbove, sizeTier, priceTier, overweight: true };
        }
      }
    }

    // Large Bulky: base fee object + per-lb
    if (tierData.baseFee && typeof tierData.baseFee === 'object') {
      const baseFee = tierData.baseFee[priceTier];
      const weightLb = Math.ceil(shippingWeightOz / 16);
      const excessLb = Math.max(0, weightLb - tierData.firstLbThreshold);
      return { fee: baseFee + excessLb * tierData.perLbAboveFirst, sizeTier, priceTier };
    }

    // Extra-Large: flat base + per-lb
    if (typeof tierData.baseFee === 'number') {
      const weightLb = Math.ceil(shippingWeightOz / 16);
      const excessLb = Math.max(0, weightLb - tierData.firstLbThreshold);
      return { fee: tierData.baseFee + excessLb * tierData.perLbAboveFirst, sizeTier };
    }

    return { fee: 0, error: 'Could not determine FBA fee' };
  }

  getReferralFee(category, salePrice) {
    const refData = this.data.referralFees;
    const catData = refData.categories[category];
    let closingFee = 0, minFee, rate;

    if (!catData) {
      rate = refData.defaultRate;
      minFee = refData.defaultMinFee;
    } else if (catData.tiers) {
      let fee = 0, remainingPrice = salePrice, prevMax = 0;
      for (const tier of catData.tiers) {
        const tierMax = tier.maxPrice === null ? Infinity : tier.maxPrice;
        const portion = Math.min(remainingPrice, tierMax - prevMax);
        if (portion > 0) { fee += portion * tier.rate; remainingPrice -= portion; }
        prevMax = tierMax;
        if (remainingPrice <= 0) break;
      }
      minFee = catData.minFee !== undefined ? catData.minFee : refData.defaultMinFee;
      closingFee = catData.closingFee || 0;
      const referralFee = Math.max(fee, minFee);
      return { referralFee, closingFee, totalReferralFee: referralFee + closingFee, category: category || 'Default (15%)', effectiveRate: salePrice > 0 ? referralFee / salePrice : 0 };
    } else {
      rate = catData.rate;
      minFee = catData.minFee !== undefined ? catData.minFee : refData.defaultMinFee;
      closingFee = catData.closingFee || 0;
    }

    const referralFee = Math.max(salePrice * rate, minFee);
    return { referralFee, closingFee, totalReferralFee: referralFee + closingFee, category: category || 'Default (15%)', effectiveRate: rate };
  }

  getInboundShipping(weightOz, inboundShipPerLb) {
    if (!inboundShipPerLb || !weightOz) return 0;
    return (weightOz / 16) * inboundShipPerLb;
  }

  calculate(input) {
    const { salePrice = 0, category, weightOz = 0, lengthIn = 0, widthIn = 0, heightIn = 0, cogs, isHazmat = false, settings = {} } = input;
    const { inboundShipPerLb = 0.50, prepCost = 1.00, additionalFees = 0, lowInventorySurcharge = 0.26, hazmatShipping = 0, hazmatPrep = 0 } = settings;

    const sizeTier = this.classifySizeTier(lengthIn, widthIn, heightIn, weightOz);
    const shippingWeight = this.getShippingWeight(sizeTier, weightOz, lengthIn, widthIn, heightIn);
    const fbaResult = this.getFbaFee(sizeTier, shippingWeight.weightOz, salePrice);
    const referralResult = this.getReferralFee(category, salePrice);
    const inboundShipping = this.getInboundShipping(weightOz, inboundShipPerLb);
    const hazmatCost = isHazmat ? (hazmatShipping + hazmatPrep) : 0;

    const totalAmazonFees = fbaResult.fee + referralResult.totalReferralFee + lowInventorySurcharge;
    const totalCostPerUnit = (cogs || 0) + inboundShipping + prepCost + additionalFees + hazmatCost;
    const totalDeductions = totalAmazonFees + totalCostPerUnit;
    const profit = salePrice - totalDeductions;
    const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;
    const roi = totalCostPerUnit > 0 ? (profit / totalCostPerUnit) * 100 : 0;

    return {
      salePrice, category: referralResult.category, cogs: cogs !== undefined ? cogs : null,
      sizeTier, shippingWeightOz: shippingWeight.weightOz,
      fbaFee: r(fbaResult.fee), referralFee: r(referralResult.referralFee), closingFee: r(referralResult.closingFee),
      totalReferralFee: r(referralResult.totalReferralFee), inboundShipping: r(inboundShipping),
      prepCost: r(prepCost), additionalFees: r(additionalFees), lowInventorySurcharge: r(lowInventorySurcharge),
      hazmatCost: r(hazmatCost), totalAmazonFees: r(totalAmazonFees), totalCostPerUnit: r(totalCostPerUnit),
      totalDeductions: r(totalDeductions), profit: r(profit), margin: r(margin), roi: r(roi),
      hasCogs: cogs !== null && cogs !== undefined, isHazmat,
      feeDataVersion: this.data._meta.version, feeDataDate: this.data._meta.effectiveDate
    };
  }

  estimateWithoutDimensions(input) {
    const { weightOz = 0 } = input;
    const weightLb = weightOz / 16;
    let tier = weightLb <= 20 ? 'Large Standard' : weightLb <= 50 ? 'Small Bulky' : 'Extra-Large 0-50lb';
    const fakeDims = { 'Large Standard': [14,10,5], 'Small Bulky': [25,15,10], 'Extra-Large 0-50lb': [70,40,30] };
    const [l,w,h] = fakeDims[tier] || [14,10,5];
    return { ...this.calculate({ ...input, lengthIn: l, widthIn: w, heightIn: h }), dimensionsEstimated: true, estimatedSizeTier: tier };
  }

  getCategories() { return Object.keys(this.data.referralFees.categories).sort(); }
  getVersion() { return this.data._meta; }
}

function r(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

if (typeof module !== 'undefined' && module.exports) { module.exports = { FeeEngine }; }
else if (typeof window !== 'undefined') { window.FeeEngine = FeeEngine; }
