# Problem and acceptance

> **Can a telephone interpretation prototype preserve the meaning of bilingual turns through interruptions and connection failures while keeping response delay measurable and bounded?**

**Why it matters:** Missing a negation, number or speaker turn can change the meaning of a conversation. Low first-audio latency alone cannot establish faithful interpretation.

**Central tension:** Early responses reduce waiting, while premature turn completion and echo suppression may discard speech or create overlapping output. Generated summaries can also introduce statements absent from the call.

**Current evidence and gap:** [README.md](README.md) describes the telephony bridge, dashboard and documentation flow. [CLAUDE.md](CLAUDE.md) documents session and audio handling. The documented demonstration does not establish clinical effectiveness, regulatory compliance or accuracy across languages and call conditions.

**Acceptance test:** Replay synthetic, bilingual scripted calls with annotated numbers, negations, code-switching and interruptions. Compare uninterrupted calls with injected delays and disconnects under a fixed model configuration. Measure meaning-preserving turn completion, critical omissions/additions, first-audio and end-of-turn latency, and session cleanup. Compare every generated summary statement with its source turn and require human review of generated documents. Failed or incomplete turns must remain visible.

This defines engineering acceptance for a prototype; no new performance claim is made.
