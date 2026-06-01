---
title : "How I Built a Self-Hosted, AI-Agnostic Workspace with Active Memory Layering"
image : "/assets/images/post/onecamp-ai-native-hero.png"
author : "Akash Hadagali"
date: 2026-06-01 16:30:00 +0530
description : "How I re-engineered OneCamp to support hot-swappable local and cloud LLMs, implemented a self-calibrating EWMA token budget to prevent context truncation, and designed a structured workspace memory layer spanning Postgres, OpenSearch, and DGraph GraphRAG."
tags : ["OneCamp", "Go", "NextJS", "Architecture", "AI", "Ollama", "PostgreSQL", "Dgraph", "OpenSearch", "GraphRAG"]
---

When I first built [OneCamp as the self-hosted, anti-SaaS workspace](/post/I-Built-OneCamp-The-Anti-SaaS.html), my goal was simple: give teams absolute control over their communication, data, and workflows without paying massive recurring subscription bills. 

But as artificial intelligence shifted from a novelty to an essential teammate, I faced a new engineering dilemma. Standard SaaS platforms integrate AI by funneling all your private company discussions directly into a single, proprietary cloud LLM. 

For a self-hosted workspace, that model is fundamentally broken. Some teams want absolute privacy, running small local models (like Llama 3 or Phi 3) entirely offline on their own hardware. Others want to leverage cloud endpoints (like OpenAI or Anthropic) with their own keys, while some want to route queries through specialized custom endpoints (like vLLM, LM Studio, or OpenRouter).

To solve this, I spent the last week re-engineering OneCamp into a **fully model-agnostic, AI-native operating hub**. 

In this post, I will break down how I engineered an AI-agnostic provider system, solved the silent context-window truncation problem using an **Exponentially Weighted Moving Average (EWMA)** token calibrator, and built an **Active Workspace Memory Layer** that synchronizes decisions, commitments, and open questions across three separate databases in real-time.

---

## 1. Going Model-Agnostic: The Universal Provider Core

To support local runtimes, cloud APIs, and arbitrary developer endpoints without duplicating LLM prompt logic across every feature, I decoupled the execution layer into a unified interface in Go.

```
                              +--------------------------+
                              |    AI Service Manager    |
                              +--------------------------+
                                           |
                    +----------------------+----------------------+
                    |                      |                      |
             +------v------+        +------v------+        +------v------+
             |   Ollama    |        |    OpenAI   |        |  Anthropic  |
             |  (Local)    |        | (Reasoning) |        |   (Cloud)   |
             +-------------+        +-------------+        +-------------+
```

### The Interface Abstraction
Every LLM capability inside OneCamp—whether it is the chat assistant, daily briefing generator, or transcript recap bot—calls a single central interface in `services/AI/interfaces.go`:

```go
type ModelLister interface {
	ListModels(ctx context.Context) ([]ModelInfo, error)
}

type ModelManager interface {
	PullModel(ctx context.Context, tag string, onProgress func(percent float64)) error
	DeleteModel(ctx context.Context, tag string) error
}

type Summarizer interface {
	Summarize(ctx context.Context, text string, systemPrompt string) (string, error)
}
```

By decoupling these services, features like our Chat Composer or Document AI can remain completely oblivious to *where* the model is running. Swapping from a local Ollama model to Claude 3.5 Sonnet requires zero logic changes in the communication controllers.

### Hot-Reloading & SSRF Hardening
In self-hosted environments, administrators expect configuration changes to take effect instantly. 

When an admin updates API credentials or toggles reasoning budgets in the settings console, the backend triggers `ai.ReloadAIService()`. This does not require restarting the Go binary:
1. It reads the new provider profile from PostgreSQL.
2. It builds the new LLM client adapters in a transient state.
3. If a custom `openai_compatible` address is provided, it passes the dialer through an **SSRF Guard** (`httpguard.go`), verifying that the destination IP does not map to localhost, link-local addresses, or cloud instance metadata endpoints (which could allow a rogue LLM agent to map the server's private network).
4. Once verified, it hot-swaps the global pointer. Any *in-flight* chat requests continue on the original client to prevent connection severing, while *new* requests instantly utilize the updated models.

---

## 2. Solving Context Truncation with EWMA Token Calibration

If you've ever integrated local LLMs served by Ollama, you've likely hit a silent, highly frustrating bug. 

Local models are typically initialized with a fixed context window (e.g., `num_ctx = 8192` tokens). When your assembled prompt (which includes system instructions, tool schemas, multi-turn history, and retrieved database context) exceeds that window, the runtime **silently truncates the prompt from the front** to make it fit. 

Because system instructions and tool definitions sit at the very front of the prompt, the model suddenly loses its core guidelines. It begins outputting raw prose instead of JSON, hallucinating formatting, or hallucinating tools.

To solve this, I designed a **dynamic context-budgeting system** (`contextBudget.go`).

```
+-----------------------------------------------------------------+
|                       Total Usable Context                      |
+-----------------------------------------------------------------+
|  Response Reserve (1024)  |  Scaffold / System Prompt (1024)    |
|-----------------------------------------------------------------|
|  Session History (25% of input) |  Workspace Context (75% of input) |
+-----------------------------------------------------------------+
```

### Prompt Budget Allocation
The budget estimator dynamically interrogates the active model's context ceiling and splits it into strict, guarded pools:
*   **Response Reserve**: 1,024 tokens (held back for model generation outputs).
*   **Scaffold Reserve**: 1,024 tokens (covers formatting instructions, tool descriptions, and the active query).
*   **Multi-Turn History**: 25% of the remaining input space.
*   **Workspace Context Blocks**: 75% of the remaining input space (semantic search results, unread message digests).

If the history or database context exceeds its allotted budget, the system recursively trims old turns or low-ranking semantic search items, appending a visible tag: `"\n\n[Context truncated to fit the model's window.]"`.

### The EWMA Token Estimator
But how do we count tokens accurately? Using heavy tokenizers for every model family (tiktoken, Llama BPE, etc.) in a self-hosted Go backend is extremely expensive and practically impossible for custom models. 

While a static `4 characters/token` heuristic is standard, REAL tokenizers diverge wildly (especially on code blocks, markdown tables, or non-English text). 

To solve this, I built a **self-correcting calibrator** that learns the active model's true ratio at runtime:
1. Every successful chat completion returns a prompt token count in its usage headers.
2. The Go backend divides the raw string length of the sent prompt by the returned token count.
3. It folds this new observation into an **Exponentially Weighted Moving Average (EWMA)**:

$$\text{Ratio}_{\text{new}} = \alpha \times \left(\frac{\text{Prompt Chars}}{\text{Prompt Tokens}}\right) + (1 - \alpha) \times \text{Ratio}_{\text{prev}}$$

*   $\alpha = 0.2$ (gives the calibrator a stable trailing memory of about 5 requests, smoothing out outliers).
*   We clamp the learned ratio strictly between $1.5$ and $12.0$ characters per token.
*   After 3 requests are completed, the calibrated ratio overrides the static heuristic, giving the budget engine a highly accurate, model-specific token counter.

---

## 3. The Active Workspace Memory Layer (Postgres + OpenSearch + DGraph)

Most AI integrations rely solely on raw document chunk vectors. When you ask, *"What did we decide during yesterday's planning meeting?"*, the model runs a vector search on the transcript and hopes the relevant text chunks get pulled. 

This often fails because raw chat transcripts are noisy, disorganized, and full of context shifts.

To fix this, I designed the **Structured Workspace Memory Engine** (`memoryExtractor.go`). Instead of storing raw data, OneCamp runs an ambient, opt-in agent that converts chat threads, transcripts, and documents into structured, atomic **facts** categorized into three kinds:
1.  **Decisions**: Concrete choices the team agreed upon.
2.  **Commitments**: Action items assigned to a specific user with an optional due date.
3.  **Questions**: Open, unresolved questions raised during discussions.

### The Multi-Database GraphRAG Ingestion
To make these memories performant, searchable, and secure, the engine processes each extracted fact by writing it to three databases simultaneously:

```
                            +--------------------------+
                            |   Memory Fact Extracted  |
                            +--------------------------+
                                         |
                +------------------------+------------------------+
                |                        |                        |
     +----------v----------+  +----------v----------+  +----------v----------+
     |      Postgres       |  |     OpenSearch      |  |       DGraph        |
     | (System of Record)  |  |  (Vector Semantic)  |  |     (GraphRAG)      |
     +---------------------+  +---------------------+  +---------------------+
```

1.  **PostgreSQL (System of Record)**: Stores the memory payload inside the `workspace_memories` table, securing dates, confidence scores, ownerships, and parent team/project bindings.
2.  **OpenSearch (Semantic Recall)**: Projects the fact with its kind prefix (`"Decision: Migrated file-upload pipelines to zero-trust magic-byte signatures."`) as a high-density vector embedding, allowing instant semantic query matching.
3.  **DGraph (GraphRAG Relations)**: Establishes a graph link connecting the memory node to the user node, channel node, and project node. This allows our AI to perform deep relational traversal (e.g., *"Show me all decisions made by @akash in private channels related to the import project"*).

### Preventing Context Hallucination & Exclusions
To guarantee compliance and trust, I added a granular opt-out system. Administrators or channel moderators can exclude specific channels, group chats, or projects from the memory layer entirely. 

Before the extractor runs, it validates exclusions via `scopeIsExcluded()`:
```go
func scopeIsExcluded(ctx context.Context, scope MemoryScope) bool {
	return check(memoryModels.ExclusionChannel, scope.ChannelUUID) ||
		check(memoryModels.ExclusionProject, scope.ProjectUUID) ||
		check(memoryModels.ExclusionChatGrp, scope.ChatGrpID)
}
```
If a scope is excluded, the extraction pipeline aborts immediately, ensuring private discussions remain completely invisible to the semantic index.

---

## 4. Frontend Resilience: Seamless Streaming & UX

To make this complex backend architecture feel fast and responsive to the user, I had to completely redesign the frontend client workflows in Next.js.

### Hydration-Safe DOM Sanitization (`<SafeHtml>`)
To render rich, formatted AI responses safely, we use `DOMPurify` on the client. But running plain `DOMPurify` on the server during Next.js Pre-rendering (SSR) throws errors because JSDOM is absent. 

This typically leads developers to use ad-hoc checks, resulting in dangerous React hydration mismatches because the server layout differs from the client paint.

To solve this, I built the `<SafeHtml>` component (`SafeHtml.tsx`). 

It outputs an empty tag on both the server and the first client paint, ensuring a perfect 1:1 match. Then, inside `useLayoutEffect` (which executes synchronously *after* DOM mutations but *before* the browser paints), the component sanitizes the HTML string and updates state. 

The user experiences a seamless, safe layout paint with zero layout shifting or unstyled content flashes.

### Visibly Responsive SSE Chunk Streams
For reasoning models (like DeepSeek R1 or OpenAI o3-mini), the model yields two streams: the **thinking trace** (complex logical chains) and the **final output**. 

I built `streamFetch.ts` using direct browser `ReadableStream` readers. It parses Server-Sent Event (SSE) chunks on-the-fly, allowing our chat interfaces to dynamically render both the expandable "thought process" block and the final Markdown response as the characters are generated in real-time.

```
[SSE Stream Source] ──> [ReadableStream Reader] ──> [Split SSE Frame \n\n]
                                                            |
                                        +-------------------+-------------------+
                                        |                                       |
                            [Update Thinking Trace State]           [Update Chat Output State]
```

---

## The Verdict: Fully Autonomous, Private-First AI

By combining model-agnostic client abstractions, EWMA-based token constraints, and a multi-database GraphRAG workspace memory layer, OneCamp delivers on its promise of an enterprise-grade workspace that operates entirely on your own terms. 

You get the power of intelligent workspace briefings, instant unread digests ("Catch Me Up"), automated meeting recaps, and deep semantic searches—without streaming a single byte of your proprietary company data to external SaaS aggregators.

The new AI configuration panel and local model browser are now live in the **Admin Settings > AI Configuration** dashboard. Give it a spin, pull down a local Llama model, and let me know how it performs on your hardware!

---

*Previous posts: [Universal Import Engine: Migrating from 8 SaaS Platforms](/post/How-I-Built-a-Universal-Import-Engine-For-8-Different-Providers.html) · [OneCamp v2.0: GitHub Sync, Webhooks, Archiving](/post/OneCamp-v2-GitHub-Webhooks-Archiving-Redesign.html) · [Why we use two databases](/post/Two-Databases-Postgres-Dgraph-OneCamp.html) · [Building the Anti-SaaS Workspace](/post/I-Built-OneCamp-The-Anti-SaaS.html)*

*For real-time updates on self-hosting and self-correcting systems, [follow me on Twitter](https://twitter.com/akashc777).*
