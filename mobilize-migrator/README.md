# Solidarity → Mobilize event migrator

Ports upcoming in-person Solidarity events into Mobilize.

```bash
npx tsx mobilize-migrator/migrate.ts           # dry run (default) — prints the plan, writes private/migration-plan.json
npx tsx mobilize-migrator/migrate.ts --apply   # create new events and push edits to existing ones
npx tsx mobilize-migrator/migrate.ts --apply --limit 5
```

`migrate.ts` is a thin wrapper over `lib/sync.ts` — the same engine the scheduled
endpoint runs, with a JSON-file ledger instead of Turso. It previously had its own
copy of the create loop and silently missed everything added to the shared one
(timeslot pairings, image upload, updates), so there is deliberately only one
implementation now.

The CLI and the endpoint share the **same Turso ledger**, so they can never
disagree about what has already been created — running one after the other is
safe. The CLI therefore needs `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN`) in
`.env.local` alongside the Mobilize credentials. Prefer the endpoint for
scheduled work; the CLI is for dry runs and inspection.

Dry run is the default deliberately: created events are publicly visible and there
is no bulk undo.

## Credentials

All in `.env.local` for the CLI, and Fly secrets for the app:

| Variable                           | Purpose                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SOLIDARITY_API_TOKEN`             | Already used elsewhere in this repo; the Solidarity read/write side.                                                            |
| `MOBILIZE_API_KEY`                 | Organization API key, sent as `Authorization: Bearer …`. Required — there is no fallback.                                       |
| `MOBILIZE_ORG_ID`                  | Numeric organization id. Required, deliberately with no default: a wrong value publishes events under someone else's name.      |
| `MOBILIZE_CONTACT_EMAIL`           | Contact on created events. The app prefers the value set on `/settings`; this is the fallback, and the only source for the CLI. |
| `MOBILIZE_CONTACT_NAME` / `_PHONE` | Optional, same resolution.                                                                                                      |

Everything runs against the documented v1 API
([mobilizeamerica/api](https://github.com/mobilizeamerica/api)) at
`https://api.mobilize.us/v1`.

**The key needs write access.** Create, update and delete event, and
`POST /v1/images`, are _restricted_ endpoints — Mobilize grants them per
organization on request, and simply holding a key is not enough. Everything the
API answers 403 for looks the same from here, so `authFailed` means "rejected or
not permitted", not "expired": there is nothing to refresh. Check the key, then
check the grant.

> Historical note: before the campaign had a key, both syncs drove Mobilize's
> private dashboard endpoints with a borrowed `sessionid`/`csrftoken` browser
> session that expired every couple of weeks. That is all gone. If you find a
> reference to `MOBILIZE_COOKIE` anywhere, it is stale.

> The captured dashboard requests this was originally reverse-engineered from
> live in **`private/`**, which is gitignored wholesale, and
> `event-rsvps.json` holds real attendees' names, emails, phone numbers and zip
> codes. Put anything else that must not leave the machine there too — generated
> run artifacts already go there.

## How it maps

**The shape mismatch.** A Solidarity event owns many _sessions_, and each session
carries its own location and time. A Mobilize event has _one_ address plus many
timeslots. So sessions are grouped by location, and one Solidarity event can become
several Mobilize events — "Operation Get Out the Vote" (Flint, Grand Rapids, Detroit,
Oakland, Ann Arbor) becomes five.

**One venue, several spellings.** Sessions are grouped on a _normalized_ address
(`normalizeLocation`): street types and directionals are collapsed onto one form
and a trailing country and ZIP are dropped, because Solidarity stores whatever was
typed that day and held the Pontiac office as all three of "1 South Saginaw Street,
Pontiac, MI 48342, USA", "1 S Saginaw St, Pontiac, MI 48342, USA" and "1 South
Saginaw Street, Pontiac, MI, USA" — three Mobilize events for one address, which
the dedupe pass then had to treat as duplicates of each other.

Only a _trailing_ five-digit token is dropped: Warren's house numbers are five
digits too, and "29200 Hoover Rd" must not merge with "29500 Hoover Rd".

The group's key is still a **raw** address — the lowest-sorting one where the
spellings differ, so it does not depend on the order Solidarity returns sessions.
That is deliberate: the ledger key is `solidarity:<eventId>:<locationKey>`, and
normalizing it would orphan every event already in the ledger from the Mobilize
event it created, which the next run would then publish a second time. An event
whose sessions all spell the address one way — nearly all of them — keeps exactly
the key it has always had.

**Titles for a split event.** Each copy needs a title that still names the event
_and_ differs from its siblings — identical titles read as accidental duplicates
in the Mobilize feed, and `findDuplicate` treats them as duplicates outright.
`titlesForLocations` takes the session's own title only when it already contains
the event name (the organizer wrote "Operation GOTV: Flint" by hand); otherwise
it keeps the campaign's title and appends the first thing that actually differs —
city, then venue, then street. This used to take the session title unconditionally,
and since plenty of sessions are named for the shift rather than the place, events
went out to volunteers titled "Session 2" and "Thursday Shift" with the campaign's
own name nowhere on the page.

**Opting an event out.** An event tagged **`mobilize-exclude`** in Solidarity is
never planned — the counterpart of the `slack-exclude` tag that keeps an event out
of the Slack announcements. Tagging is reported separately from the events that
were skipped for a fixable reason, since it is a choice rather than a failure.
Note it does **not** take down an event already published: the sync stops updating
it, but deleting a public event volunteers may have signed up for is not something
to trigger from a tag. The nightly log says how many excluded events are still live
so they can be removed by hand.

**Times.** Timeslots are unix timestamps, which makes this mostly a non-issue:
Solidarity returns absolute instants but renders them with an _inconsistent_ UTC
offset — the same session came back as both `...T18:00:00-06:00` and
`...T20:00:00-04:00` across two calls — and only the instant matters. Never read
the wall time off the string. The event's `timezone` field is
`America/New_York` (`lib/payload.ts`); Michigan is `America/Detroit`, but Mobilize
validates `timezone` against a fixed list that rejects it, and the offsets and
DST rules are identical.

**Addresses.** Most sessions leave Solidarity's structured `location_data`
components blank and carry only a Google-formatted `location_address` string plus
coordinates, so `lib/address.ts` parses that string. City-only addresses ("Ann Arbor,
MI, USA") are _rejected_ rather than migrated — Mobilize would drop a pin on the city
centroid, which is worse than a missing event a human can add correctly.

Where a record does carry structured components, they are read field by field
rather than all-or-nothing: Solidarity routinely fills `address_postal_code` on a
record whose `address_city` is blank, and that zip is the one field Mobilize will
not do without.

**Postal codes.** `postal_code` is the _only_ required field in the v1 `location`
object ("Required if `is_virtual` is `false` or unset … all other `location`
fields are optional"), and about a third of the campaign's sessions have no zip
anywhere in them. A create or update for one of those is rejected outright:

```
/organizations/44679/events returned 400: {"error":{"location":{"postal_code":["This field may not be blank."]}}}
```

Every such session does carry coordinates, so `lib/geocode.ts` recovers the zip
from those through the Census Bureau's geocoder (free, keyless, no account) and
caches it in `mobilize_geocoded_zips`, keyed by the rounded point — a venue's zip
does not change, and the campaign runs the same field offices all season. The
update pass also backfills a zip onto events migrated before the v1 switch, which
the old dashboard API let through with none.

An event whose zip cannot be resolved at all is reported rather than sent, since
Mobilize would only reject it again the next night.

**Descriptions.** `/v1/events` returns a _flattened plain-text_ description — the
bold, links and lists on the event page are stripped before we see them. The real
content is on the linked ActionPage (`/v1/pages/{event_page_id}`) as HTML, so
`lib/html-to-markdown.ts` converts that to Markdown, which is what Mobilize
renders ([help.mobilize.us](https://help.mobilize.us/en/articles/4196288-how-to-use-markdown-in-mobilize)).

Do **not** send HTML: Mobilize stores the description verbatim, and none of the
campaign's hand-written descriptions contain a tag — raw HTML would show
volunteers literal `<p style="…">`. Two rules drive the output: blocks need a
blank line between them or they collapse onto one line, and a line break inside a
paragraph needs two trailing spaces. Events with no rich page fall back to the
flattened text with its single newlines promoted to real paragraph breaks.

Events already in Mobilize get this applied by the sync's update pass, which
re-sends the event via PUT whenever the rendered description differs.

A handful of Solidarity events have no description at all — no `description`, no
ActionPage HTML, no session note — and Mobilize requires a non-blank one. Those
get the title and the signup page instead of a rejection:

```
**Macomb Defenders Rising**

Details and updates:
https://go.example.org/macomb-defenders-rising
```

**Images.** `featured_image_url` must be a URL Mobilize hosts, so the bytes are
re-uploaded rather than linked. `lib/image.ts` downloads from Solidarity and
`POST`s to `/v1/images` as `multipart/form-data` (fields `file` and
`file_name`); the response carries the hosted URL.

The sync does this as part of creating an event, and backfills it on the update
pass for any event that still has no image. Uploads are recorded in
`mobilize_synced_images`, keyed by the Solidarity URL, so a shared image is
uploaded once and reused — 53 events were covered by 38 distinct uploads. Events
that already have an image are left alone.

**Not every recorded URL is still usable.** v1 validates `featured_image_url` and
rejects one on the raw upload bucket:

```
/organizations/44679/events returned 400: {"error":{"featured_image_url":["Invalid featured image url"]}}
```

38 of the 44 ledger rows are exactly that — `mobilize-uploads-prod.s3.us-east-2
.amazonaws.com/…`, recorded by the pre-v1 dashboard code, which was given those
URLs and accepted them. Every URL `POST /v1/images` returns is on Mobilize's
image CDN instead. `isReusableImageUrl` in `lib/image.ts` therefore screens the
cache, and a rejected entry is re-uploaded and **overwritten** — `recordImage`
upserts, because a row that survives a re-upload would re-upload the same image
every night forever. Existing events keep whatever URL they already display;
only new sends are screened.

**Event types.** Plain strings from the v1 enum. Only `COMMUNITY` and
`COMMUNITY_CANVASS` are used. Solidarity has no structured
"is this a canvass" flag, so classification is by title/description keyword
(`canvass`, `knock`, `door`, …). The dry run prints the choice per event.

**Private addresses.** A Solidarity event with `hide_address_until_rsvp` syncs
with its venue, city, region and postal code but **no street line**. City plus
zip still give a usable pin without publishing the address. A private event with
no postal code _and_ no coordinates to geocode one from is skipped instead, since
there would be nothing left to place it by.

Two dead ends, both checked against the live API rather than assumed:

- The `"This event's address is private. Sign up for more details"` string in the
  docs is what Mobilize's serializer _returns_ for an event whose address is
  private. Writing it would just store that sentence as the venue name and
  street.
- `address_visibility` exists on the Event _response_ and looks like the control,
  but it is **silently ignored on create** — send `PRIVATE`, read back `PUBLIC`.
  It is documented under the response schema only, and it behaves that way.

**Skipped.** Virtual events (they need a join URL the list payload doesn't expose),
co-hosted mirrors of another org's event, past sessions, anything without a
usable street address, and private-address events with neither a postal code nor
coordinates to geocode one from.

### What the v1 API cannot set

The private dashboard payload this replaced carried about ninety fields. The
documented API accepts a much smaller set, and synced events now get Mobilize's
defaults for the rest. Deliberately accepted, not worked around:

| Dropped                                                                                  | Consequence                                                                                                           |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `van_event_activist_code_config` (activist code `5451761`)                               | **Synced events no longer tag their signups with the campaign's VAN activist code.** The most consequential of these. |
| `location_is_private`                                                                    | Handled by withholding the street line instead — see above.                                                           |
| `check_in_enabled`, `volunteer_check_in_is_enabled`                                      | Mobilize defaults apply.                                                                                              |
| `post_signup_asks`, `day_before_confirmation_is_enabled`, `shift_followup_email_enabled` | Mobilize defaults apply.                                                                                              |
| `contact_host_enabled`, `chat_enabled`                                                   | Mobilize defaults apply.                                                                                              |
| `lat` / `lon`                                                                            | Mobilize geocodes from the address instead.                                                                           |

Events created before this migration keep whatever the dashboard API set on
them; the update pass does not clear these fields, it just stops setting them.

### Capacity: one cap, two systems

A Solidarity session's `max_capacity` becomes the Mobilize timeslot's
`max_attendees`, so Mobilize enforces the limit itself — it flips `is_full` and
stops taking signups. But people sign up on **both** sides, so the number pushed
is the cap **minus the seats Solidarity has already spent**, recomputed on every
pass. Solidarity's 0 still means "no cap"; after subtraction a genuine 0 means
"full", which is why `capacity()` in transform.ts is careful never to conflate
the two.

**The double-charge trap.** The attendee sync mirrors every Mobilize signup back
into Solidarity as an RSVP. Subtracting _all_ Solidarity RSVPs would therefore
charge each Mobilize signup twice — once against Mobilize's own tally, once by
shrinking the cap we hand it — and a shift would close at half capacity. Only
RSVPs whose `source_system` is not `mobilize` are counted; see
`countSolidaritySeats` in lib/seats.ts. This is the reason that filter exists,
and it is not an optimization.

**`max_attendees` cannot be read back.** Mobilize's event read returns
`start_date, end_date, instructions, id, is_full` — the cap is write-only, so
there is nothing live to diff against. What we last sent is stored in
`mobilize_synced_timeslots.pushed_max_attendees` and that is what decides whether
a PUT is needed; without it every capped event would either be re-pushed forever
or never updated. `is_full` is the only live signal and it says "at the limit",
not what the limit is.

Two consequences worth knowing:

- **Orphan timeslots keep their recorded cap.** A PUT re-sends every upcoming
  shift, so the old hardcoded `maxAttendees: null` for orphans silently un-capped
  them on every unrelated edit. They now go back with `pushed_max_attendees`.
- **Seats are counted lazily, per event.** One Solidarity read per capped
  session, taken only for events the chunk actually reaches — a run that exhausts
  its write budget is re-invoked from the top, so counting everything up front
  meant re-counting it on all twelve chunks.

**Unverified:** that Mobilize reads `max_attendees: 0` as "closed" rather than
rejecting it. The behaviour is asserted by a long-standing comment in
transform.ts but has not been exercised against the live API — worth confirming
on a scratch event before the first shift actually fills.

## Not creating duplicates

Two independent mechanisms:

1. **The `mobilize_synced_events` ledger** — a row for every event the sync
   created, keyed by Solidarity event + location, written after _each_ success.
   A crash or expired session mid-run never causes a repeat.
2. **Heuristic matching** against Mobilize's public feed, for events created by hand.

Titles are not stable across the two systems — Solidarity's _"Marquette County Abdul
El-Sayed Canvass Launch & Debate Watch Party!"_ is Mobilize's _"Abdul El-Sayed Canvass
Launch & Debate Watch Party in Negaunee!"_ — so matching is: identical normalized
title, **or** a shared start time (±1h) plus agreeing cities plus title-token overlap.

The city guard matters more than the title score. The campaign runs the same
generically-named event in several cities on one night — "Debate Watch Party" in
Coldwater, Lansing, Pontiac and Oakland, all at 7:15pm — and title overlap alone
marks all of them as duplicates of each other.

## Running on a schedule

The scheduled path does not run this code in a GitHub runner. Following the same
pattern as `daily-snapshot.yml`, the workflow just `curl`s an authenticated
endpoint on the Fly app, so credentials and Turso stay where they already live:

```
.github/workflows/mobilize-sync.yml     every 30 min, plus 07:40 UTC windowless
  ├─ POST /api/internal/mobilize-sync?key=$INTERNAL_CRON_SECRET
  │    └─ src/lib/server/mobilize-sync.ts   (Turso-backed ledger)
  │         └─ mobilize-migrator/lib/sync.ts   (shared with the CLI)
  └─ POST /api/internal/attendee-sync?key=$INTERNAL_CRON_SECRET
       └─ src/lib/server/attendee-sync.ts
            └─ mobilize-migrator/lib/attendee-sync.ts
```

**Both halves run in one job, events first.** The order is the reason: the event
sync records the timeslot pairings the attendee sync reads, so an event created
at 09:00 has its signups mirrored in the same run instead of waiting for a
separate schedule to come round. The signup half runs even when the event half
failed — signups already in Mobilize should still reach the CRM — and the job
still goes red for whichever step failed.

Each endpoint takes a lock (`sync_locks`) and answers `{"skipped": true}` with a
200 rather than a 4xx when another run holds it, so an overlap is a logged skip
instead of a red run. That was optional at two runs a night; on the 30-minute
schedule it is what stops two passes planning from the same ledger snapshot and
both deciding an event needs creating.

The every-30-minutes pass sends `?quiet=1`, which drops the routine
"created N, updated M" Slack line when nothing was **created**. An event that
reports the same edit on every pass would otherwise post 48 times a day. New
events, failures, a rejected key and an aborted run always alert, and the nightly
pass reports the edits too.

`lib/*` stays free of `$env` and `node:fs` so both entry points can use it —
state arrives through a `Ledger` interface, credentials through `SyncConfig`.
Same dual-use trick as `src/lib/server/solidarity-paginate.ts`.

### One night is several requests

**The endpoint does not do the whole sync in one call, on purpose.** fly-proxy
autostops a machine when it decides there is excess capacity, and it decides
that from the `soft_limit` concurrency setting — [not from requests in
flight](https://fly.io/docs/reference/fly-proxy-autostop-autostart/). A single
long request therefore looks exactly like an idle machine. That is not
hypothetical: a sync doing ~15 image uploads at ~30s each was killed six minutes
in, mid-write, and the workflow got a bare `502`:

```
proxy: App has excess capacity, autostopping machine … 1 out of 2 machines left running
app:   Sending signal SIGINT to main child process
```

So each request stops starting writes at a time budget (`DEFAULT_BUDGET_MS`,
overridable with `?budgetMs=`), reports `incomplete: true` with a `pending`
count, and the workflow re-posts until `incomplete` is false. The budget covers
the whole request, reads included — the Solidarity and Mobilize reads take the
better part of a minute before any write happens.

The deadline is only ever checked _between_ writes, so a chunk always stops with
the ledger consistent and the next one resumes rather than repeats. Raising
`kill_timeout` is not an alternative: Fly caps it at 300 seconds, which is less
than a first bulk run takes.

This means a busy night posts several "created N, updated M" messages to Slack,
one per chunk — the incomplete ones say `Still working — N to go.`

### Rollout

1. `npm run db:migrate` — creates the ledger tables.
2. `fly secrets set MOBILIZE_API_KEY='…' MOBILIZE_ORG_ID='…'`
3. Set the event contact on `/settings` (or `fly secrets set
MOBILIZE_CONTACT_EMAIL='…'`). The sync refuses to run without one.
4. Verify without writing: `POST /api/internal/mobilize-sync?key=…&dry=1`, or run
   the workflow manually with **dry run** ticked.

### What it does each run

Full sync: creates events new to Solidarity, and pushes edits — title, times,
description, image — onto ones already mirrored. A steady-state pass is one
request of a few seconds; the chunking below is for a bulk first night. Events created by hand in
Mobilize are matched by the duplicate heuristic and left alone.

Two behaviors worth knowing:

- **Manual edits in Mobilize get overwritten.** If an organizer fixes a
  description there, the next run replaces it with Solidarity's. Solidarity is
  the source of truth by design; edit it there.
- **Upcoming shifts are never deleted.** Mobilize destroys an upcoming timeslot —
  and its signups — if it's absent from a PUT. So live shifts with no Solidarity
  counterpart (cancelled sessions) are re-sent untouched rather than dropped. A
  cancelled session therefore needs removing by hand. Leaving a stale shift is
  strictly better than deleting one people signed up for. _Past_ shifts are the
  exception: the endpoint does not modify them at all, so they are left out of
  the payload entirely — which is safe precisely because it cannot delete them
  either.

### The guardrail

If a night's plan wants more than `MOBILIZE_SYNC_MAX_CREATES` (default 25) new
events, it creates **nothing** and alerts. A flood means dedup broke or the
source data changed shape, and these events are public the moment they exist.
Clear it deliberately with `?maxCreates=N` or the workflow input.

### When it breaks

A 403 sets `authFailed`, the endpoint returns 503, the workflow run goes red, and
the app posts a Slack alert to the Mobilize sync channel — the one picked in
/settings if there is one, otherwise wherever the growth report goes (its own
/settings override, else `SLACK_GROWTH_REPORT_CHANNEL_ID`). There is no env var
for the sync channel itself.

A 403 means one of:

- `MOBILIZE_API_KEY` is unset, mistyped, or was revoked.
- The key is valid but the organization's **write grant** was never issued or was
  withdrawn. Create/update/delete event and `POST /v1/images` are restricted
  endpoints; email support@mobilize.us. Reads keep working in this case, so the
  attendee sync can be healthy while the event sync is not.
- `MOBILIZE_ORG_ID` points at an organization this key has no access to.

A run that stops partway is safe to re-run: the Turso ledger records everything
already created, so progress resumes rather than duplicating.

## Attendee sync (Mobilize → Solidarity)

The reverse direction: Mobilize signups become RSVPs on the matching Solidarity
event session, so organizers only check one place.

```bash
# Inspect the match rate on a real shift before trusting it with the CRM
npx tsx mobilize-migrator/attendee-sync.ts \
  --mobilize-event 812345 --timeslot 6157028 --session 80929 --event 27463

# ...with the session's cap, to see what would be waitlisted
npx tsx mobilize-migrator/attendee-sync.ts \
  --mobilize-event 812345 --timeslot 6157028 --session 80929 --event 27463 --capacity 40
```

Scheduled as the second step of `.github/workflows/mobilize-sync.yml` →
`POST /api/internal/attendee-sync` (`?dry=1`, `?window=<hours>`, `?maxProfiles=N`).
Run `only: signups` on a manual dispatch to skip the event half.

**Where the data comes from.** `GET /v1/organizations/{orgId}/events/{eventId}/attendances`,
one request per Mobilize **event** — it returns every shift on that event at once,
so `lib/attendee-sync.ts` groups its timeslot links by event and fans the results
back out by `timeslot.id`. Signups for shifts outside the requested window come
back too and are dropped.

**An event deleted in Mobilize 404s this endpoint forever.** The timeslot pairings
that point at it stay in `mobilize_synced_timeslots` — the event sync leaves a
deleted event alone rather than resurrecting it, so nothing ever cleaned them up,
and the sync re-requested a dead event on every run and alerted about the failure
nightly. A 404 is now confirmed with a read of the event itself (`GET
/events/{id}`): gone means the pairings are dropped and the run counts
`eventsGone` instead of a failure; still present means the 404 is unexplained and
stays a failure, because dropping the pairings would silently stop syncing a live
event's signups. Dropping them is safe either way — the event sync re-records
pairings for every event Mobilize still has.

**Statuses are documented strings**, not the numeric codes the dashboard scrape
had to reverse-engineer, and `CONFIRMED` — which was never observable before —
now maps cleanly. `attended` is a real tri-state boolean rather than something
inferred from the presence of a check-in timestamp, so "did not attend" and "not
recorded yet" are finally distinguishable. Anything unrecognized is still skipped
and alerted rather than guessed.

| Mobilize                   | Solidarity                                    |
| -------------------------- | --------------------------------------------- |
| `REGISTERED` / `CONFIRMED` | RSVP `is_attending: "yes"`                    |
| ...on a session at its cap | RSVP `is_attending: "waitlisted"` — see below |
| `CANCELLED`                | existing RSVP set to `"no"` — never deleted   |
| `attended: true`           | plus an `event_attendances` record            |

### Waitlisting past the cap

A signup for a session already holding `max_capacity` attending RSVPs is filed as
`waitlisted` rather than `yes`. Mobilize accepted the person, so they are not
turned away — Solidarity simply records that they are past the line.

Three rules keep that from churning:

- **Nobody who holds a seat is demoted.** Only a _new_ RSVP can be waitlisted. An
  existing `yes` stays `yes`, whatever the count now says: taking a place from
  someone who has it, because a later run read them in a different order, is not
  the sync's call.
- **A waitlisted row satisfies a Mobilize `yes`.** Comparing status naively would
  promote every waitlisted person back to `yes` on the next pass and waitlist the
  next arrival instead — the queue would reshuffle nightly and the cap would never
  hold. See `satisfies` in lib/attendee-sync.ts.
- **Cancellations still land.** A waitlisted person who cancels in Mobilize is
  updated to `no`, and the seat they were queued for is freed within the run.

**Who gets the last seat.** Signups are sorted by Mobilize's `created_date`,
oldest first, before any RSVP is written — first-come-first-served by signup
time. Mobilize does return an event's attendances in that order already (checked
across 393 signups on three events, none missing the field), but it is
undocumented, and signups are fetched one event at a time: without an explicit
sort, every signup on the first Mobilize event outranked every signup on the
second, and twelve Solidarity sessions are mirrored by timeslots on **two**
Mobilize events. A missing `created_date` sorts last rather than first, and the
attendance id breaks ties.

Note this only orders people the sync has not filed yet. Anyone already holding
an RSVP keeps their seat, so the rule is first-come-first-served as long as the
sync keeps up; after a long outage, the people who happen to be new in that run
compete only with each other.

Sessions found holding **more** attending RSVPs than their cap are reported in
`overCapacity` and called out in Slack, listed worst-overage first. That is a
standing condition for a human to resolve — raise the cap, or move people — and
the sync cannot fix it: the RSVPs are already there. Twelve such sessions existed
when this was written, so expect the first alerts to be about history rather than
anything the run just did.

### Event API traps, verified against the live API

- **Create nests the event one level deeper than everything else.** `POST
/events` answers `{"data":{"event":{…,"id":…}}}`, while `GET /events/:id` and
  the list endpoint return the event flat under `data`. Reading `data.id` on a
  create yields `undefined` and fails every single create. There's a regression
  test in `lib/mobilize.test.ts`.
- **The create response already carries the new timeslot ids**, so pairing them
  for the attendee sync needs no read-back.
- **An existing timeslot re-sent WITHOUT its id fails the whole PUT** with
  `400 ["Timeslot with start and end time already exists"]`. It is not silently
  duplicated and not silently ignored — the update simply does not happen. This
  is exactly what `reconcileTimeslots` is for: it matches live shifts to planned
  ones by start time and re-attaches their ids. Fail-safe rather than
  fail-destructive, but it means the id matching is load-bearing on every update,
  not an optimization.
- **Validation failures come back as HTTP 200** with `{"data":null,"error":{…}}`,
  not as a 4xx — so `res.ok` alone is not success. The client checks `body.error`
  too. Example: `Cannot create timeslots more than 5 years in the future`.
- **Writes are rate-limited at 5/s** and answer 429; the client retries with
  backoff, honouring `Retry-After`. Anything hitting the API outside the client
  needs to do the same, or a delete will silently not happen.
- **`lat`/`lon` are not inputs.** Mobilize geocodes from the address and returns
  `location.location.{latitude,longitude}`.

### Attendee-sync traps, all verified against the live API

- **`?phone=` is silently ignored** by `/v1/users` — it returns an _unfiltered_
  list, so matching on it attaches signups to arbitrary strangers. The real
  parameter is **`phone_number`**. There is a regression test asserting the
  query string; don't "simplify" it.
- **Paths use underscores**: `/v1/event_rsvps`, `/v1/event_attendances`. The
  hyphenated forms in the docs URLs 404.
- **`event_id` here means a _Solidarity_ event.** Solidarity calls its own event
  entity a "mobilize_event" — its sessions carry `mobilize_event_id` pointing at
  a Solidarity event. Nothing to do with mobilize.us.
- **`skip_email_confirmation: true`** on every RSVP write, or Solidarity emails a
  confirmation to everyone the sync touches.
- **`agent_user_id` is required on an RSVP create.** Sending `null` fails with
  `422 {"errors":["Agent must exist"]}`. It records who filed the RSVP; Solidarity
  sets it to the attendee on its own web-form signups, and a Mobilize signup is
  the same self-service act, so the sync sends the attendee's id.
- **`/v1/users` does not use the `data` envelope for a single user.** `GET
/v1/users/:id` and `POST /v1/users` return the user _bare_, while `GET
/v1/event_rsvps/:id` and every list endpoint wrap in `data`. Reading only
  `data.id` on a create threw "returned no id" for profiles Solidarity had
  actually created — the person existed, their RSVP did not.
- **Unknown query parameters are silently ignored, not rejected.** `?tags=`,
  `?created_after=`, `?_sort=` all return the full unfiltered list with an
  unchanged `total_count`. This is the same failure mode as the `?phone=` trap:
  a filter that appears to work is the default state. Verify any new parameter
  changes `meta.total_count` before trusting it.
- A lookup returning **more than one** person resolves to no match. Picking the
  first would file an RSVP against the wrong human.

### New profiles

`chapter_id` is required and Solidarity chapters have no geographic data, so
zip → chapter is derived from where existing members actually sit (per zip, the
most common chapter), rebuilt on the nightly pass. Falls back to the chapter
owning the event, then `SOLIDARITY_DEFAULT_CHAPTER_ID`; if none resolves, the
person is reported rather than filed under a guess.

Only `sms_permission` is set, mirroring Mobilize's opt-in. Call and email
permission are left alone — signing up for an event is not consent to be called.

**Guardrail:** a run creating more than `ATTENDEE_SYNC_MAX_NEW_PROFILES`
(default 50) profiles stops and alerts. A spike almost always means matching
broke, and duplicate people are tedious to unpick (`POST /v1/users/merge` is the
remedy).

Expect a real match rate well under 100%: on a sampled shift, 26 of 81 signups
already existed, and spot-checking 10 of the other 55 confirmed all were
genuinely absent. Mobilize reaches people the CRM hasn't seen — that's the point
of the sync — so judge a run by _change_ in the rate, not its absolute value.

### Cadence

Every 30 minutes with a **4.5-hour look-ahead**, plus a nightly windowless pass
so events further out still get a rolling picture rather than their signups only
landing 4.5h before doors. Same job as the event sync, which runs first — see
[Running on a schedule](#running-on-a-schedule).

The ask was "4 hours before, and again 30 minutes before". GitHub cron cannot hit
fixed offsets — it is best-effort and this repo documents delays of hours
(`door-knock-snapshot.yml`). A look-ahead _window_ covers both marks and
tolerates a skipped run, because the next one still refreshes the event in time.

Both passes also look **back 48 hours** (`?lookback=`). Check-ins are recorded
during and after an event, so a forward-only scope would never sync who actually
showed up.

## Tests

```bash
npx vitest run mobilize-migrator
```

Covers the places a bug writes bad data: timeslot reconciliation (including that
a past orphan is dropped while an upcoming one is preserved), duplicate
detection, attendance normalization, and the per-event grouping that keeps
out-of-window signups from being filed.
