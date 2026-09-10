# slack-solidarity-helper-tools

A Slack bot and webhook server for solidarity.tech organisations. It does four things:

- **Welcome new members** — when someone joins the Slack workspace, the bot looks up their solidarity.tech account, automatically adds them to their county chapter channel(s), and sends them a DM with a link to those channels.
- **Help volunteers join Slack** — when a volunteer has trouble joining, solidarity.tech calls the webhook, their details are queued in a database, and admins work through the queue at `/pending` with live updates via Server-Sent Events.
- **Show signup trends** — every workspace member can sign in at `/` to see Solidarity vs. Slack signup charts over the last 7/30/90 days, with per-chapter drill-down at `/dashboard/solidarity` and `/dashboard/slack`.
- **Look up a member** — admins can search any Slack member at `/members` and see their five most recent Solidarity actions and event RSVPs, plus any notes or warnings logged about them — without opening their full personal record in Solidarity.
- **Track notes and warnings** — admins log notes or rule-breaking warnings from Slack with `/member-note` or the message shortcut. Warnings DM the member a numbered, configurable message the admin can edit before sending, and everything is visible at `/members`.
- **Post a weekly growth report** — a scheduled internal endpoint computes per-chapter Slack-signup growth for the previous week and posts a Slack message highlighting the top performers.

[PRIVACY.md](PRIVACY.md) describes what the app collects about volunteers and how long it
keeps it; [SECURITY.md](SECURITY.md) covers how it is protected and how to report a
vulnerability privately. Both are served to the public at [`/policies`](#get-policies) — the
only page outside the auth guard.

## How it works

### New member welcome

1. A new member joins the Slack workspace
2. Slack sends a `team_join` event to `POST /api/slack/events`
3. The server looks up the member's email in solidarity.tech to find their chapter(s)
4. The bot invites them to the matching county channel(s) and sends them a DM:
   > _"Welcome to the workspace! We've added you to your county chapter channel: #county-name"_

### Volunteer invite queue

1. A volunteer indicates they need help joining Slack in a solidarity.tech automation
2. The automation calls `GET /webhook?secret=<WEBHOOK_SECRET>&email=<email>&name=<name>&phone=<phone>`
3. The server stores the volunteer's details in a Turso database and posts a message to a Slack channel
4. Authorised admins visit `/pending`, sign in with Slack, and see the queue update in real time
5. Admins mark volunteers as helped and add comments; changes are reflected live for all connected users

### Dashboard

1. Any workspace member signs in with Slack to land on `/`
2. The page renders two LayerChart bar charts — total Solidarity signups per day and total Slack signups per day — over a 7/30/90-day window (default 90, persisted via `?days=`)
3. A "View by chapter →" link on each card goes to `/dashboard/solidarity` or `/dashboard/slack`, which stacks bars per chapter with a top-10 + "Other" rollup
4. Chapters listed in `REPORT_EXCLUDED_CHAPTER_IDS` are omitted from both charts and from the weekly growth report
5. Data comes from local tables — `solidarity_daily_snapshots` (written nightly by `/api/internal/solidarity-snapshot`) and `slack_joins` (written in real time by the `team_join` handler)

### Weekly growth report

1. A scheduler (e.g. GitHub Actions) posts to `/api/internal/weekly-growth-report?key=<INTERNAL_CRON_SECRET>` once a week
2. The endpoint compares `slack_joins` rows from the last 7 days against the existing channel size (fetched via `conversations.info` for chapters with a chapter↔channel mapping — configured on `/settings`, falling back to `SOLIDARITY_CHAPTER_CHANNEL_MAP` — or the cumulative `slack_joins` count otherwise)
3. Chapters are ranked by a power-law score `newJoins / (existing + 1)^α` (configurable via `SLACK_GROWTH_REPORT_RANKING_ALPHA`, default `0.7`) and the top 5 are posted to `SLACK_GROWTH_REPORT_CHANNEL_ID`
4. Pass `?dry_run=1` to compute the result without posting

### Member lookup

1. An admin opens `/members` and searches the Slack directory by name
2. The member is matched to a Solidarity account by email; an admin-made link (below) takes precedence over the email match
3. Their five most recent `/v1/user_actions` and `/v1/event_rsvps` rows are shown, newest first. Neither endpoint returns a label, so page names and event titles are resolved from cached `/v1/pages` and `/v1/events` lookups
4. If no Solidarity account matches, the page shows the member's Slack email and a search box to find and **Link** the right account by name or email. Solidarity's API has no name search, so the roster is fetched once and cached for an hour, then searched server-side — the roster itself is never sent to the browser

### Member notes and warnings

1. An admin runs `/member-note` (optionally `@mentioning` someone), or picks **Log member note** from a message's ⋯ menu, which prefills both the member and a link to that message
2. A modal collects the member, Note vs. Warning, the details, an optional Slack message link, and whether to DM the member
3. Choosing **Warning** reveals an editable copy of the warning message, prefilled from the configured template. Edits apply to that one warning only
4. The note is written to the database _before_ any DM is attempted, so a Slack failure never loses the record
5. For warnings, the member is DMed the rendered message. The warning number is the member's all-time count of warnings; notes don't count toward it
6. **View member record** on a message's ⋯ menu posts an admin a link straight to that person's `/members` page
7. If a **member notes channel** is configured on `/settings`, a line is posted there for every note and warning — `Note "…" added to user @person by @admin`, with `and warning "…" sent to them` when the member was actually DM'd — so moderation is visible to all admins rather than only whoever filed it. Make it a private admin channel: the note text and the warning both appear in it.

The warning DM template is edited on `/settings` and supports `{{nth}}` (which warning this is), `{{note}}` (the details the admin typed), `{{message_link}}` (the linked message), and `#channel-name` links.

### Info commands

Slash commands that post a set message **as the admin who runs them** — not as the bot. For the answers you retype constantly: "here's where to sign up to phone bank", "here's how to join a canvass".

1. An admin adds a command on `/settings` → **Info commands**: a name (`/info-phone`) and the message it posts. Channels are written as `#channel-name` and become real links at post time
2. **You must also register the command in your Slack app** (see setup step 11) — Slack only routes commands it knows about, so a command that exists only in `/settings` does nothing
3. Running it posts the message into the current channel under the admin's own name and avatar. It is a real message from them: no **APP** badge, and they can edit or delete it like anything else they wrote
4. This works by storing a per-admin Slack user token, captured at login. Tokens are encrypted at rest with `TOKEN_ENCRYPTION_KEY` and are stored only for admins — a non-admin's token is deleted on sight
5. Admins who last logged in before this feature shipped will be told to sign in again: Slack does not add a new scope to a token it has already issued

Because the token is captured at login, and only admins can log in, these commands are admin-only. An admin who has never signed in to the web app gets an ephemeral prompt with the link, rather than a failed post.

### The `/turfs` command

Turf checkout without opening a browser. `/turfs` replies with the five nearest available
turfs, each claimable from the message itself.

Three ways to say where you are, resolved in that order:

| You type                             | County comes from                       | Sorted by         |
| ------------------------------------ | --------------------------------------- | ----------------- |
| `/turfs` in a county channel         | the chapter → channel map               | turf name         |
| `/turfs 48104`                       | the ZIP → chapter map, else the channel | distance from ZIP |
| `/turfs 100 N Main St, Ann Arbor MI` | the matched ZIP, else the channel       | distance          |

If none of them resolve, the reply is a list of counties to pick from — the same gate the
web page applies, where no county means no turf rather than a default one.

**Anyone in the workspace can run it**, minus the block list at **Settings → Blocked from
turf checkout**. This is the only slash command in the app that is not admin-only, and it
grants nothing new: a Slack workspace member is the same bar as a Slack-OAuth session, and
the `/turfs` web page is already open to exactly these people.

**Claim, Give back and Show next 5** are buttons on the reply. They re-run every gate the
command does, against the same counters — they are reachable without the command, since a
Slack message stays interactive for thirty minutes, so inheriting its gates is not
something they can do. Each press replaces the message rather than adding one, so pressing
"Show next 5" three times does not leave three stale lists to claim from.

**The MiniVAN list number is shown only to whoever claimed the turf**, in an ephemeral
message — which has exactly one recipient by construction. It is never posted to a
channel, never DMed, and deliberately kept out of the notification fallback text, which is
the one thing that renders on a locked phone.

**A typed address is never stored and never logged.** It is geocoded in memory, used to
sort, and dropped; only the ZIP the geocoder matched it to is cached, in
`van_zip_centroids`. Coordinates that ride along in a button value are rounded to three
decimals (~100 m) — enough to re-sort a list, not a location trace.

The reply is deferred: Slack allows three seconds, a cold geocode takes up to four, and
`min_machines_running = 0` can add a boot on top. So the command acknowledges immediately
and posts the real answer to `response_url`, replacing the acknowledgement.

## Setup

### 1. Configure the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (or use an existing one)
2. Under **OAuth & Permissions**, add these bot scopes:
   - `chat:write` — to post messages and DMs
   - `im:write` — to open DM channels with new members
   - `channels:manage` — to invite members to public channels
   - `groups:write` — to invite members to private channels
   - `users:read` — to list workspace members, and to read the display name at login
   - `users:read.email` — to read member email addresses
   - `channels:read`, `groups:read` — to list channels for the settings pickers and `#channel` links
   - `files:read` — to read the door-knocking channel's Conversation Codes canvas
   - `commands` — for the `/member-note` slash command and the message shortcuts

   If you are adding `commands` to an existing app, **reinstall the app** afterwards and re-copy the bot token if it changes.

3. Under **OAuth & Permissions**, set the user scopes to exactly one entry:
   - `chat:write` — signs the admin in _and_ lets the info commands post as them rather than as the bot

   **If `identity.basic` is listed there, remove it.** Slack refuses any authorization that mixes an `identity.*` scope with a normal one, failing the install with _"Invalid permissions requested"_. Sign in no longer needs it: `oauth.v2.access` returns the user's id directly, and the display name comes from `users.info` on the bot token.

   Adding `chat:write` after the fact does not upgrade tokens Slack has already issued: every existing admin has to sign in again before info commands work for them.

4. Under **OAuth & Permissions → Redirect URLs**, add:
   ```
   https://your-app.fly.dev/auth/slack/callback
   ```
5. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
6. Invite the bot to each county channel it needs to post in: `/invite @your-bot-name`
7. Invite the bot to your tracking channel: `/invite @your-bot-name`
8. Copy the **Client ID**, **Client Secret**, and **Signing Secret** from **Basic Information**
9. Under **Event Subscriptions**, enable events and set the Request URL to:
   ```
   https://your-app.fly.dev/api/slack/events
   ```
   Then under **Subscribe to bot events**, add `team_join` and `file_change`
10. Under **Slash Commands**, create `/member-note`:
    - Request URL: `https://your-app.fly.dev/api/slack/commands`
    - Usage hint: `[@member]`
    - **Turn ON "Escape channels, users, and links"** — without it the command text has no user id to prefill the modal with
11. Under **Slash Commands**, create `/turfs`:
    - Request URL: `https://your-app.fly.dev/api/slack/commands` (the same URL as `/member-note`)
    - Usage hint: `[zip or address]`
    - Leave "Escape channels, users, and links" off — the argument is a place, not a mention

12. Under **Slash Commands**, create one command per row you add on `/settings` → **Info commands**, e.g. `/info-phone`:
    - Request URL: `https://your-app.fly.dev/api/slack/commands` (the same URL as `/member-note`)
    - Leave "Escape channels, users, and links" off — these commands take no arguments

    This step is not optional and not automatic: Slack will not route a command it has no registration for, so a command that exists only on `/settings` silently does nothing. Deleting a command is likewise two steps — remove the row on `/settings` **and** the registration here.

13. Under **Interactivity & Shortcuts**, enable interactivity and set the Request URL to:
    ```
    https://your-app.fly.dev/api/slack/interactivity
    ```
14. Under **Interactivity & Shortcuts → Shortcuts**, create two **message** shortcuts (the callback IDs must match exactly):
    - "Log member note" — callback ID `log_member_note`
    - "View member record" — callback ID `view_member_record`

One new environment variable is required — `TOKEN_ENCRYPTION_KEY`, which encrypts the per-admin Slack tokens the info commands post with. Generate one and set it before deploying; the app refuses to start without it, and a key that doesn't decode to 32 bytes is rejected at startup rather than at first use:

```
openssl rand -base64 32
fly secrets set TOKEN_ENCRYPTION_KEY="<the generated value>"
```

Rotating the key does not break logins — it invalidates every stored token, and each admin re-authorizes the next time they run an info command.

The warning DM template and the info-command messages are configured on `/settings`.

> **Note on CSRF:** Slack posts slash commands and interactivity payloads as form-encoded requests with no `Origin` header, which SvelteKit's built-in CSRF check rejects — and only in production. `svelte.config.js` therefore disables that check and `src/hooks.server.ts` re-implements it, exempting only the signature-verified `/api/slack/*` routes. See `src/lib/server/csrf.ts` for the details.

### 2. Find your Slack user IDs

For each person who should have access to `/pending`:

- Open their profile in Slack → **...** menu → **Copy member ID**

### 3. Create a Turso database

1. Sign up at [turso.tech](https://turso.tech) (free tier)
2. Create a new database:
   ```bash
   turso db create solidarity-slack
   ```
3. Get the connection URL and auth token:
   ```bash
   turso db show solidarity-slack --url
   turso db tokens create solidarity-slack
   ```

### 4. Build the chapter → channel map

Find the solidarity.tech chapter ID for each county and the corresponding Slack channel ID, then build a JSON object mapping one to the other.

To find a **chapter ID**: call `GET https://api.solidarity.tech/v1/chapters` with your API token and note the `id` field for each chapter.

To find a **Slack channel ID**: right-click the channel in Slack → **View channel details** → scroll to the bottom.

The resulting map looks like:

```json
{ "123": "C012AB3CD", "456": "C987XY6Z" }
```

### 5. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_CLIENT_ID=your-client-id
SLACK_CLIENT_SECRET=your-client-secret
SLACK_SIGNING_SECRET=your-signing-secret-here
SLACK_ALLOWED_USER_IDS=U012AB3CD,U012AB3CE        # admin allowlist (fallback/seed for the DB-backed list)
SLACK_SUPERUSER_ID=U012AB3CD                      # optional; always-admin escape hatch
SLACK_TRACKING_CHANNEL_ID=C012AB3CD
SLACK_GROWTH_REPORT_CHANNEL_ID=C012AB3CD          # where the weekly growth report posts
SLACK_GROWTH_REPORT_RANKING_ALPHA=0.7             # optional; power-law exponent for ranking
REPORT_EXCLUDED_CHAPTER_IDS=123,456               # optional; chapters to omit from charts + report
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token-here
WEBHOOK_SECRET=your-webhook-secret-here
INTERNAL_CRON_SECRET=long-random-string           # required for /api/internal/* endpoints
APP_URL=https://your-app.fly.dev
SOLIDARITY_API_TOKEN=your-solidarity-api-token-here
SOLIDARITY_CHAPTER_CHANNEL_MAP='[{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]'
DOOR_KNOCK_PROVIDER=openfield                         # optional; which canvassing tool supplies the numbers
OPENFIELD_BASE_URL=https://yourcampaign.openfield.ai  # optional; enables the door-knock snapshot
OPENFIELD_USERNAME=service-account-username           # a dedicated Openfield volunteer account
OPENFIELD_PASSWORD=service-account-password
DOOR_KNOCK_CHANNEL_ID=C012AB3CD                       # channel whose "Conversation Codes" canvas lists codes
PORT=3000  # defaults to 3000 in production; ignored in dev (Vite uses 5173)
```

`SLACK_GROWTH_REPORT_RANKING_ALPHA` tunes the ranking formula `newJoins / (existing + 1)^α`. `α = 1` is pure relative growth (small chapters dominate); `α = 0` is pure absolute count; `0.7` is a middle ground where small chapters still tend to win but large ones can compete.

`REPORT_EXCLUDED_CHAPTER_IDS` is a comma-separated list of solidarity.tech chapter IDs to omit from the dashboard charts AND the weekly growth report — useful for test chapters or internal-only ones. Leave empty (or unset) to include everything.

`INTERNAL_CRON_SECRET` gates the scheduler-only endpoints under `/api/internal/`. Generate with `openssl rand -hex 32`.

The one exception is `/api/internal/van-export-callback`, which VAN calls. VAN **requires** a `webhookUrl` on every export job, stores it, and echoes it back on every later read of that job — so the URL it holds carries a per-turf HMAC (`?turf=&token=`) keyed by `INTERNAL_CRON_SECRET` rather than the secret itself. A leak of one of those tokens buys a queue drain for one turf and nothing else; the secret would have opened all seven internal endpoints. Rotating `INTERNAL_CRON_SECRET` invalidates outstanding tokens, so in-flight export jobs fall back to being collected by the next scheduled `van-sync` run.

The `OPENFIELD_*`/`DOOR_KNOCK_*` vars enable the nightly door-knock snapshot (`/api/internal/door-knock-snapshot`), which records each turf's doors-knocked total for the day. The dashboard's "Doors knocked" chart appears once the first snapshot lands.

`DOOR_KNOCK_PROVIDER` picks which canvassing tool the numbers come from; it defaults to `openfield`, so an existing deployment needs no new variable. The Openfield provider reads conversation codes from the door-knocking channel's "Conversation Codes" canvas (requires the `files:read` bot scope), logs into Openfield with the service account, and pulls each code's leaderboard. Everything tool-specific lives behind the `DoorKnockProvider` interface in `src/lib/server/door-knock-provider.ts` — adding another canvassing tool (MiniVAN, say) means implementing `dateFor` + `collect` under `src/lib/server/door-knock/<tool>/` and registering it in `src/lib/server/door-knock-env.ts`; the snapshot writer, the refresh throttle, the schema, and the charts are unaffected.

### 6. Run the server

```bash
npm install

# Development (hot reload, http://localhost:5173)
npm run dev

# Run tests
npm test

# Production
npm run build
npm start

# Database migrations
npm run db:generate   # generate a new migration after editing src/lib/server/schema.ts
npm run db:migrate    # apply pending migrations to TURSO_DATABASE_URL
```

In production, migrations run via Fly's `release_command` (`node bin/migrate.js`) — see `fly.toml`. Each deploy applies any pending migrations before the new image starts serving traffic.

## Local development

A minimal `.env.local` for local development — no real Slack credentials needed:

```
TURSO_DATABASE_URL=file:local.db
WEBHOOK_SECRET=any-local-secret
DEV_SLACK_USER_ID=U012AB3CD
```

`file:local.db` creates a local SQLite database in the project root (no Turso account needed). `DEV_SLACK_USER_ID` bypasses Slack OAuth — visiting `/pending` automatically creates a session for that user ID. Set it to your real Slack user ID so the allowlist check passes once you wire up real credentials.

The `team_join` welcome flow requires real Slack credentials and cannot be tested locally without a tunnelling tool (e.g. `ngrok`).

### Test data

A fresh `local.db` is empty, so the dashboard renders as a row of "No signups recorded yet" cards. `npm run db:seed` fills it with synthetic data:

```bash
npm run db:migrate    # create the tables first (needs TURSO_DATABASE_URL=file:local.db)
npm run db:seed       # 120 days of generated dashboard data

SEED=7 npm run db:seed              # a different but equally reproducible dataset
DAYS=400 npm run db:seed            # longer window, to exercise the 90-day preset
TURSO_DATABASE_URL=file:scratch.db npm run db:seed
```

**Nothing in it comes from production.** Chapters, members, canvassers and counts are all generated — no real names, no email addresses outside `@example.invalid`, and no Slack user IDs that resolve to a real account. Production data is not needed to exercise the dashboard, which reads almost entirely aggregates keyed by `(date, chapter)`.

The script refuses to run against anything but a `file:` URL, so it can't be pointed at Turso by accident.

Output is deterministic for a given `SEED` — two people running `npm run db:seed` on the same day get identical rows, so a bug one person sees reproduces for everyone. (Dates are relative to today, so the window moves forward as the calendar does.)

It populates `solidarity_daily_snapshots`, `slack_joins`, `door_knock_daily`, `door_knock_canvasser_daily`, `weekly_growth_windows`, `weekly_chapter_growth`, `chapter_channel_map`, and the countdown fields of `app_config`, and deliberately includes the cases that are easy to miss:

| case                                                                      | why it's there                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Members in two chapters at once                                           | Per-chapter bands sum to more than the distinct daily total, so the dark overlay marker has something to show                                           |
| Signups with no chapter                                                   | Feeds the `No chapter` band                                                                                                                             |
| A chapter id with no name row                                             | Renders as the `Chapter #199` fallback                                                                                                                  |
| More than ten chapters                                                    | Forces the `Other` band and its merged-chapter breakdown                                                                                                |
| A five-day gap in the snapshots                                           | Charts must zero-fill rather than close the gap                                                                                                         |
| Sundays with no activity                                                  | Same                                                                                                                                                    |
| Mixed chapter naming — `Kent for Abdul`, `Ingham County`, `Detroit Metro` | The county heatmap derives county names from chapter names; these are the three shapes it has to cope with, including one that maps to no county at all |
| Punctuated and multi-word counties — `St. Clair`, `Grand Traverse`        | Must survive normalization verbatim to match the map's geojson                                                                                          |
| Door-knock regions that aren't counties                                   | Door-knock chapter names come from the canvassing tool, not the chapter list                                                                            |

If you need a table the seeder doesn't cover, add it there rather than copying rows out of production — several tables (`member_notes`, `member_account_links`, `slack_user_tokens`, `sessions`) hold credentials or moderation records about named members and should not leave the production database.

## Reports

### Top RSVPers per chapter

`scripts/top-rsvpers.ts` writes a CSV of each chapter's ten most active members — the people who RSVP'd to the most distinct events over a trailing window. Read-only; nothing is written back to Solidarity.

```bash
npx tsx --env-file=.env.local scripts/top-rsvpers.ts
npx tsx --env-file=.env.local scripts/top-rsvpers.ts --months 3 --top 20
npx tsx --env-file=.env.local scripts/top-rsvpers.ts --stdout > top.csv
```

| Flag       | Default                      | Meaning                                      |
| ---------- | ---------------------------- | -------------------------------------------- |
| `--out`    | `top-rsvpers-YYYY-MM-DD.csv` | Where to write                               |
| `--stdout` | off                          | CSV to stdout, progress to stderr            |
| `--months` | `2`                          | Window length in calendar months, ending now |
| `--top`    | `10`                         | Members per chapter                          |

Columns: `Chapter Name`, `RSVP count (over the past two months)`, `Full Name`, `Email`, `Phone Number`.

The output carries members' contact details, so `top-rsvpers-*.csv` is gitignored. Point `--out` somewhere outside the repo if you'd rather not have it in the working directory at all.

How the count is arrived at, since each choice changes who appears:

- **One count per _event_, not per session.** Someone who committed to eight weeks of the same weekly canvass did one thing; counting it eight times would let a single recurring commitment outrank everyone who turned up to eight different things.
- **Cancelled RSVPs (`is_attending: "no"`) don't count.** Everything else — yes, maybe, waitlisted — is someone putting their name down.
- **Each person appears on exactly one chapter's list.** Members belong to their own chapter regardless of whose events they attended; a member of _several_ chapters is placed in the one where most of their RSVPs went, with ties broken on the lowest chapter id so repeat runs produce the same file. The reported count is still their total across every event in the window — turning out for a neighbouring chapter is engagement, not a reason to discount them.
- **Members Solidarity's roster doesn't return** are reported under `(no chapter)`, using the contact card on their RSVP rows, rather than being dropped from a chapter's list.
- **Duplicate Solidarity profiles for one person are merged on email _and_ name.** Solidarity genuinely holds duplicate people — its API has `POST /v1/users/merge` for exactly this — and the first run of this report put one member in a chapter's top ten twice, with her RSVPs split across two records so both counts understated her. Matching on email alone is wrong here: **29 different people share `noemail@gmail.com`**, a placeholder used when someone signs up without an address, and keying on it pooled all of them into one fictitious member who then topped their chapter. Requiring the name to match too costs the occasional real duplicate filed under "Bob" and "Robert" — much the cheaper error. Phone is not part of the key at all, since households share a number far more often than an inbox. The run logs how many profiles were folded together, which is a decent nudge that some records want merging upstream.

Expect the run to take about **25 minutes** on a two-month window (measured: 1204 events, 1131 non-empty sessions, ~20k RSVPs, a 15.8k-member roster). Solidarity allows 60 requests per 30 seconds and offers no bulk RSVP-by-date filter, so the script makes one paced request per event session in the window (skipping the ones the API reports as empty) plus a full roster walk. Pacing is deliberately conservative — a run at this rate still drew one `429`, which the shared retry logic absorbed by honouring `Retry-After`. Progress goes to stderr.

## API

### `POST /api/slack/events`

Receives events from the Slack Events API. Verifies the request signature using `SLACK_SIGNING_SECRET` and returns `401` if invalid.

Handles two event types:

| Event              | Action                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `url_verification` | Returns the Slack challenge token (required when first configuring the URL)                                 |
| `team_join`        | Looks up the new member in solidarity.tech, invites them to their county channel(s), and sends a welcome DM |

The `team_join` handler does nothing if the member's email is not found in solidarity.tech, or if their chapter has no chapter↔channel mapping (configured on `/settings`, falling back to `SOLIDARITY_CHAPTER_CHANNEL_MAP`).

### `POST /api/slack/commands`

Slash commands. Verifies the Slack signature over the raw body, then parses it as
form-encoded.

- `/member-note` opens the note modal via `views.open`. Admin-only.
- `/turfs` lists the nearest available turf — see [The `/turfs` command](#the-turfs-command).
  **The only command here open to non-admins**, deliberately: it serves the same data as
  the `/turfs` web page, which is already open to any signed-in member minus the turf
  block list. Its gates are `$lib/server/van/turf-slack.ts`'s.
- Anything else is looked up in `info_commands` and posted as the admin who ran it.
  Admin-only.

### `POST /api/slack/interactivity`

Handles `message_action` (both message shortcuts), `block_actions` (the Note/Warning
toggle, which re-renders the modal via `views.update`; and the turf Claim / Give back /
Show next 5 buttons) and `view_submission` (saving the note). Same signature
verification. On submit the note row is written first, the modal is closed, and the
warning DM is sent detached — so a DM failure never loses the note.

Turf buttons are dispatched by `action_id` **before** the note-modal guard, because they
come from a message rather than a modal and so carry no `view` — the modal guard would
otherwise swallow them silently.

### `GET /members` (admin)

Member lookup page. `?user=<slackUserId>` selects a member; the detail is streamed.

### `POST /api/members/link` (admin)

`{ "action": "link", "slackUserId": "U…", "solidarityUserId": 123 }` or
`{ "action": "unlink", "slackUserId": "U…" }`. The Solidarity id is validated against the
cached roster (no API call). Returns 503 only if that roster has never been fetched.

### `GET /api/members/solidarity-search?q=` (admin)

Searches the cached Solidarity roster by name or email (minimum 2 characters) and returns
up to 25 matches. Exists because Solidarity's `/v1/users` filters only by exact email or
phone — there is no name search.

Stale-while-revalidate: it answers from the last fetched roster immediately and refreshes
in the background, so it never waits on the walk (a cold one takes roughly two minutes).
The response carries `refreshing` — a fuller list is on its way — and `firstFetch`, which
distinguishes "still building the first list" from "searched, found nothing". The UI shows
a spinner and re-runs the query until it settles.

### `POST /api/settings/warning-dm-test` (admin)

Renders the warning DM template with sample values and DMs it to the signed-in admin.

### `GET /webhook`

Called by solidarity.tech when a volunteer needs help joining Slack. Stores the volunteer's details and posts to the tracking channel. Returns `401` if the secret is wrong.

| Parameter | Required | Description                 |
| --------- | -------- | --------------------------- |
| `secret`  | Yes      | Must match `WEBHOOK_SECRET` |
| `email`   | No*      | Volunteer's email address   |
| `name`    | No       | Volunteer's full name       |
| `phone`   | No*      | Volunteer's phone number    |

\* At least one of `email` or `phone` is required.

If the same email is submitted again, the existing record is updated with the new name, phone, and timestamp.

### `GET /pending`

Protected by Slack OAuth. Redirects unauthenticated users to Sign in with Slack. Only users in the admin allowlist (the DB-backed `allowed_slack_users` table, falling back to `SLACK_ALLOWED_USER_IDS` while that table is empty) are granted access; the `SLACK_SUPERUSER_ID` user is always granted access regardless of the list. Displays a web page listing volunteers who have requested help but still haven't joined the workspace.

The underlying JSON is also available at `GET /api/pending`:

```json
{
	"pending": [
		{
			"id": 1,
			"email": "volunteer@example.com",
			"name": "Jane Smith",
			"phone": "555-1234",
			"comment": null,
			"in_slack": false,
			"status": "uncontacted",
			"lastEditedById": null,
			"lastEditedByName": null
		}
	],
	"total_requested": 5,
	"total_pending": 4
}
```

- `in_slack` is `true` when the volunteer's email matches an active member in the Slack workspace.
- `status` is one of `uncontacted`, `contacted`, or `verified_in_slack`. Rows with `verified_in_slack` are excluded from `total_pending`.
- `lastEditedByName` / `lastEditedById` record which admin last updated the row.

Admins can add a comment or change a row's status directly on the page. Changes are saved automatically and pushed live to all connected admins via Server-Sent Events (`GET /api/events`).

### `POST /api/comment`

Saves a comment for a request. Admin-only (`403` for a signed-in non-admin). Passing a blank string clears the comment.

```json
{ "id": 1, "comment": "Left a voicemail, waiting to hear back." }
```

### `POST /api/helped`

Updates the status of a request. Admin-only (`403` for a signed-in non-admin). `status` must be one of `uncontacted`, `contacted`, or `verified_in_slack`.

```json
{ "id": 1, "status": "verified_in_slack" }
```

### `GET /`, `GET /dashboard/solidarity`, `GET /dashboard/slack`

Signup-trend dashboard. The whole site (and any future route) is gated by a root layout guard that redirects unauthenticated visitors to `/auth/slack`; any workspace member who completes OAuth can view the dashboard (no admin gate). `/pending` keeps its own admin allowlist check (DB-backed with `SLACK_ALLOWED_USER_IDS` fallback, plus the `SLACK_SUPERUSER_ID` escape hatch).

- `/` renders two non-interactive overview cards (Solidarity, Slack) showing daily totals.
- `/dashboard/solidarity` and `/dashboard/slack` render stacked-by-chapter bars with the top 10 chapters named and the rest rolled into an "Other" band. The Slack page also overlays a per-day distinct-user total marker (a member who joined multiple chapters in one day is counted in each band but only once in the daily total).
- Range preset (7/30/90 days) lives in `?days=` so reloads and shared links preserve the selection. Invalid or out-of-range values snap to the nearest preset.
- Each card has a visually-hidden `<table>` with the same data so screen readers can read out per-day values.

### `GET /api/dashboard/signups`

The same data the dashboard pages render, as JSON. Requires an active session (no admin gate).

| Parameter | Required | Description                                             |
| --------- | -------- | ------------------------------------------------------- |
| `days`    | No       | Window size in days. Defaults to 90; clamped to 1..365. |

```jsonc
{
	"solidarity": [
		{
			"date": "2026-05-09",
			"total": 14, // sum of byChapter
			"byChapter": [
				{ "chapterId": 123, "chapterName": "Washtenaw County", "count": 9 },
				{ "chapterId": null, "chapterName": null, "count": 5 },
			],
		},
	],
	"slack": [
		{
			"date": "2026-05-09",
			"total": 11, // distinct users that day (not sum of byChapter)
			"byChapter": [
				{ "chapterId": 123, "chapterName": "Washtenaw County", "count": 7 },
				{ "chapterId": 456, "chapterName": "Wayne County", "count": 4 },
			],
		},
	],
}
```

`chapterId: null` represents the "No chapter" bucket. The Slack `total` is the distinct user count for the day, so it can be less than the sum of `byChapter[*].count` when a member joined more than one chapter.

### `POST /api/internal/weekly-growth-report`

Scheduler-only. Computes the per-chapter growth leaderboard for the previous 7 days and posts the top 5 to `SLACK_GROWTH_REPORT_CHANNEL_ID`. Auth via `?key=<INTERNAL_CRON_SECRET>`.

| Parameter | Required | Description                                           |
| --------- | -------- | ----------------------------------------------------- |
| `key`     | Yes      | Must match `INTERNAL_CRON_SECRET`                     |
| `dry_run` | No       | When `1`, returns the result without posting to Slack |

Returns the full leaderboard (window, totals, top chapters, whether the message was posted). The ranking score is `newJoins / (existing + 1) ^ SLACK_GROWTH_REPORT_RANKING_ALPHA`. Chapters listed in `REPORT_EXCLUDED_CHAPTER_IDS` are skipped.

### `POST /api/internal/solidarity-snapshot`

Scheduler-only. Writes today's per-chapter Solidarity signup counts into `solidarity_daily_snapshots`. The dashboard's Solidarity chart reads from this table, so this should run once per day (e.g. via GitHub Actions). Auth via `?key=<INTERNAL_CRON_SECRET>`.

### `POST /api/internal/slack-invite-audit`

Scheduler-only, hourly. Finds every Slack invite link published anywhere in Solidarity, checks each one still admits the public, and posts a report to the member-note channel (`slackMemberNoteChannelId` in `/settings`) **when there is something to say** — broken links, links it could not check, or a change since the last run. A clean run posts nothing; an hourly "all clear" would only teach the channel to ignore the audit. The response body still carries the full report either way, and `posted` says whether it went to Slack.

| Parameter | Required | Description                                                     |
| --------- | -------- | --------------------------------------------------------------- |
| `key`     | Yes      | Must match `INTERNAL_CRON_SECRET`                               |
| `dry_run` | No       | When `1`, returns the report without posting or writing the log |

A stale invite is invisible from inside the workspace: the page still loads and the button still looks right, but the volunteer who clicks it is bounced to a signup form demanding an email address on the workspace's own domain, and they aren't in the Slack to complain. Hence the routine check.

**Where it looks.** Page content, the post-submit redirect URL, the follow-up email, and the follow-up text. Two things about discovery are worth knowing before changing this code:

- `/v1/pages` returns no body at all for `ActionPage::PageBuilder` and `ActionPage::BlogPost` — `description` and `form` are both `null`, and the detail endpoint returns the same stub. A link in a PageBuilder button is **invisible** to an API-only scan. Those pages (~73 of ~1,442) are fetched as rendered HTML instead, paced at 1/sec because the public site rate-limits readily.
- There is no incremental mode, deliberately. Solidarity exposes no `updated_at` on a page and its public pages send `cache-control: no-cache` with no `ETag`, so "only scan what changed" is not answerable — and a PageBuilder page's API record is byte-identical whether or not someone edited the button inside it. A full sweep takes ~100s.

**How a link is judged.** Requests go out with a current Chrome `User-Agent`, which is load-bearing: Slack serves an "your browser is not supported" wall to anything it reads as an old browser (Chrome 131 is walled, 140+ is served), and that wall is byte-identical for valid, stale and entirely fabricated tokens. If Slack raises its floor past the pinned UA the audit reports `unknown` rather than declaring every link dead — bump `BROWSER_UA` in `slack-invite-audit.ts` when that happens.

| Outcome   | Signal                                                      |
| --------- | ----------------------------------------------------------- |
| `valid`   | `200` and the real invite page                              |
| `broken`  | `302` → `/signup#/domain-signup`, or `200` "Create Account" |
| `unknown` | Browser wall, network error, or an unexpected status        |

Stale and expired links are indistinguishable — both redirect to the domain-restricted signup — and both are equally broken for a volunteer, so they share one verdict. Classification runs once per _distinct_ URL, not once per page.

**The log.** Every sighting is upserted into `slack_invite_sightings`, keyed by (page, location, link), carrying `firstSeenAt`, `lastSeenAt`, `previousStatus` and `statusChangedAt`. Because the audit is stateless, this table is the only record of when a link appeared on a page or when it went bad, and it lets the report lead with what changed since the last run. Rows are kept after a link is removed from a page — deleting them would erase the history of the fix.

### `POST /api/internal/van-sync`

Scheduler-only — every 30 minutes during waking hours, hourly overnight. Pulls the VAN turf catalog into `van_turfs` so the turf page has something to show, and does the ledger housekeeping described below. Auth via `?key=<INTERNAL_CRON_SECRET>`.

**The overnight runs exist for the expiry warnings, not the catalog.** A warning only reaches a volunteer if a run happens inside the six hours before their claim lapses, so no two runs may sit more than six hours apart — the schedule previously stopped at 03:07 and resumed at 11:07 UTC, and every claim expiring in the two hours from 09:08 was swept without its holder ever being told. Hourly overnight leaves five hours of slack, so several missed runs still warn in time. Trimming those ticks as idle would silently reopen the hole.

For each chapter mapped under **Settings → Chapter → VAN folders**, it reads `GET /folders/{id}/mapRegions`, matches each Map Route to its MiniVAN printed-list number, and upserts a row per route. Runs take a `sync_locks` lock and are idempotent — an overlapping or delayed run is a no-op, so a skipped cron is harmless.

Whatever time is left in the request budget after the catalog then goes to draining `van_geometry_queue` — one VAN export job per turf, reduced to a hull (`src/lib/server/van/geometry-worker.ts`). `POST /api/internal/van-export-callback` is the same drain, woken by VAN when a job finishes; it takes the **same** lock under the same name, because the queue has no per-row claim and two drainers racing would submit duplicate export jobs for the same turf.

**The chapter → folder mapping is an input, not something the sync discovers.** A chapter with no folder mapped has no turf, and the first sync is a no-op until an admin fills it in. Run `npm run van:check` to list the folder ids the key can see.

**Retirement is scoped to folders that actually synced.** A folder that errors — a 403 on an ungranted tier, a VAN outage — is skipped, and its turf is left exactly as it was. Retiring turf the sync merely failed to look at would release live checkouts under volunteers already standing on the doorstep. When a route genuinely disappears it is stamped `retiredAt` (never deleted, so a live checkout still renders) and any active claim on it is released with `releaseReason = 'retired'`.

#### Ledger housekeeping: expiry sweep and warning DMs

Two jobs run at the top of every tick, **before** the VAN key is even checked, because neither needs VAN and a key rotated badly on a Friday must not stop volunteers being looked after for the whole weekend. A missing key still returns 500 so the workflow run goes red — it just does the housekeeping first.

1. **Expiry sweep.** Claims past their TTL are stamped `releaseReason = 'expired'`. Reads never needed this (an expired claim already reads as free), but without it the ledger cannot tell "gave the turf back" from "let it run out".
2. **Expiry warning DM**, six hours before a claim lapses. One message, once per claim: _"Your turf expires in about 4 hours"_, the turf and its door count, the deadline in campaign-local time, and both next steps — mark it done, or give it back. It closes by saying what happens if they do nothing, because a reminder that reads as a telling-off gets muted.

The sweep runs first, so nobody is warned about turf that lapsed moments ago.

**One warning per claim, ever.** `van_turf_checkouts.expiry_warned_at` is the idempotency key. This endpoint runs every half hour across the whole six-hour window, so without the stamp a volunteer would be reminded twelve times about one turf. It is written **only after the DM actually lands** — a Slack outage leaves the row unstamped and the next tick retries, rather than burning the one message that stops turf being lost quietly.

**The MiniVAN list number is deliberately not in the DM.** The recipient is the holder so it would be permissible, but the number is issued at claim time and shown on the turf page; a second place it gets sent is a second place to get wrong. The DM links to the page instead.

A volunteer whose whole TTL is shorter than six hours is warned immediately. That is intended — "expires in two hours" is true and useful, and staying silent because we could not warn early enough is how someone loses turf they meant to walk.

**Missing tiers degrade rather than fail.** `/printedLists` (Tier 2) and `/minivanExports` + `/savedLists` (Tier 3) are each optional: without them the catalog still lands, with no list-number backfill and no flagging of turf an organizer distributed by hand. This is what makes a sandbox or demo key useful before the EveryAction security review clears. Anything skipped is reported in `degraded` and posted to the tracking channel.

#### Setting up a VAN key

1. Put the credentials in Fly secrets (or `.env.local` for dev):

   ```
   VAN_APP_NAME=…      # the Application Name EveryAction issued — this is the Basic auth username
   VAN_API_KEY=…
   VAN_DATABASE_MODE=0 # 0 = My Voters, 1 = My Campaign
   ```

   There is deliberately no default for `VAN_DATABASE_MODE`. The wrong mode authenticates successfully and returns a different, mostly empty database — a failure that reads as "the campaign has no turf" rather than as a misconfiguration.

2. Verify the key and see what it can reach:

   ```bash
   npm run van:check              # probes each tier, lists folders and export job types
   npm run van:check -- --folder 1152   # dump one folder's regions and routes
   ```

   This is read-only. It never writes to VAN or to the database.

3. Map the folder ids it printed to chapters under **Settings → Chapter → VAN folders**.

4. Trigger a sync: `curl -X POST "$APP_URL/api/internal/van-sync?key=$INTERNAL_CRON_SECRET"`.

Set `VAN_EXPORT_JOB_TYPE_ID` from the `/exportJobTypes` list that `van:check` prints — pick the type that can export `VAddressLatitude` / `VAddressLongitude`. EveryAction issues these ids per developer, so the `101` in VAN's docs is an example and hardcoding it produces a 400. The catalog sync runs fine without it; only hull geometry is blocked.

### `GET /turfs`

The volunteer turf page. Any signed-in Slack member may use it, minus the block list at **Settings → Blocked from turf checkout**. The `/turfs` slash command serves the same data over Slack, through the same gates — see [The `/turfs` command](#the-turfs-command). Organizers get the live board at [`GET /turfs/organizer`](#get-turfsorganizer-admin) and the history at [`GET /turfs/activity`](#get-turfsactivity-admin).

**Blocking is announced and the volunteer is told.** A block posts a `[van]` line to the member notes channel — the same private admin channel moderation already logs to, because cutting someone off from turf is moderation, and without a trace two organizers undo each other. If the block took turf off them, the volunteer gets a DM naming it and saying not to head out; someone walking to a block that is no longer theirs is the failure this prevents. The DM does not relay the reason the admin typed: that is a note about a person written for other organizers, and repeating it turns a routine notice into an argument the DM cannot hold. A block that freed nothing sends no DM.

**Two numbers are tunable at Settings → Turf checkout**: how long a claim lasts (default 48 hours) and how many turfs one volunteer may hold at once (default 2). Both are read wherever they matter — the page's claim button, the map's viewport endpoint, the claim route that enforces them, and the copy telling a volunteer how long they've got — so the greyed-out button, the promise on it and the expiry written to the ledger cannot drift apart. Out-of-range values are refused on write and clamped again on read, so a row predating the bounds degrades to something sane rather than handing someone a claim that lapses in a minute.

Four gates, all server-side: session, block list, chapter, and a rate limit on switching chapters. The chapter filter runs in the load function _before serialising_ — shipping every chapter and filtering in the browser would make the compartment cosmetic, because the payload is the boundary. Before a chapter is chosen the page returns no turf at all.

**The MiniVAN list number is only sent for turf you currently hold.** It is the credential — it is what pulls the doors down in MiniVAN — so serialising it for every turf on the map would let anyone load any turf regardless of who holds it, making the checkout ledger advisory. It is issued by the claim response and withdrawn on release, expiry, or completion.

**Payload budget.** A 1,000-turf chapter serialises to ~800 KB, so a page load sends at most the 150 nearest turfs plus the chapter's total, and the map fetches more by viewport from `GET /api/turfs?chapter=&bbox=minLat,minLng,maxLat,maxLng`. That endpoint re-applies every gate the page load does — it returns the same data, so a weaker guard on it would just be the way around the page's guard. `?demo` pages the same way against fabricated data, so the walkthrough exercises the real request path.

A **total** is reported rather than a remainder. "Showing 150 of 1,000" keeps both halves describing the same set; "840 more" drifts the moment someone pans, because the loaded count grows while the remainder describes whichever viewport answered last.

**`?demo` renders the same page against fabricated data** (admin-only). It replaced a separate `/turfs/demo` route, which had drifted from the real page in three ways — its own copy of the layout, its own claim handling, and its own turf type. The old URL 308s to `/turfs?demo`.

The demo branch is the first thing the load function does and returns _before any database access_, so demo mode cannot read real turf even if a later gate were wrong — a structural property rather than a flag checked correctly in several places. Claim actions mutate component state and never reach the network. `DemoTurf` is now an alias of `TurfView`, so adding a field to what volunteers see breaks the fixture until it supplies one too. `?demo&view=admin` previews the organizer payload — it feeds `visibleTurfState` server-side, so the wire format genuinely differs.

**Rate limits are shared between the page and the API**, in `$lib/server/van/rate-limit-store.ts`. Two of them, doing different jobs:

| Limit             | Budget          | Covers                                                                 |
| ----------------- | --------------- | ---------------------------------------------------------------------- |
| Distinct chapters | 8 / hour / user | Sweeping chapters. Re-opening one you've already looked at is free.    |
| Turf API requests | 60 / min / user | Walking the bbox grid, and probing route ids at `POST /api/turfs/{id}` |

Both are shared deliberately: when the chapter limiter was module state inside the page load, a loop over `GET /api/turfs?chapter=` bypassed it entirely. The budget has to follow the user, not the URL. Refusals return `429` with `Retry-After`.

**Chapter views are logged only above a threshold** — 4 distinct chapters in an hour — and the one line names every chapter seen. Logging every view produced a line each time a volunteer reopened their own county, which buried the entries that meant something. Someone pacing under the threshold browses without a log line; the rate limit still caps them at eight an hour.

**Distance sorting** uses browser geolocation when granted. When it is declined or unavailable, a ZIP box resolves through the Census TIGERweb ZCTA layer — _not_ the Census geocoder, which resolves street addresses only and returns nothing for a bare ZIP — and is cached in `van_zip_centroids`. The server sorts before serialising. It is a plain GET form, so it works with JavaScript off. Every failure path returns an unsorted list rather than an error — losing distance sorting must never cost someone the turf list.

**The map is optional.** Turf with no hull and no centroid — which is all of it on a key without export-job access — is listed but not drawn. The list view is the accessible path, the data-saving path, and the one that works when the tile provider is down.

| Env var                 | Default                              | Purpose                                 |
| ----------------------- | ------------------------------------ | --------------------------------------- |
| `MAP_TILE_URL_TEMPLATE` | CARTO Positron                       | Basemap tiles, `{z}/{x}/{y}`            |
| `MAP_TILE_ATTRIBUTION`  | © OpenStreetMap contributors © CARTO | Rendered on the map; a condition of use |
| `MAP_TILE_API_KEY`      | _(none)_                             | CARTO basemaps key, appended as `?key=` |

**Move to a keyed tile account before real volunteer traffic.** The default is CARTO's keyless endpoint, which is courtesy rather than an SLA, and a canvass launch is the worst moment to discover a rate limit. With a CARTO account, `MAP_TILE_API_KEY` alone is enough — the keyed and keyless CARTO URLs are otherwise identical, so the template stays as it is. The key is appended **only** when the template points at `cartocdn.com`; a template aimed at Stadia, Protomaps or a self-hosted box gets no key rather than someone else's. Because the browser fetches the tiles, this key is public by construction — that is how CARTO's are designed, so restrict it by domain in the CARTO dashboard and never put a key here that has to stay secret. All three vars are secrets to `fly secrets set`, not a deploy. A failed tile load degrades to a graticule and a "street map unavailable" notice rather than a white void.

### `GET /turfs/organizer` (admin)

Who holds turf right now, what is about to lapse, and which completions look like a missed MiniVAN sync. The present-tense half of the organizer surface; [`/turfs/activity`](#get-turfsactivity-admin) is the history, and the two cross-link.

Same gate and same chapter dropdown as the activity page — admin-only, bare 302 for everyone else, all chapters by default. The MiniVAN list number is withheld here too: it is the credential issued to the holder, and the query never selects it.

**Out right now.** Live claims, soonest to lapse first, with who holds each, how long they have had it, and when it expires in campaign-local time. Rows inside the six-hour warning window are flagged, and a **Not reminded** badge marks the ones where the automatic DM has not gone out — those are the volunteers someone has to contact personally. The summary counts _volunteers_, not claims, so somebody holding two turfs counts once.

A claim whose TTL has passed but which the nightly sweep has not yet stamped is excluded. The database and the truth disagree between cron ticks, and the board follows the same `isActive` rule the rest of the ledger uses rather than a second definition in SQL.

**Out of step with VAN.** The drift report (Story 8.2). Our checkout ledger and VAN both believe they know where turf is — ours from who clicked Claim, VAN's from which lists an organizer bulk-exported to MiniVAN — and the two can disagree in either direction:

- **In MiniVAN, not claimed here.** Somebody already has it, but the app shows it free, so a second volunteer can claim the same blocks. This is the failure the whole feature exists to prevent, so it sorts first.
- **Claimed here, not in MiniVAN.** The holder has a list number that will load nothing until an organizer bulk-exports that turf. Costs one person a wasted morning.

Turf both sides agree on — or neither has — is not drift. Retired turf is skipped: VAN no longer has the route, so "not in MiniVAN" is trivially true, and the sync already releases those claims with `releaseReason = 'retired'`.

**The report makes no VAN call.** Both halves are columns we own: the catalog sync writes `van_distributed_to` (Story 8.1), and the ledger is ours. That leaves one trap, which `van_sync_state` exists to close — the sync writes `van_distributed_to = NULL` both when VAN reports no export and when `/minivanExports` is not granted, so the column alone cannot say which. The sync records whether that endpoint answered, and when it did not the pane says **"can't check"** rather than showing an empty list that would read as agreement.

**Completed but nothing cleared.** After a volunteer marks turf done, VAN is refreshed and the door count compared; a count that did not move means MiniVAN was never synced and the results are still on a phone. That comparison writes `confirmed_door_delta`, which **Story 5.6 fills and is still blocked on VAN API access** — so today the pane says "not checked yet" rather than "all clear". A null delta is never treated as a zero one: reporting a check that has never run as a passing one would accuse every volunteer of something nobody has looked at.

### `GET /turfs/activity` (admin)

Turf checkout history, for organizers. Every claim, completion, hand-back, expiry and forced release, newest first, grouped by campaign-local day.

Two dropdowns in one GET form: **chapter** (all, or one) and **period** (24 hours / 7 days / 30 days / all time). Both submit together, so changing one keeps the other, and the form works with JavaScript off — the `onchange` auto-submit is enhancement, not the mechanism.

**The volunteer compartment rules deliberately do not apply here.** `/turfs` refuses an all-chapters view and hides holder names, because a volunteer cannot act on either and has no reason to learn who is knocking which block. This page is the organizer side of that line: it is admin-gated, names holders, and defaults to every chapter. Non-admins and signed-out users get a bare 302 to `/`.

**Still withheld, from admins too: the MiniVAN list number.** It is the credential issued to whoever holds the turf, and an admin is not the holder. The query never selects it, so it cannot reach the payload by omission — a test asserts that on the rendered payload rather than on the template.

**Events, not rows.** A checkout claimed at 09:10 and completed at 09:30 is two things that happened and appears twice; the same row in a one-day window shows only the completion. The three involuntary endings — expired, released by a block, released because the turf was retired — are labelled separately rather than folded into "given back", so an organizer chasing a flaky volunteer isn't chasing the nightly sweep.

**Counts come from SQL, the list from a capped query**, so "Showing the most recent 500 of 1,240" is exact on both halves even though only 500 rows were fetched. Fetching 500 rows is enough for 500 events because rows are ordered by their own newest stamp and each yields at least one event.

Empty states distinguish **"no activity in this period"** from **"no turf has been loaded yet"** — with no VAN key the catalog is empty, and reading that as a quiet week would send someone looking for volunteers instead of an API key.

Nothing is written by this page, and nothing is posted to Slack: it reads `van_turf_checkouts`, which already records every event.

### `POST /api/turfs/{mapRouteId}`

Claim, release, or complete a turf, via `{"action": "claim" | "release" | "complete"}`. 401 unauthenticated, 403 blocked, 409 with a volunteer-readable reason when the rules refuse.

Two simultaneous claims resolve to exactly one winner at the storage layer, not in application code: a partial unique index on `van_turf_checkouts (map_route_id) WHERE released_at IS NULL AND completed_at IS NULL`. `canClaim` in `$lib/van/checkout.ts` is the friendly layer that refuses with a reason someone can act on.

Release and complete are scoped to the caller's own active claim, so posting someone else's route id does nothing.

**Retired turf** — a route VAN no longer returns — is excluded from the page, **except when the viewer still holds a claim on it**. `schema.ts` keeps those rows for exactly that reason: dropping them would take a volunteer's turf and its MiniVAN list number off their own page while they were out walking it. Such turf is flagged `retired` and the page warns that the list number may stop working. The catalog sync releases these claims with `releaseReason = 'retired'`, but not before its next run.

**Expired claims** are swept by `/api/internal/van-sync` before it talks to VAN, so ledger housekeeping happens whether or not the catalog fetch succeeds. Reads never needed it — `isActive` ignores a lapsed claim — but without the sweep the table can't tell "gave the turf back" from "let it run out", which is what the drift report and per-canvasser attribution read.

#### What organizers must do in VAN

The app never cuts turf — VAN's API cannot create MiniVAN exports (`/minivanExports` is GET-only). Our app publishes what already exists and owns the checkout ledger. So after every turf cut:

- **Generate the printed list.** A route with no `printedList.number` has no MiniVAN list number, so it is not claimable. The sync posts a single summary warning naming the turfs in this state.
- **Cut map regions against a "not yet contacted" filter.** This is what makes `doorCount` shrink as doors get knocked — the entire remaining-doors mechanism. A region cut without it never shrinks, and every doors-cleared number derived from it is zero.
- **Bulk-export turf to MiniVAN ahead of time**, once per cut rather than once per volunteer.

### `GET /policies`

The privacy and security policies, rendered from `PRIVACY.md` and `SECURITY.md` in the
repository root — one page, two sections, anchored at `#privacy` and `#security`.
`/privacy` and `/security` are 308 redirects to those anchors, so the conventional URL
works wherever it gets pasted.

**This is the only page outside the auth guard.** A privacy policy that only signed-in
workspace members can read fails the one job it has: it is written for the volunteer
deciding whether to hand over a phone number, and it is the URL a Slack app listing has to
point at. The allowlist is `src/lib/server/public-paths.ts` — three prefixes, prefix-matched,
consulted by the root layout's load, and nothing behind them reads the session. (`/privacy`
and `/security` are endpoints rather than pages, so no layout load runs for them at all;
they are in the list as the record of what is public, not as the mechanism.)

The markdown is the source of truth and is inlined at build time by Vite's `?raw`, so the
page cannot drift from what a reviewer diffs, and the Docker image needs no `.md` files at
runtime. Rendering is `src/lib/server/policy-docs.ts`: headings are demoted one level (the
layout already owns the page's `<h1>`), heading ids are namespaced per document so the two
files cannot collide, and links between and inside the documents are rewritten to in-page
anchors. A test asserts every anchor the documents link to actually exists on the page.

### `GET /coalition-invite`

Invites an existing Slack user to a coalition channel. Useful for solidarity.tech automations that route members to interest-based channels (labor, housing, etc.) after onboarding.

| Parameter   | Required | Description                                                     |
| ----------- | -------- | --------------------------------------------------------------- |
| `secret`    | Yes      | Must match `WEBHOOK_SECRET`                                     |
| `email`     | Yes      | Email of an existing Slack workspace member                     |
| `coalition` | Yes      | A coalition group name mapped on `/settings` (case-insensitive) |

Returns `{ "success": true }` on a successful invite, `{ "success": true, "already_in_channel": true }` if the user was already in the channel, `404` if no Slack user matches the email, `400` for unknown coalitions or invalid input, and `502` if Slack rejects the invite.

### `GET /api/events`

Server-Sent Events stream. Admin-only: unauthenticated requests are redirected to sign in and
non-admins get `403`. The payload carries volunteers' names, emails and phone numbers, so it is
gated exactly as `/pending` is. Pushes three event types:

| `type`        | Payload                  | Meaning                            |
| ------------- | ------------------------ | ---------------------------------- |
| `new-request` | `id, email, name, phone` | A new volunteer record was created |
| `status`      | `id, status, editedBy`   | A row's status changed             |
| `comment`     | `id, comment, editedBy`  | A row's comment changed            |

### `GET /auth/slack`

Starts the Slack OAuth login flow. Redirected to automatically when visiting `/pending` without a session.

### `POST /auth/logout`

Destroys the current session.

### `GET /health`

Returns `{ "status": "ok" }`. Useful for uptime monitoring.

## Deployment

[Fly.io](https://fly.io) is the recommended hosting option. Install the CLI, run `fly launch` in the project directory, then set secrets and deploy:

### Tools for Abdul production domain

The Tools for Abdul deployment uses `https://slack.tools4abdul.com`. Attach the hostname to the existing Fly app and follow the DNS instructions printed by Fly:

```bash
fly certs add slack.tools4abdul.com -a slack-solidarity-helper-tools
fly certs check slack.tools4abdul.com -a slack-solidarity-helper-tools
```

Once the certificate is ready, make the custom hostname canonical for application-generated links and SvelteKit origin handling:

```bash
fly secrets set \
  APP_URL=https://slack.tools4abdul.com \
  ORIGIN=https://slack.tools4abdul.com \
  -a slack-solidarity-helper-tools
```

Before changing those secrets, add `https://slack.tools4abdul.com/auth/slack/callback` to the Slack app's OAuth redirect URLs. Then update its Event Subscriptions, Slash Commands, and Interactivity URLs to use the same hostname. The scheduled GitHub Actions in this repository already call the custom hostname.

### New deployments

```bash
fly secrets set \
  SLACK_BOT_TOKEN=xoxb-... \
  SLACK_CLIENT_ID=... \
  SLACK_CLIENT_SECRET=... \
  SLACK_SIGNING_SECRET=... \
  SLACK_ALLOWED_USER_IDS=U012AB3CD \
  SLACK_TRACKING_CHANNEL_ID=C012AB3CD \
  SLACK_GROWTH_REPORT_CHANNEL_ID=C012AB3CD \
  REPORT_EXCLUDED_CHAPTER_IDS=1008 \
  TURSO_DATABASE_URL=libsql://your-db.turso.io \
  TURSO_AUTH_TOKEN=... \
  WEBHOOK_SECRET=... \
  INTERNAL_CRON_SECRET=$(openssl rand -hex 32) \
  APP_URL=https://your-app.fly.dev \
  ORIGIN=https://your-app.fly.dev \
  SOLIDARITY_API_TOKEN=... \
  'SOLIDARITY_CHAPTER_CHANNEL_MAP=[{"chapterId":123,"channelId":"C012AB3CD","name":"Washtenaw County"}]'

fly deploy
```

Then point a scheduler at:

- `POST https://your-app.fly.dev/api/internal/solidarity-snapshot?key=$INTERNAL_CRON_SECRET` — daily
- `POST https://your-app.fly.dev/api/internal/weekly-growth-report?key=$INTERNAL_CRON_SECRET` — weekly

`ORIGIN` is required by SvelteKit's adapter-node for CSRF protection — it must match the public URL of your app. Set it to the same value as `APP_URL`.

Use the resulting URL as:

- The webhook endpoint in solidarity.tech: `https://your-app.fly.dev/webhook?secret=...&email=...&name=...&phone=...`
- The redirect URL in your Slack App: `https://your-app.fly.dev/auth/slack/callback`
- The Events API Request URL in your Slack App: `https://your-app.fly.dev/api/slack/events`
