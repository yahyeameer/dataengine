"""
Configuration, read once at startup.

Everything the agent needs comes from the environment, because the agent runs
on a host the web app knows nothing about (a Hostinger VPS, in the deployment
this repo documents) and the two are only ever configured separately.

The validation here is deliberately loud. A worker that starts with a missing
secret and then fails every job at 03:00 is worse than one that refuses to
start at all, because the first looks like it is working.
"""

from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "0.2.0"


class ConfigError(RuntimeError):
    """Raised at startup when the environment cannot support a working agent."""


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"{name} is not set. The agent cannot reach Supabase without it; "
            f"see services/hermes/.env.example."
        )
    return value


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class LLMConfig:
    """
    Model routing (PRD section 8: "OpenAI and Kimi are interchangeable reasoning
    models routed by task, cost and quality").

    Both are optional. With neither configured the agent still runs every
    deterministic tool and still produces cleaning proposals from its rule
    engine -- it simply cannot write prose explanations. That is the right
    default for a pilot: the numbers never depended on the model anyway, so
    losing the model must not lose the product.
    """

    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4.1-mini"

    kimi_api_key: str | None = None
    kimi_base_url: str = "https://api.moonshot.ai/v1"
    kimi_model: str = "kimi-k2-0905-preview"

    # Which provider handles which class of work. "reasoning" is proposal
    # generation and anomaly explanation; "drafting" is narrative prose, where
    # the cheaper model is usually indistinguishable.
    reasoning_provider: str = "openai"
    drafting_provider: str = "openai"

    # Sent as OpenAI's `reasoning_effort` on the categorisation call only.
    #
    # "none" by default because that task is the one place where thinking is
    # both expensive and unnecessary: sorting values into buckets needs no
    # deliberation, and a thinking model spends the output ceiling reasoning
    # before it writes any JSON. Measured on Gemini 2.5 Flash over 118 of this
    # customer's values -- 5,762 output tokens with thinking, 1,514 without, for
    # the same answer. At the configured 2,000 ceiling it never finished at all:
    # 8,400 tokens of reasoning and 338 of truncated JSON.
    #
    # Set HERMES_LLM_REASONING_EFFORT to empty to stop sending it at all, for a
    # provider that rejects the parameter.
    reasoning_effort: str = "none"

    timeout_seconds: int = 90
    max_output_tokens: int = 2000

    @property
    def enabled(self) -> bool:
        return bool(self.openai_api_key or self.kimi_api_key)

    def provider_for(self, task: str) -> str | None:
        """
        The provider to use for a task class, falling back to whichever is
        actually configured. Routing preferences must not become an outage: if
        the operator set the router to Kimi but only supplied an OpenAI key,
        run on OpenAI rather than refusing.
        """
        preferred = self.reasoning_provider if task == "reasoning" else self.drafting_provider
        if preferred == "openai" and self.openai_api_key:
            return "openai"
        if preferred == "kimi" and self.kimi_api_key:
            return "kimi"
        if self.openai_api_key:
            return "openai"
        if self.kimi_api_key:
            return "kimi"
        return None


@dataclass(frozen=True)
class Config:
    supabase_url: str
    service_key: str

    worker_id: str
    hostname: str
    version: str = VERSION
    # The job kinds this worker will claim, announced on every heartbeat so the
    # dashboard can tell "no worker" from "a worker too old to do what you just
    # asked". Empty means "everything this build can execute", resolved from the
    # handler table at startup -- see Worker.__init__.
    #
    # Deliberately not a second list of kinds. The tuple that used to live here
    # fell out of step with HANDLERS twice: replay_recipe arrived with the
    # recipe work and export_dataset with the export work, and neither updated
    # it. A worker that does not announce a kind never claims it, because the
    # same list is passed to claim_agent_job as p_kinds -- so the job sits in
    # the queue behaving exactly like one waiting for a busy worker, with
    # nothing anywhere to say it will wait forever.
    #
    # Set HERMES_CAPABILITIES to a comma-separated subset to run a specialised
    # worker -- a host that only parses, say -- without shipping a build that
    # cannot do the rest.
    capabilities: tuple[str, ...] = ()

    # How long a claimed job is ours before another worker may take it. Long
    # enough to survive a slow parse, short enough that a crashed worker's jobs
    # come back within a coffee break.
    lease_seconds: int = 300
    heartbeat_seconds: int = 30
    # How often to re-read the LLM degradation view. Slow-moving condition, and
    # a warning repeated every thirty seconds is one people learn to ignore.
    health_check_seconds: int = 600
    # Where to post when the model stops running. Unset means no webhook and no
    # behaviour change -- the log and the dashboard banner still report it.
    alert_webhook_url: str = ""
    # Sleep between claim attempts when the queue is empty. Postgres LISTEN
    # would be tighter, but a 3-second poll on an idle queue is a negligible
    # cost against a job that takes minutes, and it survives connection drops
    # without any reconnection logic.
    poll_seconds: int = 3

    max_download_bytes: int = 50 * 1024 * 1024
    work_dir: Path = field(default_factory=lambda: Path("/tmp/hermes"))

    llm: LLMConfig = field(default_factory=LLMConfig)

    # Section 8's context discipline, enforced as a setting so it is auditable
    # rather than merely intended. Raising it is a deliberate, visible act.
    max_sample_values: int = 5
    redact_samples: bool = True


def load_config() -> Config:
    """Build the config from the environment, or raise ConfigError."""
    url = _require("SUPABASE_URL").rstrip("/")
    key = _require("SUPABASE_SECRET_KEY")

    if not url.startswith(("http://", "https://")):
        raise ConfigError(f"SUPABASE_URL must be a full URL, got {url!r}")

    # A stable id keeps one row per host in agent_workers across restarts, so
    # the dashboard shows "the agent restarted" rather than accumulating a new
    # ghost worker every deploy.
    hostname = socket.gethostname()
    worker_id = os.environ.get("HERMES_WORKER_ID", "").strip() or f"hermes-{hostname}"
    if len(worker_id) > 200:
        worker_id = worker_id[:200]

    llm = LLMConfig(
        openai_api_key=os.environ.get("OPENAI_API_KEY", "").strip() or None,
        openai_base_url=os.environ.get("OPENAI_BASE_URL", "").strip() or "https://api.openai.com/v1",
        openai_model=os.environ.get("OPENAI_MODEL", "").strip() or "gpt-4.1-mini",
        kimi_api_key=os.environ.get("KIMI_API_KEY", "").strip() or None,
        kimi_base_url=os.environ.get("KIMI_BASE_URL", "").strip() or "https://api.moonshot.ai/v1",
        kimi_model=os.environ.get("KIMI_MODEL", "").strip() or "kimi-k2-0905-preview",
        reasoning_provider=os.environ.get("HERMES_REASONING_PROVIDER", "").strip() or "openai",
        reasoning_effort=(
            os.environ["HERMES_LLM_REASONING_EFFORT"].strip()
            if "HERMES_LLM_REASONING_EFFORT" in os.environ
            else "none"
        ),
        drafting_provider=os.environ.get("HERMES_DRAFTING_PROVIDER", "").strip() or "openai",
        timeout_seconds=_int("HERMES_LLM_TIMEOUT_SECONDS", 90),
        max_output_tokens=_int("HERMES_LLM_MAX_OUTPUT_TOKENS", 2000),
    )

    work_dir = Path(os.environ.get("HERMES_WORK_DIR", "").strip() or "/tmp/hermes")

    return Config(
        supabase_url=url,
        service_key=key,
        worker_id=worker_id,
        hostname=hostname,
        capabilities=tuple(
            kind
            for kind in (
                part.strip() for part in os.environ.get("HERMES_CAPABILITIES", "").split(",")
            )
            if kind
        ),
        lease_seconds=_int("HERMES_LEASE_SECONDS", 300),
        heartbeat_seconds=_int("HERMES_HEARTBEAT_SECONDS", 30),
        health_check_seconds=_int("HERMES_HEALTH_CHECK_SECONDS", 600),
        alert_webhook_url=os.environ.get("HERMES_ALERT_WEBHOOK_URL", "").strip(),
        poll_seconds=_int("HERMES_POLL_SECONDS", 3),
        max_download_bytes=_int("HERMES_MAX_DOWNLOAD_BYTES", 50 * 1024 * 1024),
        work_dir=work_dir,
        llm=llm,
        max_sample_values=_int("HERMES_MAX_SAMPLE_VALUES", 5),
        redact_samples=_bool("HERMES_REDACT_SAMPLES", True),
    )


def new_run_id() -> str:
    return str(uuid.uuid4())
