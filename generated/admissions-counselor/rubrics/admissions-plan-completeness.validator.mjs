#!/usr/bin/env node
// Hard check: model-generated blueprint signals compiled by Vegito, not arbitrary model code.
import { readFileSync } from "node:fs";
const text = (process.argv[2] ?? readFileSync(0, "utf8")).toLowerCase();
const signals = ["intake","school list","timeline","activities","essays","recommendations","materials checklist","financial aid","ethics","memory","next actions"];
const missing = signals.filter((signal) => !text.includes(String(signal).toLowerCase()));
if (missing.length > 0) { console.error(`missing required signal(s): ${missing.join(", ")}`); process.exit(1); }
process.exit(0);
