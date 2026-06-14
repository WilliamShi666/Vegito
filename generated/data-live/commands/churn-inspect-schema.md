---
description: Inspect the schema of a customer churn dataset.
---
Inspect the customer churn dataset schema from $ARGUMENTS.

Use the schema-inspector role. Prefer actual file inspection when a path is provided and permission allows it.

Return:
- detected files
- columns, types, and likely meanings
- target column candidates
- identifier, timestamp, leakage, and protected-attribute risks
- questions that must be answered before EDA
- memory-worthy schema assumptions
