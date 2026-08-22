---
title: "Shipping Two Editions, And The Customer Install That Actually Works"
image: "/assets/images/post/onecamp-release-editions.jpg"
author: "Akash Hadagali"
date: 2026-08-19 12:00:00 +0530
description: "OneCamp now ships as two tracked editions: v1 without AI, and v2 with AI. That sounds like a packaging change until you try to install it. The published guide told customers to run make targets that did not exist, the shipped Makefile pointed at a compose file with a different name, and make doctor reported a clean config while secret-store placeholders were still in it. Fixing the install surface turned up the same pattern as the code: the spec was the documentation, and the documentation had drifted."
tags: ["OneCamp", "Release", "Self-Hosted", "OpenSource", "DevOps", "CI", "Enterprise"]
---

> **Note, added later.** Two things have changed since this was written.
>
> **If you downloaded before 22 August 2026, re-run the installer.** Releases before that date
> shipped a service-account credential inside the archive and baked your `.env` into the container
> image. Both are fixed. You do not need to look up a version — the installer always fetches the
> current release on the edition you choose. Delete the old archive once you have re-downloaded.
>
> The seven commands below were also replaced the next day by a single `make install`. This post is
> the story of how the install got fixed, not the instructions — for those see
> [the installation guide](https://onemana.dev/docs/installation), or
> [OneCamp Cloud](https://onemana.dev/docs/cloud) if you would rather not run a server at all.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace — chat, docs, tasks, projects, calls, boards, tables, an API, and optional AI teammates. It runs on **your** infrastructure, with **your** choice of model.

This week was release infrastructure, not features. The kind of week that is invisible when it works and very visible when it doesn't. It follows [two-factor and SCIM](/post/Two-Factor-SCIM-And-The-Config-File-Nothing-Was-Checking.html), [a compose fault found five times](/post/The-Same-One-Line-Fault-Five-Times-And-The-Test-That-Missed-It-Too.html), and [a failed signup that burned the email](/post/A-Failed-Signup-Burned-The-Email-Address-Forever.html). The other post from these days is [one server per customer, and the four times the obvious design was wrong](/post/One-Server-Per-Customer-And-The-Four-Times-The-Obvious-Design-Was-Wrong.html).

---

## Two Editions, Two Branches

OneCamp has always had an AI branch and a non-AI branch, but the releases were drifting. They are now two permanent editions, each tracking its own branch:

- **v1** is the AI-free edition (`without-ai`).
- **v2** is the AI edition (`main`).

That is the whole vocabulary a customer needs. Nobody picks a version number: you choose an edition,
and the installer fetches the current release on that line. Every licence includes **both**, so
moving from v1 to v2 later is a re-run of the installer, not another purchase.

The AI-free tree is not the same code with features hidden. It is a separate build that has the AI packages, routes, marketplace entry, and AI-only environment keys removed. That means a v1 install never downloads an Ollama image, never exposes an AI endpoint, and never asks an operator to configure keys for a feature that is not there.

Keeping two editions buildable from the same repo means every CI gate has to pass on both. The `without-ai` workflow was failing on guard tests that assume the full tree — tests that walk every exported function, every environment template, every OpenSearch seam, and every authorization consumer. Those tests are correct for the full edition. In the AI-free edition the right answer is not "make the code look like the full edition"; it is "make the guards understand that this edition intentionally does less." So the guards now skip or baseline the parts that do not exist in `without-ai`.

---

## The Install Guide Was The Specification

The published install guide told customers to run:

```bash
make update-admin-email
make update-server-ip
make replace-domain
make create-traefik-password
make update-traefik-email
make update-allowed-domains
make create-swap
```

None of those targets existed in the customer Makefile. A paying customer following the official instructions hit `No rule to make target` on the third line. They had already been charged.

The Makefile they received also pointed at `compose.yml`, but the zip shipped `sample-compose.yml`. So even a customer who got past configuration would fail at `make build_restart_all` with `can't find a suitable configuration file`.

`make doctor` reported "No placeholders left in .env" while `INTERNAL_SECRET`, `LIVEKIT_API_PASS`, `TURN_SECRET`, `RESEND_API_KEY`, and `ADMIN_PASSWORD` still contained `__SET_FROM_SECRET_STORE__`. The regex only caught `__CHANGE_ME_*__` placeholders.

The fix was not to rewrite the guide. The guide was the spec. The Makefile had to match it:

- All seven setup targets now exist and are idempotent.
- `COMPOSE` points at `sample-compose.yml`.
- `make doctor` flags any remaining `__...__` placeholder, including secret-store placeholders.
- `make ollama_update` exists, because the admin AI panel tells admins to run it.
- `include .env` became `-include .env` so `make help` works before the operator has copied `.sample.env` to `.env`.

---

## Why The Frontend Snapshot Needed A Hard Reset

The public frontend repo has two branches with unrelated histories: `ai` (v2) and `main` (v1). `main` had fallen behind because every sync meant cherry-picking non-AI commits out of an AI-first tree. After a while the only honest thing to do was regenerate it: take the current `ai` tree, delete the AI-only pages, components, hooks, and utilities, and fix what broke.

That removed ~60 files and ~20k lines. Build and tests pass. The non-AI edition now has the same recent boards, tables, templates, SCIM, two-factor, and call-gating work as the AI edition, without the AI surfaces.

---

## What Is Still Open

- **Runtime license enforcement.** OneCamp does not phone home after install. Revoking a license stops future downloads, not a running instance. That is a product decision, not a bug, but it is the next security hardening item.
- **Lint.** The frontend snapshot passes build and tests. Lint warnings are at a pre-existing baseline; a separate pass is needed to ratchet them down without mixing release work with a massive cleanup.

---

## The Pattern

The same failure mode showed up three times this week:

1. The install guide described targets that did not exist.
2. The CI guard tests described a full tree that the AI-free edition does not ship.
3. The frontend `main` branch described a non-AI edition that had not been fully synced.

In each case the fix was to make the artifact match the stated contract, rather than quietly update the contract. A release is not done when the code works in development; it is done when the thing a customer actually receives behaves the way the documentation says it does.

Next: [one server per customer, and the four times the obvious design was wrong](/post/One-Server-Per-Customer-And-The-Four-Times-The-Obvious-Design-Was-Wrong.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace. It now ships as two editions, v1 without AI and v2 with it: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
