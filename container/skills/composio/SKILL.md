---
name: composio
description: Use composio-tool to take actions on 500+ external apps (HubSpot, Gmail, Jira, Slack, Notion, Salesforce, etc.) — search tools, inspect schemas, and execute actions.
---

## CRITICAL: Never guess tool slugs

**ALWAYS search first.** Tool slugs are unpredictable (e.g. `HUBSPOT_CUSTOMIZABLE_CONTACTS_PAGE_RETRIEVAL`, not `HUBSPOT_LIST_CONTACTS`). If you guess, you will waste calls on "not found" errors.

---

## Credentials check

If `composio-tool apps` returns an error about missing API key, tell the user:
> "To use external app tools, set up Composio in Settings → Integrations at your Pepper Cloud dashboard."

---

## DO NOT use Composio for these services

- **Supabase** → use `supabase` CLI (supabase skill)
- **Agent's own email inbox** → use AgentMail MCP tools (agentmail-cli skill)

**Email distinction:** AgentMail = the agent's own dedicated inbox (receiving messages, maintaining threads). Composio Gmail = the *user's* Gmail account (read, send, draft on their behalf).

**GitHub:** Use Composio for standard operations (create issue, PR, list repos). For complex git operations (clone, checkout, commit, push), use the `gh` CLI alongside.

---

## Gmail workflows

Use Composio to read and act on the **user's Gmail account**. Always `search` before executing — Gmail slugs are not obvious.

```bash
# Send an email
composio-tool search "send email" --toolkit gmail --limit 3
composio-tool execute GMAIL_SEND_EMAIL '{"recipient_email": "user@example.com", "subject": "Hello", "body": "Message body here"}'

# List / search emails
composio-tool search "list emails" --toolkit gmail --limit 3
composio-tool execute GMAIL_LIST_EMAILS '{"query": "is:unread", "max_results": 20}'

# Get a specific email by message ID
composio-tool search "fetch email" --toolkit gmail --limit 3
composio-tool execute GMAIL_FETCH_EMAIL_BY_MESSAGE_ID '{"message_id": "<id from list>"}'

# Create a draft
composio-tool search "create draft" --toolkit gmail --limit 3
composio-tool execute GMAIL_CREATE_EMAIL_DRAFT '{"recipient_email": "user@example.com", "subject": "Draft subject", "body": "Draft body"}'
```

---

## GitHub workflows

Use Composio for standard GitHub CRUD. For git operations (clone, checkout, commit, push) use the `gh` CLI.

```bash
# Create an issue
composio-tool search "create issue" --toolkit github --limit 3
composio-tool execute GITHUB_CREATE_AN_ISSUE '{"owner": "myorg", "repo": "myrepo", "title": "Bug: ...", "body": "Steps to reproduce..."}'

# List repos
composio-tool search "list repositories" --toolkit github --limit 3
composio-tool execute GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER '{}'

# Create a pull request
composio-tool search "create pull request" --toolkit github --limit 3
composio-tool execute GITHUB_CREATE_A_PULL_REQUEST '{"owner": "myorg", "repo": "myrepo", "title": "feat: ...", "head": "feature-branch", "base": "main", "body": "## Summary\n..."}'

# Get a repository
composio-tool execute GITHUB_GET_A_REPOSITORY '{"owner": "myorg", "repo": "myrepo"}'
```

---

## Google Sheets workflows

```bash
# Create a new spreadsheet
composio-tool search "create spreadsheet" --toolkit googlesheets --limit 3
composio-tool execute GOOGLESHEETS_CREATE_GOOGLE_SHEET '{"title": "My Sheet"}'

# Add / update values in a range
composio-tool search "update values" --toolkit googlesheets --limit 3
composio-tool execute GOOGLESHEETS_BATCH_UPDATE_VALUES '{"spreadsheet_id": "<id>", "data": [{"range": "Sheet1!A1", "values": [["Col1", "Col2"], ["Val1", "Val2"]]}]}'

# Read values from a range
composio-tool search "get values" --toolkit googlesheets --limit 3
composio-tool execute GOOGLESHEETS_GET_VALUES_OF_A_SPREADSHEET '{"spreadsheet_id": "<id>", "ranges": ["Sheet1!A1:Z100"]}'

# Add a single row
composio-tool search "add row" --toolkit googlesheets --limit 3
composio-tool execute GOOGLESHEETS_SHEET_FROM_JSON '{"spreadsheet_id": "<id>", "sheet_name": "Sheet1", "data": [{"col1": "val1", "col2": "val2"}]}'
```

---

## Google Calendar workflows

```bash
# Create an event
composio-tool search "create event" --toolkit googlecalendar --limit 3
composio-tool execute GOOGLECALENDAR_CREATE_EVENT '{"summary": "Team Standup", "start": {"dateTime": "2026-04-23T10:00:00Z"}, "end": {"dateTime": "2026-04-23T10:30:00Z"}}'

# List upcoming events
composio-tool search "list events" --toolkit googlecalendar --limit 3
composio-tool execute GOOGLECALENDAR_LIST_EVENTS '{"calendar_id": "primary", "time_min": "2026-04-23T00:00:00Z", "max_results": 10}'

# Find / search events
composio-tool search "find event" --toolkit googlecalendar --limit 3

# Delete an event
composio-tool search "delete event" --toolkit googlecalendar --limit 3
composio-tool execute GOOGLECALENDAR_DELETE_EVENT '{"calendar_id": "primary", "event_id": "<id>"}'
```

---

## Slack workflows

```bash
# Send a message to a channel
composio-tool search "send message" --toolkit slack --limit 3
composio-tool execute SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL '{"channel": "#general", "text": "Hello from Pepper!"}'

# List channels
composio-tool search "list channels" --toolkit slack --limit 3
composio-tool execute SLACK_LISTS_ALL_CHANNELS_IN_A_SLACK_TEAM '{}'

# Fetch channel message history
composio-tool search "channel history" --toolkit slack --limit 3
composio-tool execute SLACK_FETCH_CHANNEL_MESSAGE_HISTORY '{"channel": "C12345678", "limit": 50}'
```

---

## Notion workflows

```bash
# Create a page in a database
composio-tool search "create page" --toolkit notion --limit 3
composio-tool execute NOTION_CREATE_PAGE '{"parent": {"database_id": "<db_id>"}, "properties": {"Name": {"title": [{"text": {"content": "New Page"}}]}}}'

# Search Notion
composio-tool search "search notion" --toolkit notion --limit 3
composio-tool execute NOTION_SEARCH_NOTION '{"query": "meeting notes"}'

# Retrieve a page
composio-tool search "get page" --toolkit notion --limit 3
composio-tool execute NOTION_RETRIEVE_A_PAGE '{"page_id": "<page_id>"}'

# Add content to a page
composio-tool search "add content" --toolkit notion --limit 3
```

---

## Google Drive workflows

```bash
# Find a file
composio-tool search "find file" --toolkit googledrive --limit 3
composio-tool execute GOOGLEDRIVE_FIND_FILE '{"query": "budget report"}'

# Create a file / document
composio-tool search "create file" --toolkit googledrive --limit 3
composio-tool execute GOOGLEDRIVE_CREATE_FILE_FROM_TEXT '{"name": "My Doc", "content": "Document content here"}'

# Get file metadata
composio-tool search "get file" --toolkit googledrive --limit 3
composio-tool execute GOOGLEDRIVE_GET_FILE_METADATA '{"file_id": "<id>"}'

# Create a folder
composio-tool search "create folder" --toolkit googledrive --limit 3
composio-tool execute GOOGLEDRIVE_CREATE_FOLDER '{"name": "Project Assets"}'
```

---

## Twitter / X workflows

Use Composio for all Twitter **actions** (post, like, reply, retweet, DM, follow/unfollow).
Use `x-search` for Twitter **research** (search tweets, check mentions, look up users).

### Post a tweet
```bash
composio-tool search "post tweet" --toolkit twitter --limit 3
composio-tool schema TWITTER_CREATE_TWEET
composio-tool execute TWITTER_CREATE_TWEET '{"text": "Hello from my AI agent!"}'
```

### Reply to a tweet
```bash
composio-tool search "reply" --toolkit twitter --limit 3
composio-tool execute TWITTER_REPLY_TO_TWEET '{"tweet_id": "123456", "text": "Great post!"}'
```

### Research then engage (recommended pattern)
```bash
# 1. Search for mentions
x-search query "@myhandle" --from 2026-04-04

# 2. Like or reply to relevant mentions via Composio
composio-tool execute TWITTER_LIKE_TWEET '{"tweet_id": "..."}'
```

---

## Ideal workflow (3 calls max)

```bash
# 1. Search — get the exact slug (NEVER skip this)
composio-tool search "list contacts" --toolkit hubspot --limit 3

# 2. Schema — check required params (skip if obvious)
composio-tool schema HUBSPOT_CUSTOMIZABLE_CONTACTS_PAGE_RETRIEVAL

# 3. Execute — run it
composio-tool execute HUBSPOT_CUSTOMIZABLE_CONTACTS_PAGE_RETRIEVAL '{}'
```

**Do NOT:**
- Invent slugs like `HUBSPOT_LIST_CONTACTS` or `HUBSPOT_GET_CONTACTS_PAGE`
- Run `tools <toolkit>` to dump 100+ tools then grep — use `search` instead
- Re-execute the same tool to "verify" — trust the first result

---

## Check connected apps

```bash
composio-tool apps
```

If the toolkit isn't connected, tell the user:
> "HubSpot isn't connected yet. Connect it in Settings → Integrations at your Pepper Cloud dashboard."

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `composio-tool search "query" --toolkit name` | Find tools (always start here) |
| `composio-tool search "query" --limit 3` | Fewer results, save tokens |
| `composio-tool schema TOOL_SLUG` | Get input parameters |
| `composio-tool execute TOOL_SLUG '{"..."}'` | Execute a tool |
| `composio-tool apps` | List connected apps |
| `composio-tool tools <toolkit> --limit 20` | Browse toolkit (only if search fails) |

---

## Vercel workflows

Use Composio for all Vercel operations. Do NOT use the Vercel CLI directly.

### Set up CI/CD (link GitHub repo to Vercel)
```bash
# 1. Search for the project creation tool
composio-tool search "create project" --toolkit vercel --limit 3

# 2. Create project linked to GitHub repo (enables auto-deploy on push)
composio-tool execute VERCEL_CREATE_PROJECT2 '{"name":"my-app","gitRepository":{"type":"github","repo":"owner/repo"}}'
```

### Deploy from GitHub
```bash
# 1. Get numeric repo ID from GitHub
composio-tool execute GITHUB_GET_A_REPOSITORY '{"owner":"myorg","repo":"myrepo"}'
# Note the "id" field in the response

# 2. Deploy latest from branch
composio-tool execute VERCEL_CREATE_NEW_DEPLOYMENT '{"name":"my-app","gitSource":{"type":"github","repoId":"668449998","ref":"main"}}'

# 3. Deploy specific commit
composio-tool execute VERCEL_CREATE_NEW_DEPLOYMENT '{"name":"my-app","gitSource":{"type":"github","repoId":"668449998","ref":"main","sha":"abc123"}}'
```

### Get deployment URL and details
```bash
composio-tool search "deployment details" --toolkit vercel --limit 3
composio-tool execute VERCEL_GET_DEPLOYMENT_DETAILS '{"idOrUrl":"<deployment-id>"}'
```

### List all deployments
```bash
composio-tool execute VERCEL_LIST_ALL_DEPLOYMENTS '{"project":"my-app"}'
```

### Pull logs for debugging
```bash
composio-tool execute VERCEL_GET_DEPLOYMENT_LOGS '{"id":"<deployment-id>"}'
composio-tool execute VERCEL_GET_DEPLOYMENT_EVENTS '{"idOrUrl":"<deployment-id>"}'
```

### Manage environment variables
```bash
composio-tool search "environment variable" --toolkit vercel --limit 5
composio-tool execute VERCEL_LIST_ENV_VARIABLES '{"idOrName":"my-project"}'
composio-tool execute VERCEL_ADD_ENVIRONMENT_VARIABLE '{"idOrName":"my-project","key":"API_KEY","value":"xxx","target":["production"],"type":"encrypted"}'
```

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Guessing a slug | **Always** `search` first — slugs are unpredictable |
| Dumping all tools then grepping | Use `search` with `--toolkit` — it's faster and targeted |
| Re-executing to verify data | Trust the first result — don't repeat calls |
| Skipping schema check | Run `schema` if you're unsure about required params |
| Wrong parameter format | Arguments must be valid JSON: `'{"key":"value"}'` |
