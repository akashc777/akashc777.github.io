---
title: "The Update Downloaded Fine, and Never Ran"
image: "/assets/images/post/onecamp-updater.jpg"
author: "Akash Hadagali"
date: 2026-08-23 12:00:00 +0530
description: "Shipping self-hosted software means the update runs on a machine you cannot see, at a moment you do not choose, on a database you must not break. OneCamp's updater downloaded the new version and stopped there, leaving customers with new code on disk and old code running, and nothing anywhere said so. Fixing it turned up an ordering question with a real answer, a backup that had never once succeeded on a fresh machine, and a release I shipped twice that could not start."
tags: ["OneCamp", "Self-Hosted", "Deployment", "Migrations", "Backups", "Shell", "Docker", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace, chat, docs, tasks, projects, calls, boards, tables, an API, with AI teammates that live in it. It runs on **your** infrastructure, through **your** choice of model.

This sits on [two tracked editions, and the customer install that actually works](/post/Shipping-Two-Editions-And-The-Customer-Install-That-Actually-Works.html), and on [one server per customer](/post/One-Server-Per-Customer-And-The-Four-Times-The-Obvious-Design-Was-Wrong.html). The first is what a self-hosted update has to land on. The second is the customers who still have no update path at all.

Which means when I ship a fix, I cannot deploy it. You do. On a machine I have never seen, at a time I do not choose, over a database I must not break. Everything I know about deployment assumes I am holding the other end. None of that is true here.

The updater I had written did this: fetch the archive, unzip it, print a cheerful line, exit 0.

That is not an update. That is a download.

## New Code on Disk, Old Code Running

The failure has no symptom, which is what makes it interesting.

A customer runs the install command. It reports success. The files on disk are the new version. The containers are still running the old binary, because nothing restarted them, and the database is still on the old schema, because nothing migrated it. Everything works. It keeps working. The workspace is fine.

Then, weeks later, something restarts. A reboot, a `docker compose up` after an unrelated change, a machine that came back from an outage. Now the new binary starts against a schema that was never migrated, and the failure arrives with no connection whatsoever to the update that caused it, because that update reported success a month ago.

Some of my customers were in exactly this state and neither of us knew.

The fix is not clever. `make update`, one command, four steps that each have to finish before the next begins:

```
1/4  backing up before anything changes
2/4  applying migrations, while the current version is still running
3/4  rebuilding and restarting
4/4  checking the result
```

The interesting part is step two.

## Migrate Before Restart, Not After

Both orders are defensible and only one is right.

Migrate **after** the restart, and there is a window where the new binary is live against the old schema. The new code is precisely the code that expects the new columns. Every request in that window hits a database that does not have them yet.

Migrate **before** the restart, and the window is the other way round: the old binary, briefly, against the new schema. Old code does not know the new columns exist. It selects the columns it always selected and ignores the rest.

So the order follows from a property the migrations have to hold anyway: a migration must be safe against the version currently running. Add columns, do not rename them. Add tables, do not drop them in the same release. That constraint is not free, but it is the constraint that makes a zero-downtime update possible at all, and it is worth paying because the alternative is asking every customer to take their workspace down on my schedule.

The step order is just that property, written out where the customer can see it.

## The Backup That Had Never Worked

Step one is a backup, and step one had a bug I put there myself.

```sh
exec 9>"$BACKUP_DIR/.lock" || mkdir -p "$BACKUP_DIR"
```

Read it the way I wrote it: take the lock, and if that fails, the directory probably does not exist, so create it. Reasonable. Wrong. In POSIX `sh` a failed redirection on `exec` is fatal. The shell does not continue to the `||`. It exits.

So on any machine that had never taken a backup before, the directory did not exist, the redirection failed, and the shell died on that line. The fallback I wrote to handle the first run was unreachable **on the first run**, which is the only time it was ever needed.

```sh
mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.lock"
```

Unconditionally, first. The lock is still there, because two overlapping updates would dump the same database twice and race each other deleting old dumps.

While I was in there I stopped trusting the dump too:

```sh
$(COMPOSE) exec -T postgres pg_dumpall -U "$DB_USER" | gzip -c > "$dest.partial/postgres.sql.gz"
gzip -t "$dest.partial/postgres.sql.gz"
```

`gzip -t` proves the file is complete. A truncated dump restores silently up to the point it stops, and a backup that restores most of your data without telling you which part is missing is worse than no backup, because you will trust it. It writes to `.partial` and renames on success, so a directory with the final name is one that finished.

## An Upgrade and a First Install Need Opposite Endings

The installer has to end differently depending on which one it is. An upgrade has a database and an `.env` and wants migrate-and-restart. A first install has neither and wants a setup wizard.

The signal is whether `version.txt` exists. The bug is that the unzip creates it. Check afterwards and every run looks like an upgrade, including the first.

```sh
# IS_UPGRADE is decided HERE, before the unzip overwrites version.txt.
IS_UPGRADE=0
if [ -f "version.txt" ]; then IS_UPGRADE=1; fi
```

Six lines, and the comment is longer than the code, because the ordering is the whole point and nothing about the lines themselves says so. The next person to tidy this file will move that block. The comment is there to make them stop.

Then, at the end, it asks rather than assumes:

```
The new version is unpacked. Nothing is running it yet.
Applying it will back up the database, migrate, rebuild and restart.
Apply it now? (y/n):
```

Restarting somebody's workspace is not a thing to do silently because the script happened to reach the bottom. Declining leaves the new files staged and one command to finish.

## I Shipped It Twice, Broken

Worth writing down, because the mistake was in how I checked rather than in the code.

I had just removed `.env` from the Docker image, which was correct: it was baking configuration into an artifact that gets distributed. What I had not noticed was two separate `godotenv.Load()` calls that treat a missing `.env` as fatal.

So the image built, the container started, and died. Twice. Two published releases that could not run.

I checked by reading the log output, which was full of ordinary startup lines, and moved on. I did not check the exit code. The container was announcing its own death in a format that looked exactly like it announcing its own health, and I read the part I expected to see.

Now both sites share one `ConfiguredFromEnvironment()` check, and the thing I verify is `docker inspect` for the exit code, not the log. Logs are what a process says about itself. The exit code is what happened.

## What Is Still Not Automated

Managed customers, the ones on [OneCamp Cloud](https://onemana.dev/buy) where I run the server, still have no update path at all. Their workspaces are on whatever version they were provisioned with. Self-hosted customers now have one command; the people who are paying me specifically so they do not have to think about this have none.

That is the wrong way round, and it is next.

## The Pattern

Three of the four problems here were code that had never run: an unreachable fallback on the only path that needed it, a check that ran after the thing it checked for was created, a fatal startup gate on a file I had just removed. None of them threw an error. Two of them printed success.

The through line is that I verified by reading what the software said about itself. What it says is written by the same person who wrote the bug. The exit code, the checksum, the state of the database afterwards: those are written by the machine, and the machine has no opinion about whether the update worked.

The install surface this has to land on: [shipping two editions](/post/Shipping-Two-Editions-And-The-Customer-Install-That-Actually-Works.html). The customers who still have no update path: [one server per customer](/post/One-Server-Per-Customer-And-The-Four-Times-The-Obvious-Design-Was-Wrong.html).

*[OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace: one payment, unlimited users, your server. Find it at [onemana.dev](https://onemana.dev/buy).*
