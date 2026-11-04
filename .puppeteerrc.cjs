// Puppeteer's browser download lives inside the project (SPEC §22 "PO
// documents"): Render keeps the build directory at runtime but not the
// build machine's ~/.cache, so the default location would leave the server
// without Chrome. Gitignored (.cache/).
const { join } = require("path");
module.exports = { cacheDirectory: join(__dirname, ".cache", "puppeteer") };
