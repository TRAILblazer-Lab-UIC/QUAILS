"""Ollama API wrapper with logprobs, chat API, and structured output."""

import json
import math
import re
import subprocess
import threading
import requests
import requests.adapters

import os

from config import OLLAMA_BASE_URL, DEFAULT_MODEL


def _strip_thinking(text):
    """Remove <think>...</think> blocks emitted by reasoning-capable models.

    Fallback for Ollama versions that don't honour think=False or models that
    emit thinking tokens despite the flag.  The actual guard is think=False in
    every API payload; this cleans up anything that slips through so logprob
    scoring and response parsing always operate on the plain answer.
    """
    if not text:
        return text
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    return cleaned.strip()

# Ollama's built-in default when num_ctx is not specified
OLLAMA_DEFAULT_NUM_CTX = 2048

# One pooled HTTP session per thread: reuses connections to Ollama instead of
# opening a new TCP connection per call (requests.Session is not guaranteed
# thread-safe, so parallel workers each get their own).
_tls = threading.local()


def _session():
    s = getattr(_tls, "session", None)
    if s is None:
        s = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=8)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
        _tls.session = s
    return s


def client_keep_alive():
    """How long Ollama keeps a model loaded after a QUAILS request (no reload between units/runs).
    Does not affect outputs. Override with OLLAMA_KEEP_ALIVE_CLIENT in backend/.env."""
    return os.environ.get("OLLAMA_KEEP_ALIVE_CLIENT") or "30m"


class OllamaClient:
    """Client for Ollama's Chat and Generate APIs with logprob support."""

    def __init__(self, base_url=OLLAMA_BASE_URL, model=DEFAULT_MODEL,
                 temperature=0, seed=5, top_k=3, top_p=0.9, repeat_penalty=1.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self.seed = seed
        self.top_k = top_k
        self.top_p = top_p
        self.repeat_penalty = repeat_penalty
        # Read user-configured context window override from env (set via Settings page slider)
        try:
            _raw_ctx = int(os.environ.get("OLLAMA_NUM_CTX", "") or 0)
            self.num_ctx = _raw_ctx if _raw_ctx > 0 else None
        except (ValueError, TypeError):
            self.num_ctx = None

    def is_running(self):
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=5)
            return resp.status_code == 200
        except requests.ConnectionError:
            return False

    def ensure_running(self):
        """Start Ollama if not running."""
        if self.is_running():
            return True
        try:
            from services.ollama_server import server_env
            subprocess.Popen(
                ["ollama", "serve"],
                env=server_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # Wait for startup
            import time
            for _ in range(30):
                time.sleep(1)
                if self.is_running():
                    return True
            return False
        except FileNotFoundError:
            print("[ollama_client] Ollama not found on PATH")
            return False

    def list_models(self):
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=10)
            if resp.status_code == 200:
                return resp.json().get("models", [])
        except requests.ConnectionError:
            pass
        return []

    def warm_model(self):
        """Load the model up front with the same num_ctx as real calls (a different
        num_ctx would force a reload on the first real request) and keep it resident."""
        options = {"num_predict": 1}
        if self.num_ctx:
            options["num_ctx"] = self.num_ctx
        try:
            _session().post(
                f"{self.base_url}/api/generate",
                json={"model": self.model, "prompt": "hi", "stream": False, "think": False,
                      "keep_alive": client_keep_alive(), "options": options},
                timeout=300,
            )
            return True
        except Exception:
            return False

    def chat(self, messages, temperature=0.1, num_predict=256, logprobs=True, format=None, options_override=None):
        """Send a chat request and return response with logprobs.

        Args:
            messages: List of {"role": "user"|"assistant"|"system", "content": str}
            temperature: Sampling temperature
            num_predict: Max tokens to generate
            logprobs: Whether to request logprobs

        Returns:
            Dict with:
                - content: response text
                - logprobs: list of token logprobs (if available)
                - raw: full API response
        """
        options = {
            "temperature": self.temperature,
            "seed": self.seed,
            "top_k": self.top_k,
            "top_p": self.top_p,
            "repeat_penalty": self.repeat_penalty,
            "num_predict": num_predict,
        }
        if self.num_ctx:
            options["num_ctx"] = self.num_ctx
        if options_override:
            options.update(options_override)

        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            "think": False,   # disable reasoning tokens so logprobs reflect the answer only
            "logprobs": logprobs,
            "options": options,
            "keep_alive": client_keep_alive(),
        }
        if format is not None:
            payload["format"] = format  # JSON schema (or "json") for structured output

        try:
            resp = _session().post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=300,
            )
            if resp.status_code != 200:
                return {"content": None, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}

            data = resp.json()
            message = data.get("message", {})
            content = _strip_thinking(message.get("content", "").strip())

            # logprobs is a top-level field in the Ollama response (not inside message)
            token_logprobs = data.get("logprobs") or []

            return {
                "content": content,
                "logprobs": token_logprobs,
                "raw": data,
            }

        except requests.Timeout:
            return {"content": None, "error": "Request timed out"}
        except Exception as e:
            return {"content": None, "error": str(e)}

    def generate(self, prompt, system=None, temperature=0.1, num_predict=256, logprobs=True):
        """Send a generate request with logprobs.

        Returns:
            Dict with content, logprobs, raw.
        """
        gen_options = {
            "temperature": temperature,
            "num_predict": num_predict,
            "logprobs": logprobs,
        }
        if self.num_ctx:
            gen_options["num_ctx"] = self.num_ctx

        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "think": False,   # disable reasoning tokens so logprobs reflect the answer only
            "options": gen_options,
            "keep_alive": client_keep_alive(),
        }
        if system:
            payload["system"] = system

        try:
            resp = _session().post(
                f"{self.base_url}/api/generate",
                json=payload,
                timeout=300,
            )
            if resp.status_code != 200:
                return {"content": None, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}

            data = resp.json()
            content = _strip_thinking(data.get("response", "").strip())

            token_logprobs = data.get("logprobs", [])

            return {
                "content": content,
                "logprobs": token_logprobs,
                "raw": data,
            }

        except requests.Timeout:
            return {"content": None, "error": "Request timed out"}
        except Exception as e:
            return {"content": None, "error": str(e)}
