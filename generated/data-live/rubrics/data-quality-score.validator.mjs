#!/usr/bin/env node
// Hard check: model-generated blueprint signals compiled by Vegito, not arbitrary model code.
import { readFileSync } from "node:fs";
const text = (process.argv[2] ?? readFileSync(0, "utf8")).toLowerCase();
const signals = ["missing_rate","outlier_count","schema_valid"];
const missing = signals.filter((signal) => !text.includes(String(signal).toLowerCase()));
if (missing.length > 0) { console.error(`missing required signal(s): ${missing.join(", ")}`); process.exit(1); }
const scoreLabels = ["score"];
const scoreLabelText = scoreLabels.join(" or ");
const escapedScoreLabels = scoreLabels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const scorePattern = new RegExp(`(?:${escapedScoreLabels.join("|")})\\s*[:=]?\\s*(-?\\d+(?:\\.\\d+)?)`, "gi");
const scores = [...text.matchAll(scorePattern)].map((m) => Number(m[1]));
if (scores.length === 0) { console.error(`no ${scoreLabelText} scores found`); process.exit(1); }
const scoreMin = 1;
const scoreMax = 5;
const scoreIncrement = 1;
const outOfRange = scores.find((score) => score < scoreMin || score > scoreMax);
if (outOfRange !== undefined) { console.error(`${scoreLabelText} out of range: ${outOfRange}`); process.exit(1); }
if (scoreIncrement > 0) {
  const offStep = scores.find((score) => Math.abs(scoreMin + Math.round((score - scoreMin) / scoreIncrement) * scoreIncrement - score) > 1e-9);
  if (offStep !== undefined) { console.error(`${scoreLabelText} does not match increment ${scoreIncrement}: ${offStep}`); process.exit(1); }
}
const artifactOutputs = [{"name":"final-churn-analysis-report","path":"artifacts/report.md","requiredSignals":["eda_complete","causal_approval","quality_pass"]},{"name":"reproducibility-package","path":"artifacts/reproducibility.zip","requiredSignals":["reproducibility_certificate","env_record","seed_record"]}];
const missingArtifactSignals = artifactOutputs.flatMap((artifact) => [artifact.name, artifact.path, ...artifact.requiredSignals].filter((signal) => !text.includes(String(signal).toLowerCase())));
if (missingArtifactSignals.length > 0) { console.error(`missing artifact output signal(s): ${missingArtifactSignals.join(", ")}`); process.exit(1); }
const verificationSignals = ["All outputs are bitwise identical or within an acceptable numeric tolerance.","Environment dependencies (library versions, OS) match the original specification.","The reproduction uses only the raw snapshot and the packaged logs—no external data."];
const missingVerificationSignals = verificationSignals.filter((signal) => !text.includes(String(signal).toLowerCase()));
if (missingVerificationSignals.length > 0) { console.error(`missing verification signal(s): ${missingVerificationSignals.join(", ")}`); process.exit(1); }
process.exit(0);
