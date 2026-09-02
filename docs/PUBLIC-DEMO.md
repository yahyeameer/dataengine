# Putting the demo on a public URL, for free

The goal: a link you can send someone, that opens DataEngine over HTTPS, that
they can sign in to and use. No domain purchased, nothing new installed on the
VPS, and a path that becomes your real domain later by changing one line.

**Where it runs today.** `docker-compose.demo.yml` publishes the app on
`127.0.0.1:3100` and expects an SSH tunnel. That is correct for proving the
pipeline and useless for sending to a friend — they would need your SSH key.

**Where it is going.** The VPS already runs Traefik on ports 80 and 443 with a
Let's Encrypt resolver, and `docker-compose.yml` already carries the labels that
put the app behind it. The only missing piece is a hostname. So: get a free one,
point it at the box, and switch compose files.

Host: `srv1927440`, `191.215.42.242`.

```bash
ssh -i ~/.ssh/srv1927440 root@191.215.42.242
```

---

## Why not the other free options

| | |
|---|---|
| **Free subdomain + the Traefik that is already there** | What this document does. Stable URL, real certificate, no new moving parts, and the switch to a bought domain is one variable. |
| **Cloudflare quick tunnel** | `cloudflared tunnel --url http://localhost:3100` gives a URL in ten seconds with no account. The URL changes on every restart, and each new one has to be re-added to Supabase's redirect list before sign-in works again. Fine for showing someone something for an hour; wrong for "have a play this week". |
| **Vercel free tier** | Would host the Next app happily. The Hermes gateway it talks to listens only on the VPS's private Docker network, so this would mean publishing the gateway to the internet — more work, and it puts a service whose API key grants terminal access behind nothing but an HMAC. Not for a demo. |
| **`nip.io` / `sslip.io`** | Tempting because they need no signup: `191-215-42-242.sslip.io` already resolves. They are not on the Public Suffix List, so Let's Encrypt counts every certificate anyone anywhere issues under them against one shared weekly limit, and it is routinely exhausted. The failure is an unexplained certificate that never arrives. |

`duckdns.org` **is** on the Public Suffix List, which is the whole reason it is
the recommendation: your subdomain gets its own rate-limit budget.

---

## 1. Claim the name

1. Open <https://www.duckdns.org> and sign in with Google or GitHub.
2. Type a subdomain — `dataengine-demo` — and press **add domain**.
3. In the **current ip** box for it, put `191.215.42.242` and press **update ip**.

Your URL is now `https://dataengine-demo.duckdns.org`, once the rest of this is
done.

Check it resolves before going further. From the VPS:

```bash
dig +short dataengine-demo.duckdns.org
# must print 191.215.42.242
```

If it prints nothing, wait a minute and try again. **Do not start Traefik
routing until this answers** — the certificate challenge fails against a name
that does not resolve, and Let's Encrypt backs off for a while after a few
failures.

---

## 2. Confirm Traefik is the one serving

This box runs Hostinger's own applications. Before pointing anything at 80/443,
confirm what holds them.

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '0.0.0.0:(80|443)'
```

You want to see a Traefik container. Then read its entrypoint and resolver
names, because the values in `.env` are conventions rather than guarantees and a
wrong entrypoint gives you a router that is created and never matches anything:

```bash
docker inspect traefik-traefik-1 -f '{{json .Config.Cmd}}' | tr ',' '\n' | grep -E 'entryPoints|certificatesresolvers'
docker network ls | grep -i traefik
```

If nothing holds 80 and 443, Traefik is not serving on this box and you want the
Caddy fallback instead — see *If Traefik is not there* at the bottom.

---

## 3. Point the app at the name

On the VPS, in `/opt/dataengine/apps/web/.env`:

```bash
WEB_DOMAIN=dataengine-demo.duckdns.org
TRAEFIK_NETWORK=<the name from `docker network ls | grep traefik`>
TRAEFIK_ENTRYPOINT=websecure          # or whatever the inspect above printed
TRAEFIK_CERTRESOLVER=letsencrypt      # likewise
```

Everything else in that file is already set from the current deployment. Confirm
these four are present, because they were only ever in the demo compose file and
a variable missing here reaches the process as empty rather than as an error:

```bash
grep -E '^(HERMES_ASK_SECRET|HERMES_JOB_SECRET|HERMES_GATEWAY_PROFILE|SUPABASE_SECRET_KEY)=' .env
```

`HERMES_ASK_SECRET` is the one that matters for the assistant. Hermes keys its
HMAC secret to the route, not to the gateway, so the single shared secret is
right for the job route and wrong for `ask` — leave it unset and every question
comes back `401 Invalid signature` while everything else works.

---

## 4. Switch the front door

The demo file and the production file both want to run the `web` service. Stop
one before starting the other.

```bash
cd /opt/dataengine/apps/web
docker compose -f docker-compose.demo.yml down
docker compose pull web
docker compose up -d
docker compose logs -f web
```

Traefik picks the container up from its labels within a few seconds and asks
Let's Encrypt for a certificate on first request. The first load of the site can
take ten or twenty seconds while that happens; after that it is instant.

```bash
curl -sI https://dataengine-demo.duckdns.org | head -3
# HTTP/2 307    <- the redirect to /login. That is success.
```

---

## 5. Tell Supabase about the URL

Sign-in will fail until this is done, and the failure is a redirect back to the
login page with no message — the most confusing shape a problem can have.

In the Supabase dashboard for project `jweclsvkndyvltchnbcl`, under
**Authentication → URL Configuration**:

- **Site URL**: `https://dataengine-demo.duckdns.org`
- **Redirect URLs**: add `https://dataengine-demo.duckdns.org/**`

Keep `http://localhost:3100/**` in the list so local development still works.

---

## 6. Give your friend a way in

Sign-up is open at `/signup` — email and password, no invitation — so the
simplest thing is to send the link and let them create their own account. They
land on `/onboarding`, name a firm, and get an organisation of their own,
separate from yours with RLS between the two. That is the right demo: they see
the product, not your client data.

**Check the confirmation setting first.** In **Authentication → Sign In / Up →
Email**, if *Confirm email* is on, they cannot sign in until they click a link
Supabase emails them — and the built-in SMTP on the free tier is rate limited to
a handful of messages an hour, so a couple of people signing up at once means
the second one waits without being told why. For a demo, either turn it off, or
create their account yourself in **Authentication → Users → Add user** with
*Auto Confirm* ticked and send them the password.

If you would rather they saw *your* data, add them to your organisation instead:

```sql
-- Their user id, after they have signed up once
select id, email from auth.users order by created_at desc limit 5;

insert into organization_members (org_id, user_id, role)
values ('<your org id>', '<their user id>', 'member');
```

`member` can read and ask; it cannot create workspaces or delete an
organisation.

---

## 7. When you buy a real domain

Nothing about the deployment changes shape.

1. Add an A record for `app.yourdomain.com` → `191.215.42.242`.
2. `WEB_DOMAIN=app.yourdomain.com` in `.env`.
3. `docker compose up -d web` — Traefik re-reads the label and asks for a new
   certificate.
4. Update the two Supabase URL settings.
5. Leave the duckdns name pointed at the box for a week if anyone has bookmarked
   it, then delete it.

---

## If Traefik is not there

Only if step 2 showed nothing holding 80 and 443. Starting a second proxy while
Traefik is running takes Hostinger's own applications offline, which is why this
is behind a compose profile rather than on by default.

```bash
cd /opt/dataengine/apps/web
docker compose --profile caddy up -d
docker compose logs -f proxy
```

Caddy reads `WEB_DOMAIN` from its own environment and gets its own certificate.
Same URL, same result; one fewer thing sharing the port.

---

## Troubleshooting

**The page never loads.**
`docker compose ps` — is `web` up? `docker compose logs web --tail 50`.

**404 from Traefik.**
The router exists but nothing matched. Almost always `TRAEFIK_ENTRYPOINT` or
`TRAEFIK_NETWORK`: Traefik can only route to containers it shares a network
with, and joining the wrong one fails silently. Compose names the container
after the directory it runs from, so ask it rather than guessing:

```bash
docker inspect "$(docker compose ps -q web)" -f '{{json .NetworkSettings.Networks}}'
```

**Certificate error in the browser.**
Let's Encrypt has not issued yet, or the challenge failed. `docker logs
traefik-traefik-1 --tail 100 | grep -i acme`. The usual cause is DNS not having
propagated when the first request arrived — wait, then restart `web`.

**Sign-in bounces back to /login.**
Step 5 was skipped, or the Site URL has a trailing slash.

**Every question returns "The agent's gateway refused the request (401)".**
`HERMES_ASK_SECRET` is unset or wrong. See step 3.

**Answers are suddenly plain and short.**
Not a hosting problem. The worker has lost the agent's network and every model
call is falling back to the rule engine. See *"The explanations look worse than
they used to"* in [RUNBOOK.md](RUNBOOK.md) — it is the first item because it is
the failure this system is most likely to have.
