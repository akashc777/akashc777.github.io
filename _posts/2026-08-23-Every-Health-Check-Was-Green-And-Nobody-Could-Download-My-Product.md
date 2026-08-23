---
title: "Every Health Check Was Green and Nobody Could Download My Product"
image: "/assets/images/post/onecamp-release-editions.jpg"
author: "Akash Hadagali"
date: 2026-08-23 18:00:00 +0530
description: "I made the build server's Docker image smaller, which is a good idea, and it removed two binaries that appear in no import statement. The service compiled, started, stayed healthy, answered its install script from memory, and returned 404 for the actual product. It stayed that way for hours. Four failures stacked on top of each other, each one hidden by the one above it, and the only reason I found any of them was asking a question that had nothing to do with them."
tags: ["OneCamp", "Docker", "Go", "Operations", "Silent Failure", "Self-Hosted", "OpenSource"]
---

If you're new here: [OneCamp](https://onemana.dev/buy) is an open-source, self-hosted workspace, chat, docs, tasks, projects, calls, boards, tables, an API, with AI teammates that live in it. It runs on **your** infrastructure, through **your** choice of model.

The service that sells it does something slightly unusual: it compiles OneCamp on request. A customer's licence decides which release line they get, so the server clones the repository at that tag, patches two constants with the customer's own domains, builds a binary, and zips it. One archive per customer, built when they ask for it.

Earlier this week I made that server's Docker image smaller. Two stages instead of one, so the runtime carries the binary and not the toolchain. It went from 876MB to 46MB. Every test passed. It deployed. It has been serving happily since.

It could not build a single archive that entire time.

## Nothing in the imports mentions it

Go's dependency graph is excellent and it only knows about Go. My build path does this:

```go
cmd := exec.Command("go", "build", "-o", out, "./cmd/server")
cmd.Dir = clonedRepo
```

`git` and `go`, as binaries, on the PATH. There is no import for that. `go mod tidy` will not mention it, `go vet` has no opinion, and the compiler is perfectly happy to produce a program whose central feature is shelling out to a compiler that is not there.

So when I stripped the runtime to `alpine` plus `ca-certificates curl tzdata`, I removed a hard dependency and nothing anywhere said a word.

## The failure was designed to be invisible

Here is what a customer saw. The install script downloaded fine, because I had embedded that in the binary the week before, after breaking it in a different way. It ran, asked for their domain, and then fetched the archive.

404.

Here is what I saw:

```
ERROR business/GetLatestOneCampZip Failed to get onecamp build err: <nil>
```

An error log with a nil error. The health check was green because the health check checks that the process answers, and it did. Uptime was perfect. The one endpoint that matters returned 404 to everybody and the system's own opinion of itself never wavered.

## Four bugs in a stack

Fixing it took four passes, because each one was hidden underneath the one above.

**Git was missing.** Adding it got me a real error message instead of a nil one, which felt like progress.

**The Go toolchain was missing too.** I added Alpine's, which produced the first genuinely informative failure of the day:

```
go: go.mod requires go >= 1.25.0 (running go 1.24.13; GOTOOLCHAIN=local)
```

Alpine packages 1.24. OneCamp needs 1.25. `GOTOOLCHAIN=local` means the compiler refuses rather than quietly downloading a newer one, which is the correct behaviour and was, in that moment, extremely annoying. Present but too old failed exactly as completely as absent.

**Then the interesting one.** With git and a modern Go in place, the build still produced nothing:

```go
files, err := filepath.Glob("cmd/server/*.go")
```

That glob resolves against the *process's* working directory. The clone is somewhere else entirely; `cmd.Dir` points at it, but the glob never looked there.

This code had worked for months. It worked because the old single-stage image carried this service's own source at `/app`, that source also has a `cmd/server`, and the relative filenames the glob produced happened to also exist inside the OneCamp clone where the build actually ran. A glob of the wrong repository was producing the right answer.

Slimming the image deleted that source. The glob matched nothing. And then:

```go
if len(files) == 0 {
    fmt.Println("No files matched the pattern")
    return
}
```

A bare `return`. The error value stays nil. That is the `err: <nil>` in the log: a guard that noticed the problem, declined to describe it, and handed back success.

It is now built by package path, which the toolchain resolves relative to `cmd.Dir`, so it cannot read from anywhere else and picks up new files without being told.

## How I actually found it

Not from monitoring. Not from a customer, though one of them was five days into not being able to install.

I had fixed something unrelated in the customer Makefile and wanted to know whether the fix could reach anybody, so I cut a release tag and asked the API what the latest version was. That failed, which was surprising, and pulling the thread took the rest of the afternoon.

The question was "can this change actually reach a customer", and it is a completely different question from "does it work". I had asked the second one many times.

## What I did about the class of it

The download path has now broken silently twice in one week, both times mine, both times through a dependency that no import statement mentions. So there are two guards, at the two moments it can be caught.

CI asserts the built image can *build an archive*, not merely boot:

```sh
command -v git >/dev/null || { echo "FAIL: git missing"; exit 1; }
command -v go  >/dev/null || { echo "FAIL: go missing";  exit 1; }
have=$(go env GOVERSION | sed "s/^go//")
# ... compare against the minimum go.mod requires
```

I tested it against three images before trusting it: the correct one passes, `alpine` plus `apk add go` fails on the version, bare `alpine` fails on git. A guard I have not watched fail is a guard I have not written.

And the service says at boot whether it can still do its job:

```
INFO toolchain: git and go1.25.14 present, downloads can be built
```

Deliberately not fatal. Payments, the customer portal and everything else work fine without a compiler, and taking the whole service down over one lost capability trades a partial outage for a total one.

## The part I keep relearning

Small images are good. Fewer packages is a smaller attack surface, a faster pull, less to patch. I would make the same change again.

What I would do differently is notice that "this service needs a build toolchain" was a fact living nowhere except in the old image, discovered by accident. It was not in a comment, not in a test, not in a dependency file. It was in the Dockerfile as an accident of the base image, and I deleted it while tidying.

The Dockerfile now says so, at some length, including the part where the right answer is to build archives in CI and stop running a compiler on the API box. Until that exists, the dependency is real, and being honest about it beats a small image that cannot do its job.

Health checks tell you a process is running. They are very bad at telling you it is useful.
