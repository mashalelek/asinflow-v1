const { FeeEngine } = require('./feeEngine');
const feeData = require('./feeData.json');
const engine = new FeeEngine(feeData);
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  ✅ ' + name); }
  catch (e) { failed++; console.log('  ❌ ' + name); console.log('     ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertClose(a, e, t, m) { if (Math.abs(a-e) > t) throw new Error((m||'') + ': expected ~' + e + ', got ' + a); }

console.log('\n📏 SIZE TIERS');
test('Small Standard', () => assert(engine.classifySizeTier(12,8,0.5,6) === 'Small Standard'));
test('Small Standard at max', () => assert(engine.classifySizeTier(15,12,0.75,16) === 'Small Standard'));
test('Too thick → Large Standard', () => assert(engine.classifySizeTier(12,8,1,6) === 'Large Standard'));
test('Too heavy → Large Standard', () => assert(engine.classifySizeTier(12,8,0.5,20) === 'Large Standard'));
test('Large Standard typical', () => assert(engine.classifySizeTier(14,10,5,14*16) === 'Large Standard'));
test('Large Standard at max', () => assert(engine.classifySizeTier(18,14,8,20*16) === 'Large Standard'));
test('Longest >18 → Small Bulky', () => assert(engine.classifySizeTier(20,12,6,10*16) === 'Small Bulky'));
test('Weight >20lb → Small Bulky', () => assert(engine.classifySizeTier(16,12,6,25*16) === 'Small Bulky'));
test('Large Bulky', () => assert(engine.classifySizeTier(50,30,30,40*16) === 'Large Bulky'));
test('Extra-Large', () => assert(engine.classifySizeTier(65,30,30,40*16) === 'Extra-Large 0-50lb'));
test('Dimension order independence', () => {
  assert(engine.classifySizeTier(0.5,12,8,6) === 'Small Standard');
  assert(engine.classifySizeTier(8,0.5,12,6) === 'Small Standard');
});

console.log('\n💰 FBA FEES');
test('Small Std 6oz $25', () => { const r = engine.getFbaFee('Small Standard',6,25); assertClose(r.fee,2.86,0.01); });
test('Small Std 6oz <$10', () => { const r = engine.getFbaFee('Small Standard',6,8); assertClose(r.fee,2.49,0.01); });
test('Small Std 6oz >$50', () => { const r = engine.getFbaFee('Small Standard',6,65); assertClose(r.fee,3.37,0.01); });
test('Large Std 12oz $30', () => { const r = engine.getFbaFee('Large Standard',12,30); assertClose(r.fee,3.64,0.01); });
test('Large Std 2lb $30', () => { const r = engine.getFbaFee('Large Standard',32,30); assertClose(r.fee,4.64,0.01); });
test('Large Std 5lb overweight $30', () => {
  const r = engine.getFbaFee('Large Standard',80,30);
  assertClose(r.fee,5.84,0.15,'5lb FBA');
  assert(r.overweight === true);
});
test('Large Std 10lb $30', () => { assertClose(engine.getFbaFee('Large Standard',160,30).fee,7.74,0.20); });
test('Price tier $10 = 10to50', () => assert(engine.getFbaFee('Large Standard',12,10).priceTier === '10to50'));
test('Price tier $50 = 10to50', () => assert(engine.getFbaFee('Large Standard',12,50).priceTier === '10to50'));
test('Price tier $50.01 = over50', () => assert(engine.getFbaFee('Large Standard',12,50.01).priceTier === 'over50'));

console.log('\n🏷️  REFERRAL FEES');
test('Pet Supplies 15% at $30', () => assertClose(engine.getReferralFee('Pet Supplies',30).referralFee, 4.50, 0.01));
test('Electronics 8% at $100', () => assertClose(engine.getReferralFee('Consumer Electronics',100).referralFee, 8.00, 0.01));
test('Grocery tiered $12', () => assertClose(engine.getReferralFee('Grocery & Gourmet Food',12).referralFee, 0.96, 0.01));
test('Grocery tiered $25', () => assertClose(engine.getReferralFee('Grocery & Gourmet Food',25).referralFee, 2.70, 0.01));
test('Apparel $12', () => assertClose(engine.getReferralFee('Clothing & Accessories',12).referralFee, 0.60, 0.01));
test('Apparel $18', () => assertClose(engine.getReferralFee('Clothing & Accessories',18).referralFee, 1.05, 0.01));
test('Apparel $50', () => assertClose(engine.getReferralFee('Clothing & Accessories',50).referralFee, 6.35, 0.01));
test('Books + closing fee', () => {
  const r = engine.getReferralFee('Books',20);
  assertClose(r.referralFee,3.00,0.01); assertClose(r.closingFee,1.80,0.01);
});
test('Min fee $0.30', () => assertClose(engine.getReferralFee('Consumer Electronics',2).referralFee, 0.30, 0.01));
test('Unknown → 15%', () => assertClose(engine.getReferralFee('Fake Category',30).referralFee, 4.50, 0.01));
test('Jewelry tiered $400', () => assertClose(engine.getReferralFee('Jewelry',400).referralFee, 57.50, 0.01));

console.log('\n📊 FULL CALCULATION');
test('Typical wholesale product', () => {
  const r = engine.calculate({ salePrice:29.99, category:'Pet Supplies', weightOz:14, lengthIn:10, widthIn:8, heightIn:4, cogs:12.50,
    settings:{ inboundShipPerLb:0.50, prepCost:1.00, additionalFees:0, lowInventorySurcharge:0.26 }});
  assert(r.sizeTier === 'Large Standard'); assert(r.fbaFee > 3 && r.fbaFee < 5);
  assert(r.profit > 0); assert(r.hasCogs === true);
  console.log('     → Profit: $' + r.profit + ', Margin: ' + r.margin + '%, ROI: ' + r.roi + '%');
});
test('No COGS', () => {
  const r = engine.calculate({ salePrice:25, category:'Home & Garden', weightOz:10, lengthIn:8, widthIn:6, heightIn:3,
    settings:{ inboundShipPerLb:0.50, prepCost:1.00, lowInventorySurcharge:0.26 }});
  assert(r.hasCogs === false); assert(r.fbaFee > 0);
});
test('Under $10 gets low-price rate', () => {
  const r = engine.calculate({ salePrice:7.99, category:'Toys & Games', weightOz:4, lengthIn:6, widthIn:4, heightIn:2, cogs:1.50,
    settings:{ inboundShipPerLb:0.50, prepCost:1.00, lowInventorySurcharge:0.26 }});
  assert(r.fbaFee < 3, 'Low-price FBA: ' + r.fbaFee);
});
test('Hazmat surcharges', () => {
  const r = engine.calculate({ salePrice:25, category:'Beauty, Health & Personal Care', weightOz:8, lengthIn:6, widthIn:4, heightIn:3,
    cogs:8, isHazmat:true, settings:{ inboundShipPerLb:0.50, prepCost:1.00, lowInventorySurcharge:0.26, hazmatShipping:0.50, hazmatPrep:0.25 }});
  assertClose(r.hazmatCost, 0.75, 0.01);
});

console.log('\n🔮 WITHOUT DIMENSIONS');
test('10oz item estimates Large Standard', () => {
  const r = engine.estimateWithoutDimensions({ salePrice:25, category:'Sports & Outdoors', weightOz:10, cogs:8,
    settings:{ inboundShipPerLb:0.50, prepCost:1.00, lowInventorySurcharge:0.26 }});
  assert(r.dimensionsEstimated === true); assert(r.sizeTier === 'Large Standard');
});

console.log('\n📖 CROSS-REFERENCE: Nventory $29.99 Kitchen Gadget');
test('Matches Nventory example', () => {
  const r = engine.calculate({ salePrice:29.99, category:'Kitchen', weightOz:14, lengthIn:10, widthIn:8, heightIn:4, cogs:8.00,
    settings:{ inboundShipPerLb:0, prepCost:0, additionalFees:0, lowInventorySurcharge:0 }});
  assertClose(r.referralFee, 4.50, 0.05, 'Referral');
  assertClose(r.fbaFee, 4.04, 0.10, 'FBA (14oz = 16oz bracket)');
  console.log('     → FBA: $' + r.fbaFee + ' (14oz→16oz bracket), Referral: $' + r.referralFee + ' (ref: $4.50)');
});

console.log('\n🔧 UTILITIES');
test('getCategories', () => { const c = engine.getCategories(); assert(c.length > 30); assert(c.includes('Pet Supplies')); });
test('getVersion', () => assert(engine.getVersion().version === '2026.1'));

console.log('\n' + '═'.repeat(50));
console.log('  ' + passed + ' passed, ' + failed + ' failed out of ' + (passed+failed));
if (failed > 0) { console.log('  ⚠️  Failures detected\n'); process.exit(1); }
else console.log('  🎉 All tests passed!\n');
