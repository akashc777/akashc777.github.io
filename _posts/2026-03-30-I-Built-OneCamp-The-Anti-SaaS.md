---
title : "I Spent a Year Building OneCamp. Here's the Complete Architecture."
image : "/assets/images/post/onecamp-hero.png"
author : "Akash Hadagali"
date: 2026-03-30 12:00:00 +0530
description : "The honest, technical story of building OneCamp  -  a self-hosted all-in-one workspace. Full system architecture, real tech choices, and the reality of launch day."
tags : ["OneCamp", "SaaS", "Go", "NextJS", "Self-Hosted", "Startup", "OpenSource", "IndieHacker"]
---

On March 9th, 2026, I launched [OneCamp](https://onemana.dev/onecamp-product).

It's a self-hosted, all-in-one workspace. Chat. Tasks. Docs. Video calls. Calendar. A local AI assistant. All on your own server. One-time payment. No per-seat pricing.

This post is about the year that led to that launch  -  the actual architecture, the real tech decisions, and the most important lesson I learned the hard way. Grab a coffee. This is going to be a long one.

---

## The Itch That Started It 🤔

Early in my career, I worked on large-scale distributed systems. Great teams, genuinely fun problems, real production scale. But every single day I'd open Slack, then Jira, then Notion, then Google Meet, then Google Calendar.

Five apps. Five subscription bills. Five notification systems that don't talk to each other. Five places where context dies.

You finish a task in Jira and have to manually post in Slack that it's done, then update the doc in Notion, then check if the calendar event is still relevant. **Your brain becomes the integration layer.** You're basically a human API.

At some point I thought: *what if one thing just... did all of it?* Chat, tasks, docs, calls, calendar, AI. On YOUR server. One payment. No monthly seat tax. No "we've updated our pricing, sorry 😇" emails every six months.

That's OneCamp. Here's how I built it.

---

## The Full System Architecture 🗺️

Let me show you what this actually looks like before I explain any of it:

```mermaid
graph TB
    subgraph FE["🖥️ Frontend · Next.js 16 + React 19"]
        PWA["PWA · TailwindCSS v4 · Redux Toolkit"]
        RTUI["Radix UI · TipTap Editor · LiveKit SDK · MQTT.js"]
    end

    subgraph RT["📡 Real-Time Layer"]
        EMQX["EMQX · MQTT Broker"]
        LK["LiveKit · WebRTC Video"]
        HC["Hocuspocus · CRDT Collaborative Docs"]
    end

    subgraph BE["⚙️ Backend · Go 1.24"]
        API["Chi Router · 150+ REST Endpoints"]
        MW["JWT Auth · CORS · OpenTelemetry Middleware"]
    end

    subgraph DB["💾 Data Layer"]
        PG["PostgreSQL · Users & Config"]
        DG["Dgraph · Social Graph"]
        RD["Redis · Cache & Pub/Sub"]
        MN["MinIO · S3 File Storage"]
        OS["OpenSearch · Full-text + k-NN Vectors"]
    end

    subgraph OBS["📊 Observability"]
        HDX["HyperDX · ClickHouse · OpenTelemetry"]
    end

    FE -->|HTTPS| API
    FE -->|WSS| EMQX & LK & HC
    API --> PG & DG & RD & MN & OS
    API -->|Publish Events| EMQX
    API --> LK
    HC --> RD
    API --> HDX
```

Yeah. That's... a lot of boxes. Each one is justified. Let me walk through them.

---

## The Backend: One Go Binary 🦫

The entire backend is **Go 1.24**, compiles to a single binary, and runs with a **Chi router** serving 150+ REST endpoints. JWT auth, CORS, and OpenTelemetry tracing are middleware layers applied globally.

Why Go?

1. **Deployment simplicity.** No runtime, no `pip install`, no "wait which Node version did you use". You hand someone a binary and they run it. That's it.
2. **Concurrency model.** When you're handling WebSocket pub/sub, real-time event workers, background AI processing, and calendar sync jobs all at once, goroutines + channels are genuinely nice to work with. I've written async Node.js. I've written threaded Java. Go's model doesn't keep me up at night.
3. **I've seen monoliths hit their limits.** Migrating parts of legacy PHP monoliths to Go microservices cures you of any remaining nostalgia for dynamically typed web frameworks.

The codebase follows a strict layered architecture:
- **Controllers** → HTTP handlers, input validation, request parsing
- **Business** → Domain logic. No HTTP types, no database drivers  -  pure functions on domain objects
- **Models** → DB queries organized by store (Postgres, Dgraph, Redis, etc.)
- **Adapter** → Request/response DTOs, the border types

This means I can test business logic without spinning up a database. Wild concept. More people should do it.

---

## Five Data Stores (Yes, Five) 💾

| Store | What lives there |
|---|---|
| **PostgreSQL** | Users, auth, workspace config, team membership, task data |
| **Dgraph** | Social graph: messages, posts, reactions, comments, DM relationships |
| **Redis** | Pub/Sub relay, user profile cache, rate limits, AI session history |
| **MinIO** | File attachments  -  self-hosted S3-compatible object storage |
| **OpenSearch** | Full-text search + k-NN vector index for AI semantic retrieval |

The spicy choice here is **Postgres + Dgraph** instead of just Postgres.

The data in OneCamp is fundamentally graph-shaped. A DM is a relationship between N users. A message is attached to a group (edge) authored by a user (edge). A reaction is attached to a message (edge) added by a user (edge). In SQL, loading all messages in a conversation with their reactions and comment counts is 4-5 JOINs. In Dgraph, it's one traversal query.

I've watched deeply joined SQL queries on message tables get progressively more painful as production volume grew. I'd rather fight the graph database learning curve upfront than fight query planner confusion at 10x scale.

> [I wrote a whole post about this decision](/post/Two-Databases-Postgres-Dgraph-OneCamp.html) if you want the full analysis.

---

## Three Real-Time Systems (Also Yes, Three) 📡

**EMQX (MQTT)** handles all workspace events  -  new messages, typing indicators, emoji reactions, call status, user presence. Every entity gets an MQTT topic. The broker handles fan-out. You don't write fan-out code. I replaced what would've been hundreds of lines of stateful WebSocket routing with "subscribe to a topic". Feels like cheating.

**LiveKit (WebRTC)** handles video calls. HD video, screen sharing, recording. It's open-source and self-hostable, which is the only kind of video infra that fits OneCamp's philosophy. We also run a **Python transcription agent** alongside it  -  it listens to LiveKit sessions and sends transcripts back to the Go backend for storage and AI search.

**Hocuspocus (CRDT)** handles real-time collaborative document editing. Two people edit the same doc simultaneously? CRDTs (Conflict-free Replicated Data Types) handle the merge automatically  -  no last-write-wins, no locking, no "someone is currently editing this section" blocking. It stores session state in Redis between editing sessions.

---

## Deployment: The Whole Thing, One Command 🚀

```bash
onemana
```

That command spins up this:

```mermaid
graph TB
    subgraph EDGE["🌐 Edge"]
        TR["Traefik v2\nAuto TLS via Let's Encrypt"]
    end

    subgraph APP["🚀 Application"]
        GO["Go API · :3000"]
        COL["Hocuspocus · :1234"]
    end

    subgraph MEDIA["📡 Media & Real-Time"]
        LK["LiveKit · :7880"]
        EG["LiveKit Egress · Recording"]
        AG["Python Transcription Agent\n2 CPU · 2GB"]
        EM["EMQX · MQTT + JWT Auth"]
    end

    subgraph DATA["💾 Data"]
        PG["PostgreSQL · 0.5 CPU · 512MB"]
        DZ["Dgraph Zero + Alpha"]
        RD["Redis · 0.5 CPU · 256MB"]
        MN["MinIO · S3 Storage"]
        OS["OpenSearch · 512MB JVM"]
    end

    subgraph OBSERVE["📊 Observability"]
        OT["OTEL Collector"]
        CH["ClickHouse · 2 CPU · 4GB"]
        HX["HyperDX App"]
    end

    TR --> GO & COL & LK & EM
    GO --> PG & DZ & RD & MN & OS & EM & LK
    COL --> RD & GO
    LK --> EG & AG
    AG --> GO
    GO & AG --> OT --> CH
    HX --> CH
```

**Traefik** sits at the edge and handles TLS  -  SSL certificates are automatic via Let's Encrypt. You don't configure certs. You don't think about cert renewal. It just exists and works.

**HyperDX + ClickHouse** is the observability stack. Every API request gets an OpenTelemetry trace. When something breaks in production, I have distributed traces instead of `grep`-ing through raw log files. This was worth every minute of setup.

Setting all of this up manually would take an experienced engineer a couple of days. The `onemana` CLI does it in minutes. That's the bar I set for self-hosted software UX: **if the install requires a PhD, I've failed.**

---

## The AI Layer: Workspace Secondary Brain 🤖

OneCamp AI has its own [detailed technical post](/post/Streaming-AI-Go-SSE-Circuit-Breaker.html), but here's the overview:

- **Supports Ollama, OpenAI, and Anthropic**  -  you pick. Default is Ollama so zero data leaves your server. Switch to GPT-4 if you want. Your call, your infrastructure.
- **RAG over your workspace**  -  AI answers are grounded in your actual chat history, tasks, and docs via embedding search over OpenSearch vectors.
- **Streaming via SSE**  -  responses stream token-by-token. No 15-second loading spinners.
- **Circuit breaker + per-user rate limiting**  -  if Ollama is under load, requests fail fast instead of forming a queue that takes down everything else.
- **Actions require confirmation**  -  AI can *propose* creating a task or scheduling an event. It never auto-executes. You see a confirmation card and click it. An AI that silently creates calendar events without your approval is a liability disguised as a feature.

---

## The Launch 🚀

March 9th, 2026. Shipped to [onemana.dev](https://onemana.dev). Tweeted about it. Posted in a few places. Added it to some lists.

The response was incredibly validating, but also a stark reminder of an engineering truth that you only truly learn when you launch your own product.

---

## The Lesson I Already Knew But Had To Learn Again 📢

**Distribution > Code.**

I've read this in a hundred blog posts. I've nodded along. I've said "yeah, totally agree" in conversations. And then I spent 90% of my time building and 10% thinking about who would actually find the thing.

Classic. Engineer. Mistake.

The product is  -  genuinely  -  not the hard part. The binary works. The features are real. The architecture is solid. But *none of that matters* if the right person never sees it.

Distribution channels for a self-hosted developer tool:
- **Hacker News**  -  A strong "Show HN" post can drive thousands of targeted visitors in 24 hours
- **Reddit**  -  r/selfhosted, r/homelab, r/sysadmin are full of people who are already paying for Slack alternatives and complaining about it
- **GitHub**  -  The [open-source frontend](https://github.com/OneMana-Soft/OneCamp-fe) is a long-term discovery channel. Stars compound slowly.
- **SEO**  -  "Self-hosted Slack alternative", "open source Notion alternative". These are real searches with real buyer intent.
- **Building in public**  -  Which is what this blog post is. Hi 👋, welcome to my distribution strategy.

The tactical mistake: I built all of this first and *then* thought about distribution. The right order is to have distribution channels warm before launch day.

I'm fixing this now. One post at a time.

---

## What's Next 🔮

OneCamp isn't going anywhere. I believe in the problem. Teams deserve to own their tools.

If you're paying SaaS seat tax every month for tools your team barely uses, look at [onemana.dev](https://onemana.dev/onecamp-product). 

If you want to contribute to the open-source frontend: [github.com/OneMana-Soft/OneCamp-fe](https://github.com/OneMana-Soft/OneCamp-fe)

---

*More technical deep-dives on specific parts of the architecture are coming. [Follow on Twitter](https://twitter.com/akashc777) or check back here. Or both.*
