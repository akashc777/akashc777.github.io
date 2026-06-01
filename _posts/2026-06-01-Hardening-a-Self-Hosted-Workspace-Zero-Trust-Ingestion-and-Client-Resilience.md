---
title : "Hardening a Self-Hosted Workspace: Zero-Trust Ingestion and Client Resilience"
image : "/assets/images/post/onecamp-security-resilience-hero.png"
author : "Akash Hadagali"
date: 2026-06-01 16:45:00 +0530
description : "How I built a zero-trust ingestion layer for OneCamp—implementing magic-byte file signatures, zip-slip and zip-bomb decompression protection, ClamAV socket scanning, and designed a visibility-aware exponential backoff polling engine for client-server resilience."
tags : ["OneCamp", "Go", "NextJS", "Security", "Zero-Trust", "ClamAV", "Decompression", "API-Resilience", "Web-Performance"]
---

When you host your own workspace, security isn't someone else's problem. 

In a standard SaaS workspace (like Slack or Microsoft Teams), a massive team of engineers manages global file quarantine, antivirus scanning, and secure request isolation. But when a team pulls their workspace onto their own secure local hardware, **the security surface area shifts entirely to the self-hosted binary**. 

If a user uploads a malicious script, a corrupted zip archive, or a Trojan horse into a chat channel, your private server or local VPS is the immediate execution target. 

Over the last 6 days, I undertook a deep, zero-trust security audit of OneCamp. 

In this post, I will walk you through the engineering behind our new **zero-trust ingestion system**—including peeking file magic-bytes for MIME validation, scanning uploads with live ClamAV socket pipes, preventing zip-slip and zip-bomb exploits during Slack imports, and building an **exponentially-backed-off, visibility-aware polling engine** on the frontend to keep clients resilient during server deployments.

---

## 1. Zero-Trust Ingestion: Magic Bytes and Forced Coercion

In many web applications, checking a file upload is dangerously simple: the backend reads the client-supplied `Content-Type` header or inspects the file extension (`.png`, `.pdf`) and trusts it. 

This is a massive security vulnerability. A malicious attacker can easily rename a dangerous executable or an XSS-carrying HTML file (e.g., `payload.exe` or `xss.html`) to `photo.png`, upload it, and exploit the server or downstream users' browsers when it's rendered inline.

To resolve this, I built the **Safe Upload Pipeline** (`uploadsafe.go`).

```
                    +------------------------------------+
                    |        Incoming File Stream        |
                    +------------------------------------+
                                      |
                      +---------------v---------------+
                      |     Peek first 512 Bytes      | (Using bufio.NewReaderSize)
                      |  Detect Magic Byte Signature  |
                      +---------------v---------------+
                                      |
                     +----------------v----------------+
                     |  Verify Extension vs. Signature |
                     +----------------v----------------+
                                      |
                      +---------------v---------------+
                      |   Coerce Dangerous Types to   | (e.g., HTML, SVG -> octet-stream)
                      |   application/octet-stream    |
                      +---------------v---------------+
```

### 1. Magic-Byte Verification (Zero Copying)
When a file is uploaded, the backend must read its leading bytes to identify the true file signature. However, reading the entire file into memory to detect the MIME type causes severe memory spikes (especially for large video shares).

We solve this by **peeking** the stream:
* We wrap the incoming reader with a `bufio.NewReaderSize(body, 512)`.
* We peek at the first 512 bytes (which is the standard `http.DetectContentType` contract).
* If the detected bytes do not match the expected format (e.g., a file claiming to be a `.png` contains standard HTML headers or binary ELF code), the upload is immediately rejected with `ErrSignatureMismatch`.
* Crucially, the peeked buffer is never discarded. It is re-prepended to the Go reader, allowing us to stream the original, untouched payload directly into our storage bucket without writing temporary files to disk or duplicating data in RAM.

### 2. Forced MIME Coercion
Certain file extensions (like `.html`, `.xml`, `.js`, and `.svg`) can carry malicious Javascript payloads. If an SVG file is rendered inline by a browser, the embedded script executes within the context of your application, leading to a direct **Stored Cross-Site Scripting (XSS)** vulnerability.

To neutralize this risk:
1.  We maintain a strict allowlist of images safe for inline browser rendering (`inlineSafeTypes`: png, jpeg, gif, webp, bmp, and ico). Note that SVG is explicitly excluded.
2.  If the file extension belongs to a `dangerousExtensions` list (such as `.html`, `.svg`, `.wasm`, `.exe`, or `.sh`), the Content-Type is immediately coerced to `application/octet-stream`.
3.  We force the browser to treat the download as a secure file save by formatting a robust RFC 5987-compliant header:
    ```http
    Content-Disposition: attachment; filename="untrusted.svg"; filename*=UTF-8''untrusted.svg
    ```
Because it is served as an attachment with a raw stream MIME type, modern browsers will always save it to disk instead of executing or rendering it, completely eliminating stored-XSS threats.

---

## 2. Hardening Ingestion: Socket Antivirus and Safe Decompression

For self-hosted deployments, data migration is a primary ingestion channel. In my [previous post about our universal import engine](/post/How-I-Built-a-Universal-Import-Engine-For-8-Different-Providers.html), I broke down how we stream data from external platforms. But accepting massive, multi-gigabyte Zip archives from administrators requires absolute infrastructure protection.

### Live Antivirus Socket Pipe (`avscan.go`)
To prevent infected attachments from ever touching our long-term storage buckets, I integrated an ambient **ClamAV Antivirus Scanner**:
* Every upload stream is piped into a local ClamAV daemon socket in real-time.
* The scanning logic runs in a streaming fashion, reading bytes off the socket chunk-by-chunk.
* If a virus signature is detected, the pipeline aborts the write instantly, drops the connection, and logs the quarantine event in Postgres.

### Safe Decompression Pipeline (`zipsafe.go`)
Decompressing untrusted zip archives presents two classic, high-risk security threats: **Zip Slip** (directory traversal) and **Zip Bombs** (infinite decompression loops).

```
                             +------------------------+
                             |   Zip Archive Entry    |
                             +------------------------+
                                          |
                +-------------------------+-------------------------+
                |                                                   |
     +----------v----------+                             +----------v----------+
     |     Zip Slip?       |                             |     Zip Bomb?       |
     | - Check ".." paths  |                             | - Check compression |
     | - Verify in root    |                             |   ratio (> 100x)    |
     | - Abort instantly   |                             | - Check total bytes |
     +---------------------+                             +---------------------+
```

1.  **Preventing Zip Slip**: If a zip entry contains path traversal segments (e.g. `../../etc/passwd` or relative `../` markers), a naive decompressor will write the file outside the targeted staging directory, potentially overwriting critical system files. We enforce strict root path isolation on every extracted path using `filepath.Clean()`.
2.  **Preventing Zip Bombs**: A tiny 10KB zip archive can contain highly compressed nested layers that expand to 500GB of empty space, quickly exhausting server storage and causing a complete **Denial of Service (DoS)**.
    * We calculate the decompression ratio in real-time: `float64(decompressedBytes) / float64(compressedBytes)`.
    * If the ratio exceeds `100.0` (indicating an anomaly) or the raw decompressed size exceeds a safe threshold (like 2GB for a standard Slack channel history pack), the extractor terminates instantly and rolls back the transaction.

---

## 3. Client & API Resilience: Preventing Client-Induced DDoS

Security is also about **availability**. 

If a self-hosted server experiences a routine deploy, an update restart, or a temporary database lockup, thousands of open browser tabs will instantly fail their API requests. If those tabs are configured with basic, naive `setInterval()` polling loops, they will all bombard the server with reconnection attempts. 

When the server finally restarts, it is instantly met with a massive, client-induced **Thundering Herd DDoS attack**, crashing it again.

To protect the server and keep the client experience seamless, I built the visibility-aware **Resilient Polling Hook** (`useResilientPolling.ts`).

```typescript
export function useResilientPolling(opts: PollingOptions) {
  // ... ref and timeout bookkeeping ...
  const tick = useCallback(async () => {
    if (!enabled || mqttHealthy) return
    
    // Pause if tab is in the background
    if (document.visibilityState === "hidden") {
      schedule(interval)
      return
    }
    
    // Cap execution wall-clock time
    if (capMs > 0 && startedAt && Date.now() - startedAt > capMs) {
      clearTimer()
      return
    }

    try {
      await onPoll()
      errorCount.current = 0 // Reset on success
      schedule(interval)
    } catch {
      // Exponential Backoff on failure
      errorCount.current = Math.min(errorCount.current + 1, 30)
      const factor = Math.min(2 ** errorCount.current, maxBackoff)
      schedule(interval * factor)
    }
  }, [enabled, mqttHealthy, interval, capMs])
}
```

### The Three Pillars of Polling Resilience
1.  **MQTT Handover**: Polling is strictly configured as a fallback. When our real-time MQTT subscription is healthy (`mqttHealthy: true`), the hook completely disables its timers. The UI stays fresh via live pushes, saving significant database read cycles on the backend.
2.  **Visibility-Gated Execution**: If the browser tab is hidden in the background or minimized, polling stops immediately. When the user returns to the tab (firing a `focus` or `visibilitychange` event), the hook kicks off an immediate, responsive revalidation.
3.  **Exponential Backoff**: If an API call fails (e.g. during a database restart), successive polling delays are multiplied by $2^n$ up to a configured maximum (default: 8x base interval). This gives the server crucial breathing room to complete its boot sequence without facing immediate request traffic.

---

## The Verdict: Hardened, Autonomous Infrastructure

By implementing magic-byte signatures, eager antivirus checking, safe decompression boundaries, and visibility-aware client backoffs, OneCamp ensures that self-hosting does not mean compromising on security. 

You get the isolation of running on your own physical hardware, with the enterprise-grade ingestion protection you would expect from a massive cloud platform.

The zero-trust upload security layer and import workers are fully live in the [OneCamp backend repository](file:///home/akash/Documents/oneCamp). Dive into the `helpers/uploadsafe` and `hooks/useResilientPolling.ts` files to explore the full Go and TypeScript implementations!

---

*Previous posts: [Active Memory Layering: How OneCamp Orchestrates GraphRAG and Vector Databases](/post/How-I-Built-an-AI-Agnostic-Workspace-with-Active-Memory-Layering.html) · [Universal Import Engine: Migrating from 8 Platforms](/post/How-I-Built-a-Universal-Import-Engine-For-8-Different-Providers.html) · [Why MQTT for Real-time Sync](/post/MQTT-vs-WebSockets-Real-Time-OneCamp.html) · [Building the Anti-SaaS Workspace](/post/I-Built-OneCamp-The-Anti-SaaS.html)*

*For security audits and engineering deep-dives, [follow me on Twitter](https://twitter.com/akashc777).*
