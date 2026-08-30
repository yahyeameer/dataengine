# Hermes skills for DataEngine

The repository is the source of truth for skills that describe how to work on
DataEngine. The Hermes agent reads them from its own home, so a copy is
installed there — the copy is a deployment artefact, this directory is not.

## Which profile gets it, and why

`dataengine-evolution` is installed to the **default** profile only:

```bash
scp .hermes/skills/dataengine-evolution/SKILL.md root@srv1927440:/tmp/SKILL.md
ssh root@srv1927440 '
  C=hermes-agent-bwlq-hermes-agent-1
  docker exec $C mkdir -p /opt/data/skills/dataengine-evolution
  docker cp /tmp/SKILL.md $C:/opt/data/skills/dataengine-evolution/SKILL.md
  rm -f /tmp/SKILL.md'
```

`default` is the profile a human talks to, and therefore the one that does
engineering work on this system.

It is deliberately **not** installed into `dataengine-supervisor`, `-analyst` or
`-reporter`. Those profiles exist to reason about a customer's spreadsheet, and
each carries its own skills directory under
`/opt/data/profiles/<name>/skills`. Adding an engineering skill there would put
bytes into the prompt of every customer job, for guidance the supervisor must
never act on — it has no business changing production mid-`propose_cleaning`.

## Verifying it actually loaded

`hermes skills list` reports a skill as `enabled` when it is merely discovered.
That is not proof it reached the prompt, and the two are different directories.
Measure the index instead:

```bash
docker exec $C hermes prompt-size --json | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["skills_index"]["bytes"])'
```

Remove the skill directory, measure again, restore it. The number must drop and
return. At the time of writing `dataengine-evolution` accounts for 113 bytes of
the default profile's 9,389-byte index.

Note that `hermes prompt-size` with no `HERMES_HOME` reports the **default**
profile. To read a named profile, set it explicitly:

```bash
HERMES_HOME=/opt/data/profiles/dataengine-supervisor hermes prompt-size --platform api_server --json
```
