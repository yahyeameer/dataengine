"""
A Supabase stand-in backed by real PostgreSQL and a real directory.

The end-to-end suites this repository already has (`test:e2e`, `test:agent:e2e`)
drive the product over real HTTP against a local Supabase stack, which needs
Docker. That is the right test and it is the one nobody can run in a sandbox or
on a CI box without a Docker daemon — so the whole agent, the part with the
customer's money in it, had no end-to-end coverage that could run anywhere.

This closes that gap without pretending to be Supabase. Two things are
substituted and everything else is the real article:

  * **PostgREST** -- replaced by psycopg against the same database, with the
    same migrations, RPCs, triggers, constraints and RLS applied. The handler
    code is unchanged; it calls `select`/`insert`/`update`/`rpc` exactly as it
    does in production.
  * **Storage** -- replaced by a directory. Buckets are folders and objects are
    files, which is enough for Parquet round-trips and for a report to be
    written and read back.

What that leaves under test is everything that has ever broken: the SQL, the
handlers, the tools, the queue protocol, the chaining, and the agreement between
them. In particular `rpc()` resolves each function's real argument names and
types out of `pg_proc` and binds against them, so a handler that calls an RPC
with a parameter that does not exist, or with the wrong type, fails here --
which is a class of bug no unit test with a hand-written fake can catch, because
the fake agrees with whatever the caller says.

Not under test: HTTP status handling, PostgREST's own filter parsing, GoTrue,
and the storage policies (which are SQL, and are covered by `rls-smoke.ts`).
Those need the real stack, and the scripts that need it say so.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row


class LocalSupabaseError(RuntimeError):
    """Raised for the failures the real client would raise as SupabaseError."""


@dataclass
class StoredObject:
    bucket: str
    path: str
    size: int


# The PostgREST filter grammar, as far as this codebase uses it. Deliberately a
# closed list rather than a general parser: an operator the worker does not use
# should fail loudly here rather than be silently approximated, because a filter
# this harness misunderstands is a test that passes for the wrong reason.
_FILTER = re.compile(r"^(eq|neq|gt|gte|lt|lte|like|ilike|in|is|not)\.(.*)$", re.DOTALL)

_COMPARISON = {
    "eq": "=",
    "neq": "<>",
    "gt": ">",
    "gte": ">=",
    "lt": "<",
    "lte": "<=",
    "like": "like",
    "ilike": "ilike",
}


def _jsonish(value: Any) -> Any:
    """
    Coerce a psycopg value into the shape PostgREST would have sent.

    This matters more than it looks. psycopg returns `uuid.UUID`, `datetime`,
    `date` and `Decimal` objects; PostgREST returns strings and numbers, because
    it sends JSON. The handlers are written against JSON -- `_store_connection`
    compares a workspace id with `!=`, and `UUID(...) != "..."` is true for the
    same id -- so a harness that handed back native objects would fail the
    tenancy check on a connection that was perfectly in-tenant, and would pass
    tests that production fails.

    Converting here rather than at each call site is the point: the fidelity is
    a property of the transport, which is what is being substituted.
    """
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dt.datetime):
        # PostgREST renders timestamptz as ISO 8601 with an offset.
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, Decimal):
        # PostgREST sends numeric as a JSON number.
        return float(value)
    if isinstance(value, dict):
        return {key: _jsonish(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonish(item) for item in value]
    return value


def _row(row: Any) -> dict[str, Any]:
    return {key: _jsonish(value) for key, value in dict(row).items()}


class LocalSupabase:
    """Speaks the `SupabaseClient` surface the worker actually uses."""

    def __init__(self, dsn: str, storage_root: Path, *, jwt_sub: str | None = None):
        self._conn = psycopg.connect(dsn, autocommit=True, row_factory=dict_row)
        self._root = Path(storage_root)
        self._root.mkdir(parents=True, exist_ok=True)
        self._signatures: dict[str, dict[str, str]] = {}
        self._returns_set: dict[str, bool] = {}
        self.calls: list[tuple[str, str]] = []
        self._register_enums()
        self._role: tuple[str | None, str] = (None, "service_role")
        if jwt_sub:
            self.act_as(jwt_sub)

    def _register_enums(self) -> None:
        """
        Teach psycopg about this schema's enums, so their arrays load as lists.

        Without this, psycopg does not know `agent_job_kind` and hands back the
        raw Postgres array literal -- `{parse_workbook,profile_dataset,...}` --
        as one string, where PostgREST would have sent a JSON array. A test that
        then asks "how many capabilities were announced" counts characters and
        passes or fails for reasons that have nothing to do with the product.
        """
        from psycopg.types import TypeInfo

        with self._conn.cursor() as cur:
            cur.execute(
                "select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace "
                "where n.nspname = 'public' and t.typtype = 'e'"
            )
            names = [row["typname"] for row in cur.fetchall()]

        for name in names:
            info = TypeInfo.fetch(self._conn, name)
            if info is not None:
                info.register(self._conn)

    # -- session ------------------------------------------------------------

    def act_as(self, user_id: str | None, role: str = "authenticated") -> None:
        """
        Become a signed-in user for the RPCs that read `auth.uid()`.

        The worker never does this -- it holds the service role and has no user
        session at all -- so the harness uses it only where a person would be
        clicking: creating an organisation, approving a change, connecting a
        store. Keeping the two modes explicit is what stops a test from
        accidentally proving that a *user* can do something only the worker can.
        """
        with self._conn.cursor() as cur:
            # Back to the owner first: a `set role` cannot be escaped from the
            # role it switched into.
            cur.execute("reset role")
            if user_id:
                cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id,))
            else:
                cur.execute("select set_config('request.jwt.claim.sub', '', false)")
            cur.execute("select set_config('request.jwt.claim.role', %s, false)", (role,))
            # And actually *become* the role, which is what makes a privilege or
            # RLS assertion in this harness mean anything. Setting only the JWT
            # claim while staying superuser would let every check pass for the
            # wrong reason -- a harness that proves a browser session cannot
            # read a credential table has to be denied by Postgres, not by
            # politeness.
            if role in ("authenticated", "anon", "service_role"):
                cur.execute(f"set role {role}")
        self._role = (user_id, role)

    @contextmanager
    def as_user(self, user_id: str):
        """
        A browser session: the `authenticated` role, RLS on, SELECT only.

        Used for exactly what a person does — sign up, create a workspace,
        approve a change, connect a store — all of which go through
        SECURITY DEFINER RPCs because `authenticated` has no write privilege on
        any table. That is the product's design, and a harness that wrote rows
        directly here would be proving something the real app cannot do.
        """
        previous = self._role
        self.act_as(user_id, "authenticated")
        try:
            yield self
        finally:
            self.act_as(*previous)

    @contextmanager
    def as_server(self):
        """
        What a Next.js route does when it holds the service key, and what the
        worker does always: `service_role`, which bypasses RLS and may write.
        """
        previous = self._role
        self.act_as(None, "service_role")
        try:
            yield self
        finally:
            self.act_as(*previous)

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "LocalSupabase":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # -- tables -------------------------------------------------------------

    def _where(self, filters: dict[str, str] | None) -> tuple[str, list[Any]]:
        if not filters:
            return "", []

        clauses: list[str] = []
        params: list[Any] = []

        for column, expression in filters.items():
            match = _FILTER.match(str(expression))
            if not match:
                raise LocalSupabaseError(
                    f"filter {expression!r} on {column!r} is not a form this harness "
                    f"understands. Add it here rather than working around it."
                )
            op, value = match.group(1), match.group(2)
            quoted = f'"{column}"'

            if op == "in":
                items = [v.strip() for v in value.strip("()").split(",") if v.strip()]
                if not items:
                    clauses.append("false")
                    continue
                clauses.append(f"{quoted} = any(%s)")
                params.append(items)
            elif op == "is":
                if value.lower() != "null":
                    raise LocalSupabaseError(f"'is.{value}' is not supported")
                clauses.append(f"{quoted} is null")
            elif op == "not":
                if value.lower() != "is.null":
                    raise LocalSupabaseError(f"'not.{value}' is not supported")
                clauses.append(f"{quoted} is not null")
            else:
                clauses.append(f"{quoted} {_COMPARISON[op]} %s")
                params.append(value)

        return " where " + " and ".join(clauses), params

    def select(
        self,
        table: str,
        columns: str = "*",
        filters: dict[str, str] | None = None,
        order: str | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        self.calls.append(("select", table))

        if columns.strip() == "*":
            projection = "*"
        else:
            names = [c.strip() for c in columns.split(",") if c.strip()]
            for name in names:
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    raise LocalSupabaseError(f"column list {columns!r} is not plain names")
            projection = ", ".join(f'"{name}"' for name in names)

        sql = f'select {projection} from "{table}"'
        where, params = self._where(filters)
        sql += where

        if order:
            clauses = []
            for item in order.split(","):
                parts = item.strip().split(".")
                name = parts[0]
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                    raise LocalSupabaseError(f"order {order!r} is not a plain column")
                direction = "desc" if len(parts) > 1 and parts[1] == "desc" else "asc"
                # PostgREST puts nulls last by default on ascending order.
                clauses.append(f'"{name}" {direction} nulls last')
            sql += " order by " + ", ".join(clauses)

        if limit is not None:
            sql += f" limit {int(limit)}"

        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            return [_row(row) for row in cur.fetchall()]

    def insert(
        self, table: str, rows: dict[str, Any] | list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        self.calls.append(("insert", table))
        payload = rows if isinstance(rows, list) else [rows]
        if not payload:
            return []

        names = list(payload[0].keys())
        placeholders = ", ".join(["%s"] * len(names))
        columns = ", ".join(f'"{name}"' for name in names)
        sql = f'insert into "{table}" ({columns}) values ({placeholders}) returning *'

        out: list[dict[str, Any]] = []
        with self._conn.cursor() as cur:
            for row in payload:
                cur.execute(sql, [self._adapt(row.get(name)) for name in names])
                fetched = cur.fetchone()
                if fetched:
                    out.append(_row(fetched))
        return out

    def update(
        self, table: str, filters: dict[str, str], values: dict[str, Any]
    ) -> list[dict[str, Any]]:
        self.calls.append(("update", table))
        assignments = ", ".join(f'"{name}" = %s' for name in values)
        params = [self._adapt(value) for value in values.values()]
        where, where_params = self._where(filters)
        sql = f'update "{table}" set {assignments}{where} returning *'
        with self._conn.cursor() as cur:
            cur.execute(sql, params + where_params)
            return [_row(row) for row in cur.fetchall()]

    @staticmethod
    def _adapt(value: Any) -> Any:
        """dicts and lists-of-dicts are jsonb columns; everything else passes."""
        if isinstance(value, dict):
            return json.dumps(value, default=str)
        if isinstance(value, list) and value and isinstance(value[0], dict):
            return json.dumps(value, default=str)
        return value

    # -- RPC ----------------------------------------------------------------

    def _signature(self, function: str) -> dict[str, str]:
        """
        A function's real argument names and declared types, from the catalogue.

        This is the part that earns the harness its keep. Binding against the
        *declared* signature means a handler that passes `p_dataset` where the
        function says `p_dataset_id`, or a jsonb where it wants text, fails here
        with the mismatch named -- whereas a hand-written fake agrees with
        whatever the caller happens to say and the disagreement is not found
        until the job runs against a real database.
        """
        if function in self._signatures:
            return self._signatures[function]

        with self._conn.cursor() as cur:
            cur.execute(
                """
                select p.oid,
                       p.proretset as returns_set,
                       coalesce(p.proargnames, '{}') as names,
                       array(
                         select format_type(t, null)
                         from unnest(p.proargtypes) as t
                       ) as types
                from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = %s
                order by p.pronargs desc
                """,
                (function,),
            )
            rows = cur.fetchall()

        if not rows:
            raise LocalSupabaseError(
                f"there is no function {function}() in this database. The worker calls it, "
                f"so either a migration is missing or the name is wrong."
            )

        row = rows[0]
        signature = {
            name: row["types"][index]
            for index, name in enumerate(row["names"] or [])
            if index < len(row["types"])
        }
        self._signatures[function] = signature
        self._returns_set[function] = bool(row["returns_set"])
        return signature

    def rpc(self, function: str, params: dict[str, Any] | None = None) -> Any:
        self.calls.append(("rpc", function))
        supplied = params or {}
        signature = self._signature(function)

        unknown = sorted(set(supplied) - set(signature))
        if unknown:
            raise LocalSupabaseError(
                f"{function}() has no parameter(s) {', '.join(unknown)}. "
                f"It takes: {', '.join(sorted(signature)) or '(none)'}."
            )

        pieces: list[str] = []
        values: dict[str, Any] = {}
        for name, value in supplied.items():
            declared = signature[name]
            if declared in ("jsonb", "json"):
                values[name] = json.dumps(value, default=str) if value is not None else None
            else:
                values[name] = value
            # Cast to the declared type so an enum, a date or a smallint arrives
            # as itself rather than as text the function has to coerce.
            pieces.append(f"{name} => %({name})s::{declared}")

        sql = f'select * from "{function}"({", ".join(pieces)})'

        with self._conn.cursor() as cur:
            cur.execute(sql, values)
            if cur.description is None:
                return None
            rows = [_row(row) for row in cur.fetchall()]

        # PostgREST's own rule, and getting it wrong is subtle enough to be worth
        # stating: a set-returning function answers with a JSON *array* however
        # many rows came back, and a scalar or composite function answers with a
        # single value or object.
        #
        # Collapsing a one-row set to an object instead cost an afternoon. The
        # worker reads `match_recipe` as `matched[0] if isinstance(matched, list)`,
        # so a dict made `recipe` None, month 2 never took the replay route, and
        # the harness reported a failure in the product's single most important
        # claim that was really a failure in the harness.
        returns_set = self._returns_set.get(function, False)

        if returns_set:
            if not rows:
                return []
            if len(rows[0]) == 1:
                return [next(iter(row.values())) for row in rows]
            return rows

        if not rows:
            return None
        if len(rows[0]) == 1:
            return next(iter(rows[0].values()))
        return rows[0]

    # -- storage ------------------------------------------------------------

    def _object(self, bucket: str, path: str) -> Path:
        target = (self._root / bucket / path).resolve()
        root = (self._root / bucket).resolve()
        # A storage key is built from ids in production, but this harness reads
        # paths the handlers compose, and a traversal here would write outside
        # the sandbox. Cheap to refuse.
        if root not in target.parents and target != root:
            raise LocalSupabaseError(f"{path!r} escapes the {bucket} bucket")
        return target

    def upload(
        self,
        bucket: str,
        path: str,
        data: bytes,
        content_type: str = "application/octet-stream",
        upsert: bool = False,
    ) -> StoredObject:
        self.calls.append(("upload", bucket))
        target = self._object(bucket, path)
        if target.exists() and not upsert:
            raise LocalSupabaseError(f"{bucket}/{path} already exists and upsert was not asked for")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return StoredObject(bucket=bucket, path=path, size=len(data))

    def download(self, bucket: str, path: str, max_bytes: int) -> bytes:
        self.calls.append(("download", bucket))
        target = self._object(bucket, path)
        if not target.exists():
            raise LocalSupabaseError(f"download of {bucket}/{path} failed: not found")
        size = target.stat().st_size
        if size > max_bytes:
            raise LocalSupabaseError(f"{bucket}/{path} exceeds the {max_bytes} byte limit")
        return target.read_bytes()

    def create_signed_download_url(self, bucket: str, path: str, expires_in: int) -> str:
        return f"file://{self._object(bucket, path)}"

    def create_signed_upload_url(self, bucket: str, path: str) -> str:
        return f"file://{self._object(bucket, path)}"


__all__ = ["LocalSupabase", "LocalSupabaseError", "StoredObject"]
