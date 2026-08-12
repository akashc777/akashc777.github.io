---
title: "Two-Factor, SCIM, and the Config File Nothing Was Checking"
image: "/assets/images/post/onecamp-2fa-scim.jpg"
author: "Akash Hadagali"
date: 2026-08-12 12:00:00 +0530
description: "OneCamp now has TOTP two-factor sign-in and SCIM 2.0 provisioning, so Okta or Entra can create and deactivate members and a stolen password is no longer enough. Writing them turned up four decisions where the obvious answer was wrong — reusing the AI key-encryption key would have locked every enrolled user out on the next provider leak, and reusing the API-token middleware for SCIM meant offboarding the admin who connected Okta would silently kill provisioning. Then my own commit corrupted the production config template, and every gate passed, because nothing in the repository had ever read that file."
tags: ["OneCamp", "Security", "2FA", "TOTP", "SCIM", "Go", "NextJS", "Enterprise", "Self-Hosted", "OpenSource"]
---

One of three posts about the days after [the week with no new features in it](/post/We-Opened-OneCamp-To-Outside-AI-Agents-And-Every-Gate-Found-A-Bug.html). This one has new capability in it. The other two are about [the same one-line fault found five times](/post/The-Same-One-Line-Fault-Five-Times-And-The-Test-That-Missed-It-Too.html) and [a failed signup burning an email address forever](/post/A-Failed-Signup-Burned-The-Email-Address-Forever.html).

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace — chat, docs, tasks, projects, calls, boards, tables, an API — with AI teammates that live in it. It runs on **your** infrastructure, through **your** choice of model.

Two things came up in every conversation with anyone who has a compliance team: **make a stolen password insufficient**, and **stop making us create and delete accounts by hand**. So: TOTP two-factor, and SCIM 2.0 provisioning.

Both are boring, well-specified features. That is exactly why the interesting part is where the obvious implementation was wrong.

---

## Two-Factor: Why I Wrote the TOTP Myself 🔐

There is a good Go library for this. I didn't use it, and I want to be precise about why, because "I wrote my own crypto" deserves a real justification.

TOTP is a hash of a shared secret and a time counter. The algorithm is [RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238) and the implementation is about fifteen lines you can check by hand against the RFC's own test vectors. That is not the hard part.

The hard part is **replay**. A six-digit code is valid for its whole 30-second step, plus the skew either side — so on OneCamp's settings a code is good for at most 90 seconds. Someone who reads a code over your shoulder, or off a screen share, has a minute and a half to use it. The only thing that closes that window is recording *which time-step was accepted* and refusing that step a second time.

Every library I looked at returns a boolean. `Valid(code) bool` cannot tell you the step that matched, so it cannot tell you what to refuse next time. I'd have ended up recomputing the step outside the library, which means writing the interesting half anyway and then keeping two implementations of the counter in agreement.

So `ValidateTOTP` returns the matched step, the step is stored, and a code presented twice fails the second time. Fifteen provable lines against the RFC's vectors, and the property I actually needed.

**Recovery codes** are ten per user, hashed with SHA-256 rather than bcrypt. That looks like a downgrade and isn't: bcrypt's cost exists to slow down guessing at *human-chosen* secrets. A recovery code is 
generated with full entropy, so there is nothing to guess faster than brute force, and bcrypt would mean one deliberately expensive comparison per stored code on every attempt.

---

## The Key That Must Not Be the Other Key 🔑

TOTP secrets are encrypted at rest. OneCamp already had a key-encryption key for AI provider credentials, `AI_CONFIG_KEK`. Reusing it is one less thing for an operator to configure, which is a real benefit in a self-hosted product.

It is also a trap, and the reason is operational rather than cryptographic.

`AI_CONFIG_KEK` is the key you **rotate** when an AI provider key leaks. That is its job; it's supposed to be rotated, possibly in a hurry, possibly at 2am. If TOTP secrets were sealed under the same key, then rotating it during a provider incident would instantly lock out **every enrolled user in the workspace** — including the admins trying to handle the incident. The two secrets have opposite lifecycles: one you rotate on suspicion, the other must survive for as long as the user's phone does.

So `TOTP_KEK` is separate, and it deliberately has **no development fallback**. A fallback would be a value in the repository that works, and the entirely predictable outcome is someone deploying with it. If `TOTP_KEK` is unset, two-factor is simply unavailable and the rest of the product runs — which is a supported configuration, not a failure.

While I was there I made a placeholder KEK **fatal at boot in every environment**, not just production. The previous behaviour was to warn. A warning in a startup log is not a control; it is a thing nobody reads, in the one place where getting it wrong means every encrypted value in the database is sealed under a key that is published on GitHub.

### The sign-in challenge is a signed token, not a session

After a correct password, the server has to remember "this person is halfway in" until they produce a code. The obvious home for that is Redis.

I used a short-lived signed JWT with a `purpose` claim instead, because putting it in Redis would make **Redis an availability dependency of logging in**. OneCamp uses Redis for caching, and caches are allowed to be down. Login is not. A signed challenge needs no server-side state at all, and the `purpose` claim is what stops it being replayed at any other endpoint that accepts a token.

---

## The Frontend Lesson: A Discriminated Union Does Not Force You to Handle Every Case ⚠️

Login used to return a session. Now it returns one of three things: a session, a two-factor challenge, or a failure. I modelled that as a TypeScript discriminated union — `LoginOutcome` — and wrote a comment saying the compiler would now force any new outcome to be handled everywhere.

Then I checked, because I've started distrusting claims I haven't watched fail.

I deleted the `totp_required` branch from the component that consumes it. **`tsc --noEmit` stayed clean.** A discriminated union gives you *narrowing* — inside a branch, the type is refined — but nothing anywhere requires you to write all the branches. An `if` chain that silently falls through the end is perfectly well-typed.

The comment was wrong, and it was the kind of wrong that costs you later: a future outcome would have been silently ignored while the code looked exhaustive. Exhaustiveness has to be asked for, so there is now an `assertUnreachable` helper in the default branch — a function whose parameter is `never`, so adding a variant without handling it becomes a type error. And I corrected the comment rather than leaving a confident sentence that wasn't true.

For the QR code I did add a dependency. Rendering a QR is Reed–Solomon error correction, mask-pattern selection and version capacity tables — not fifteen checkable lines, and getting it subtly wrong produces a code that scans on your phone and not on someone else's.

---

## SCIM: The Middleware That Would Have Deleted Its Own Access 🔁

SCIM is how Okta, Entra and friends create, update and deactivate accounts in your app without a human in the loop. The protocol is well specified and mostly unsurprising. Three decisions were not.

### 1. It needed its own credential

OneCamp already has API tokens with a perfectly good middleware. Reusing it would have been free.

That middleware **refuses a request whose token owner is inactive**. Which is correct for API tokens, and catastrophic for SCIM, because *deactivating users is what SCIM is for*. Connect Okta using an admin's token, then let Okta offboard that admin six months later, and provisioning dies — silently, permanently, and at the exact moment you are relying on it to remove someone's access. You would find out when a leaver kept working.

So SCIM credentials are their own table, not owned by a user. `created_by` is recorded for audit and is `ON DELETE SET NULL`: it answers "who set this up" without making the credential depend on that person still existing.

### 2. Deactivated users must still be visible

OneCamp soft-deletes. The email column is `NOT NULL UNIQUE` and a soft-deleted row keeps its address.

So if SCIM's list and get endpoints hid deactivated users — the intuitive reading of "deleted" — the identity provider would conclude the user is gone and try to **create** them on rehire. That create fails on the unique constraint. Forever. There would be no route back through the protocol at all.

Deactivated members are therefore returned with `active: false`, and `PATCH active: true` is the reactivation path. Bots and external identities are excluded entirely: they aren't the IdP's to manage, and letting a directory sync decide the fate of a bot account is a category error.

### 3. An unsupported filter is refused, never approximated

SCIM filtering is a small query language, and almost nobody implements all of it. The tempting shortcut when you meet a filter you don't support is to ignore it and return everything.

That is the worst available option. A client that asks for `userName eq "alice"` and receives every user in the workspace will read `Resources[0]` and **act on the wrong person** — and the action in question is usually deactivation. An unsupported filter now returns `400` with `scimType: invalidFilter`, which the IdP surfaces as a clear error. Refusing to answer is safer than answering about someone else.

---

## Locking Out an Admin, and Unlocking Them 🧑‍💼

Two-factor creates a support burden: someone will lose their phone. So there is an audited admin reset, `POST /admin/auth/2fa/reset`.

It **refuses to target the caller.** Disabling your own second factor requires a current code — that's the point of it. If an admin could reset *themselves* through this endpoint, then anyone with a stolen admin session could strip the factor they can't satisfy and walk straight past it. Self-service and administrative recovery are different operations, and the administrative one is not allowed to be a bypass of the self-service one.

The audit record is written best-effort, using the same helper as the rest of the product, rather than failing the reset if the audit write fails. That is a deliberate departure from the fail-closed rule OneCamp uses for MCP calls: an administrative action is visible in its own effect, and refusing to unlock a locked-out user because a log row didn't insert helps nobody.

---

## And Then I Broke the Production Config, and Everything Passed ✅

Here is the part I'd rather not write up.

The commit that added two-factor authentication inserted its `TOTP_KEK` block into the **middle of a comment** in both `vars/.env.beta` and `vars/.env.prod`. The result was a split sentence and this line, sitting in the file that configures production:

```
CLAMAV_HOST is set, every upload (chat/import attachments, avatars,
```

No leading `#`. No `=`. A line Docker Compose cannot parse, in both templates at once.

**Every gate passed.** `go build ./...` passed. `make test` passed with zero failures across 67 packages. `gofmt` passed. The pre-commit hook passed. All of them, because *nothing in the repository had ever looked at those files*. They are the highest-consequence text in the project and they had less checking than a comment in a Go file.

Fixing the two lines wasn't the fix. The fix is that the templates are now checked for three properties, each of which had actually been violated:

- **Parseable.** Every meaningful line is `KEY=value`. This is the one I broke.
- **Unambiguous.** No key declared twice. `OPENAI_API_KEY` was — once in the speech-to-text section and again under AI providers — so the later line silently blanked the earlier one, and an operator who set the first would find it had no effect with nothing anywhere to explain why.
- **No real secrets.** The KEK values must still look like placeholders. A committed template with a real key substituted in is a leaked key, and the leak is invisible in review: a 64-character base64 blob replacing another 64-character blob.

Auditing the live beta configuration in the same pass turned up fifteen more duplicate keys, an environment flag that had never been set to production, and file permissions that were wider than they should have been. All of which had been true for a while, and none of which anything would have told me.

The general lesson is one I keep relearning in different costumes: **a file that nothing reads is a file that is wrong.** Config, fixtures, compose files, docs. If no test opens it, its correctness is a rumour.

---

## What This Means If You Run OneCamp 🚀

- **Two-factor** is opt-in per member, from profile settings. Ten recovery codes at enrolment, and an audited admin reset for the phone that ends up in a river.
- **SCIM 2.0** is at `/scim/v2/Users`, with its own credential you create in the admin panel. Point Okta or Entra at it and joiners, movers and leavers stop being tickets.
- **Set `TOTP_KEK`** to a real 32-byte-or-longer random value if you want two-factor available. Leave it unset and the feature is simply off.
- **A placeholder KEK now refuses to boot**, in every environment. If that catches you on upgrade, it was already broken — the values it refuses are published in this repository.

The SCIM implementation was exercised end to end against the beta deployment with a temporary credential — list, filter, an unsupported filter correctly rejected, deactivate, reactivate — and that credential was deleted afterwards. I'd rather say that than "it should work".

Next: [the same one-line fault, five times, and the test I wrote to catch it that missed it too](/post/The-Same-One-Line-Fault-Five-Times-And-The-Test-That-Missed-It-Too.html).
