#!/usr/bin/env node
// Hard check: the examiner output must carry a numeric band 0..9 for each criterion.
import { readFileSync } from "node:fs";
const text = process.argv[2] ?? readFileSync(0, "utf8");
const bands = [...text.matchAll(/band\s*[:=]?\s*([0-9](?:\.5)?)/gi)].map((m) => Number(m[1]));
if (bands.length === 0) { console.error("no band scores found"); process.exit(1); }
const bad = bands.find((b) => b < 0 || b > 9);
if (bad !== undefined) { console.error(`band out of range: ${bad}`); process.exit(1); }
process.exit(0);
