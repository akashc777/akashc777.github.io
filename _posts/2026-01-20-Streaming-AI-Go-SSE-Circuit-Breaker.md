---
title : "Streaming AI in Go: SSE, Circuit Breakers, and the nginx Buffering Bug That Aged Me"
image : "/assets/images/post/onecamp-hero.png"
author : "Akash Hadagali"
date: 2026-01-20 12:00:00 +0530
description : "The real technical details behind OneCamp's streaming AI feature — Server-Sent Events in Go's net/http, a fast-path optimization for conversational inputs, post-stream tool call parsing, circuit breakers, and the React batching gotcha that will catch you eventually."
tags : ["Go", "AI", "SSE", "Ollama", "OneCamp", "LLM", "CircuitBreaker", "Architecture"]
---

The most common mistake in AI-integrated backends: treating the LLM like a normal API call.

```
POST /ai/ask
{ "question": "summarize my week" }

// 12 seconds pass

200 OK
{ "answer": "Here is your summary..." }
```

Your users think the app crashed. Three people refresh. Two file bug reports. One leaves.

OneCamp's AI streams responses token-by-token via Server-Sent Events. The first token appears in ~500ms. The UI updates in real time as the model generates. Users feel like they're watching someone type — which is exactly what's happening, except the "someone" is a local LLM running on their own server.

Here's the full technical story of how that actually works.

---

## Why SSE, Not WebSockets?

WebSockets are bidirectional. LLM streaming is one-directional — tokens flow from server to client, never the other way. SSE (Server-Sent Events) is half-duplex HTTP: the server keeps the connection open and pushes events. The browser handles reconnection automatically. It works over HTTP/1.1. It doesn't need any special infrastructure.

The wire format is almost comically simple:

```
data: {"content": "The "}

data: {"content": "answer "}

data: {"content": "is..."}

data: {"done": true}
```

Each line starts with `data: `, followed by JSON, terminated by a double newline. That's the entire protocol. I've seen JIRA tickets more complex than this spec.

---

## The Go Implementation (And The nginx Bug That Almost Broke Me)

Go's `net/http` returns when the handler function returns. For SSE, you need the handler to stay open while streaming. Here's the skeleton:

```go
func AskAIStream(w http.ResponseWriter, r *http.Request) {
    // 2-minute hard limit — prevents zombie SSE goroutines
    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
    defer cancel()

    // SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no") // 👈 the one that matters

    flusher, ok := w.(http.Flusher)
    if !ok {
        helpers.WriteJSON(w, http.StatusInternalServerError, ...)
        return
    }

    for chunk := range stream {
        if chunk.Content != "" {
            escaped := strings.ReplaceAll(chunk.Content, "\n", "\\n")
            escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
            fmt.Fprintf(w, "data: {\"content\": \"%s\"}\n\n", escaped)
            flusher.Flush() // 👈 the one you'll forget
        }
    }

    fmt.Fprintf(w, "data: {\"done\": true}\n\n")
    flusher.Flush()
}
```

Three things that will wreck you if you miss them:

**1. `flusher.Flush()` after every write.**
Go's `ResponseWriter` buffers writes. Without explicit flushing, the runtime holds your tokens in memory until the buffer fills or the handler returns. Your client gets nothing until the model finishes generating the entire response. You've implemented the world's most elaborate `POST /ask` endpoint.

**2. `X-Accel-Buffering: no`.**
I wasted an entire afternoon on this. SSE worked perfectly on localhost. In production behind nginx, it batched the entire response and delivered it all at once. nginx buffers upstream responses by default. This header tells it to stop. I found it at 11pm, added one line, it worked, and I sat in silence for a moment.

**3. Context with timeout.**
Without a deadline, a stalled LLM request holds a goroutine and an open HTTP connection indefinitely. Multiply by concurrent users hitting a slow model, and you've got a goroutine leak. 2 minutes is generous — most responses finish in 10-30 seconds — but it's the difference between "AI is slow" and "entire server is unresponsive."

---

## The Fast-Path Optimization (Don't Spend 500ms on "Hi")

Building workspace context is expensive:

1. Take the user's question → generate an embedding vector (~100ms)
2. Run k-nearest-neighbours over all workspace documents, messages, and tasks (~200-500ms)
3. Assemble the top results into a context window
4. Send everything to the LLM

For a substantive question — "summarize what we decided about the API design last Tuesday" — this 300-600ms overhead is worth it. The context makes the answer meaningfully better.

For "hi", "thanks", "lol" — it's pure overhead. You're building a vector search over all your team's data to answer a two-character greeting.

```go
// Fast-path: skip expensive context building for conversational inputs.
// BuildUserContextPublic generates an embedding + k-NN search (~3-5s),
// which is unnecessary for greetings like "hi", "hello", etc.
var contextText string
isConversational := ai.IsConversational(req.Question)
if !isConversational {
    contextText, _, ctxErr = business.BuildUserContextPublic(ctx, &userInfo, req.Question, localization)
}
```

`IsConversational` is a small classifier — regex patterns and common short phrases. When it fires, we skip the embedding entirely and go straight to the LLM with a "casual conversation" system prompt at higher temperature (0.8 vs 0.3 for factual RAG queries).

The temperature difference is intentional. Factual retrieval should be deterministic — lower temperature keeps the model from improvising when it should be citing sources. Casual conversation should feel human — higher temperature adds natural variation so you're not talking to a robot that gives the exact same response to "how's it going?" every single time.

---

## Post-Stream: The Tool Call Parsing Problem

OneCamp AI is agentic — it can propose workspace actions. The LLM is prompted with a set of available tools (create task, search docs, schedule event, etc.) and embeds structured tool calls in its response:

```
Sure! I'll create that task for you.
<tool_call>{"name": "create_task", "params": {"title": "Fix login bug", "due": "tomorrow"}}</tool_call>
```

We stream the raw text as it arrives — including the `<tool_call>` block. After the stream finishes, we parse the complete response:

```go
// Post-stream: parse tool calls and sanitize
fullResponse := accumulated.String()
cleanText, proposedActions := ai.ParseToolCalls(fullResponse)
sanitized := business.SanitizeResponse(cleanText)

// Tell the frontend to swap the displayed text (remove leaked tool call XML)
if sanitized != fullResponse {
    replaceEvent := map[string]string{"replace": sanitized}
    replaceJSON, _ := json.Marshal(replaceEvent)
    fmt.Fprintf(w, "data: %s\n\n", string(replaceJSON))
    flusher.Flush()
}

// Send the parsed actions for the user to confirm
if len(proposedActions) > 0 {
    actionsJSON, _ := json.Marshal(proposedActions)
    fmt.Fprintf(w, "data: {\"actions\": %s}\n\n", string(actionsJSON))
    flusher.Flush()
}
```

The frontend handles three event types:
- `content` — append to display text
- `replace` — swap entire display text (cleans up the leaked `<tool_call>` XML)
- `actions` — render as interactive confirmation cards

**Critical design decision: actions are never auto-executed.** The user sees a card: "Create task: Fix login bug, due tomorrow. Confirm?" They click confirm. Only then does the frontend call `/ai/action/execute`. 

An AI that silently creates calendar events or tasks without explicit user approval is a liability disguised as a feature. The five seconds saved by skipping confirmation is not worth the first time it misunderstands context and creates "Fix login bug" as a recurring weekly task.

---

## The Circuit Breaker (Or: Don't Let the AI Take Down Your Chat)

Local LLMs (Ollama) can be slow, fail to load, run out of GPU memory, or just crash. Without protection, every AI request during an outage waits for a timeout — tying up goroutines and degrading the entire service, not just the AI endpoints.

OneCamp wraps every LLM call in a circuit breaker with three states: **Closed** (normal), **Open** (tripped, fail fast with 503), **Half-open** (probing, let one request through to test recovery).

```go
// Check resiliency before streaming — fail fast if circuit is open
if err := ai.Service.Resiliency.PreCheck(ctx, userInfo.UserDgraphInfo.Uuid); err != nil {
    statusCode := http.StatusTooManyRequests
    if err == ai.ErrCircuitOpen {
        statusCode = http.StatusServiceUnavailable
    }
    helpers.WriteJSON(w, statusCode, helpers.Envolope{"msg": err.Error()})
    return
}
```

On top of the circuit breaker, there's **per-user rate limiting**. One user can't saturate Ollama and make the experience terrible for everyone else on the server. Rate limit state lives in Redis (atomic increments with TTL expiry). Failures trip the circuit; successes close it:

```go
ai.Service.Resiliency.CB.RecordFailure()  // on any LLM error
ai.Service.Resiliency.CB.RecordSuccess()  // after stream completes cleanly
```

Without this, I tested what happens when Ollama is slow: the server spawns goroutines faster than the model responds, memory climbs, and eventually everything is slow — not just the AI. The circuit breaker means AI degradation stays contained.

---

## The Frontend: Stream Consumer and the React Batching Gotcha

The browser-side SSE client uses `fetch` + `ReadableStream` instead of the native `EventSource` API, because `EventSource` doesn't support POST requests. Long story. Annoying limitation.

```typescript
const reader = response.body?.getReader();
const decoder = new TextDecoder();
let accumulated = ""; // local, not React state

while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));

        if (data.content) {
            accumulated += data.content.replace(/\\n/g, "\n");
            setStreamText(accumulated); // update React state for rendering
        }

        if (data.replace) {
            accumulated = data.replace; // update both!
            setStreamText(data.replace);
        }

        if (data.done) {
            return { text: accumulated, actions: parsedActions }; // ← NOT state
        }
    }
}
```

Notice: `askStream()` returns `{ text: accumulated, actions: parsedActions }` — using the **local closure variable**, not React state.

This is the gotcha. If you read `streamText` (React state) immediately after the stream ends, you might get the previous value. React batches state updates asynchronously. The local `accumulated` variable is always current because it's updated synchronously in the same function scope.

This pattern — local closure variable as the reliable value, React state as the rendering signal — comes up constantly when coordinating async streams with React. The bug it prevents is subtle: your stream finishes, you read `streamText`, you get the second-to-last update, you render that as the "final" result. Users occasionally see responses cut off by one token. Nightmare to debug.

---

## What I'd Change

**The `replace` event is a hack.** Users briefly see raw `<tool_call>` XML before the replacement event arrives. A proper fix would detect the opening `<tool_call>` tag mid-stream and buffer the tail. I haven't done it yet because it requires a stateful streaming parser — more complexity than I wanted during the initial build. It's on the backlog.

**Session history truncation.** We append full Q&A pairs to Redis per session. Long conversations hit token limits. Should use a sliding window or incremental summarization. Known debt.

---

*[OneCamp is open source on the frontend](https://github.com/OneMana-Soft/OneCamp-fe) — `services/aiService.ts` has the full streaming client. The backend runs as a single Go binary at [onemana.dev](https://onemana.dev/onecamp-product). Local AI, no data leaves your server.*
