# Hermes agent

The process that does the data work: reads a messy workbook, profiles it, says
what should be fixed and why, applies what a human approved, answers questions
about the result and writes the month-end report.

It runs on its own host — a Hostinger VPS in the deployment documented below —
and it is designed to sit there for months without attention.

```
  Dashboard (Next.js)            Supabase                   Hermes (this)
  ───────────────────            ────────                   ─────────────
  "Analyse this file"  ──────▶  agent_jobs  ◀───── claims ──── worker loop
                                     │                             │
  polls for status     ◀─────────────┤                        parse / profile
                                     │                        propose / clean
  review queue         ◀──── proposed_changes ◀── writes ─────  query / report
```

## Why a queue instead of an API

The dashboard never calls the agent. It writes a row; the agent picks it up.
Four things follow from that, and each one is a problem that does not need
solving later:

- **The VPS needs no inbound port and no domain.** The agent dials out to
  Supabase over HTTPS and nothing dials in. Close everything except SSH.
- **A restart loses nothing.** Kill the box mid-parse and the job's lease
  expires; the next worker to poll picks it up with the attempt count already
  incremented.
- **Nothing times out.** Parsing a 50 MB workbook takes minutes. A request
  handler cannot wait that long; a status column can.
- **The tenant boundary reaches the agent.** Every job carries `org_id` and
  `workspace_id`, checked by the database before the row exists.

## What it can do

| Job | What happens |
|---|---|
| `parse_workbook` | Finds the real table in a messy sheet — header row, table bounds, subtotal and footnote rows — infers types, writes Parquet, opens a dataset version |
| `profile_dataset` | Column statistics plus the accounting checks: duplicates, name variants, VAT rates, declared-total reconciliation, date coverage |
| `propose_cleaning` | Turns the profile into grouped, materiality-ranked, explained proposals |
| `apply_cleaning` | Applies what a human approved, into a **new** version — nothing is ever overwritten |
| `query_dataset` | A question in English or a structured query → validated SQL → an answer with the source rows behind it |
| `reconcile_sources` | Two versions matched on a key: matched, matched-with-a-difference, unmatched either side |
| `generate_report` | A month-end report in the `exports` bucket, as Markdown, PDF, Word or Excel, branded from the organisation's own identity |
| `replay_recipe` | Runs a learned recipe against a new month's file, writes a new version, and produces the recipe's configured report |

`parse_workbook` chains the next two itself, so "Analyse" in the dashboard is
one click and three visible stages.

### Report formats

`generate_report` takes `format` on the payload — `md` (the default), `pdf`,
`docx` or `xlsx` — or `formats` for several at once, which is what a recipe's
deliverable sends. Where more than one is asked for, each is rendered
independently: one failing marks that format failed and the others are still
stored, because a pack that arrives as a PDF without its workbook is better than
one that does not arrive.

### Whose name is on it

Nothing has to send a name any more. `_resolve_branding` walks the order in
`tools/branding.py` — an explicit payload override, then `organization_branding`,
then the organisation, then the workspace, then a stated fallback — and the
logo is resolved the same way: the organisation's stored object, then an
approved image discovered inside an upload, then an administrator's https URL,
then none. "None" is an ordinary outcome: the header becomes the business name
set in the brand colour, never an empty box.

The accent is one hex colour; the deep tone, the tint behind a figure card and
whether the band carries white or near-black text are derived from it. An
unusable value falls back to the product's own blue and records a warning rather
than failing the job, and so does a logo that will not download or decode.

A remote logo URL is a request this server makes on a user's behalf, so it is
checked before a socket opens: https only, no credentials, and every address the
host resolves to must be public — a hostname answering `10.0.0.5` is refused
exactly like `localhost` is. Redirects are not followed, because a redirect is a
second URL the check never saw.

### Images inside an upload

`parse_workbook` also reads the pictures out of an .xlsx, .docx or .pptx and
records them as *candidates* with a score and the sentences behind it. It never
promotes one: a month-end workbook holds a logo, a product photograph, a chart
and sometimes a signature, and a person picks on the branding screen. Discovery
failing costs the suggestion and never the upload.

What the report *says* is built once, as typed blocks, in `tools/report.py`.
The four renderings live beside it: Markdown there, and PDF, Word and Excel in
`tools/documents.py`. Adding a figure to the report means adding it in one
place, and the reconciliation warning cannot go missing from one format and not
another.

Markdown stays the default because it is the copy that goes into the working
papers, where editable and diffable beat beautiful. The other three are the
copy that goes to the client: PDF to email, Word for the partner who edits a
sentence before it goes, Excel for the client's own finance person — which is
why every figure that can be a number in that workbook is written as a number
and not as formatted text.

## Where the AI is, and where it is not

The model writes prose and translates questions. It does not compute, and it
does not decide.

- **Never sees a row.** The LLM layer accepts a `Profile` — schema, statistics,
  a handful of frequent values — and there is no code path from a table to a
  prompt. PRD section 8 asks for this as a policy; `hermes/llm/redact.py` makes
  it a structure.
- **Never emits SQL.** For a question it emits a *structured query*, which
  `analyze.compile_query` validates against the real column list before any SQL
  exists. An invented column fails loudly instead of silently returning nothing.
- **Never changes a decision.** Proposals come from the rule engine. The model
  is offered the finished proposal and asked to reword the rationale.

So with no API key configured the agent still does all of its work; the
explanations are just plainer. That is deliberate — a pilot's month-end must not
depend on an API being up.

## Deploying to a Hostinger VPS

The smallest KVM plan is enough. Everything below is copy-paste; the whole thing
takes about ten minutes.

### 1. What you need first

- A Supabase project with the migrations in `supabase/migrations/` applied
  (`supabase db push`).
- Its **Project URL** and **service-role key**, from
  *Project Settings → API* → `service_role`. This key bypasses RLS. Treat it
  like a database password: it is the reason this VPS should run nothing else.
- Optionally an OpenAI or Kimi key.

### 2. Create and secure the server

Order an Ubuntu 24.04 KVM VPS in hPanel. Then:

```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y

# A non-root user to own the agent.
adduser --disabled-password --gecos "" hermes
usermod -aG sudo hermes

# Only SSH in. The agent needs no inbound port at all.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# Unattended security updates, because nobody is going to log in for months.
apt install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
```

If Hostinger's firewall is also enabled in hPanel, leave it closed to
everything except SSH for the same reason.

### 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker hermes
```

### 4. Deploy

```bash
su - hermes
git clone https://github.com/yahyeameer/dataengine.git
cd dataengine/services/hermes

cp .env.example .env
nano .env      # SUPABASE_URL, SUPABASE_SECRET_KEY, optionally a model key

chmod 600 .env

docker compose up -d --build
docker compose logs -f
```

You are looking for:

```
INFO    hermes.worker: hermes 0.2.0 starting as hermes-srv123 on srv123 (models: openai)
```

`restart: unless-stopped` means it comes back after a reboot, a crash, or an
out-of-memory kill. There is nothing else to configure for it to run
continuously.

### 5. Confirm it from the dashboard

Open any client workspace. The strip at the top should read **Agent online**
with the hostname beside it. That indicator is derived from a heartbeat the
worker writes every thirty seconds — after ninety seconds of silence it flips to
offline, so it tells you the truth rather than what it was last told.

Upload a workbook, press **Analyse**, and watch the stages appear.

### 6. Deploying the web app beside it

The dashboard can run on the same VPS as the agent. Nothing about the two
requires it -- they share a Supabase project and no sockets -- but one host is
one bill, and the Hostinger-managed **Hermes Agent** application is already
there, which is the one thing the web app *does* need to reach directly.

Understand what changes before doing it. Step 2 closed every inbound port on the
argument that the agent needs none. That stops being true the moment a browser
has to reach this box, and the machine holding the service-role key acquires a
public attack surface it did not have. That is a real trade, not a formality.

```bash
su - hermes
cd ~/dataengine/apps/web

cp .env.docker.example .env
nano .env
chmod 600 .env
```

Four of those values you already have from step 1. The other two describe the
agent, and only the VPS can tell you them:

```bash
ssh root@YOUR_SERVER 'bash -s' < scripts/vps-preflight.sh
```

That script is read-only and prints every host-derived value this deployment
needs, in one pass: the agent's network and aliases, Traefik's network and its
entrypoint and certresolver names, the firewall state, and the core count. Each
of those fails quietly when wrong -- a mistyped entrypoint produces a router
that is created successfully and never matches a request -- so they are worth
reading together before the first deploy rather than one outage at a time.

On srv1927440 the agent half resolves to:

```
HERMES_NETWORK=hermes-agent-bwlq_default
HERMES_WEBHOOK_URL=http://172.16.0.2:8644
HERMES_WEBHOOK_SIGNING=v2
```

Three things about those three lines.

**8644, not 8642.** The agent listens on 4860, 8642 and 8644; only the first two
are published, which tells you nothing, because the web app reaches all three
over the shared network. 8644 is the Generic Webhook V2 adapter. 4860 is the
public dashboard and must not be used as a gateway.

**A base url, with no path.** The route appends `/webhooks/ask` itself. A value
that already ends in `/webhooks/ask` posts to `/webhooks/ask/webhooks/ask` and
404s every question.

**A literal container IP is not stable.** Docker reassigns it when a container
is recreated, so a Hostinger redeploy of that application can silently break
this line -- it presents as "the agent could not be reached" on every question.
`http://hermes-agent:8644`, the compose service alias, is the same address and
survives a recreate.

Create the `ask` route in Hermes and set its HMAC secret *before* deploying:
`HERMES_WEBHOOK_SECRET` is one half of a pair, and this app cannot define it
alone. Signing is Generic Webhook V2 -- `X-Webhook-Signature-V2` over a
timestamped HMAC, with `X-Webhook-Timestamp` beside it. Confirm the canonical
string the adapter signs against `canonicalV2()` in
`apps/web/src/app/api/hermes/ask/route.ts`; it is one line and deliberately so,
because a wrong canonical string produces a well-formed signature that never
verifies and presents as a bad secret. `HERMES_WEBHOOK_SIGNING=github` falls
back to the older `X-Hub-Signature-256` receiver if this gateway turns out to
predate V2.

None of this involves the Python worker in this directory. That queue is a
separate path -- upload, parse, profile, propose -- that reaches the app only
through Supabase, and it plays no part in answering a question.

`HERMES_NETWORK` is the network the Hermes Agent container is on.
`HERMES_WEBHOOK_URL` addresses it by *service* name, not container name --
`http://hermes-agent:8644`, not `http://hermes-agent-bwlq-hermes-agent-1:8644`.
Compose registers the service name as a network alias and it survives a
redeploy; the container name carries a random project suffix that does not, so
hard-coding it buys an outage the next time Hostinger recreates the app. Plain http is
correct -- the request never leaves the Docker bridge, and what authenticates it
is the HMAC in `apps/web/src/app/api/hermes/ask/route.ts`, not the transport.
`HERMES_WEBHOOK_SECRET` must be the secret that gateway verifies against; a
mismatch shows up as a 502 on every question and nothing in the app's own logs.

This VPS already runs Traefik as a second Docker Manager application, and it
owns ports 80 and 443. Do not start another proxy beside it: `apps/web` joins
Traefik's network and declares its routing as container labels, which Traefik
picks up on its own. Set `TRAEFIK_NETWORK`, `WEB_DOMAIN`, and -- if Hostinger's
template names them unconventionally -- the entrypoint and certresolver:

```bash
docker network ls | grep -i traefik
docker inspect traefik-traefik-1 -f '{{json .Config.Cmd}}'
```

Those last two names are the usual failure: a router with the wrong entrypoint
is created successfully and then never matches a request, so the app looks
deployed and answers nothing. If `docker port traefik-traefik-1` prints nothing
at all, Traefik is installed but not serving the internet on this box; in that
case open the ports yourself and start the bundled Caddy fallback instead, which
is behind a profile precisely so it cannot collide by accident:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
docker compose --profile caddy up -d
```

Either way, point an A record at the server first -- the certificate is obtained
by proving control of the name, and a domain that does not resolve yet fails
that and retries with backoff.

TLS is not optional here. Supabase's auth cookies are `Secure`, so over plain
http sign-in fails silently -- the cookie is set, the browser discards it, and
the user is returned to the login page with no error to read.

**Build the image somewhere else.** `docker compose up -d --build` on this box
runs `next build`, which pins every core for minutes at a time. Hostinger reads
sustained CPU as a possible compromise and throttles the VPS by 25% per hour --
and the throttle applies to the whole machine, so a deploy takes the agent down
with it. Build where there is CPU to spare and pull the result:

```bash
# On a laptop or CI, once per release:
docker build -t YOUR_REGISTRY/dataengine-web:$(git rev-parse --short HEAD)   --build-arg NEXT_PUBLIC_SUPABASE_URL=...   --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... apps/web
docker push YOUR_REGISTRY/dataengine-web:TAG
```

Then swap `build:` for `image:` in `apps/web/docker-compose.yml` and deploy with
`docker compose pull && docker compose up -d`, which costs the box a download
instead of a compile. If you would rather build in place anyway, do it once,
off-hours, and expect the usage graph to spike.

```bash
docker compose up -d --build     # or `pull && up -d` with a prebuilt image
docker compose logs -f web
```

Open the domain, sign in, and ask the agent a question from a workspace. The
answer does not come back over the network you just configured: the gateway
accepts in milliseconds, the agent writes into `hermes_answers`, and the browser
picks it up over Realtime. If the question is accepted and no answer ever
arrives, the fault is on the agent's side of Supabase, not in this app.

### One core is the constraint, not memory

`nproc` on srv1927440 prints **1**, against 3.8 GiB of RAM of which under 700 MB
is in use. Every sizing decision here follows from that asymmetry: memory is not
the scarce resource on this box and CPU is the only one.

What already runs there, measured at idle:

| container | CPU | RAM |
|---|---|---|
| `hermes-agent-…` (Hostinger's) | 0.42% | 642 MiB |
| `traefik-traefik-1` | 0.00% | 48 MiB |

Idle is not the problem. One core means any single process that wants real work
gets the whole machine, and sustained is exactly what Hostinger throttles. Two
consequences worth stating plainly:

**`next build` on this box is a real cost, and sometimes the right one.** It
runs in the daemon, outside every container limit in these compose files, and on
one core it is several minutes of unbroken 100%. The throttle applies to the
whole VPS, so a build can take the agent down with it.

Shipping a prebuilt image (`docker save | ssh | docker load`) avoids that
entirely and is what a rebuild-often workflow should use.

But building in place needs no second machine and no registry, and one build is
minutes rather than hours -- so for a first deploy, or a demo, it is a
defensible trade made knowingly. If you take it: build once rather than
iterating, prefer a quiet hour, and remember hPanel's **Remove Limitations**
resets a throttle once a week. What is not defensible is rebuilding on every
small change and wondering why the box is slow.

**The parse worker and the web app together are a stretch.** Serving pages is
not CPU-bound and fits fine. Parsing workbooks with polars and duckdb is CPU-
bound by definition, and the caps here (`HERMES_CPUS` 0.35, `WEB_CPUS` 0.4) keep
it survivable rather than comfortable -- a large workbook will simply take
longer. If both need to run and jobs start queueing, the answer is a second
vCPU, not a higher cap: raising a cap on a single core moves the contention, it
does not remove it.

### Keeping the box off the throttle

Three containers now share one small VPS, and Hostinger throttles the host --
not the offender -- when sustained CPU looks like a compromise. `top` is the
wrong first tool on a Docker host: it shows the processes without saying which
container owns them. Start here instead:

```bash
docker stats --no-stream       # per-container CPU and memory, attributed
nproc                          # how many cores there actually are
```

If CPU reads normal *now* but the dashboard reported a limit, the cause was
episodic -- a build, or a workbook parse -- and no live command will show it.
Use **Backups & Monitoring → Server Usage** for the history and match the spike
against `docker compose logs --since`.

Both compose files cap CPU (`HERMES_CPUS`, `WEB_CPUS`, defaulting to half a core
each). The worker's cap matters most: polars, duckdb and pyarrow size their
thread pools from the host's core count and ignore the container's quota, so
without it one parse fans out across every core until it finishes. Raise the
caps if `nproc` says there is room; do not remove them.

Two things a cap will not fix, because neither runs inside these limits: an
image build, which runs in the daemon, and the Hermes Agent application, which
Hostinger manages and this repository does not configure.

### Running it without Docker

A 1 GB plan spends a noticeable slice of its memory on the Docker daemon. To
skip it:

```bash
sudo apt install -y python3.12-venv
sudo mkdir -p /opt/dataengine /etc/dataengine /var/lib/dataengine
sudo chown -R hermes:hermes /opt/dataengine /var/lib/dataengine

su - hermes
cd /opt/dataengine
git clone https://github.com/yahyeameer/dataengine.git repo
cp -r repo/services/hermes/hermes repo/services/hermes/requirements.txt /opt/dataengine/
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
exit

# Secrets in a root-owned file, not in the unit -- units are world-readable.
sudo cp /opt/dataengine/repo/services/hermes/.env.example /etc/dataengine/hermes.env
sudo nano /etc/dataengine/hermes.env
sudo chmod 600 /etc/dataengine/hermes.env
sudo chown root:hermes /etc/dataengine/hermes.env

sudo cp /opt/dataengine/repo/services/hermes/deploy/hermes.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes
journalctl -u hermes -f
```

### Day-to-day

| | Docker | systemd |
|---|---|---|
| Logs | `docker compose logs -f` | `journalctl -u hermes -f` |
| Restart after editing config | `docker compose restart` | `sudo systemctl restart hermes` |
| Update to a new version | `git pull && docker compose up -d --build` | `git -C repo pull && cp -r repo/services/hermes/hermes . && sudo systemctl restart hermes` |
| Stop | `docker compose down` | `sudo systemctl stop hermes` |

Both stop gracefully: the worker finishes the job in its hands before exiting,
so a deploy in the middle of month-end does not throw away a running parse.

### Running more than one

Start a second host with a different `HERMES_WORKER_ID` and nothing else
changes. `claim_agent_job` uses `for update skip locked`, so workers step over
each other's rows rather than colliding, and they need no knowledge of one
another. Worth doing when several firms close their books on the same day; a
single worker is otherwise ample.

## Troubleshooting

**The dashboard says the agent is offline.**
`docker compose logs --tail 50`. Nearly always a wrong `SUPABASE_URL` or an
expired key — the worker logs the exact HTTP status it got back. Jobs queued in
the meantime are not lost; they run when it reconnects.

**A job says a .xls file could not be read.**
`.xls` is supported (xlrd reads the legacy binary format). This message means
that *particular* file could not be opened -- almost always because it is
password-protected, or because it is really an .xlsx or an HTML table that was
given an .xls extension by whatever exported it. Opening and re-saving it as
`.xlsx` resolves both.

**A job keeps retrying.**
Only transient failures retry. Something that fails three times is usually
storage or the network; the error text on the job says which. Anything the agent
can state as a conclusion — an unsupported file, an unresolved blocker — fails
once and stops.

**The agent runs but proposals read tersely.**
No model key is configured, so the rule engine is writing the explanations. The
findings and the figures are identical either way.

**Out of memory on a 1 GB plan.**
A workbook is held in memory while it is parsed. Either add a swap file
(`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`,
then add it to `/etc/fstab`) or move to the 2 GB plan.

## Development

```bash
cd services/hermes
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # .venv/bin/pip on Linux/macOS
.venv/Scripts/python -m hermes
```

With the local Supabase stack running (`npm run db:start` at the repository
root) the agent reads its credentials from `apps/web/.env.local` automatically,
so there is nothing to configure and nothing to keep in sync.

```bash
.venv/Scripts/python -m pytest        # tools, against the messy fixture
npm run test:agent                    # tenancy and queue protocol, from the root
```

## Layout

```
hermes/
  config.py        environment, validated loudly at startup
  supabase.py      PostgREST + Storage over httpx
  worker.py        the 24/7 loop: heartbeat, claim, run, report
  jobs.py          one handler per job kind -- the only place tools meet the database
  tools/
    values.py      accounting-aware coercion: (150.00), £1,240, DD/MM vs MM/DD
    parse.py       messy workbook structure detection
    profile.py     statistics and the accounting checks
    propose.py     the deviation engine: grouped, ranked, explained
    clean.py       pure operations over a dataset version, plus Parquet output
    analyze.py     DuckDB. Structured queries only, never model-authored SQL
    report.py      month-end Markdown
  llm/
    redact.py      the boundary: a Profile goes out, never a row
    router.py      OpenAI / Kimi, interchangeable, always with a fallback
```

A tool never talks to Supabase. A handler never implements a transformation.
That split is what lets the tools be tested against a fixture with no database
at all.
