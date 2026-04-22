---
name: find-skill
description: Discover skills available on the Pepper platform. Use when you need a capability you don't currently have — search the catalog, see what's installed, and understand how to request a new skill.
---

## When to use

- You need a capability that doesn't seem to be in your current toolset
- Someone asks you to do something and you're unsure if a skill exists for it
- You want to know what skills are currently installed
- You want to browse available skills by category before starting a task

## When NOT to use

- When you already know which skill you need and it's installed
- For general web research (use web_search instead)

---

## List installed skills

```bash
ls ~/.claude/skills/ 2>/dev/null || echo "No skills directory found"
```

Each subdirectory is an installed skill. To read a skill's description:

```bash
# Read the top of a specific skill
head -10 ~/.claude/skills/<skill-name>/SKILL.md 2>/dev/null
```

---

## Search the full Pepper skill catalog

Requires `PEPPER_CLOUD_URL` to be set (it is in all Pepper-managed containers).

### Get all available skills

```bash
curl -s "${PEPPER_CLOUD_URL}/api/skills/catalog" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(f\"Total skills available: {data['total']}\")
print(f\"  Platform skills: {len(data['platform'])}\")
print(f\"  Catalog skills: {len(data['catalog'])}\")
"
```

### Search by keyword

```bash
# Replace 'email' with any search term
curl -s "${PEPPER_CLOUD_URL}/api/skills/catalog" | python3 -c "
import json, sys
term = 'email'
data = json.load(sys.stdin)
all_skills = data['platform'] + data['catalog']
matches = [s for s in all_skills if term.lower() in s['name'].lower() or term.lower() in s['description'].lower()]
for s in matches:
    print(f\"[{s['category']}] {s['name']}: {s['description']}\")
    print(f\"  install: {s['source_url']}\")
    print()
"
```

### Browse by category

Available categories: `core`, `documents`, `dev-tools`, `integrations`, `sales`, `marketing`, `engineering`, `product`, `finance`, `hr`, `legal`, `operations`, `data`, `support`, `design`, `gtm`, `dev`

```bash
# Replace 'sales' with any category
curl -s "${PEPPER_CLOUD_URL}/api/skills/catalog" | python3 -c "
import json, sys
category = 'sales'
data = json.load(sys.stdin)
all_skills = data['platform'] + data['catalog']
matches = [s for s in all_skills if s['category'] == category]
for s in matches:
    print(f\"{s['name']}: {s['description']}\")
print(f\"\\n{len(matches)} skills in '{category}'\")
"
```

### List all platform skills (installed by default)

```bash
curl -s "${PEPPER_CLOUD_URL}/api/skills/catalog" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data['platform']:
    status = '✓ default' if s['default'] else '  optional'
    print(f\"{status}  [{s['category']}] {s['name']}: {s['description']}\")
"
```

---

## How to get a skill installed

### From the Pepper catalog (self-install)

If the skill you need is in the catalog, install it directly using the `manage_skills` MCP tool:

```bash
# In the manage_skills tool, use action: "add" with the repo slug
# e.g., repo: "marmikcfc/pepper-skills" or "owner/repo-name"
```

The orchestrator will:
1. Validate the repo is in the Pepper catalog
2. Install it via `npx skills add`
3. Send you the result (including any required env vars)
4. Restart the agent so the skill loads (including MCP servers)

**If the skill has required env vars:** installation succeeds but the agent won't restart automatically. Tell the user which vars to add in **dashboard → agent settings → Environment**, then ask them to restart the agent.

### Off-catalog or env-var setup (dashboard path)

1. **Tell the user** what skill you need and its `source_url`
2. **The user** goes to their Pepper dashboard → agent settings → Skills
3. The skill gets provisioned on next agent restart

---

## How skills work

| Type | How the agent uses it |
|------|-----------------------|
| **CLI skill** | Reads SKILL.md docs, runs bash commands |
| **MCP skill** | Gets structured tool definitions from an MCP server |
| **Composio** | Uses `composio search` / `composio execute` CLI |

All skills live in `~/.claude/skills/<skill-name>/SKILL.md`. Claude Code loads them automatically at session start.

---

## Quick reference: notable skill categories

| Category | What's available |
|----------|-----------------|
| `gtm` | Lead enrichment, prospecting, LinkedIn, funding signals, cold outreach, competitor intel |
| `sales` | Account research, call prep, pipeline review, cold call workflows |
| `marketing` | Content creation, SEO, email sequences, CRO, ad creative, brand voice |
| `engineering` | Code review, debugging, architecture, incident response, system design |
| `product` | PRD writing, A/B tests, roadmap, user research, PMF surveys |
| `data` | SQL, data viz, statistical analysis, dashboards |
| `documents` | PDF, Excel, Word, PowerPoint |
| `core` | Web search, browser, workspace memory |
| `integrations` | Email (AgentMail), Twitter/X search, image gen, Composio (500+ apps) |
