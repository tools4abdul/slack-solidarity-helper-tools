# Security Policy

## Reporting a vulnerability

**Report privately, through GitHub.** Go to the repository's
[**Security** tab → **Report a vulnerability**](https://github.com/tools4abdul/slack-solidarity-helper-tools/security/advisories/new).
That opens a private advisory visible only to the maintainers.

Please **do not** open a public issue, a pull request, or a Slack message for anything that
would let someone else exploit the flaw before it is fixed.

Useful things to include, roughly in order of value:

1. What an attacker gets — read a volunteer's phone number, post as another member, claim turf
   someone else holds, reach an admin-only page without being an admin.
2. The route or file involved, and the request that triggers it.
3. Whether it needs a Slack session, a workspace membership, an admin role, or nothing at all.
   "Unauthenticated" and "needs an admin account" are very different findings.
4. Anything you had to guess about the deployment.

### What to expect

This project is maintained by volunteers, not a security team. Expect:

- **Acknowledgement within about 3 days**, including "still looking at it".
- **An assessment within about 14 days** — whether it is accepted, what the severity looks like,
  and a rough fix timeline.
- **Credit in the advisory**, unless you would rather not be named.

There is no bug bounty and no payment. If a report is declined you will be told why, not ignored.

### Safe harbor

Testing done in good faith against your own deployment or a local instance is welcome and will
not be met with a complaint. Please do not test against `slack.tools4abdul.com` in ways that
touch other people's data, degrade the service, or spam a real Slack workspace — a local
instance (`npm run dev` with `TURSO_DATABASE_URL=file:local.db`) plus `npm run db:seed` gives
you the whole app with synthetic data. If you believe a finding can only be demonstrated
against production, say so in the report first.

## Supported versions

Only the current `main` branch is supported, and only the deployment running from it. There are
no maintained release branches and no backports — fixes land on `main` and deploy from there.

Dependencies are pinned in `package-lock.json`; the Node version in the `Dockerfile` and in
`.github/workflows/ci.yml` are kept identical so CI runs what deploys.

## Scope

**In scope** — this repository's code and the app it builds:

- Authentication and session handling
- The admin allowlist and any way around it
- Slack request-signature verification and the webhook / cron secrets
- The turf checkout rules (claiming turf you do not hold, exceeding limits, reading another
  volunteer's MiniVAN list number)
- Data exposure: any route serving a member's contact details, a moderation note, or a roster to
  someone who should not see it
- Injection, SSRF, XSS, CSRF, and dependency vulnerabilities that are actually reachable here

**Out of scope** — report these to the vendor, not here:

- Slack, solidarity.tech, EveryAction/VAN, Mobilize, Openfield, Fly.io, Turso, CARTO
- Anything requiring a workspace admin to be already compromised, or physical access
- Missing hardening headers with no demonstrated impact, and automated-scanner output without
  a working path to harm
- Social engineering of the volunteer team

A misconfiguration in one operator's own deployment (a public member notes channel, a leaked
`WEBHOOK_SECRET`) is theirs to fix — but if the code makes that mistake easy to make, that is a
finding worth reporting.

## How the app is protected

Context for anyone assessing it. All of this is in the repository; none of it is a claim that
the app is unbreakable.

### Authentication and authorization

- **Sign-in is Slack OAuth.** The whole site is behind a root layout guard that redirects
  unauthenticated visitors; there is no password to leak or guess.
- **Session cookies** carry a random ID only, and are `httpOnly`, `sameSite=lax`, and `secure`
  outside dev. Sessions live server-side, expire after 8 hours, and are deleted on expiry.
- **The OAuth `state` nonce** is cookie-bound (`src/lib/server/oauth-state.ts`).
- **Two tiers.** Any workspace member may see the dashboards and the turf page; everything else
  is gated on a database-backed admin allowlist (`allowed_slack_users`, edited on `/settings`),
  with `SLACK_SUPERUSER_ID` as a break-glass entry. The allowlist has no environment fallback,
  and the last row in it cannot be removed. Non-admins get a bare redirect.
- **`DEV_SLACK_USER_ID` bypasses OAuth and is a development-only affordance.** It must never be
  set in production.

### Request authenticity

- **Slack requests are signature-verified** over the raw body against `SLACK_SIGNING_SECRET`
  before anything is parsed (`src/lib/server/slack-signature.ts`).
- **CSRF is re-implemented in `src/hooks.server.ts`.** SvelteKit's built-in check is disabled in
  `svelte.config.js` because Slack posts form-encoded payloads with no `Origin` header; the
  replacement exempts only the signature-verified `/api/slack/*` routes. `src/lib/server/csrf.ts`
  has the reasoning. **Any change here deserves close review** — it is the one place the
  framework's default protection was deliberately turned off.
- **`/webhook` and `/coalition-invite`** are gated on `WEBHOOK_SECRET`, and `/api/internal/*` on
  `INTERNAL_CRON_SECRET`. Both are bearer secrets in a query string, so they appear in logs at
  every hop — treat them as rotatable, and rotate on any suspicion.

### Secrets and data at rest

- **Per-admin Slack user tokens are encrypted with AES-256-GCM** before they are written
  (`src/lib/server/token-crypto.ts`), with a fresh random IV per record and the key held in
  `TOKEN_ENCRYPTION_KEY` outside the database. A database dump yields ciphertext, not working
  credentials. The app refuses to start if the key is missing or does not decode to 32 bytes.
  Rotating the key invalidates every stored token; admins simply re-authorize.
- **All other secrets live in Fly secrets**, never in the repository or the database.
  `.env.local` is gitignored.
- **Nothing sensitive is committed.** the seed data is fully synthetic —
- several tables (`member_notes`, `member_account_links`, `slack_user_tokens`, `sessions`)
- are documented as never to be copied out of production.

### Data minimization, by design

These are structural properties, and they exist because losing them would be a security
regression even though nothing would visibly break:

- **The MiniVAN list number is the credential** that pulls voter records down to a phone. It is
  sent only to the volunteer currently holding the turf, in an ephemeral Slack message, and is
  withheld from the organizer and activity pages — from admins too. It is deliberately kept out
  of Slack notification fallback text, the one thing that renders on a locked phone.
- **Chapter filtering happens server-side before serializing.** The payload is the boundary;
  filtering in the browser would make the compartment cosmetic.
- **The Solidarity roster is searched server-side and never sent to the browser.**
- **Typed addresses are never stored or logged**, and coordinates in button values are rounded
  to ~100 m.
- **`?demo` returns before any database access**, so demo mode cannot read real turf even if a
  later gate were wrong.

### Abuse limits

- **Per-user rate limits** on turf browsing (8 distinct chapters/hour) and the turf API (60
  requests/minute), shared between the page and the API in
  `src/lib/server/van/rate-limit-store.ts`. They follow the user, not the URL — an earlier
  module-scoped limiter was bypassed simply by using the API instead of the page.
- **Turf claim races are resolved in storage**, by a partial unique index on
  `van_turf_checkouts (map_route_id) WHERE released_at IS NULL AND completed_at IS NULL`, not in
  application code.
- **Release and complete are scoped to the caller's own active claim**, so posting someone
  else's route ID does nothing.

### Build and deploy

- CI runs Prettier, ESLint, `svelte-check`, and the full test suite on every push and pull
  request; **deploys are gated on all of them** and only run from `main`.
- Migrations run as Fly's `release_command`, before new machines take traffic, so a failing
  migration aborts the release rather than half-applying.
- The container runs as the unprivileged `node` user.

## For operators

If you deploy this yourself, the checklist:

1. **Generate every secret freshly.** `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`),
   `INTERNAL_CRON_SECRET` and `WEBHOOK_SECRET` (`openssl rand -hex 32`). Never reuse another
   deployment's.
2. **Never set `DEV_SLACK_USER_ID` in production.**
3. **Set `ORIGIN` to your real public URL.** It is what the CSRF check compares against.
4. **Make the member notes channel private.** Note text and warning text both land there.
5. **Keep the admin allowlist short**, and remove people when they stop organising — an admin's
   Slack user token is stored (encrypted) and can post as them.
6. **Rotate `WEBHOOK_SECRET` and `INTERNAL_CRON_SECRET` periodically**, since they travel in URLs.
7. **Restrict database access.** The Turso token reads everything, including moderation records
   and contact details.
8. **Use a keyed map tile account** before real volunteer traffic; the default CARTO endpoint is
   courtesy, not an SLA.
9. **Give VAN and canvassing integrations their own service accounts** with the least access
   that works — missing tiers degrade rather than fail.

See [PRIVACY.md](PRIVACY.md) for what the app collects and how long it keeps it.
