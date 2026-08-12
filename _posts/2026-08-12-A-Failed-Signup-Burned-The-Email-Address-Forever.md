---
title: "A Failed Signup Burned the Email Address Forever"
image: "/assets/images/post/onecamp-failed-signup.jpg"
author: "Akash Hadagali"
date: 2026-08-12 10:00:00 +0530
description: "Creating a user wrote to Postgres, then to Dgraph, and on a Dgraph failure it logged and returned — leaving a row that owns the email address and an account nobody can see. Every retry then failed on the unique constraint, and for SSO every subsequent login failed the same way with no self-service recovery. The same pattern was in channels, teams and projects. Sending a message had a crueller version: the rollback overwrote the error that triggered it, so the API returned 'created post successfully' for a message it had just deleted. Also: 790 response bodies were handing clients Postgres constraint names and internal source lines, and an MCP server whose secret wouldn't decrypt was registered and called with an empty auth header."
tags: ["OneCamp", "Go", "Postgres", "Dgraph", "Reliability", "Security", "NextJS", "Debugging", "SelfHosted", "OpenSource"]
---

One of three posts about the days after [the week with no new features in it](/post/We-Opened-OneCamp-To-Outside-AI-Agents-And-Every-Gate-Found-A-Bug.html). The others are about [two-factor and SCIM](/post/Two-Factor-SCIM-And-The-Config-File-Nothing-Was-Checking.html) and [the same one-line fault found five times](/post/The-Same-One-Line-Fault-Five-Times-And-The-Test-That-Missed-It-Too.html).

No features in this one. It's the half of the job where you find out what your code does when the second write fails.

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace with AI teammates, on your own infrastructure. It stores relational data in Postgres and the identity/permission graph in Dgraph, which means a lot of operations are **two writes**, and this post is about all the ways I had not thought hard enough about the gap between them.

---

## The Shape: Write One, Write Two, Give Up ✍️

The pattern, in four places:

```go
// 1. Postgres
row, err := insert(...)
if err != nil { return err }

// 2. Dgraph
_, err = domain.CreateOrUpdateDgraphUser(ctx, ...)
if err != nil {
        log(err)
        return err   // <- and the Postgres row is still there
}
```

That looks defensible. It logs, it returns the error, the caller sees a failure. Nothing is silently swallowed.

What it does not do is **undo step one**. And in a schema with unique constraints, the leftover row is not inert — it holds the name.

### Channels, teams and projects: the name is taken and nobody has it

For a channel, the row owns `ch_name` while every membership lookup reads Dgraph. So the channel exists enough to block the name and not enough to appear anywhere. The user retries with the same name, hits the unique constraint, and is told the channel already exists — which is true, and useless, because they cannot see it.

Annoying. Recoverable: pick another name.

### Signup and SSO: you cannot pick another email

`users.email_id` is `NOT NULL UNIQUE`, and every user lookup goes through Dgraph. Same fault, and now the orphan owns **an email address**:

- An account nobody can see that permanently owns the address.
- Every retry fails on the constraint.
- **You cannot choose a different email.** Unlike a channel name, it isn't a preference — it's who you are.
- For SSO it compounds badly: every later login retries just-in-time provisioning, collides again, fails again. There is no self-service recovery at all. That person simply cannot use the product, and nothing tells anyone why.

I checked that both creation paths were live rather than assuming it. One is the canonical creator — invitation signup, admin bootstrap, and every SAML/OIDC/LDAP provision. The other is reached from an unauthenticated `POST /demo-login` that creates users on demand, which makes an orphan there very easy to produce.

Both paths also **discarded the returned uid**:

```go
_, err = CreateOrUpdateDgraphUser(ctx, ...)
```

So a mutation that returned no uid *and no error* counted as success, and the caller handed back a UUID for a user that does not exist in the graph. That's a second, quieter bug living inside the first.

### Why the undo is a hard delete, and why it must be immediate

The compensation deletes the row outright rather than soft-deleting, because a soft delete keeps both unique columns populated — which leaves the address exactly as burned as before.

It is also strictly confined to the window between the insert and the failed graph write, and that confinement is not tidiness. `users(id)` is referenced by **55 tables**, with a mix of `ON DELETE CASCADE`, `SET NULL` and `RESTRICT`. Run the same delete a minute later and it either gets refused by a `RESTRICT`, or it cascades into agent evaluations and skills. Inside the window the user has no children at all, which is the only moment the delete is knowably safe.

---

## The Crueller Version: "Created Successfully", for a Message It Had Just Deleted 💬

Sending a post or a chat message *did* have a rollback. It was worse than not having one.

```go
_, err = domain.CreateOrUpdateDgraphPost(ctx, &dgraphPost)
if err != nil {
        log(err)
        err = domain.HardDeletePostByUUID(ctx, postUUID)  // clobbers it
        if err != nil { log(err) }
        return                                            // naked return
}
```

Look at the assignment. The rollback's result goes into the same `err` as the failure that caused it. So when the rollback **succeeds** — the ordinary case, the case it was written for — `err` becomes `nil`, and the naked return reports success.

Traced through to what a person sees, the controller answers **HTTP 200**:

```json
{"msg": "created post successfully!", "data": null}
```

for a post it has just deleted. The sender watches their message appear, and it is gone on refresh. Both chat paths had it identically — 1:1 DMs and group DMs. This is the core messaging path of a chat product.

All three now go through a shared `CompensateOnFailure` helper that **cannot** make this mistake: the undo is a closure and its error is returned separately, so the caller's `err` is never touched. Two things come free with that:

- The undo runs on a context **detached from the request**, with its own deadline. That matters specifically here, because a cancelled request is a very plausible reason for the graph write to have failed in the first place — and the old rollback used the same dying context, so it would fail too, leaving precisely the orphan it existed to prevent.
- A failed undo is logged with the word **orphan** in it, because that is what somebody will grep for at 3am.

---

## An MCP Server Whose Secret Wouldn't Decrypt Was Called Anyway 🔓

This one I found in the beta log, two lines sitting next to each other:

```
models/AIMCP: decrypt auth secret failed for server 71289cdc-…
AIMCP: registered 44 tool(s) from 1 server(s)
```

It registered the tools anyway. The cause:

```go
if len(authSecret) > 0 {
        m.HasAuthSecret = true                        // set BEFORE trying
        if plain, derr := DecryptAPIKey(authSecret); derr == nil {
                m.AuthSecret = plain
        } else {
                log(derr)                             // and carry on
        }
}
```

The flag was set before the decryption was attempted and never withdrawn. So the record asserted it held a usable credential while the credential was empty — and the flag is the thing every reader downstream trusts.

The consequence is not a degraded call. Every call to that server would have gone out with an **empty auth header**, to an external endpoint about to receive workspace data. A correctly configured remote rejects it and blames the wrong thing. A permissive remote **accepts it** — meaning the authentication was never enforced at all, and nothing anywhere reports a problem, because an empty header is a perfectly well-formed request.

Fixed at three levels: the flag stays false when the secret won't decrypt (an undecryptable secret is exactly as unusable as no secret), a separate field carries the distinction an operator actually needs — *present but needs re-entering* versus *never set* — and the client now refuses such a server outright instead of calling it.

---

## 790 Response Bodies Were Handing Out the Schema 🕵️

Roughly 790 controller responses were built like this:

```go
helpers.Envolope{"msg": "something failed", "err": err}
```

A Postgres driver error has exported fields. So encoding one gives the client the constraint name, the table, the column, the SQLSTATE — and Postgres' own C source file, line number and internal routine. I marshalled one rather than reasoning about it:

```json
{"err":{"Severity":"ERROR","Code":"23505",
  "Message":"duplicate key value violates unique constraint \"channels_ch_name_key\"",
  "Detail":"Key (ch_name)=(general) already exists.",
  "Table":"channels","Column":"ch_name","Constraint":"channels_ch_name_key",
  "File":"nbtinsert.c","Line":"666","Routine":"_bt_check_unique"}}
```

The part that makes this pure loss: **nothing consumed the field.** The frontend reads `msg`, `mag` and `message` only — I grepped every `err` reference in the frontend and they are all local catch variables. So those bodies were publishing internal schema detail to no purpose whatsoever.

I fixed it in one place rather than 790. Controllers make **2,667** calls through the shared JSON writer, against six that write a body directly, so redacting at that chokepoint closes the class for every handler at once — including the 791st, which a 790-file sweep would not have covered. It's also the difference between a reviewable commit and one whose failure mode is a silently mangled response somewhere nobody looks. The same writer had the wrong `Content-Type` on every response, which was a one-line fix in the same spot.

There is now a check that fails the build if a controller puts a raw error string into a response detail key again.

### And the logs

Four related fixes, all the same idea — a log line should be readable and shouldn't be a second copy of your data:

- Whole hydrated user objects were being dumped into logs on every request; now summarised.
- OpenSearch response bodies were logged in full.
- Answered `4xx` responses were logged at `ERROR`, so the error log was mostly a list of things that worked correctly.
- Log messages weren't being rendered, and stdout lines carried no trace correlation.

---

## The Frontend Was Paying a Provider Twice 💸

The admin AI panel issued the same provider-models request twice on every open. Beta's log shows the pair, 62ms apart.

Not cosmetic: that endpoint makes the backend call the **AI provider's** `/models` API. So every doubled fetch is a doubled upstream request — against a rate limit, and against real money on a paid provider — for a byte-identical answer.

I fixed it at the request layer rather than in the component. The card mounts once and already guards against duplicate loads for the same provider, so the mount effect itself was running twice, and there are several possible reasons for that — React's development double-invoke, a remount from a parent re-render, a fast double-click. I could not determine which from the logs. Fixing the component addresses one of them; **sharing the in-flight promise addresses all of them**, and keeps working for callers that don't exist yet. Same reasoning as putting error redaction at the server's chokepoint.

It shares in-flight requests only and caches nothing. The entry is dropped the moment the promise settles, so the next call after completion really does hit the network — a deduplicator that quietly became a cache would be a much worse bug than the one it fixed.

---

## Then I Deleted Four Things I'd Written 🗑️

Last, the opposite exercise. I went back through everything added since the start of August looking not for missing code but for **code that turned out not to be needed** — and four of my own helpers didn't survive.

Each had zero production callers and a passing test that was the only thing calling it. Two were predicates for foreign-key and NOT-NULL violations, added next to a unique-violation predicate because a set of three looked more complete than one. Only the unique one ever had a caller, and on reflection that's correct: a foreign-key or NOT-NULL failure is a server-side bug, not something a handler translates into a message for a user.

I kept their table-driven test, with the neighbouring error codes still in it, because "these must return **false**" is a real assertion about the predicate that survived.

A passing test on unreachable code is not evidence of anything except that you wrote a test. It's the same lesson as [the week before](/post/The-Code-Was-Written-Nothing-Called-It.html), applied to my own recent work rather than to code I inherited from myself six months ago.

---

## What Changes If You Run OneCamp 🚀

- **A failed signup no longer burns the email address.** If the second write fails, the first is reversed, and the person can just try again.
- **Messages don't lie about being sent.** If a send fails, you're told it failed, instead of watching it vanish on refresh.
- **API error bodies no longer contain your schema.** Constraint names, table and column names and Postgres internals are gone from responses.
- **An MCP server with an unreadable secret is refused**, not called with an empty auth header, and the admin panel tells you which credential to re-enter.
- **The admin AI panel stops double-charging your provider** on every page open.

None of these are things anyone asked for, and all of them were live. The email one had probably already happened to someone, quietly, with no way for them to tell me.

Back to [two-factor and SCIM](/post/Two-Factor-SCIM-And-The-Config-File-Nothing-Was-Checking.html), or [the reliability arc](/post/The-Same-One-Line-Fault-Five-Times-And-The-Test-That-Missed-It-Too.html).
