---
name: incident-report
description: Template and rules for writing blameless incident reports / postmortems. Use when asked to write up an outage or incident.
---

# Incident report

Write blameless reports with these sections, in order:

1. **Summary**: two sentences, impact first.
2. **Impact**: who was affected, for how long, and what they saw.
3. **Timeline** in UTC, as a table (time | event).
4. **Root cause**: what happened technically. No names.
5. **What went well / what didn't**
6. **Action items**: a table (action | owner role | priority).

Use the `get_time` tool to timestamp the report.
