# DISPOSABLE operator harness

**This directory is DISPOSABLE. It is not a product surface and it is not on the road to
one.** It exists so a human can look at the follow-up loop's state during Wave 1 without
reading SQL, and for no other reason.

## The deletion criterion

**Delete this directory the day the client dashboard (A0b) can show the follow-up queue.**
Nothing here is to be ported: the value is in the CLIs and the `crm/src` modules it reads,
which is where the logic already lives.

## What keeps it disposable, mechanically rather than by intention

A pin in `test/fence.test.ts` asserts that **nothing under `crm/src`, `approval/src`,
`ingest/src` or `agent/src` imports from `harness/`**. That is what stops a throwaway tool
accreting into a dependency — every previous "temporary" surface in this industry became
permanent by being imported once.

Three more fences, all pinned:

- it binds **127.0.0.1 only** and refuses any other host;
- it **refuses to boot under `NODE_ENV=production`**;
- there is **no auth, no session, no CSS, and no write path**. It reads.

## What it must always say out loud

- Every summary is **generated, not verbatim**, and carries the date the full transcript was
  emailed. There is no stored transcript to check it against — that is the design, and the
  banner is the only thing that keeps the summary honest.
- Answers from an **identity-unverified** touch came from *that number*, not from *that
  person*. They are labelled everywhere they appear. She must not be misled about provenance.
