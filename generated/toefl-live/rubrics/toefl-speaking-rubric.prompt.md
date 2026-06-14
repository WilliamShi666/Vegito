Evaluate the spoken response on a scale of 0-4 for each dimension: delivery, language use, topic development, according to the official TOEFL iBT Speaking rubrics. Provide a score for each and evidence from the response.
Score scale: score 0-4 in 1 increments
Required signals:
- delivery_score
- language_use_score
- topic_development_score
- overall_avg_score
- evidence_quotes
Quality gates:
- All three rubric dimensions must be evaluated with evidence
- Evidence must be direct quotes or timestamps from the response
- Drill feedback must reference the specific skill and provide a corrective hint
- Memory must be updated with every new session data
- Full test simulation must reproduce realistic timing constraints
- Diagnostic report must include actionable next steps
Data quality gates:
- Audio input must be at least 2 seconds long and contain English speech
- Transcript confidence must be >0.7 (or fallback to text)
- Response must have topic relevance >0.6 to the prompt
- User must consent to recording and data storage before first use
- All stored scores must be in 0-4 range (or 0-30 after conversion)
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
