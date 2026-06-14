---
description: Run the complete customer churn analysis workflow.
---
Run the customer churn analysis pipeline on $ARGUMENTS.

Use the schema-inspector, data-quality-gatekeeper, eda-analyst, causal-guard, artifact-compiler, and reproducibility-verifier roles.

Workflow:
- locate or ask for the dataset path
- inspect schema and column meanings before conclusions
- run data quality gates for missingness, duplicates, type mismatches, leakage risk, and outliers
- perform descriptive EDA only after quality gates are reported
- reject or rewrite unsupported causal claims
- write declared artifacts such as artifacts/report.md and a reproducibility summary when write permission is available
- record dataset assumptions, quality risks, causal rejections, artifact status, and reproducibility findings as memory-worthy facts

Return schema, data quality, EDA, evidence, causal caution, artifact paths, and reproducibility status.
