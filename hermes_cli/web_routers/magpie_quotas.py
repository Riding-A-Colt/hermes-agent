"""``/api/magpie/quotas*`` — read-through proxy to the magpie app's local quota API.

Why a proxy and not a direct browser call: the desktop renderer may live on a
different machine than the backend (laptop client -> always-on server), while
magpie listens on ``127.0.0.1:3425`` of the *backend* host only. Fetching from
the renderer would either hit the wrong machine or need magpie exposed on the
LAN; both are worse than one thin hop here.

Nothing is cached or reinterpreted: the payload is magpie's, verbatim. Quota
numbers are pre-formatted there (``display`` etc.), and inventing our own would
drift. Failures map to explicit statuses so the page can say what happened
instead of showing an empty grid:

- ``503 magpie_not_running`` — nothing is listening on 3425 (no auto-start: the
  user decides whether the app runs).
- ``504 magpie_timeout`` — the probe to the vendor answered too slowly.
- ``502 magpie_error`` — magpie answered, but not with 2xx; its body is kept.

Refresh endpoints really do call the vendors' billing APIs, so a full refresh
takes seconds (volcengine alone ~8 s) and can be rate limited upstream. The
routes are POST-only on purpose: no accidental refreshes from a prefetcher.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)
router = APIRouter()

MAGPIE_BASE = os.environ.get("MAGPIE_BASE_URL", "http://127.0.0.1:3425").rstrip("/")

# magpie is on loopback: never let an HTTP(S)_PROXY from the service env swallow
# the request (a configured proxy answers 503 with an empty body, which would be
# reported as "magpie error" instead of "magpie is not running").
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# Reading the cached snapshot is cheap; a refresh waits on the vendors.
_READ_TIMEOUT_S = 8.0
_REFRESH_TIMEOUT_S = 25.0


def _call(method: str, path: str, timeout: float) -> dict:
    req = urllib.request.Request(MAGPIE_BASE + path, method=method, data=b"" if method == "POST" else None)
    req.add_header("Accept", "application/json")
    if method == "POST":
        req.add_header("Content-Type", "application/json")
        req.data = b"{}"
    try:
        with _opener.open(req, timeout=timeout) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:2000]
        raise HTTPException(
            status_code=502,
            detail={"code": "magpie_error", "status": exc.code, "message": detail},
        ) from exc
    except (urllib.error.URLError, ConnectionRefusedError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, (ConnectionRefusedError, socket.gaierror)) or "Connection refused" in str(reason):
            raise HTTPException(
                status_code=503,
                detail={"code": "magpie_not_running", "message": "magpie is not running on this host"},
            ) from exc
        raise HTTPException(
            status_code=502,
            detail={"code": "magpie_unreachable", "message": str(reason)[:500]},
        ) from exc
    except (socket.timeout, TimeoutError) as exc:
        raise HTTPException(
            status_code=504,
            detail={"code": "magpie_timeout", "message": "magpie did not answer in time"},
        ) from exc

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "magpie_bad_json", "message": "magpie returned a non-JSON body"},
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=502,
            detail={"code": "magpie_bad_json", "message": "magpie returned an unexpected payload"},
        )
    return payload


@router.get("/api/magpie/quotas")
def magpie_quotas_read():
    """Current quota snapshot, with icons and daily usage (``/quotas/cards``)."""
    return _call("GET", "/v1/magpie/quotas/cards", _READ_TIMEOUT_S)


@router.post("/api/magpie/quotas/refresh")
def magpie_quotas_refresh(provider: str = ""):
    """Re-probe every provider, or just ``provider`` when given.

    magpie honours only the first ``provider`` parameter and answers 200 with an
    untouched snapshot for an unknown id, so this stays single-provider by
    design: no batch semantics that the upstream does not actually implement.
    """
    query = ""
    if provider:
        query = "?" + urllib.parse.urlencode({"provider": provider})
    return _call("POST", "/v1/magpie/quotas/refresh" + query, _REFRESH_TIMEOUT_S)
