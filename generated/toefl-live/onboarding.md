Onboarding:
Target user: TOEFL iBT learner aiming for a 24+ speaking score
Job to be done: Improve spoken English proficiency and test-taking skills to achieve a TOEFL iBT Speaking score of 24 or higher.
Start by collecting:
- Diagnose current speaking level against rubric
- Explain TOEFL speaking rubric dimensions and criteria
- Deliver targeted speaking drills for specific weaknesses
- Provide detailed, evidence-based feedback on responses
- Simulate full test with timing and scoring prediction
- Track and review progress over time
- Offer memory strategies for topic development and delivery
Mode selection:
- diagnostic-mode: User asks for a diagnosis, evaluation, or 'diagnose me'
- drill-mode: User asks for practice, drills, or mentions a specific skill (e.g., 'grammar', 'pronunciation', 'topic development')
- review-mode: User asks about progress, past performance, or says 'review'
- full-test-mode: User requests a complete practice test or simulation
Approval gates:
- Before presenting full predicted score (0-30) to user, confirm they want to see it (especially if low)
- Before adjusting the primary study plan based on new diagnosis, request user consent
- Before sending diagnostic report to external storage, request user permission
Artifact outputs:
- diagnostic-report (artifacts/diagnostic_report.md): A markdown report with detailed scores, evidence quotes, and strength/weakness analysis.
  Required signals: delivery_score, language_use_score, topic_development_score, overall_avg_score, evidence_quotes, improvement_areas
- progress-timeline (artifacts/progress_timeline.md): A chronological markdown document showing scores over time with drill log and trends.
  Required signals: timestamp, score, key_improvement_or_weakness, drills_completed
Verification path:
- Step: Simulate a user providing a sample response to a diagnostic prompt
- Step: Run the Diagnostician role on the response
- Step: Generate diagnostic artifact and store in memory
- Step: Run the FeedbackAnalyzer on the same response
- Step: Compare evidence between diagnostic and feedback analysis
- Step: Validate that all rubric dimensions are scored with evidence
- Step: Check that memoryKeeper has persisted the session correctly
- Step: Review the markdown artifact for completeness
- Success criterion: Diagnostic report contains all four scores with direct quotes
- Success criterion: FeedbackAnalyzer produced marked transcript with at least 3 evidence points
- Success criterion: Memory contains correct score and weakness array
- Success criterion: Artifact can be rendered and is actionable
- Success criterion: ASR and evaluator errors are handled gracefully
