"""
SENTINEL — LLM client (Groq, OpenAI-compatible endpoint).

WHAT THIS IS FOR, AND WHAT IT IS NOT FOR

The LLM writes *prose about findings that already exist*. It does not detect
anything, score anything, or decide anything. Every number it is allowed to
mention is computed by the statistics engine before the model is called, and
the caller checks the output against those numbers afterwards.

That boundary is deliberate and it is the whole design. A language model cannot
be held to an evidential standard: it cannot show its working, it is not
reproducible across versions, and it will produce a confident number when it
has no number. So it is kept out of the analytical path entirely and used only
where its actual strength lies — turning a structured result into a paragraph
an investigator can read.

  app/analytics/   no LLM. Ever. Permutation tests, lift, FDR, baselines.
  this module      prose only, over figures it is handed.

OPERATIONAL NOTES

  - The API key is read from the environment and never logged, never returned
    by any endpoint, and never included in an error message.
  - Failure is always reported, never swallowed into silence. Callers receive
    an explicit mode so the UI can say the text was not model-generated.
  - reasoning_effort is set low by default. The configured model
    (openai/gpt-oss-20b) is a reasoning model that spends completion tokens on
    internal reasoning before emitting content: measured at 269 reasoning
    tokens for a short case brief, against 19 with low effort. Those tokens
    come out of the same max_tokens budget as the answer, so leaving it
    unbounded is how a response gets truncated into invalid JSON.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("sentinel.llm")

DEFAULT_MODEL = "openai/gpt-oss-20b"
BASE_URL = "https://api.groq.com/openai/v1"

# Generous enough that reasoning tokens plus a several-paragraph answer fit with
# room to spare. The previous 512 left ~100 tokens of headroom on a short brief,
# and a truncated JSON response fails silently -- it looks exactly like a model
# that declined to answer.
DEFAULT_MAX_TOKENS = 1500
DEFAULT_TIMEOUT = 20.0


@dataclass
class LLMResult:
    """The outcome of one completion, successful or not."""

    ok: bool
    text: str = ""
    mode: str = "UNAVAILABLE"        # LIVE | UNAVAILABLE
    reason: str | None = None
    model: str | None = None
    latency_ms: int = 0
    usage: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"mode": self.mode, "reason": self.reason, "model": self.model,
                "latency_ms": self.latency_ms, "usage": self.usage}


def model_name() -> str:
    return os.environ.get("GROQ_MODEL") or DEFAULT_MODEL


def available() -> bool:
    """True if a key is configured. Says nothing about the service being up."""
    return bool(os.environ.get("GROQ_API_KEY"))


def config() -> dict[str, Any]:
    """
    Non-secret description of the LLM setup, safe to return from an API.

    Deliberately reports only whether a key is present. The key itself is never
    exposed, not even truncated -- a prefix is still a credential fragment.
    """
    return {
        "configured": available(),
        "model": model_name() if available() else None,
        "provider": "Groq (OpenAI-compatible endpoint)",
        "role": "Narrative generation only. The LLM performs no detection, "
                "scoring or decision-making; all statistics are computed "
                "before it is called and its output is checked against them.",
        "max_tokens": DEFAULT_MAX_TOKENS,
        "timeout_seconds": DEFAULT_TIMEOUT,
    }


def complete(
    *,
    system: str,
    user: str,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    temperature: float = 0.2,
    timeout: float = DEFAULT_TIMEOUT,
    reasoning_effort: str | None = "low",
) -> LLMResult:
    """
    One completion. Returns a result object; never raises for an API failure.

    Callers are on a request path with a person waiting, so there is no retry
    ladder here: a failure is reported at once and the caller falls back to
    deterministic text rather than holding the response open.
    """
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return LLMResult(ok=False, mode="UNAVAILABLE",
                         reason="No GROQ_API_KEY is configured.")

    model = model_name()
    started = time.time()
    try:
        import openai
    except ImportError:
        return LLMResult(ok=False, mode="UNAVAILABLE", model=model,
                         reason="The openai client library is not installed.")

    try:
        client = openai.OpenAI(api_key=key, base_url=BASE_URL,
                               timeout=timeout, max_retries=0)
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort

        try:
            response = client.chat.completions.create(**kwargs)
        except TypeError:
            # An older client, or a model that rejects the parameter. Retry
            # once without it rather than failing over a tuning hint.
            kwargs.pop("reasoning_effort", None)
            response = client.chat.completions.create(**kwargs)

        elapsed = int((time.time() - started) * 1000)
        text = (response.choices[0].message.content or "").strip()
        usage = {}
        if getattr(response, "usage", None):
            u = response.usage
            usage = {"prompt_tokens": u.prompt_tokens,
                     "completion_tokens": u.completion_tokens}
            details = getattr(u, "completion_tokens_details", None)
            if details is not None:
                usage["reasoning_tokens"] = getattr(details, "reasoning_tokens", None)

        if not text:
            # Characteristic of a reasoning model whose budget went entirely on
            # reasoning. Reported as its own reason, because "empty" and
            # "refused" are different problems with different fixes.
            log.warning("llm returned no content model=%s usage=%s", model, usage)
            return LLMResult(ok=False, mode="UNAVAILABLE", model=model,
                             latency_ms=elapsed, usage=usage,
                             reason="The model returned no content. The token "
                                    "budget may have been consumed by internal "
                                    "reasoning.")

        log.info("llm ok model=%s ms=%d usage=%s", model, elapsed, usage)
        return LLMResult(ok=True, text=text, mode="LIVE", model=model,
                         latency_ms=elapsed, usage=usage)

    except Exception as exc:  # noqa: BLE001 - reported, not propagated
        elapsed = int((time.time() - started) * 1000)
        # The exception type, not its message: a provider error can echo back
        # request content, and this is written to shared logs.
        log.warning("llm call failed model=%s after %dms: %s",
                    model, elapsed, type(exc).__name__)
        return LLMResult(ok=False, mode="UNAVAILABLE", model=model,
                         latency_ms=elapsed,
                         reason=f"The language model request failed "
                                f"({type(exc).__name__}).")
