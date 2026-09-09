# Contributing

## Getting set up

```bash
make install
cp .env.example .env
make up
make test
```

## Invariants

Four things hold everywhere. A change that breaks one of them is a bug even if
the tests pass.

**No fixture data.** Nothing renders that is not a persisted row. If the data is
not there, show an empty or pending state.

**Every citation is retrieved.** A URL reaches the database only if a provider
returned it in this pass. Filter against the pool; never trust a model to quote
a link.

**Every state change appends to the ledger.** If it would matter in a dispute,
it belongs in `ledger`, not only in `activity`.

**Authority is checked on the server.** `requireRole` is the gate. Hiding a
button is presentation, not permission.

## Conventions

Comments explain *why*, particularly where the obvious implementation is wrong —
the `jsonb` key-ordering trap in `core/ledger.ts` is the model to follow.

Interface copy is sentence case, active voice, and names the thing that will
happen. Errors say what went wrong and what to do; they do not apologise.

TypeScript is strict with `noUncheckedIndexedAccess`. Money is integer
micro-dollars. Dates cross the wire as ISO strings.

## Layout

```
packages/shared   vocabulary both sides speak
services/api      core · providers · pipeline · jobs · routes · report
apps/web          api · hooks · components (ui, findings, production, shell) · pages
```

Providers never reason. The pipeline never opens a socket. Routes never call a
model.

## Before opening a pull request

```bash
make typecheck && make test
```

If the change touches the pipeline or a human gate, exercise it by hand as well.
The integration tests cover the parts that must not be wrong; they do not cover
whether a screenplay produces sensible findings.
