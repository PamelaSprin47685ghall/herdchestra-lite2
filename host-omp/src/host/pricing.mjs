// Model pricing catalog for the cache economics.
//
// Three responsibilities, one file each:
//  - `pricing/ingest.mjs` reads model tables once at activation and freezes them.
//  - `pricing/policy.mjs` turns one entry into per-token prices.
//  - `pricing/parse.mjs` resolves what the user typed into an entry.
// This module is the public face: these four names are what the rest of the host
// imports, and every one of them is a pure query except `loadPricingCatalog`.
//
// No network access and no writes after construction.

export { charsToTokens } from "./pricing/policy.mjs";
export { preparseModelSpec } from "./pricing/parse.mjs";
export { createEmptyCatalog, loadPricingCatalog } from "./pricing/ingest.mjs";
