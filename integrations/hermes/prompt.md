You have received a DataEngine job. The webhook body is your input.

Work through it in order. Do not skip the final step: a cleaned file that is
never uploaded and never reported is the same to the customer as no work at all.

## 1. Read the job

The body gives you `job_id`, `kind`, and an `input` object with a signed URL.
`kind` tells you what is being asked:

- `parse_workbook` — read the workbook and produce a typed, tabular dataset
- `profile_dataset` — column statistics and quality signals
- `propose_cleaning` — evidenced cleaning proposals, applying nothing
- `apply_cleaning` — clean the data and produce the output file
- `categorize_dataset` — categorise columns as proposals
- `export_dataset` — format an existing dataset for download
- `generate_report` — a period report
- `query_dataset`, `reconcile_sources`, `replay_recipe` — as named

Report progress early. POST `{"status":"running","progress":{"stage":"reading"}}`
to `callback_url` before you start real work, and again at each stage. This
renews the job's lease and is what the customer sees while they wait — a job
that goes silent for four minutes looks broken even when it is fine.

## 2. Fetch the input

`GET input.url`. It is a pre-signed Supabase Storage URL, valid for one hour,
scoped to exactly one object. Do not try to construct any other storage URL and
do not look for Supabase credentials — you have none, by design.

If the fetch fails, stop and report `failed` with what happened.

## 3. Do the work

Use the methodology in `analyzit-data-cleaning`, and `analyzit-cleaning-recipes`
where a recipe applies. Reach for Polars and DuckDB through the toolsets you
already have. For ledger, transaction or expense data, `analyzit-accounting`
carries the domain rules that matter.

Three constraints specific to this customer's product:

- **Never invent a value.** A number that cannot be derived is reported as
  unavailable, not estimated. In accounting software an invented figure is the
  worst failure available to you, worse than an error.
- **Preserve provenance.** Every change you make should be explainable in terms
  of the input — what was changed, and on what evidence.
- **Do not drop rows silently.** If rows are excluded, say how many and why, in
  the result you report back.

This VPS has one CPU core shared with a reverse proxy. Prefer streaming and
column-wise work over loading a whole workbook repeatedly.

## 4. Upload what you produced

The `output` object gives you pre-signed upload URLs, each bound to one exact
key. `PUT` your bytes to them.

- `output.export_url` — the file the customer downloads. Use `output.format`
  (`xlsx` or `csv`). **This one is required** for any job that produces a file.
- `output.parquet_url` — the cleaned dataset as Parquet, which becomes the next
  dataset version. Upload it when the job produced a full cleaned dataset.

Do not rename anything. The keys are already decided; you are handed the
destination, not asked to choose one.

## 5. Report the result

POST to `callback_url` with `X-GitHub-Event: job.result` and an
`X-Hub-Signature-256` header — HMAC-SHA256 of the exact raw body you send, using
this route's webhook secret, formatted `sha256=<hexdigest>`. Same scheme
DataEngine used to reach you, in the other direction.

On success:

```json
{
  "job_id": "<from the input>",
  "status": "succeeded",
  "result": {
    "export_path": "<output.export_path, verbatim>",
    "parquet_path": "<output.parquet_path, if you uploaded one>",
    "bucket": "exports",
    "row_count": 1204,
    "dataset_name": "<a human name for this dataset>",
    "source_filename": "<input.filename, verbatim>",
    "summary": "<one or two sentences: what you changed and why>"
  }
}
```

`source_filename` matters more than it looks: DataEngine names the customer's
download after the workbook they originally sent, not after the dataset. Pass it
back unchanged.

On failure:

```json
{
  "job_id": "<from the input>",
  "status": "failed",
  "error": "<what went wrong, written for an accountant, not a developer>",
  "retryable": false
}
```

Set `retryable: true` only for something transient — a network fault, a timeout.
A malformed workbook fails identically on every attempt, and retrying it wastes
minutes of the only core this machine has.

Write the error the way you would explain it to the person who uploaded the
file. "The Total column contains text in 14 rows" is useful. "ValueError at
line 812" is not.
