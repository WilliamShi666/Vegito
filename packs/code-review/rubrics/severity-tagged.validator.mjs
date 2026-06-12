#!/usr/bin/env node
// Hard check: every finding line must carry a recognized severity tag.
import { readFileSync } from "node:fs";
const text = process.argv[2] ?? readFileSync(0, "utf8");
const findings = text.split(/\n/).filter((l) => /\bfinding\b/i.test(l));
if (findings.length === 0) { console.error("no findings to grade"); process.exit(1); }
const sev = /\b(blocker|major|minor)\b/i;
const missing = findings.filter((l) => !sev.test(l));
if (missing.length > 0) { console.error(`${missing.length} finding(s) lack a severity`); process.exit(1); }
process.exit(0);
