Evaluate the overall data quality based on completeness, validity, and consistency using the quality audit output.
Score scale: score 1-5 in 1 increments
Required signals:
- missing_rate
- outlier_count
- schema_valid
Quality gates:
- schema_completeness
- no_critical_missing_values
- no_unsupported_causal_claims
- reproducibility_certificate_present
Data quality gates:
- missing_values_threshold
- outlier_detection
- schema_conformance
Artifact outputs:
- final-churn-analysis-report (artifacts/report.md): Final customer churn analysis report containing EDA findings, data quality summary, and a clear statement of non-causal nature of all inferences.
  Required signals: eda_complete, causal_approval, quality_pass
- reproducibility-package (artifacts/reproducibility.zip): A ZIP archive containing all analysis logs, seeds, environment snapshot, and a verification certificate.
  Required signals: reproducibility_certificate, env_record, seed_record
Verification path:
- Step: 1. Load raw customer churn dataset from the provided snapshot.
- Step: 2. Re-run schema inspection using the logged metadata.
- Step: 3. Execute data quality checks with identical parameters and thresholds.
- Step: 4. Perform EDA steps exactly as logged, using the recorded random seeds.
- Step: 5. Compare the newly generated report, figures, and audit outputs with the certified originals.
- Step: 6. Confirm that no manual intervention influenced any result.
- Success criterion: All outputs are bitwise identical or within an acceptable numeric tolerance.
- Success criterion: Environment dependencies (library versions, OS) match the original specification.
- Success criterion: The reproduction uses only the raw snapshot and the packaged logs—no external data.
