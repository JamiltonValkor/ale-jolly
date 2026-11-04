"""Fixed internal Brain transport. The token and native context never become model arguments."""
from __future__ import annotations

from base64 import urlsafe_b64encode
from hashlib import sha256
import hmac
import json
from pathlib import Path
import re
import stat
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ORIGIN = 'http://saleads-brain:8765'
ROUTES = frozenset({'/continuous/context', '/continuous/curation/batch', '/continuous/curation/commit', '/continuous/goals'})
MAX_REQUEST_BYTES = 128000
MAX_RESPONSE_BYTES = 1048576
TOKEN = re.compile(r'^[a-f0-9]{64}$')
PUBLIC_REASONS = frozenset({
    'invalid_knowledge_candidate_contract', 'invalid_specialist_experience_contract',
    'candidate_source_outside_batch', 'owner_quote_not_in_registered_source',
    'scalar_fact_requires_subject_ref', 'unknown_ontology_field', 'unknown_ontology_type',
    'experience_requires_native_role_result', 'inference_is_not_confirmed_fact',
    'non_business_source_not_admissible', 'empty_curation_requires_reason',
    'curation_batch_not_running', 'curation_native_context_mismatch',
    'owner_mandate_required', 'goal_requires_current_owner_mandate', 'goal_revision_conflict',
    'goal_selector_mismatch', 'native_task_not_in_business', 'invalid_goal_state_contract',
    'invalid_goal_origin', 'goal_confirmation_requires_current_owner_answer',
    'goal_confirmation_requires_owner_source',
    'curation_commit_payload_conflict', 'curation_commit_receipt_unverifiable',
    'invalid_curation_page_cursor', 'curation_page_metadata_too_large',
})


class MemoryFailure(Exception):
    """A fixed public code, not a transport error or response body."""
    def __init__(self, code, reason=None):
        super().__init__(code)
        self.code = code
        self.reason = reason if reason in PUBLIC_REASONS else None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(ProxyHandler({}), NoRedirect())


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def read_token(home: Path, *, collector=False):
    path = home / 'plugin-data/saleads-memory' / ('collector-token' if collector else 'auth-token')
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_size > 128:
            raise MemoryFailure('MEMORY_AUTH_UNAVAILABLE')
        token = path.read_text().strip()
    except (OSError, UnicodeError) as error:
        raise MemoryFailure('MEMORY_AUTH_UNAVAILABLE') from error
    if not TOKEN.fullmatch(token):
        raise MemoryFailure('MEMORY_AUTH_UNAVAILABLE')
    return token


class BrainClient:
    def __init__(self, home: Path, opener=None, *, collector=False):
        self.home = home
        self.opener = OPENER if opener is None else opener
        self.collector = collector

    def request(self, context, path, payload, *, timeout=10):
        if (self.collector and path != '/continuous/sources') or (not self.collector and path not in ROUTES):
            raise MemoryFailure('MEMORY_ROUTE_NOT_ALLOWED')
        token = read_token(self.home, collector=self.collector)
        encoded = urlsafe_b64encode(canonical(context).encode()).decode().rstrip('=')
        proof = hmac.new(token.encode(), encoded.encode(), sha256).hexdigest()
        try:
            body = canonical(payload).encode()
        except (TypeError, ValueError) as error:
            raise MemoryFailure('MEMORY_ARGUMENTS_INVALID') from error
        if len(body) > MAX_REQUEST_BYTES:
            raise MemoryFailure('MEMORY_REQUEST_TOO_LARGE')
        request = Request(ORIGIN + path, data=body, method='POST', headers={
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'x-saleads-memory-token': token, 'x-saleads-memory-context': encoded,
            'x-saleads-memory-proof': proof,
        })
        try:
            with self.opener.open(request, timeout=timeout) as response:
                data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise MemoryFailure('MEMORY_RESPONSE_TOO_LARGE')
            result = json.loads(data)
        except HTTPError as error:
            # Only enumerated validation codes may be returned; never an arbitrary error body.
            reason = None
            try:
                if error.code in (400, 409):
                    failure = json.loads(error.read(4096))
                    reason = failure.get('reason') if isinstance(failure, dict) else None
                    if error.code == 409 and reason not in {
                        'curation_commit_payload_conflict', 'curation_commit_receipt_unverifiable',
                    }:
                        reason = None
            except (ValueError, OSError):
                pass
            finally:
                error.close()
            rejected = error.code in (400, 403) or error.code == 409 and reason is not None
            raise MemoryFailure('MEMORY_REJECTED' if rejected else 'MEMORY_UNAVAILABLE', reason) from error
        except (URLError, TimeoutError, OSError) as error:
            raise MemoryFailure('MEMORY_UNAVAILABLE') from error
        except (ValueError, UnicodeError) as error:
            raise MemoryFailure('MEMORY_INVALID_RESPONSE') from error
        if not isinstance(result, dict):
            raise MemoryFailure('MEMORY_INVALID_RESPONSE')
        return result
