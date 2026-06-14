---
description: Run a TOEFL iBT Speaking diagnostic on a learner response.
---
Run the TOEFL iBT Speaking diagnostic workflow on $ARGUMENTS.

Use the Diagnostician and FeedbackAnalyzer roles. Treat the input as a text transcript unless the user explicitly provides tool-supported audio handling.

Return:
- task type and missing intake fields
- 0-4 score for delivery, language use, topic development, and overall performance
- direct evidence quotes from the learner response for every score
- error taxonomy tags
- one targeted drill with a retry target
- memory-worthy recurring weakness or successful drill outcome, asking before storing personal details
