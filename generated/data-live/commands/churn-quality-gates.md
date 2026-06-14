---
description: Run data quality gates for a customer churn dataset.
---
Run customer churn data quality gates on $ARGUMENTS.

Use the data-quality-gatekeeper role. Read the dataset or schema files when available under Vegito permissions.

Return:
- dataset path or requested missing input
- row and column count if available
- schema conformance checks
- missingness and duplicate checks
- target leakage risks
- critical blockers versus warnings
- artifact path for the audit report if written
- memory-worthy data quality risks
