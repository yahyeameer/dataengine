# Connected stores

A shop in Bakaara or a warehouse in Berbera keeps its books in one of three
places: a spreadsheet somebody maintains by hand, a QuickBooks Online company,
or an Odoo instance a local integrator set up. This feature points the agent at
whichever one it is and answers the question the owner actually asks — **did I
make money this week, and where did it go** — every day, week, month or year,
in English or Somali, without anybody uploading anything again.

The rest of this product is built for an accountant working through a client's
month end. This part is built for the shopkeeper.

## What it does

```
  the shop's own system              the agent                    the owner
  ─────────────────────              ─────────                    ─────────
  spreadsheet  ─┐
  QuickBooks   ─┼── sync_store ──▶  one ledger, versioned  ──┐
  Odoo         ─┘                    (Parquet, immutable)     │
                                                              ├─▶ store_financials
  a schedule row ──── the worker sweeps it ────────────────────┘        │
                                                                        ▼
                                                          revenue · cost of goods
                                                          gross profit · running
                                                          costs · net profit
                                                          + what changed and why
```

Two job kinds, and the split between them is the design:

- **`sync_store`** reads. It fetches a window from the connected system,
  normalises every line into one row shape, merges it with what the connection
  already knew, and writes the whole thing as an immutable dataset version. It
  holds no opinion about what the numbers mean.
- **`store_financials`** reports. It reads that version, computes the period
  figures, and renders a document. It never touches the shop's system.

Keeping them apart is what makes a failed sync produce a *visible failure*
rather than a quietly stale report, and what lets a shop re-report last month in
Somali without fetching anything again.

## Getting a report

1. **Connect the store.** *Stores* in the sidebar → *Connect a store*. Pick the
   system, name the shop, choose the report language. A spreadsheet store needs
   no credentials at all and takes about a minute.
2. **Read it once.** *Read my store now.* The first sync reaches back 90 days so
   the first report has a previous period to compare against.
3. **Put it on a schedule.** *Send me a report on a schedule* → every week, as a
   PDF. The report always covers the **last complete period** — a monthly report
   fired on the 1st reports the month that just ended, never the few hours of
   the one that just began.

## What makes it Somali, specifically

None of this is localisation applied to a British product. Each item below
changes a number or a finding, not a label.

**The week starts on Saturday.** The working week runs Saturday to Thursday and
Friday is the day of rest. A Monday-start week puts Friday in the middle of one
week and splits the actual trading week across two, so every week-on-week
comparison compares six trading days against five. `retail.WEEK_START` is where
that is fixed; a warehouse serving international customers can override it per
connection.

**Dollars and shillings, with the rate stated.** Somali wholesale, import and
most retail pricing is denominated in USD and the shilling is quoted against it,
so USD is the base and the shilling figure sits *beside* it rather than instead
of it. The rate and the date it was set travel into every report's footnote,
because a converted figure whose basis is not stated is a number nobody can
check. A currency with no configured rate is **refused**, not assumed 1:1 — a
shilling figure silently counted as dollars would overstate a month by a factor
of about 570.

**The cost categories are the ones that dominate here.** `electricity` is its
own category and not a child of "utilities", because most shops buy power from a
private generator company by the kilowatt and it is frequently the largest
controllable cost after stock. `security` is a routine monthly line, not an
exception. `remittance_fees` exists because money moves by hawala and the
transfer fee is a real cost of every supplier payment. `customs_duty` and
`municipal_tax` are separate because they are levied by different authorities on
different events, and a report that merges them cannot answer what an importer
is asking.

**Account names are matched in both languages.** A sheet whose column reads
`Kiro dukaanka` gets the same report as one that reads `Shop rent`. Somali marks
the definite article as a suffix that changes the final vowel — `koronto` becomes
`korontada` — so the keyword table holds stems rather than dictionary forms;
that detail is the difference between this working in Mogadishu and being a
translation of something that does not.

**Zakat is estimated only when it can be.** Zakat on trade is levied on *assets*
held for a lunar year — stock, cash and recoverable receivables, less short-term
debts — at 2.5%. It is not a percentage of profit, and a ledger of revenue and
expenses does not contain what it needs. So the agent refuses to produce a
figure unless the business enters those balances on the connection, and says
what is missing instead. The tempting version computes 2.5% of net profit and is
wrong in a way the reader cannot detect. Where a figure *is* produced it is
labelled an estimate for planning, to check with your own scholar.

## What the report says, in order

1. **The figures.** Sales, cost of goods sold, gross profit, running costs, net
   profit. Gross margin leads because a shopkeeper cannot do much about rent this
   month and can do something about pricing today.
2. **What changed** against the period before.
3. **What needs attention** — findings, worst first.
4. **Where the money went**, by category.
5. **The shape of trading** — the series, the weekday pattern, best sellers,
   biggest customers, biggest cost lines.
6. **What this covers**, including what could not be read.

The findings are rules with stated thresholds, not model output. Trading at a
loss; gross margin down two points or more; a cost category up 40% on a material
amount; one product or customer carrying the business; a refund rate over 5%;
more than 10% of costs uncategorised; a month with more silent days than trading
days. Each carries the figures that triggered it.

Four formats, from one document model: Markdown, PDF, Word and Excel. The
English and Somali reports are provably the same report — the arithmetic happens
once, in `retail.py`, and neither rendering path can compute.

## Where the trust boundaries are

**Transactions are not in the database.** A sync writes Parquet into the storage
bucket as an ordinary immutable `dataset_version`, exactly as an uploaded
workbook does. So a shop's daily takings stay out of the database the dashboard
queries with a user session, and a synced ledger inherits versioning, questions,
exports and the storage tenancy boundary for free.

**Credentials are in Supabase Vault, and there is no way back out.**
`store_connection_secrets` maps a connection to a Vault secret id and has *no RLS
policy at all* — absence of a policy is a deny, so an authenticated session
cannot read it. The plaintext never sits in a normal table, no route anywhere
returns a stored credential, and only `service_role` may execute the one function
that decrypts one. A credential can be replaced; it can never be retrieved.
QuickBooks rotates its refresh token on every use, and the worker writes the
replacement back through a function that will only *replace* a credential, never
create one.

**The job row is the authority on tenancy; the payload is not.**
`enqueue_agent_job` validates the job's workspace against the caller's
membership. It does not validate the payload, and the credential function runs
as the service role, which sees every tenant — so `handle_sync_store` re-checks
that the named connection belongs to the job's workspace before anything is
fetched. `test_store_jobs.py::TestTenancy` is that check under test.

**A customer-supplied URL is checked before the worker dials it.** The Odoo
address is the one input in this feature that could be pointed back at us. Plain
`http` is refused unless deliberately allowed, private, loopback and link-local
literals are refused outright, redirects are not followed, and the settings blob
is a named schema rather than a free-form record so a key nobody designed for
cannot arrive at all. A hostname that *resolves* to a private address still gets
through — defeating that needs resolution-time pinning — so this is a floor
rather than a ceiling, and it is stated here rather than implied.

**The feature is off until an operator turns it on.** `HERMES_STORE_ENABLED` on
the agent host. A worker that has not been switched on does not announce the two
kinds, so a job sits queued and visible instead of being claimed and failed once
a second. The dashboard reads the workers' announced capabilities and says "no
agent on duty reads stores yet" before anybody waits — the difference between
"not enabled" and "broken".

## Things worth knowing before you rely on it

**Each version is a complete snapshot, not a window.** A sync merges what it
fetched with what the connection already knew and writes the whole ledger. That
makes reporting one read of the latest version rather than a hunt across
several, and it is why the ledger has a line ceiling
(`HERMES_STORE_MAX_LINES`). A warehouse with years of history will reach it; the
answer today is to report on a shorter history, and the real answer is pruning
that has not been built.

**Every later sync re-reads a week.** All three sources let somebody edit last
week's invoice. New entries are merged ahead of stored ones so a correction
*replaces* the stale row rather than being dropped as a duplicate of it — that
ordering is the whole point, and reversing it would silently discard every
correction the overlap exists to catch.

**Refunds are negative revenue.** QuickBooks records a credit memo as its own
positive document and Odoo records it as a debit to an income account. Booked as
a cost, a refund overstates sales and expenses together, so margin and net profit
are both wrong in opposite directions. Both connectors fix it before a
`LedgerEntry` exists.

**Odoo is read from the posted ledger, not from orders.** `pos.order` and
`sale.order` are closer to what a shopkeeper thinks about, but they are documents
rather than postings: a draft order is not revenue and a cancelled one is not a
refund. Posted move lines are the company's own accounting truth, so this agrees
with the customer's own Odoo P&L — the only comparison they will actually make.

**QuickBooks is read from transactions, not from the P&L report.** The report API
would return the totals in one call, and its rows carry no reference back to the
transactions behind them — so tracing a figure to its source would have been
broken the day this shipped, and two shops with the same trade would produce
differently shaped reports.

**The exchange rate is one number, not a dated table.** Applied to every entry
regardless of date. A dated table is more correct and nobody in a shop will
maintain one; the basis is stated in the report instead. Correcting a wrong rate
fixes every past period, because the report re-derives base-currency figures from
the connection's current rates rather than trusting what was stored at sync time.

**Supabase Vault must be enabled** for a QuickBooks or Odoo connection. A
spreadsheet connection needs no credential and works without it. The RPC refuses
with a sentence naming the fix rather than storing a secret somewhere less safe.

## Where the code is

```
services/hermes/hermes/connectors/
  ledger.py        the one row shape, the category vocabulary, the FX table
  excel.py         three sheet shapes, English and Somali headers
  quickbooks.py    OAuth refresh, the Query API, refunds as negative revenue
  odoo.py          JSON-RPC, posted move lines, the sign flip, the SSRF floor

services/hermes/hermes/tools/
  retail.py        periods, margins, movements, findings, zakat
  somali.py        both languages, both currencies, the trading week
  store_report.py  the document, in the order it argues

services/hermes/hermes/jobs.py        handle_sync_store, handle_store_financials
supabase/migrations/*_store_*.sql     connections, secrets, runs, schedules
apps/web/src/app/app/stores/          the screen
apps/web/src/app/api/stores/          connect, settings, credentials, schedule
```

Tests: `test_retail.py` (the engine and both languages), `test_store_connectors.py`
(QuickBooks and Odoo against recorded payloads, and the address guard),
`test_store_jobs.py` (the handlers, tenancy first).

```bash
cd services/hermes && python -m pytest tests/test_retail.py tests/test_store_connectors.py tests/test_store_jobs.py
```
