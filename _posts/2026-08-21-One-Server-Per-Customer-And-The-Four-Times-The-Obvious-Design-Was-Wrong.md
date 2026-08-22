---
title: "One Server Per Customer, and the Four Times the Obvious Design Was Wrong"
image: "/assets/images/post/onecamp-managed-hosting.jpg"
author: "Akash Hadagali"
date: 2026-08-21 12:00:00 +0530
description: "OneCamp has always been self-hosted: you buy a licence, you run it. Managed hosting adds the other option — you pay monthly and a whole server gets provisioned for you, one machine per customer, no shared database anywhere. Building it turned up four places where the obvious implementation was quietly wrong: a claim that excluded nobody, a nil provisioner that reported success, a DNS record pointing the workspace at the wrong host, and a server pool defined by exclusion that would have wiped the production box. None of them would have failed loudly."
tags: ["OneCamp", "Managed Hosting", "Go", "Postgres", "OVH", "Provisioning", "Distributed Systems", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace — chat, docs, tasks, projects, calls, boards, tables, an API — with AI teammates that live in it. It runs on **your** infrastructure, through **your** choice of model.

Until this week there was exactly one way to get it: buy a lifetime licence, download the archive, run it on a machine you own. That is still the option I'd pick. But "run it on a machine you own" is a sentence that ends a lot of conversations, and the people it ends them with are not the ones who don't care about their data — they're the ones who care and don't have an ops team.

So: **managed hosting**. You pay monthly, and a server gets provisioned for you.

The part I want to be precise about is what "for you" means, because in most products it means a row in a shared database.

---

## One Machine Per Customer, and No Shared Anything 🏠

Every managed workspace gets **its own server**. Not its own schema, not its own tenant id with a `WHERE` clause in front of it — its own machine, its own Postgres, its own object storage, its own encryption keys.

This is worse for me on every dimension a spreadsheet measures. It costs more per customer, it scales worse, and it makes "just run one migration" into a fleet operation.

It is also the only version of this I'd be willing to sell, and the reason is that the alternative requires you to trust my `WHERE` clause. Every multi-tenant breach story is the same story: one query somewhere forgot the tenant filter. I would rather not have the class of bug at all than promise I've never written it.

The trade I'm making is honest and worth stating: **more expensive to run, and it means I cannot look at your data even if I wanted to** — which also means I cannot restore it for you from some central backup, because there isn't one.

---

## The State Machine, and the Claim That Excluded Nobody 🔁

Provisioning is not one operation, it's about seven, each of which can fail differently and be retried: order a machine, adopt it, install, point DNS, deploy the customer's own web app, verify, hand over credentials.

That is a state machine, and I wrote it as one — a row per workspace, with transitions guarded by compare-and-swap so that two workers racing on the same instance cannot both act on it.

The compare-and-swap was wrong in a way that testing found and reading did not.

The guard said: move this instance from state X to state Y, but only if it is still in state X. That is textbook, and for a *transition* it is correct. The problem is the step that claims work **without** changing state — "I am now working on this instance, in the state it is already in". Written the same way, the condition becomes `WHERE state = X` and moves it to `X`, which is true for **every** caller. Twelve concurrent workers, twelve winners.

I found it by running twelve goroutines at a real Postgres and counting. Twelve. The fix is a **leased claim** — a `claimed_until` timestamp that the swap also has to beat — and the same test then reported one winner.

The general lesson I keep relearning: a concurrency guard that has never had two things pointed at it is a comment, not a guard.

---

## The Provisioner That Wasn't There ⚙️

The orchestrator takes a `Provisioner` — the thing that actually SSHes into a machine and installs the product. In tests it's a fake. In production it's built from configuration.

If the SSH key wasn't configured, the constructor returned nil. And the orchestrator's step, finding nothing to call, did the natural Go thing: skipped the call and returned no error.

So the workspace advanced through *adopting*, *provisioning*, *verifying*, and reached **live**. The customer got an email saying their workspace was ready, with a link to a machine on which nothing had been installed.

Every state transition worked perfectly. That's what makes it a good bug: nothing failed, so nothing was reported. It now holds with an explicit `ErrNoProvisioner` and stays where it is until somebody configures a key.

---

## The DNS Record That Pointed at the Wrong Machine 🌐

A managed workspace lives at `yourname.onemana.dev`. Two things need to answer: the web app the customer opens, and the API the web app talks to.

The API runs on their new server. The web app does **not** — it's deployed per-customer to Vercel, because `NEXT_PUBLIC_*` values are baked in at build time, so a shared frontend cannot be pointed at a different backend per tenant.

My record layer only knew how to write `A` records. An `A` record is an IP address. So the workspace hostname was pointed at the server's IP — which is the API, not the web app. Every customer would have opened their workspace and got raw JSON.

The fix is that the frontend hostname is a `CNAME` at Vercel and the API hostname is an `A` at the server. Obvious once written down. Completely invisible until something actually resolved it.

There was a matching bug in the custom-domain flow, for customers who bring their own domain: the verification step demanded a record shape that a **correct** configuration wouldn't have. It would have rejected people who'd done it right and accepted people who hadn't.

---

## The Server Pool Defined by Exclusion 🗑️

Managed hosting needs a way to answer "is there a spare machine I can give this customer". I had a sweep that asked the provider for the account's servers and treated anything not currently assigned as available — then **wiped it** and installed on it.

I found this because someone asked me a very simple question: *how does it tell your machines apart?*

It didn't. The production box — the one running this service, the payments, everything — is a server in that account and was not assigned to any customer workspace. It matched. The first customer to sign up would have triggered a reinstall of the machine serving the site they signed up on.

A pool defined by **exclusion** ("everything I haven't claimed") is a loaded gun pointed at whatever you forgot. It's now defined by **inclusion**: an explicit list of machine names an operator has to add a server to, and an empty list means no servers are available rather than all of them.

---

## Cancelling, and Actually Destroying the Data 🔥

The part of this I most wanted to get right, because it's the part every SaaS is vague about.

When a subscription ends: the workspace keeps running to the end of the paid period, then enters a **14-day export window** where it's readable but not writable, and then the machine is **wiped** — a real disk wipe through the provider, before the server is released back to the pool.

The order matters and it was originally the other way round. Releasing a machine and *then* wiping it means there is a window where a machine holding a customer's data is available for reassignment. It now wipes first and releases second, and the release only happens if the wipe succeeded.

There are no refunds and the product says so plainly: you keep the service to the end of what you paid for. I'd rather write that sentence than a policy page.

---

## What This Isn't, Yet ⚠️

I want to be straight about the state of this.

The whole flow is built, instrumented, tested and deployed. Every step has been exercised against fakes, the state machine against a real Postgres, the reconciliation against the real provider API.

**It has never provisioned a real machine.** The SSH transport and the provider's reinstall call have not run against actual hardware, because doing that means buying a server to throw away, and I've been building the thing that spends money before spending it. That dry run is the last thing between this and a paying customer, and until it happens I'd describe managed hosting as *finished* rather than *proven*.

If you want the version that is proven: [the self-hosted edition](https://onemana.dev/buy) has been running in production for months, and it's the same product. You just have to bring the machine.
