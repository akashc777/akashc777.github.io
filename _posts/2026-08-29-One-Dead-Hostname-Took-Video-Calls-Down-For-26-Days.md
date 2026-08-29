---
title: "One Dead Hostname Took Video Calls Down for 26 Days"
image: "/assets/images/post/onecamp-dead-hostname.jpg"
author: "Akash Hadagali"
date: 2026-08-29 12:00:00 +0530
description: "A customer churned in July. Their DNS record was deleted and their hostname stayed in a Traefik rule, which meant the certificate covering every customer's video service could no longer renew. It expired on 29 July and nobody could join a call until 24 August. In the same week I found an email queue that had never once enqueued anything, an agent that could not report its own failure, a dry run that was not a dry run, and my own public repository configured to point every buyer at my servers."
tags: ["OneCamp", "Traefik", "TLS", "Postgres", "Operations", "Silent Failure", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace (chat, docs, tasks, projects, calls, boards, tables, an API) that runs on **your** infrastructure. I build it, sell it, and operate the demo, which means I get to find out what breaks.

This sits next to [every health check was green, and nobody could download the product](/post/Every-Health-Check-Was-Green-And-Nobody-Could-Download-My-Product.html) and [the update that downloaded and never ran](/post/The-Update-Downloaded-Fine-And-Never-Ran.html). Same shape: the thing that was green was not the thing that mattered.

This is the week I found out that five different things had been broken for a long time, and that the thing they had in common was not a bug.

## Twenty-six days

Video calls did not work. Not "were degraded". Nobody reached the server, at all, from 29 July to 24 August.

The chain is short enough to state in one paragraph. Every customer's LiveKit lives at `onecamp-livekit.<their-domain>`. Those hostnames are appended to one shared Traefik rule, so Traefik requests one certificate covering all of them. A customer churned in July. Their DNS record was deleted. Their hostname stayed in the rule.

Let's Encrypt issues a multi-SAN certificate as a single order, and a single order succeeds or fails as a whole. One hostname whose HTTP-01 challenge can no longer be satisfied does not get dropped from the certificate; it fails the renewal for every name on it. So the certificate for every live customer expired because of a domain belonging to somebody who had left.

Cloudflare, sitting in front, saw an expired origin certificate and returned **526**. Browsers could not reach LiveKit at all.

Twenty-six days.

## Nothing in that chain is a bug

This is the part I keep turning over. Traefik behaved correctly. ACME behaved correctly: atomicity is the specified behaviour, and it's the right one. Cloudflare 526 is exactly what a proxy should do with an invalid origin certificate. The churn process removed the DNS record, which is correct. Every component did its job.

The fault is that a hostname outlived the customer it belonged to, in a file nothing was reading. There was no line of code to fix. `LIVEKIT_TRAEFIK_RULE` was a string in an `.env` that grew by one entry per sale and never shrank.

So the fix is not a patch, it's a thing that looks:

```
livekit-domains.sh list      every hostname, its DNS state, its certificate state
livekit-domains.sh check     non-zero when one is dead or expiring
livekit-domains.sh remove    take a churned customer out cleanly
```

`check` now runs daily from cron, and provisioning runs it too, so a stale hostname surfaces when somebody is already looking rather than at the next renewal, months later, silently.

One implementation note that cost me twenty minutes: the replacement rule contains backticks and pipes, so rewriting it with `sed` produced something that was not the string I wrote. It builds the line with `awk` now. Shell quoting is a place where "it worked when I tested it" and "it is correct" separate very cleanly.

## The queue that had never queued anything

Different system, same shape.

An admin screen has a "send me a test digest" button. A customer reported it did nothing. It reported success every time.

```
ERROR: inconsistent types deduced for parameter $8 (SQLSTATE 42P08)
DETAIL: text versus character varying
```

`AtomicEnqueue` used `$8` twice: once in an `INSERT ... SELECT` list, where a bare parameter is *unknown* and Postgres defaults it to `text`, and once in `WHERE dedup_key = $8`, where a `varchar` column forces `varchar`. Postgres must deduce exactly one type per parameter. It cannot, so it rejects the statement.

At **PREPARE** time. Before any value is bound.

Which means it had never worked. Not "failed under load", not "failed for certain addresses". No notification email had ever been enqueued, on either release line, since the feature shipped. Casting the parameter (`$8::varchar`) makes it prepare. I verified both against the live database: the original refuses to prepare, the cast version prepares and deallocates cleanly.

Why nobody noticed for so long is the more useful half. The test button dispatched fire-and-forget and returned `nil` regardless, so the endpoint answered *"Test digest sent to your email"* while nothing was queued. The only trace was one ERROR line in a log nobody reads when the UI says it worked.

**A test button that cannot fail tests nothing.** It's worse than no button, because it manufactures evidence. The test path is synchronous now and checks the dispatch count, and says what to go look at when it's zero.

The guard test asserts the property rather than the fix: any parameter used in both the `SELECT` list and the `WHERE` must carry an explicit cast. The literal bug will not come back; that shape might.

## An agent that could not report its own failure

Call transcription had stopped working, and `docker logs` was empty. For 43 hours.

Two faults, and it's the second one that matters.

The agent fetched its configuration from the backend over the **public** hostname, so a call between two containers on the same machine left the box, crossed the internet and came back through Cloudflare, which answers a Python user-agent with 403. I verified that by issuing the same request twice and changing only the `User-Agent`: Python default 403, browser-like 200. So the config fetch always failed, the agent silently fell back to defaults with no speech-to-text key, and `INTERNAL_SECRET` was being sent over the public internet for a loopback call. Every other service already used `http://go-service:3000`.

Then the second fault. `setup_otel()` attaches an OpenTelemetry handler to the root logger. `logging.basicConfig()` is a **no-op if the root logger already has a handler**. They ran in that order, so the agent finished startup with zero stream handlers: every `logger.warning` went nowhere, including the one naming the failing config fetch.

Swapping two lines takes it from 0 handlers to 1.

I've been writing Python for years and I did not know that about `basicConfig`. It is documented. It is also the single most consequential line in that file, because it decides whether any of the others can be heard.

## `make -n` is not a dry run

I wanted to preview a restore on the demo host, so I ran `make -n restore`. It performed a real restore.

GNU make treats **any recipe line containing `$(MAKE)`** as recursive and runs it even under `-n`, so that it can print what the sub-make would do. Step 5 of `restore` is one line containing `$(MAKE) ... verify`. Under `-n`, that whole line executes: the drop, the replay, the migrate, the restart.

No data was lost. It replayed the current golden snapshot, which is how the new step ordering got an unplanned end-to-end test. `CONFIRM=restore` is the real guard and it did its job; my mistake was passing it alongside `-n` and believing `-n` outranked it.

It's written down at the target now. Some things are cheaper to document than to defend against, and this is one, because the alternative is restructuring a Makefile around a flag's edge case.

## And then I read my own repository

A squash import had silently overwritten the public frontend's README with the default `create-next-app` boilerplate, so the front page of a product I sell explained how to run `create-next-app`. While fixing that, I looked at the committed `.env.production` next to it.

It held my live deployment. Real backend, LiveKit, collaboration and MQTT hostnames. A real Firebase project. `DEMO_MODE=true`.

Anybody who cloned the repository and ran `pnpm build` got a workspace wired to **my** servers, registering their users' devices against a push project they cannot send from, showing a "try it without an account" button on their own sign-in screen. Nothing failed. It built, it started, and it pointed at the wrong place.

I want to be precise about what was and was not wrong, because the instinct is to call this a leak. It wasn't. Every `NEXT_PUBLIC_` value is compiled into the JavaScript the browser downloads, so a Firebase web key sitting in that file is public whether or not it's in git. There was nothing to rotate. The defect is **destination**, not disclosure: a default that quietly sends a buyer's traffic somewhere they did not choose.

The same fault turned out to be in two more places, and that one a buyer cannot work around. Avatars and attachments are served from the object store on its own hostname. Two separate allowlists have to name that host or images don't render: Next's `images.remotePatterns`, and the CSP's `img-src`. The first held *my* object-store hostname as a literal, so `next/image` returned 400 for every avatar on every install that wasn't mine. The second never mentioned the object store at all, which is harmless only while the policy is Report-Only and becomes the identical outage the day it's enforced.

Both now derive from one function. Having a single source is the part that matters: before, there was no shared value to disagree about, just a literal in one file and an omission in another.

The committed env file is placeholders now, the Firebase block is empty (empty is the *working* state, because the app checks those values before initialising, so empty means push is cleanly off, whereas a plausible-looking dummy passes the check and fails later in a browser), and replacing them is one question:

```bash
pnpm configure
```

It writes `.env.production.local`, which Next loads after `.env.production` and which is git-ignored, so a buyer's domains never land in a commit and `git pull` never conflicts with their configuration.

Two guards, because this is the second time a wrong default has shipped quietly. One asserts the committed file names no host outside the placeholder domain. It is a *shape*, not a list, so it catches my domain and equally catches a customer's, which is the one a contributor is most likely to paste. The other covers the domain parsing, because a fumbled domain there produces a file that looks right and a build that reaches nothing.

Writing that second guard, a test failed on my own new code: `mediaOrigin("undefined")` returned `https://undefined`, because `new URL()` accepts any single word as a hostname. Then I found the identical hole in the CSP module, in a function whose own header comment names that exact failure as its reason for existing. It guarded against an *empty* value and not against the literal string an unset variable produces. Both require a dot now, or `localhost`.

One last one, from the same afternoon. A browser test asserting that colour tokens re-point in dark mode had started failing about one run in three, and I assumed I had broken it, because I had just changed the file next to it. I had not. The test set the `dark` class on `<html>` and then read a computed colour, but the theme provider owns that class and rewrites it on mount, so whenever the provider ran second it removed the class and the test read the light value twice. It was failing for a reason that had nothing to do with what it was checking. The probe lives inside its own wrapper element now, where nothing else can reach it.

I mention it because my first instinct, twice in one afternoon, was to believe the newest change was the cause. Once that was right. Once it was not, and I said so out loud before checking, which is its own kind of green light.

## What these have in common

Five systems. A certificate, a queue, an agent, a Makefile, a config file. Every one of them reported success.

Not one was a crash. Not one produced a stack trace. Traefik logged renewal attempts. The API returned 200 with "Test digest sent to your email". The agent's container stayed up and healthy. `make -n` printed a plausible list of commands while executing them. `pnpm build` compiled cleanly.

The common shape is that **the thing checking and the thing that mattered were different things**, and nothing connected them:

- Traefik checked that it could attempt a renewal. Nothing checked that a hostname still resolved.
- The endpoint checked that it had dispatched. Nothing checked that anything was enqueued.
- The health check confirmed a process was running. Nothing confirmed it could read its configuration.
- `-n` promised not to execute. Nothing enforced that promise across a recursive line.
- The build checked that the config parsed. Nothing checked where it pointed.

I don't think the lesson is "add more monitoring". Every one of these had monitoring; the monitoring was green and honest about the narrow thing it watched. The lesson I'm actually taking is duller: **when I add something to a list, I should also decide what removes it.** The hostname list, the allowlist, the exception list. All three of this week's worst failures were entries that outlived their reason, in a place nothing read.

## What shipped

Video and captions are back. Transcription can now say why it failed, which it could not before. The notification queue enqueues. `restore` leaves a bootable service and warns about `-n`. Response security headers are set by the application rather than deferred to a proxy that was never configured to set them. The authorization entry point has tests, which it had none of. There's a personal-data inventory that answers "where does this person's data actually live" from the catalog rather than from a list somebody hand-maintains.

Both release lines carry the same migration sequence now, so moving between them is a supported operation rather than a hope.

If you run OneCamp: the object-store and collaboration fixes matter to you, and they're in the current release. If you were about to clone the frontend, do it again: the README is a README, and the config is placeholders.

And if you have a Traefik rule that accumulates hostnames, go read it. Mine had been wrong for a month and the only symptom was that a feature people rarely test on a demo had stopped existing.

The same class of green light, twice already this month: [every health check was green](/post/Every-Health-Check-Was-Green-And-Nobody-Could-Download-My-Product.html), and [the update that downloaded and never ran](/post/The-Update-Downloaded-Fine-And-Never-Ran.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
