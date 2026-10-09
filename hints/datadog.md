---
servers: [Datadog]
identify: [analyze_datadog_logs, search_datadog_logs]
---
- analyze_datadog_logs and other DDSQL tools return text, not JSON: a <METADATA> block and the rows as TSV inside <TSV_DATA>…</TSV_DATA>. Parse the TSV in the program: first line is the header, columns are tab-separated.
- DDSQL is a PostgreSQL subset: there is no substr, INTERVAL or CURRENT_TIMESTAMP. Do not filter time in SQL; use the tool's from/to arguments.
- Every Datadog tool needs telemetry: { intent: "<why this call>" }.
- Custom log attributes need extra_columns, e.g. { name: "@graphqlErrorCode", type: "varchar" }, and double quotes in SQL: "@graphqlErrorCode".
- search_datadog_logs with use_log_patterns samples the logs: its counts are lower than analyze_datadog_logs counts.
