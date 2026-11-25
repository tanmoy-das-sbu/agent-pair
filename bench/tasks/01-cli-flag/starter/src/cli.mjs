import { formatSummary } from "./format.mjs";

const items = process.argv.slice(2);
console.log(formatSummary(items));
