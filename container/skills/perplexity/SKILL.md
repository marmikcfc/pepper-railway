---
name: perplexity
description: Run AI-grounded web search using Perplexity Sonar — get current, sourced answers with citations for market research, competitive analysis, and real-time information.
---

## When to use Perplexity vs Exa

| Task | Tool |
|------|------|
| AI-grounded answers with citations ("what is X's current pricing?") | `perplexity` |
| Finding specific URLs, pages, or content by domain | `exa-search` |
| Deep multi-step research reports | `perplexity --model sonar-deep-research` |
| Finding recent discussions on Reddit/HN | `exa-search --domain reddit.com` |

---

## Basic usage

```bash
# Quick grounded answer
perplexity "What is Retell AI's pricing in 2026?"

# Deeper search with more sources
perplexity "Latest funding rounds in voice AI space" --model sonar-pro

# Comprehensive multi-step research
perplexity "Comprehensive analysis of B2B SaaS churn benchmarks by company size" --model sonar-deep-research

# Expert reasoning + search
perplexity "What are the unit economics implications of moving from usage-based to seat-based pricing for PLG SaaS?" --model sonar-reasoning-pro
```

---

## Models

| Model | Best for | Speed |
|-------|----------|-------|
| `sonar` | Fast lookups, factual Q&A | Fastest |
| `sonar-pro` | Market research, competitive intel (default) | Fast |
| `sonar-deep-research` | Deep multi-step reports, comprehensive analysis | Slow |
| `sonar-reasoning-pro` | Complex reasoning + web data | Medium |

Default is `sonar-pro` — use it unless you need speed (`sonar`) or depth (`sonar-deep-research`).

---

## Output format

```json
{
  "answer": "The full AI-generated answer...",
  "citations": ["https://source1.com", "https://source2.com"],
  "model": "sonar-pro",
  "usage": { "prompt_tokens": 42, "completion_tokens": 512 }
}
```

Always include citations in your final output when they are available.

---

## Options

```
perplexity "query" [--model MODEL] [--max-tokens N]

--model MODEL      Model (default: sonar-pro)
--max-tokens N     Max output tokens (default: 2000)
```
