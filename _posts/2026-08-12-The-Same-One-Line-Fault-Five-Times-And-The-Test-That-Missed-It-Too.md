---
title: "The Same One-Line Fault, Five Times, and the Test That Missed It Too"
image: "/assets/images/post/onecamp-realtime-improved.jpg"
author: "Akash Hadagali"
date: 2026-08-12 11:00:00 +0530
description: "Every document and board in the workspace showed 'Reconnecting to collaboration server...' for two weeks, because one unhandled rejection killed a container that had no restart policy. Fixing that one service was the wrong-sized fix: eight more services in the same file would not have survived a reboot, including Postgres, and the same default was in the stack that ships to customers. Then a Makefile target turned out to point at a stub that would have undone the fix, ten compose files turned out to be divergent duplicates of services already defined, `latest` had already moved for all eight upstream images — and the test I wrote to catch the original fault silently skipped a service because its name had a comment after it."
tags: ["OneCamp", "Docker", "DockerCompose", "Reliability", "Go", "Testing", "DevOps", "SelfHosted", "OpenSource"]
---

One of three posts about the days after [the week with no new features in it](/post/We-Opened-OneCamp-To-Outside-AI-Agents-And-Every-Gate-Found-A-Bug.html). The others are about [two-factor and SCIM](/post/Two-Factor-SCIM-And-The-Config-File-Nothing-Was-Checking.html) and [a failed signup burning an email address forever](/post/A-Failed-Signup-Burned-The-Email-Address-Forever.html).

This is the one I'd read. Not because the fixes are clever — every single one is a one-line change — but because the shape of it is something I've now watched happen five times in a row, and the last instance was a test I had written specifically to prevent the previous four.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace with AI teammates, running on your own infrastructure.

---

## It Started With Two Weeks of "Reconnecting…" 🔌

Real-time editing in OneCamp — documents and boards, multiple cursors, the usual — runs through a collaboration service. One unhandled promise rejection killed that container.

It had no restart policy. So it stayed dead.

For two weeks, every document and every board in the workspace displayed:

```
Reconnecting to collaboration server...
```

The rest of the product worked perfectly. Chat, tasks, search, calls, the API — all fine. And the client was behaving *correctly*: it was reconnecting, patiently, on a backoff, to something that was not there and was not coming back. Nothing alerted, because nothing was erroring. A container that has exited is not throwing exceptions.

I fixed it in one line: `restart: unless-stopped`. Then I moved on, which was the mistake.

---

## Fixing One Service Was the Wrong-Sized Fix 📉

A week later, with a reboot pending on the host, I went to check whether the stack would come back. That question has a precise answer, and it is not the one most people assume.

Docker starts a container when the daemon starts **only** for `always` and `unless-stopped`. A missing policy means `no`. And `on-failure` — which reads like the careful, considered choice — [does not restart the container when the daemon restarts](https://docs.docker.com/engine/articles/host_integration/) either.

Auditing the main compose file found **eight more services** that would not have come back:

| service | policy | what it is |
|---|---|---|
| `postgres` | *none* | the primary database |
| `zero`, `alpha` | `on-failure` | Dgraph, read by every user lookup |
| `emqx` | *none* | MQTT — all realtime messaging |
| `minio` | *none* | object storage |
| `agent` | *none* | meeting transcription |
| `ratel`, `opensearch-dashboards` | *none* | operator tooling |

Meanwhile `go-service` — the API — had `always`.

Read that table with the API in mind. A reboot would have brought the stack back as a **shell**: the API restarts immediately, into a world with no databases and no message broker, and stays there until a human notices. Healthy container, listening port, nothing behind it.

The `on-failure` pair is the worse half, and it's worth dwelling on. It looks like someone thought about it. It provides neither reboot survival *nor* a retry cap — bare `on-failure` retries forever, exactly like `unless-stopped`. It is the appearance of a decision with none of the effect.

**And the same defaults were in all three deployed stacks**, including the one that ships to customers. So this was never one host's misconfiguration. It was the default every deployment inherited.

Twenty-seven lines across three files. I chose `unless-stopped` over `always` because a deliberate `docker stop` during maintenance has to stay stopped, or the policy fights the operator.

---

## Instance Three: The Target Named After the Fix Would Have Undone It 🔨

Before that, something else had already gone wrong in the same shape.

Three Makefile targets for deploying the collaboration service pointed at `hocuspocus-compose.yml` — a local-development stub from 2025 that declared the same service **without** the Redis password, without the Traefik labels, and without a restart policy.

So `make build_collaboration_service` — the command named exactly after the thing you'd want to do — would have replaced the working container with an unreachable one, and silently reverted the restart-policy fix I'd just made. The stub was deleted, because two definitions of one service is the fault itself, not a thing to keep in sync.

At this point the pattern is clear enough to name: **the fault is one line, its absence is invisible in review, and it only surfaces on the one occasion nobody is watching.** So the third fix shouldn't be another line. It should be a test.

I wrote one. It asserts that every service in every deployed compose file has a reboot-surviving policy, with one-shot init jobs exempted by name and reason.

Hold that thought.

---

## Instance Four: Ten Compose Files That Were All Slightly Wrong 🗂️

Auditing the rest of the deployment surface found ten more per-component compose files — `postgres-compose.yml`, `redis-compose.yml`, `dgraph-compose.yml` and seven others. Each was a second declaration of a service the main compose file already owned. Each was reachable from a Makefile target named after exactly what an operator would want. And nothing had ever compared them to the real definition, so all ten had drifted:

- **Nine declared no networks at all.** `up -d` would recreate the service on the project's default bridge instead of the shared network — reachable by nothing that needs it. For the API service, that also drops the Traefik network, so it comes back healthy and the reverse proxy cannot route to it. The whole product down, every container green.
- **All but one published ports to the host**, turning internal-only datastores into host-reachable ones. Postgres, Redis and MinIO among them.
- **The OpenSearch one was the worst.** It declared `opensearch-node1` — a *different service name* from the real `opensearch-onecamp-node1` — mounting **the same data directory**. So it wouldn't have replaced the running node. It would have started a second OpenSearch JVM on the live one's data files.
- One was a byte-identical copy of the sandbox that runs untrusted code, minus the profile guard. Harmless today, and precisely the shape where a hardening added to one copy never reaches the other.

Deleted; targets repointed at the definition the stack actually uses. One detail mattered more than the rest: every repointed target had to become `stop` rather than `down`. `docker compose down` aimed at the *main* file removes every service in it — so `stop_redis_containers`, harmless while it named a file containing only Redis, would have taken the entire stack down the moment it was repointed.

---

## Instance Five: `latest` Had Already Moved. For All Eight. 📦

The same audit, one layer down. Thirty of fifty-one image references were floating — `:latest`, and in one case no tag at all, which Docker reads the same way.

I checked the eight distinct upstream images against the registry, expecting to find that this *could* drift.

**It already had. Every one of them.** Beta was running Redis 8.6.2 while `latest` had reached 8.6.5. Dgraph, EMQX, LiveKit, the egress service — all of them pointing at something newer than what was deployed. So the running stack was a set of versions nobody had chosen and nothing recorded, and a `docker compose pull` aimed at any one of them would have moved a datastore underneath a live workspace.

Then it got worse. For **three** of the eight, no published tag matched the running image's digest *at all*. Upstream had re-pushed or pruned it. The running configuration was not reproducible from any tag in existence — if those containers had been removed, what came back would necessarily have been something else. For a product whose whole proposition is that it runs on your infrastructure, "we cannot tell you what you are running" is not an acceptable answer.

And the stack that ships to customers named `minio/minio` with **no tag** while the two stacks under test both pinned a specific release. Object storage was one version in testing and a floating, different one in production. The line looks like an image reference because it is one; nothing in review shows you the missing tag.

Every pin was chosen by matching the **running container's digest** against the registry's published tags, rather than reading the image's version label. That distinction earned its keep immediately: for the Dgraph admin UI, the label carries no version, and my first guess at a tag existed — and would have been a silent seven-major-version *downgrade*. The digest matched nothing, which is the honest answer, and the file now says so on the line.

---

## The Instruction in the Product Didn't Work Either 📋

Pinning the AI engine's version exposed something adjacent. The admin panel reads the running Ollama version, compares it against the newest release, and shows "update available" — which is genuinely useful. Next to it, it printed the command to run:

```
docker compose pull ollama && docker compose up -d ollama
```

That command does not work on **any** OneCamp deployment. There is no `compose.yml` in the deploy directory — the stack is `-f final-compose.yml` under a named project — so it fails with "no configuration file provided" wherever an admin ran it. And once the image is pinned, `pull` on its own would fetch the version already installed and change nothing, because the version now lives in the environment file.

Both halves were wrong. The reason nobody had reported it is instructive: **the only person who could discover it was already logged into a server**, which is the exact situation the instruction exists to help them avoid.

It was also written out by hand in three separate places in the UI, and they had already drifted — one was HTML-escaped differently from the others, which is the fingerprint of a copy-paste rather than a shared component. All three are now one component, showing the two steps that are actually the update, each copyable, with the target version filled in from the release the panel already knew about.

There is deliberately no *button*. Replacing a container image needs something in the deployment holding the Docker socket, which is root on the host, and the service rendering that page runs AI agents against external tool servers. It is the last process that should have it.

---

## And the Test I Wrote to Catch All This Was Lying 🙈

Now back to that test.

It had been passing for an hour. It reported all three deployed compose files clean. Its commit message said the fault was closed.

Its service-name pattern ended in `:\s*$`. And the stack that ships to customers declares its search node like this:

```yaml
opensearch-node1: # This is also the hostname of the container within the Docker network
```

A trailing comment. The pattern doesn't match it. So the test never looked at that block — and `opensearch-node1` **had no restart policy**. A ninth missing policy, in the most important of the three files, hidden behind a `#`, reported as clean by the test written to find exactly that.

I only found it because I'd copied the same regex into a throwaway analysis script and the service count came out one short of what I could see with my own eyes.

**A parser bug in a test does not fail. It under-reports.** Which is worse than having no test at all, because it also stops anyone looking again. A red test gets fixed. A green test that isn't looking gets trusted.

So the fix is not the regex. Any future shape the pattern couldn't handle — a quoted key, a different indent, a character outside the class — would fail the same silent way. There is now a second check that compares what the strict parser matches against a deliberately sloppy pattern (anything at service indentation ending in a colon) and **fails on the difference**, naming the line. The parser is allowed to be strict. It is not allowed to be strict and quiet.

I verified that by putting the repository back to the exact state it had been in an hour earlier — old pattern, no policy on that service — and running both checks. The original test passes. That's the bug. The new one fails, and names the file and line.

---

## What I Actually Take From This 🧠

Five instances, one shape. Let me state it plainly, because I don't think it's specific to Docker or to me:

**A fault whose fix is one line, and whose absence produces no error, will be present in more places than the one you found it in.** Every time. The single-service fix feels proportionate and is not, because the reason you found it in one place is that one place got unlucky first.

The corollary is the harder one. When you finally write the check, **the check is code**, and it is code written by the same person who missed the fault five times, under the impression that this part is the easy part. So:

- Watch your check fail. Not "run the test suite and see green" — deliberately reintroduce the fault and confirm the failure message names the thing. Every check in this work was verified that way, and two of them were wrong when I did it. The compose parser was one. A version-splitting helper was the other: it read the colon inside `${VAR:-latest}` as the tag separator, so a variable defaulting to `latest` read as *pinned* — the exact shape the check existed to catch, waved through by the check.
- Make blind spots loud. A checker that can't parse something should say so, not skip it.
- Treat a file nothing reads as a file that is wrong. Compose files, config templates, fixtures. Correctness nobody verifies is a rumour.

---

## What Changes If You Run OneCamp 🚀

- **The stack survives a reboot now.** All three deployed compose files, every long-running service.
- **Every image is pinned** to the version that was actually running and verified, so an upgrade is a decision with a rollback rather than a side effect of the next pull.
- **One definition per service.** Ten duplicate compose files are gone; the per-service Makefile targets act on the real definition and use `stop` rather than `down`.
- **The Ollama engine has a version you control**, `OLLAMA_IMAGE_TAG`, and `make ollama_update` applies it. Putting the old value back is the rollback.
- **On upgrade**, the pinned tags differ from whatever `latest` you have cached, so the first recreate of each service pulls. Same versions, new tags, real download — worth scheduling rather than discovering.

None of this is a feature. Nobody will notice it, which is the entire objective.

Next: [a failed signup burned the email address forever](/post/A-Failed-Signup-Burned-The-Email-Address-Forever.html).
