# Privacy Policy

_Last updated: 2026-09-09_

This document covers **Tools for Abdul's deployment** of slack-solidarity-helper-tools at
`https://slack.tools4abdul.com`, and — in [For other operators](#for-other-operators) — what
anyone self-hosting this code needs to change before publishing it as their own.

The short version: this app holds contact details and organising records for volunteers of a
political campaign. It exists to move that data between Slack, solidarity.tech and VAN so
organisers do not have to. It sells nothing, tracks nobody across sites, and runs no
advertising or analytics.

## Who is responsible

The **Tools for Abdul** volunteer team operates this deployment and decides what is collected
and how long it is kept. The source code is public at
[tools4abdul/slack-solidarity-helper-tools](https://github.com/tools4abdul/slack-solidarity-helper-tools);
everything described below can be verified there.

To ask about your data, correct it, or have it removed, see [Your choices](#your-choices).

## Who the data is about

Three groups, with different data held about each:

| Group                   | What they did                                               |
| ----------------------- | ----------------------------------------------------------- |
| **Volunteers**          | Joined the Slack workspace, or asked for help joining it    |
| **Canvassers**          | Claimed turf, or knocked doors recorded by canvassing tools |
| **Organisers / admins** | Signed in to the web app to run it                          |

Most people are in more than one group.

## What is collected, and why

### From Slack

- **Your Slack user ID, display name and email address**, read through the Slack API when you
  join the workspace, when you sign in, and when an admin looks you up. The email is what
  matches you to a solidarity.tech account so the bot can add you to your county channel.
- **The date you joined the workspace**, and the chapters you matched to (`slack_joins`). This
  is what the signup charts and the weekly growth report are counted from.
- **Messages you link**, when an admin files a note about one — the channel, timestamp and
  permalink, not the message body.

### From solidarity.tech

Your account is read to find your chapter, your five most recent actions, and your event
RSVPs. Those are **fetched live and displayed** on the member lookup page; they are not copied
into this app's database. What is stored is the link between your Slack account and your
solidarity.tech account (`member_account_links`), including the email that matched.

### From volunteers who ask for help joining

If you tell solidarity.tech you are having trouble joining Slack, your **name, email address
and phone number** are sent to this app's webhook and stored in a queue (`requests`) so an
admin can contact you. Admins can add a comment on your row and mark it handled; the app
records which admin did so. The queue is admin-only, both the page and the live update stream
behind it.

### Notes and warnings

Admins can log a **note** or a **rule-breaking warning** about a workspace member
(`member_notes`). The record holds the member, the text the admin wrote, who wrote it, when,
any linked message, and — for warnings — the exact message that was DMed to the member and its
sequence number. If a member notes channel is configured, a line naming the member, the admin
and the note text is also posted there, in a private admin channel.

This is a moderation record about a named person. It is the most sensitive thing the app holds.
It is kept for the length of the campaign and deleted with everything else after the election
(see [How long](#how-long-it-is-kept)).

### Turf checkout

When you claim a canvassing turf — from the web page or the `/turfs` slash command — the app
records **your Slack ID and display name, which turf, when you claimed it, when it expires, and
how it ended** (completed, handed back, expired, or released because you were blocked or the
turf was retired). That ledger is what stops two people knocking the same blocks, and it is
visible to organisers on the activity and organizer pages.

Being blocked from turf checkout stores your Slack ID, display name, the reason the admin gave,
and who set it (`van_blocked_users`). The reason is shown to other organisers; it is
deliberately **not** repeated to you in the DM telling you your turf was released.

If an organiser hands turf out inside VAN rather than through this app, VAN reports who it went
to, and **the canvasser names on that export are stored** against the turf
(`van_turfs.van_distributed_to`). That is what marks a turf as already assigned so nobody claims
it twice, and what the drift report compares against this app's own ledger. It is the only
per-person detail this app copies out of VAN — no voter name, address, date of birth, party,
phone number, email or VAN ID is ever stored, and the code that reads VAN's export files drops
those columns as it passes over them (`src/lib/server/van/hull-extract.ts`).

### Location, when you use `/turfs`

Three deliberate limits here, all verifiable in the code:

- **A typed street address is never stored and never logged.** It is geocoded in memory through
  the US Census geocoder, used to sort the list, and dropped. Only the ZIP code it matched to is
  cached, in `van_zip_centroids` — a table of ZIP centroids, not of people.
- **Browser geolocation, if you grant it, stays in your browser** for sorting. Coordinates that
  ride along in a Slack button are rounded to three decimal places (~100 m) — enough to re-sort a
  list, not a movement trace.
- Your ZIP, if you type one, is used for the same sort and is not attached to your record.

### Turf map shapes

The turf map draws each turf as a shape. VAN does not publish turf boundaries, so the shape is
derived: the app asks VAN for the coordinates of the addresses in a turf, computes the outline
that contains them, and **stores only that outline and a count**. No address, name or other
per-person detail is written to the database, and none of it reaches your browser — the map
shows a polygon and a door count, nothing else.

**Where VAN has not already geocoded an address, that street address is sent to the US Census
Bureau's geocoder to obtain coordinates.** This happens automatically, as part of the same
scheduled sync, and it is the only point in the app where voter address data leaves its
servers. Three limits apply, enforced in `src/lib/server/van/geocode-batch.ts`:

- **Only address components are sent** — street, city, state, ZIP. Never a name, date of birth,
  party, phone number, email address, or any VAN identifier. Rows are keyed by a throwaway
  number that means nothing outside the request.
- **Addresses are never stored and never logged**, by this app or in its error output. They
  exist in memory for the length of one request and are discarded with it.
- **Only addresses VAN left without coordinates are sent.** VAN's own coordinates are always
  preferred, so a turf VAN has already geocoded sends nothing at all — and in a VAN database
  that is fully geocoded, this never runs.

The US Census Bureau is a federal statistical agency; its geocoder is a public service that
requires no account, and it is already used for the address sorting described above. A bare ZIP
code is answered from the Bureau's TIGERweb service instead — the published ZIP Code Tabulation
Area boundaries — because the geocoder resolves street addresses only. That lookup sends the five
digits and nothing else.

### Canvassing results

Nightly snapshots from the campaign's canvassing tool record **per-canvasser daily attempt and
contact counts** by name (`door_knock_canvasser_daily`), plus per-region totals. These drive the
doors-knocked charts and the leaderboard. No voter records, addresses, or conversation contents
from canvassing are stored by this app.

### Sessions and admin tokens

- A **session cookie** holds a random ID; the session itself (your Slack ID, display name, and
  whether you are an admin) lives server-side and expires after 8 hours.
- For admins only, the app stores a **Slack user token, encrypted with AES-256-GCM**, so info
  commands can post as you rather than as the bot. A non-admin's token is deleted on sight.

### What is not collected

No analytics or advertising SDKs. No cross-site tracking, no third-party cookies, no
fingerprinting. No page-view or click logging. Server logs record request handling and admin
actions (for example, that a claim was made on a route ID); they are not used to build a profile.

## Where it goes

Data leaves this app in exactly these directions:

| Recipient                  | What reaches them                                                                                                                                                                                    | Why                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Slack**                  | Messages, DMs, channel invites, modal contents                                                                                                                                                       | The app is a Slack bot            |
| **solidarity.tech**        | Lookups by email; RSVP and event reads                                                                                                                                                               | Chapter matching, member lookup   |
| **Mobilize**               | Event and RSVP sync                                                                                                                                                                                  | Keeping the two calendars aligned |
| **EveryAction / VAN**      | Read-only turf catalog requests                                                                                                                                                                      | The turf list                     |
| **Openfield** (canvassing) | Service-account reads of leaderboards                                                                                                                                                                | Doors-knocked numbers             |
| **US Census Bureau**       | A ZIP or address string, at request time (ZIPs to TIGERweb, addresses to the geocoder); and voter street addresses in bulk where VAN has not geocoded them (see [Turf map shapes](#turf-map-shapes)) | Distance sorting; turf map shapes |
| **CARTO / OpenStreetMap**  | Your browser's IP, when the turf map loads tiles                                                                                                                                                     | The basemap                       |
| **Fly.io**                 | Everything, as the host                                                                                                                                                                              | Hosting                           |
| **Turso**                  | The database contents                                                                                                                                                                                | Storage                           |

Nothing is sold, rented, or shared for advertising. Data is disclosed to anyone else only if
the law requires it.

Within the workspace, note that **Slack channels are a disclosure**: the tracking channel sees
new help requests, the member notes channel sees note and warning text, and the growth report
channel sees per-chapter counts. Configure those as private admin channels.

## How long it is kept

**Everything personal is deleted after the general election on 3 November 2026.** This app
exists to run one campaign, and the records below have no purpose once it is over. Within 30
days of the election every record identifying a volunteer, canvasser or organiser is deleted —
the help-to-join queue, notes and warnings, Slack join rows, account links, the turf checkout
ledger and block list, per-canvasser door-knock rows, stored admin tokens, and any sessions
still open. What survives is aggregate: daily and weekly counts per chapter and date, which name
nobody.

Nothing in the code enforces that date. It is a commitment the Tools for Abdul team carries out
by hand, not a scheduled job, and this document is the record of it. The retention below
describes what happens **until** then.

| Data                                | Retention                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions                            | 8 hours, then deleted on next access                                                                                                                                            |
| Admin Slack tokens                  | Until you stop being an admin, the encryption key is rotated, or the election                                                                                                   |
| Help-to-join queue (`requests`)     | Until removed by an admin, and in any case the election; no automatic expiry                                                                                                    |
| Notes and warnings                  | Kept until the election. Warning numbering is a running count, so deleting one before then silently renumbers the rest — early removal is a deliberate act, not routine cleanup |
| Turf checkout ledger                | Kept until the election, as the record of who had which turf when                                                                                                               |
| Retired turf rows                   | Kept while the campaign runs, so a live claim still renders                                                                                                                     |
| Slack invite sightings              | Kept after a link is removed — deleting them would erase the record of the fix. Names pages, not people                                                                         |
| Daily signup / door-knock snapshots | Kept indefinitely. These are counts per (date, chapter), not per person                                                                                                         |
| Geocoded ZIP centroids              | Kept indefinitely. Not linked to anyone                                                                                                                                         |

Apart from session expiry, no deletion is automated — including the post-election wipe above.
Earlier removal is done on request, by hand.

## Your choices

- **See what is held about you.** Ask an organizer; most of it is already on your `/members`
  page, which any admin can show you.
- **Correct it.** Chapter mismatches and wrong account links are fixed by an admin on the same page.
- **Have it removed.** Ask an organizer, or open an issue on the repository if you would rather
  not go through the workspace. Records that must be kept as a moderation or turf history — and
  the reason why — will be named explicitly rather than quietly retained.
- **Leave.** Leaving the Slack workspace stops all future collection. It does not by itself
  delete what was already recorded; ask if you want that too.
- **Turn off location.** Decline the browser prompt; `/turfs` still works, sorted by name or by
  a ZIP you choose to type.

Depending on where you live you may have stronger statutory rights (access, deletion,
portability, objection). Ask, and they will be honoured on the same route.

## Children

This is a tool for campaign volunteers. It is not directed at children under 13 and no age
information is collected.

## Security

See [SECURITY.md](SECURITY.md) for how the app is protected and how to report a vulnerability.
Nothing here is a promise that a breach is impossible; if one happens, affected people will be
told what was involved.

## Changes

Material changes will be noted in the repository's commit history and the date at the top of
this file updated. The git history is the changelog.

## For other operators

If you self-host this code, **this document is not your privacy policy** — it describes one
deployment's choices. Before publishing your own, change at least:

1. **Who is responsible** and the contact route for requests.
2. **Which integrations you actually run.** Openfield, Mobilize, VAN and the door-knock
   snapshot are each optional; a deployment without them collects less and should say so.
3. **Your channel configuration.** Which Slack channels see notes, warnings, tracking messages
   and growth reports is your decision and belongs in your policy.
4. **Your retention practice, including your own end date.** The code deletes nothing but expired
   sessions — the post-election wipe above is a Tools for Abdul commitment carried out by hand,
   not something you inherit by running this software. Decide when your campaign's records end,
   say so, and set a reminder; a deletion date nobody is scheduled to act on is worse than an
   honest "retained indefinitely".
5. **Your hosting and storage vendors**, if not Fly.io and Turso.
6. **Your map tile provider.** The default is CARTO's keyless endpoint; whichever you use sees
   your volunteers' IP addresses.
7. **Your jurisdiction.** Nothing here is legal advice, and the statutory basis for processing —
   GDPR, CCPA, or none of the above — depends on where your volunteers are.

Two properties are structural rather than policy, and hold in any deployment: typed addresses
are never persisted or logged, and the seed data in `npm run db:seed` is entirely synthetic, so
development never needs a copy of production.
