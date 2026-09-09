# Security

## Reporting

Report a vulnerability privately through GitHub's security advisory form on this
repository rather than opening a public issue.

## Design notes

**Pre-release intellectual property.** An uploaded screenplay is the most
sensitive asset a production has. Scripts go to object storage under
project-scoped access. What leaves the perimeter is only the item being
investigated — its name, category and one sentence of context — never the file
and never the surrounding script.

**Credentials.** Provider keys are read from the environment and used only
inside the two provider adapters. Agents call tools; tools hold secrets. In
production these belong in Secret Manager.

**Authority.** Four roles, enforced server side on every privileged route. The
client cannot grant itself a role. Reviewers are read-only by construction.

**Tokens.** JWTs expire after 12 hours. The Server-Sent Events route alone
accepts a token as a query parameter, because `EventSource` cannot set headers;
no other route honours it, because query strings end up in access logs.

**Webhooks.** Monitor callbacks are HMAC-verified against the raw body before
anything is queued. Unverified events are logged and dropped.

**Audit.** Every state change is appended to a hash-chained ledger that refuses
`UPDATE` at the database level. Tampering is detectable and locatable to the
exact entry.

**Outbound actions.** There is no email send capability in the codebase. Licence
inquiries are drafted and held behind counsel approval; a person copies them
out. An agent cannot contact a rights holder.
