---
title : "How I Built a Universal Import Engine Supporting 8 Different Productivity Platforms"
image : "/assets/images/post/onecamp-importer-improved.jpg"
author : "Akash Hadagali"
date: 2026-05-25 12:00:00 +0530
description : "How I engineered a high-throughput, chunk-based, multi-database migration engine for OneCamp that seamlessly unifies, de-duplicates, and ingests workspace data from Slack, Notion, Asana, Jira, Linear, Trello, ClickUp, and Todoist."
tags : ["OneCamp", "Go", "NextJS", "Architecture", "Data-Migration", "PostgreSQL", "Dgraph", "OpenSource"]
---

When building [OneCamp as the self-hosted, all-in-one anti-SaaS workspace](/post/I-Built-OneCamp-The-Anti-SaaS.html), the biggest friction point for teams migrating to it was always the same: **\"Our data is locked inside five different SaaS apps.\"** 

If a team wants to switch, they shouldn't have to start with a blank slate. They need their channels and threads from Slack, their boards from Trello, their issue backlogs from Jira, their databases from Notion, and their projects from Asana. 

Writing one-off migration scripts is easy. Designing a **production-grade, universal import engine** that unifies 8 vastly different data models, prevents rate-limit choking, maps user identities dynamically, streams heavy attachments securely, indexes into three separate databases, and supports one-click absolute rollbacks is an entirely different engineering challenge.

In this post, I will break down the design, the exact database schemas, the concurrent Go architecture, and the frontend decisions I made to support importing from **Slack, Notion, Asana, Jira, Linear, Trello, ClickUp, and Todoist** into a single cohesive system.

---

## The Landscape: 8 Models, 1 Target

Every workspace tool thinks about data differently. To import from all of them, the engine has to handle a massive conceptual divide:

*   **Slack**: Focuses on real-time messaging, channels, DMs, threads, emoji reactions, and files.
*   **Trello**: Focuses on a visual Kanban layout (boards, lists, cards, checklists, and comments).
*   **Asana & ClickUp**: Hierarchical task tracking (spaces, folders, lists, subtasks, task assignees, and rich HTML descriptions).
*   **Jira & Linear**: Highly structured issue tracking (projects, issues, workflows, components, transitions, custom priorities, and epic relationships).
*   **Notion**: Semi-structured databases where pages are database rows, containing nested block-based documents and comments.
*   **Todoist**: Lightweight task management (projects, checklists, tasks, and simple comments).

To avoid writing separate database writer pipelines for every single service (which would create a massive, unmaintainable testing surface), I built a **provider-agnostic intermediate representation**. The engine forces every import source to map its raw data into a set of standard, provider-neutral Go structs before writing them to the database.

---

## 1. The Provider-Agnostic Engine Interface

At the core of `business/Import/provider/provider.go` is the standard `Provider` interface that every integration must implement:

```go
type Provider interface {
	Name() string
	Capabilities() Capability
	SupportedSources() []string

	// cheap structural / token authentication checks
	Validate(ctx context.Context, j *importModels.Job, opts JobOptions) error

	// walks the source to produce counts, conflict warnings, and initial chunk queue
	Plan(ctx context.Context, j *importModels.Job, opts JobOptions) (*Plan, []*importModels.Chunk, error)

	// streams each entity tier down buffered channels with backpressure
	IterUsers(ctx context.Context, j *importModels.Job, opts JobOptions) (<-chan SourceUser, <-chan error)
	IterTeams(ctx context.Context, j *importModels.Job, opts JobOptions) (<-chan SourceTeam, <-chan error)
	IterProjects(ctx context.Context, j *importModels.Job, opts JobOptions) (<-chan SourceProject, <-chan error)
	IterTasksOfProject(ctx context.Context, j *importModels.Job, opts JobOptions, projectSourceId string) (<-chan SourceTask, <-chan error)
	IterSubtasksOfTask(ctx context.Context, j *importModels.Job, opts JobOptions, taskSourceId string) (<-chan SourceTask, <-chan error)
	IterCommentsOfTask(ctx context.Context, j *importModels.Job, opts JobOptions, taskSourceId string) (<-chan SourceComment, <-chan error)

	// streams media attachments to storage
	FetchAttachment(ctx context.Context, j *importModels.Job, opts JobOptions, att SourceAttachment, dest io.Writer) (mime string, size int64, err error)

	// mappings prefilled as initial user-interface state
	DefaultStatusMap() map[string]string
	DefaultPriorityMap() map[string]string
}
```

Each provider declares what it is capable of yielding by advertising flags like `CapTeams`, `CapProjects`, `CapTasks`, `CapSubtasks`, `CapTaskComments`, `CapAttachments`, or legacy communication types like `CapChannels` and `CapMessages` (which the Slack provider exclusively uses).

### Standardizing the Intermediate Representation (IR)

Here are the intermediate Go models that sit in the middle of our pipeline. Every source item—whether a Trello card, a Notion page, or a Jira issue—is converted into a `SourceTask` before the orchestrator commits it to storage:

```go
type SourceTask struct {
	SourceID        string
	ParentTaskID    string // empty for top-level tasks
	ProjectSourceID string
	Name            string
	Description     string // Rich text rendered as standardized HTML
	Status          string // Raw source status (mapped during the Plan phase)
	Priority        string // Raw source priority (mapped during the Plan phase)
	Labels          []string
	AssigneeIds     []string
	CreatedBy       string
	StartDate       *time.Time
	DueDate         *time.Time
	Created         time.Time
	Updated         time.Time
	Completed       bool
	AttachmentRefs  []SourceAttachment
	CommentCount    int
	SubtaskCount    int
	Metadata        map[string]any // source-specific properties (site URL, custom fields)
}
```

---

## 2. The 3-Stage Pipeline: Discover, Plan, Execute

The migration workflow runs across three distinct phases to ensure the administrator has absolute control and visibility over their imported data.

```
+------------------+     +------------------+     +------------------+
| 1. Discovery API | --> | 2. Planning API  | --> | 3. Execution     |
| - Connect OAuth  |     | - Collect Counts |     | - Chunk Queue    |
| - Dynamic List   |     | - Fetch Statuses |     | - Worker Pool    |
| - Pick Board/DB  |     | - Map Dropdowns  |     | - Live MQTT Sync |
+------------------+     +------------------+     +------------------+
```

### Phase 1: Live Structural Discovery

Instead of forcing the administrator to copy-paste complex, undocumented API resource hashes (like a Notion Database UUID or a Trello Board ID), the frontend uses a dynamic **Discovery API** at `/admin/import/discover`. 

Once the OAuth or Personal Access Token (PAT) is supplied and encrypted server-side, the frontend makes a discovery request. The backend resolves the active provider, queries the vendor's API, and returns a unified list of friendly, selectable targets:

```typescript
// From ImportCard.tsx
const startNewJob = async () => {
  const opts: Record<string, unknown> = {}
  switch (selectedProvider) {
    case "trello":
      opts.board_id = pickedDiscoverId // Resolved board name -> ID
      break
    case "notion":
      opts.databases = [pickedDiscoverId] // Selected DB
      break
    case "linear":
      opts.team_id = pickedDiscoverId // Selected Team
      break
    case "clickup":
      opts.workspace_id = pickedDiscoverId // Selected Workspace
      break
  }
  // ...
  const { job_id } = await createImportJob(selectedProvider, {
    source_workspace_name: workspaceName,
    source: "api",
    options: opts
  })
}
```

### Phase 2: Structural Planning & Mapping

Once the job is created, the backend executes the provider's `Plan()` phase. Rather than downloading the entire dataset, the engine queries the API metadata to build a structured preview of the incoming data, returning:
1.  **Item Counts**: The exact count of users, teams, projects, tasks, comments, and attachments.
2.  **Unique Statuses & Priorities**: A flat list of every custom status (e.g., `"In QA"`, `"Sprint Backlog"`, `"Done"`) and priority found in the source.

The frontend blocks the run phase and renders the **ImportPlanDialog**, forcing the administrator to map these external tags directly to OneCamp equivalents:

```
+--------------------------------------------------------+
|               Map Jira -> OneCamp Statuses             |
+--------------------------------------------------------+
|  Jira Status          |      OneCamp Target            |
|  -------------------  |      -------------------       |
|  "To Do"              | [v] Todo                       |
|  "In Progress"        | [v] Doing                      |
|  "In QA"              | [v] Review                     |
|  "Done"               | [v] Done                       |
+--------------------------------------------------------+
```

This mapping is stored in PostgreSQL and used dynamically by the execution workers, preventing corrupt workflows.

### Phase 3: High-Throughput Chunk-Based Execution

When the administrator clicks "Run", the orchestrator (`business/Import/orchestrator.go`) takes over. Running a migration containing 10,000 tasks and 50GB of attachments as a single massive sequential transaction is a recipe for memory leaks, socket timeouts, and API rate-limiting crashes. 

To solve this, the orchestrator divides the execution into a **chunk-based queue**:
1.  **Stage 1 (Sequential)**: Streams and resolves all users. User resolution matches external emails with existing OneCamp users, failing back to creating sandboxed "external guest" profiles so that activity feeds remain historically accurate.
2.  **Stage 2 (Chunked & Parallel)**: The planner creates a `Chunk` record in PostgreSQL for every project, database, or list. The orchestrator spawns a concurrent worker pool (`task_worker.go`). 
3.  **Dynamic Backpressure**: Workers pull chunks from the database and invoke stream channels (e.g., `IterTasksOfProject`). Channels use small buffered buffers (50–100 items) to backpressure heavy API payloads, keeping memory profiles flat even on small VPS instances.

---

## 3. Engineering Tradeoffs & Hardened Systems

### Tradeoff 1: Token Buckets & Rate Limiting (The clickup/asana gotcha)
Productivity APIs are notorious for aggressive rate limits. ClickUp and Asana will quickly throw `429 Too Many Requests` when queried across multiple concurrent worker pools. 

I implemented a central, token-bucket based rate limiter (`business/Import/provider/ratelimit.go`) that wraps every outgoing provider HTTP request. If a vendor returns a 429, the provider converts the response into an `ErrRateLimited` struct, containing a `RetryAfter` duration:

```go
type ErrRateLimited struct {
	RetryAfter time.Duration
	Reason     string
}

// Inside our worker loop:
if delay, ok := provider.IsRateLimited(err); ok {
	log.Warnf("Hit rate limit on %s, pausing queue for %v", job.Provider, delay)
	mqtt.PublishProgress(jobId, "rate_limited", delay)
	// resets the current chunk state to pending without burning attempt counts
	orchestrator.ResetChunkForRetry(chunkId, delay)
	return
}
```

This allows the engine to adapt dynamically to rate-limit ceilings, gracefully putting workers to sleep and resuming syncs without losing a single item.

### Tradeoff 2: SSRF & Eager Media Downloader
When importing files from Notion or Trello, the APIs often return highly ephemeral AWS S3 pre-signed URLs that expire in 15–60 minutes. If we simply saved those URLs in our database, every attachment image in our chats and docs would break by the next morning.

To fix this, the engine uses **eager downloading**. The worker downloads every attachment file immediately during the task-processing phase, streaming the raw bytes directly to our local, self-hosted MinIO bucket:

```
[External URL] ──> [SSRF Guard & HTTP Client] ──> [Worker Stream] ──> [MinIO Bucket]
```

However, accepting arbitrary URLs from an external provider presents a severe security risk: **Server-Side Request Forgery (SSRF)**. A malicious task containing an attachment pointing to `http://127.0.0.1:5432` could trigger our backend into scanning its own internal Postgres port.

To protect against this, I routed all media downloads through our hardened SSRF guard (`helpers/ssrf.go`), which dynamically resolves DNS, checks the target IP against private CIDR blocks, and pins the resolved IP at dial time to prevent DNS rebinding attacks.

### Tradeoff 3: Eventually Consistent Multi-Store Sync
Because OneCamp indexes data across **PostgreSQL** (relational structures), **Dgraph** (graph relations, chat message threads, and active circles), and **OpenSearch** (full-text cataloging), importing an item requires writing to three databases.

```
                           +----------------------+
                           |  PostgreSQL (Author) |
                           +----------------------+
                                      |
                +---------------------+---------------------+
                |                                           |
    +-----------v-----------+                   +-----------v-----------+
    |  Dgraph (Sync Graph)  |                   | OpenSearch (Async ES) |
    |  - Synchronous        |                   | - Async Goroutine     |
    |  - Non-fatal fallback |                   | - Panic Recovery      |
    +-----------------------+                   +-----------------------+
```

To optimize write performance:
1.  **Postgres is treated as the atomic source of truth.** The write must succeed.
2.  **Dgraph graph node instantiation is performed synchronously** immediately after. If it fails, the item import still succeeds, and the engine logs a warning. Dgraph is marked for asynchronous repair.
3.  **OpenSearch full-text cataloging is dispatched to an async goroutine** with robust panic recovery. This keeps the worker from blocking on indexing bottlenecks, ensuring fast import loops.

---

## 4. The Safety Net: Real-Time Monitoring & One-Click Rollbacks

A migration engine is only as good as its recovery path. If an administrator imports a massive Jira space and halfway through realizes they mapped the wrong statuses, they shouldn't have to manually delete thousands of records or restore a raw database snapshot.

### Dynamic Rollback Indexes
Every time a worker successfully imports a record (a project, task, comment, or attachment), it records the generated UUID inside a transactional **migration log** in PostgreSQL.

If the import fails or is manually cancelled by the admin, they can trigger a **One-Click Rollback**. The engine reads the job's precise mapping logs, resolves the cascading relationships, and cleanly deletes every created record across all three databases:

```sql
-- Autoritative soft-delete cascade
UPDATE tasks SET deleted_at = NOW() WHERE id IN (SELECT entity_id FROM import_logs WHERE job_id = $1);
UPDATE projects SET deleted_at = NOW() WHERE id IN (SELECT entity_id FROM import_logs WHERE job_id = $1);
```

Afterward, it triggers a `BulkArchive` set on the Dgraph graph nodes and issues a clean async purge on the OpenSearch indices. It's clean, fast, and completely safe.

### Real-Time UX with MQTT and SWR Fallback
To keep administrators from guessing what the importer is doing, the orchestrator publishes live sync metrics to our MQTT broker on the `Slack_Import_Progress` topic. 

The Next.js frontend subscribes to these topics, dynamically rendering a real-time progress bar, item counters, current stages, and live error banners:

```typescript
// From ImportCard.tsx
useEffect(() => {
  const handler = (msg: any) => {
    if (msg?.type !== "Slack_Import_Progress") return
    refetchJobs() // SWR revalidation
  }
  const unsubscribe = window.__mqttBroadcastHandlers?.register?.(handler)
  return () => unsubscribe?.()
}, [refetchJobs])
```

If the MQTT broker goes down or the client suffers a network drop, the frontend automatically falls back to an exponential-backoff SWR polling loop (`POLL_INTERVAL_MS = 6000`), ensuring robust state monitoring.

---

## The Verdict: Zero SaaS Lock-in

By building a unified, highly concurrent intermediate migration pipeline, OneCamp has effectively eliminated the last remaining hurdle of self-hosting. 

Moving away from bloated SaaS services shouldn't mean losing years of historical comments, checklists, assignees, and media files. With this unified import engine, a team can migrate from Asana or Trello in less than 5 minutes—running on their own secure hardware, owning their database, and eliminating recurring subscription bills forever.

The importer frontend is available in your admin panel under the **Import** tab. Dive into the code, hook up your developer tokens, and take control of your team's historical data!

---

*Previous posts: [OneCamp v2.0: GitHub Sync, Webhooks, Archiving](/post/OneCamp-v2-GitHub-Webhooks-Archiving-Redesign.html) · [Why we use two databases](/post/Two-Databases-Postgres-Dgraph-OneCamp.html) · [Why MQTT for real-time](/post/MQTT-vs-WebSockets-Real-Time-OneCamp.html) · [Building the Anti-SaaS Workspace](/post/I-Built-OneCamp-The-Anti-SaaS.html)*

*[Follow on Twitter](https://twitter.com/akashc777) for more updates.*
