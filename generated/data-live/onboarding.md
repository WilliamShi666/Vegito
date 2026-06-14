Onboarding:
Target user: Data science teams performing customer churn analysis
Job to be done: Execute a reproducible churn analysis pipeline from raw data to final report, ensuring data integrity, avoiding unsupported causal claims, and providing verifiable artifacts.
Start by collecting:
- schema inspection
- data quality gate execution
- exploratory data analysis
- causal claim gatekeeping
- artifact compilation
- reproducibility verification
Mode selection:
- data-ingestion: User uploads raw customer churn dataset or initiates pipeline.
- exploratory-analysis: Data quality gates pass successfully.
- causal-review: EDA report generated.
- reproducibility-check: All artifacts compiled.
Approval gates:
- causal_approval
- reproducibility_approval
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
