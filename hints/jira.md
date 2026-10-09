---
servers: [Jira, Atlassian]
identify: [getJiraIssue, atlassianUserInfo]
---
- Most Jira and Confluence tools need a cloudId. The site hostname (for example "example.atlassian.net") usually works; else get it from getAccessibleAtlassianResources.
- atlassianUserInfo and getAccessibleAtlassianResources take no arguments: pass {}.
