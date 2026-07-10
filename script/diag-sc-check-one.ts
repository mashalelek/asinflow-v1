import "dotenv/config";
import { searchListingsItemsByAsin } from "../server/sku-listing-search";
const asin = process.argv[2] ?? "B000JYD0X6";
const r = await searchListingsItemsByAsin(process.env.SP_API_SELLER_ID!, asin);
console.log(`SC search for ${asin}:`);
console.log(JSON.stringify(r, null, 2));
