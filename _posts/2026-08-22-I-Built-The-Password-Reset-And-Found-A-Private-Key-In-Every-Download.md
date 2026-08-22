---
title: "I Built the Password Reset and Found a Private Key in Every Download"
image: "/assets/images/post/onecamp-recovery-week.jpg"
author: "Akash Hadagali"
date: 2026-08-22 12:00:00 +0530
published: false
description: "A customer asked what happens if they forget their workspace admin password. The honest answer was that nobody could help them, because the password is delivered once and never stored. Building the recovery path took a day. Verifying it took the rest of the day and turned up a service-account private key committed to the repository and shipped inside every customer download, the production .env baked into every image, reset tokens stored in plaintext, and two releases I published that would not start. The last one is the one I want to talk about, because I checked the logs instead of the exit code."
tags: ["OneCamp", "Security", "Docker", "Go", "Release Engineering", "Postmortem", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace — chat, docs, tasks, projects, calls, boards, tables, an API — with AI teammates that live in it. It runs on **your** infrastructure, through **your** choice of model.

This week I added [managed hosting](/post/One-Server-Per-Customer-And-The-Four-Times-The-Obvious-Design-Was-Wrong.html). Then someone asked a question that sounded like support and turned out to be architecture:

> If a customer forgets their workspace admin password, can you resend it?

**No.** And I want to explain why that's the right answer, because the wrong version of it is the reason this post exists.

---

## The Password That Cannot Be Resent 🔑

When a managed workspace is provisioned, the first admin account is created for the customer and a password is generated. That password is put in exactly one email and then forgotten — never written to a database, a log line, or an error string.

That is the correct design. A credential you keep is a credential you can leak. But it has a consequence I hadn't followed through: **there is nothing to resend.** "Resend their password" isn't a support action anybody can perform, because it no longer exists.

Fine — so they use forgot-password. Except a freshly provisioned workspace has **no mail key**. The installer clears it deliberately, so that nothing ever sends from a customer's domain without them choosing to. So `/auth/forgot-password` mints a reset token and then has nothing to deliver it with.

And because that endpoint always answers *"check your email"* — it has to, otherwise it becomes a way to discover which addresses have accounts — the failure is completely invisible. The customer sees success. Nothing arrives. Nobody is alerted.

A workspace whose only admin forgot their password before adding a mail key had **no route back in over HTTP at all**.

The fix is a set of `make` targets that need nothing but shell access: mint a reset link, set a password directly, clear a lost second factor, and change the address when the mailbox itself is gone. Plus a button in the operator panel that runs the first one over SSH and relays the link, because our backend can send mail even when a tenant cannot.

Two details I'd defend:

**A link, not a password.** Whoever runs it never learns the customer's secret. A password read out over a support channel lives in that channel's history forever.

**Clearing two-factor is a separate command**, never a side effect of a reset. *"I lost my phone, please turn off my second factor"* is the oldest pretext in support, and a reset that quietly stripped 2FA would make every password recovery a full account takeover for anyone who could ask for one.

---

## Then I Read the Code Around It 🔍

Building that meant reading the reset-token table. It stores the token in **plaintext**.

A reset token is a bearer credential: whoever holds it can set the password on that account without knowing the old one. Stored in plaintext, that table is a list of working skeleton keys for every reset currently in flight — usable by anyone who can read the database once, from a leaked backup or a replica, and replayable until each expires.

What makes this a good example rather than an embarrassing one is that **the codebase already knew this**. The recovery-code table, added weeks earlier, hashes with SHA-256 and its migration explains at length why a generated high-entropy value needs a fast hash rather than bcrypt. The reset tokens simply predated that reasoning. It wasn't a disagreement, it was a gap nobody had walked back through.

---

## The Private Key in Every Download 🚨

Then I went to make the image smaller, and found the thing that actually matters.

`firebase-cred.json` — a service-account private key — was **committed to the repository**. The download endpoint serves repository contents. So it has been inside the archive every customer has ever downloaded, and baked into every Docker image.

Separately, `.dockerignore` contained one line: `data`. Everything else in the working directory went into the image via `COPY . .` — and the build runs in the *deployment* directory, where the real `.env` lives. I confirmed it on the running production image: `/app/.env`, 11,583 bytes, containing the key-encryption keys that decrypt everything at rest, the database password, and the admin token. That image then had to be treated as a secret, and was not.

Both are now excluded from any build context, and the key is being rotated — which is the only real remediation, because removing a file from a repository does not remove it from history or from tags already published.

The uncomfortable part is that neither of these was found by a security review. They were found because I was trying to make a container smaller and looked at what was inside it.

---

## Two Releases That Would Not Start 💥

This is the one I actually want to write about.

Removing `.env` from the image made the image correct and the product broken, because **that file was how the container got its configuration**. `godotenv.Load()` calls `log.Fatal` when there's no file. I restarted a live workspace onto the new image and it crash-looped. Users were down for about two minutes while I put an emergency mount in place.

That's a bad afternoon but a normal one. Here's the part worth learning from.

I fixed it, rebuilt, ran the container, and read this:

```
env: no .env file; using the configuration already in the environment
```

Which is exactly the message I'd just written to mean *it worked*. So I tagged the release.

The container was still exiting. There was a **second** `godotenv.Load()` in `main.go`, and it killed the process immediately after that reassuring line. I had read the logs and never run `echo $?`.

I did the same thing twice — two published tags, `v2.4.2` and `v2.4.3`, neither of which would start on a customer install. Both compiled. Both passed every unit test. Nothing in the pipeline had ever asked whether the thing it built **runs**.

There are now three assertions in CI on the image a customer receives: it contains no `.env` and no credential file; given configuration in the environment and no file, it gets past every configuration gate and stops only for want of a database; and given nothing at all, it says so plainly. It checks the **failure reason**, not just the exit code — because a container with no database is *supposed* to die, and what must not happen is dying at configuration while claiming the environment was fine.

I verified the check by running it against the commit that became the broken release. It fails. That's the only way I now believe a guard works: point it at the bug it was written for.

---

## Deleting a Broken Release Didn't Delete It 🪞

Epilogue, and my favourite one.

I deleted the four broken tags. Then I checked the backend, which keeps a local mirror of the repository to resolve which version to serve — and all four were still there.

The mirror fetched without `--prune`, so it only ever **added** refs. A tag deleted upstream lived in it forever. Which means deleting a release was ineffective, and that is precisely the one operation that has to work when a release turns out to be broken: publish it, discover it doesn't start, delete the tag, and the backend keeps handing it out from its own copy.

One word. `Prune: true`. Found only because I'd just done the thing it breaks.

---

## What I'd Take From This 📌

Four things, none of them clever:

**A credential you never store is one you cannot leak — and cannot resend.** That trade is correct, but you have to build the other half of it, or your support answer is "nothing can be done".

**Look inside the artefact you ship.** Both leaked secrets were visible to anyone who ran `ls` in the image. Nobody had.

**Check the exit code, not the log.** I wrote a reassuring message and then believed it. Twice.

**Point every new guard at the bug it was written for.** A test that has never seen the failure it guards against is a comment.

The recovery paths, the token hashing, the slimmer images and the CI boot check are all live. The Firebase key rotation is the one item still outstanding, and it's the one that matters most.

The other posts from these days: [one server per customer](/post/One-Server-Per-Customer-And-The-Four-Times-The-Obvious-Design-Was-Wrong.html), and [shipping two editions](/post/Shipping-Two-Editions-And-The-Customer-Install-That-Actually-Works.html). Before that: [two-factor and SCIM](/post/Two-Factor-SCIM-And-The-Config-File-Nothing-Was-Checking.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
