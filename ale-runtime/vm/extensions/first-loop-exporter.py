#!/usr/bin/env python3
"""Read-only native Kanban projection. Never invokes an agent or writes Hermes tables."""
from __future__ import annotations
import argparse
import datetime as dt
import gzip
import hashlib
import ipaddress
from itertools import islice
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
from urllib.parse import urlsplit

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
NATIVE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$')
PROFILES = {'investigador': 'research', 'estratega': 'strategy', 'estructurador': 'structure', 'analista': 'analysis', 'optimizador': 'optimization'}
STATUS = {'todo': 'queued', 'pending': 'queued', 'queued': 'queued', 'ready': 'queued', 'in_progress': 'running', 'running': 'running', 'review': 'awaiting_review', 'in_review': 'awaiting_review', 'done': 'completed', 'completed': 'completed', 'blocked': 'blocked', 'failed': 'failed', 'cancelled': 'cancelled', 'canceled': 'cancelled'}
MAX_TEXT = 131072
MAX_RECEIPTS = 1000
MAX_RECEIPT_BYTES = 32768
MAX_SOURCES = 100

def encoded(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True, ensure_ascii=False).encode()

def regular(path: Path, root: Path) -> bool:
    try:
        if '..' in path.parts:
            return False
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
        return path.is_file() and not any(p.is_symlink() for p in (path, *path.parents) if p == root or root in p.parents)
    except (ValueError, OSError):
        return False

def instant(value):
    try:
        if isinstance(value, (int, float)):
            return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()
        if isinstance(value, str):
            return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat()
    except (ValueError, OverflowError, OSError):
        pass
    return None

def marker(body):
    for line in str(body or '').splitlines():
        if not line.startswith('SALEADS_FIRST_LOOP_TASK_V1 '):
            continue
        try:
            value = json.loads(line.split(' ', 1)[1])
            if UUID.fullmatch(str(value.get('work_id', ''))) and UUID.fullmatch(str(value.get('business_id', ''))) and value.get('stage') in PROFILES.values() and isinstance(value.get('revision'), int) and 1 <= value['revision'] <= 1000 and value.get('response_locale') in ('es', 'en'):
                return value
        except (ValueError, TypeError):
            pass
    return None

def clean_text(value):
    if not isinstance(value, str) or not value.strip() or len(value.encode()) > MAX_TEXT:
        return None
    if re.search(r'Bearer\s+[A-Za-z0-9._-]{20,}|LLM_[A-Za-z0-9_]{12,}|-----BEGIN .*PRIVATE KEY', value):
        return None
    return value

def safe_metadata(value, depth=0):
    """Completion metadata is an artifact, never a config/credential or host-path export."""
    if depth > 6:
        return None
    private = {'env', 'environment', 'headers', 'authorization', 'api_key', 'apikey', 'access_token', 'refresh_token', 'token', 'secret', 'password', 'system_prompt', 'prompt', 'reasoning', 'chain_of_thought', 'path', 'file_path', 'workspace_path', 'workdir', 'data_dir', 'source_path', 'worker_session_id', 'session_id', 'run_id', 'worker_run_id', 'task_run_id', 'task_id', 'run_refs'}
    if isinstance(value, dict):
        return {str(k): safe_metadata(v, depth + 1) for k, v in list(value.items())[:100] if str(k).lower() not in private}
    if isinstance(value, list):
        return [safe_metadata(v, depth + 1) for v in value[:100]]
    if isinstance(value, str):
        return None if value.startswith(('/opt/data/', '/var/lib/', '/home/', '/root/')) else clean_text(value)
    return value if value is None or isinstance(value, (int, float, bool)) else None

def run_content(run):
    summary = clean_text(run.get('summary'))
    structured = None
    if isinstance(run.get('metadata'), str) and len(run['metadata'].encode()) <= MAX_TEXT:
        try:
            parsed = json.loads(run['metadata'])
            if isinstance(parsed, (dict, list)):
                structured = safe_metadata(parsed)
        except ValueError:
            pass
    parts = [summary] if summary else []
    if structured:
        data = json.dumps(structured, ensure_ascii=False, indent=2)
        if clean_text(data):
            parts.append('## Structured result\n\n```json\n' + data + '\n```')
    return clean_text('\n\n'.join(parts))

def sources(text):
    out = []
    for raw in re.findall(r'https?://[^\s<>"\]\)]+', text):
        try:
            u = urlsplit(raw)
            if u.username or u.password or not u.hostname or re.search(r'token|signature|api[_-]?key', u.query, re.I):
                continue
            if raw not in [x['url'] for x in out]:
                out.append({'title': u.hostname, 'url': raw})
        except ValueError:
            continue
    return out[:100]

def public_source_url(value):
    if not isinstance(value, str) or len(value.encode()) > 2048 or re.search(r'[\s\\<>"`]', value):
        return None
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        if parsed.scheme not in ('http', 'https') or not host or parsed.username is not None or parsed.password is not None:
            return None
        if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')) or re.search(r'token|signature|api[_-]?key|secret|password', parsed.query + '&' + parsed.fragment, re.I):
            return None
        parsed.port  # Reject malformed port values without connecting to the source.
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            if '.' not in host:
                return None
        return value
    except ValueError:
        return None

def research_receipt_sources(data, task, run):
    """Join completed hosted-search evidence only to its verified native task/run."""
    if run['profile'] != 'investigador' or run['status'] != 'done' or run['outcome'] != 'completed':
        return []
    session = None
    if isinstance(run.get('metadata'), str) and len(run['metadata'].encode()) <= MAX_TEXT:
        try:
            metadata = json.loads(run['metadata'])
            candidate = metadata.get('worker_session_id') if isinstance(metadata, dict) else None
            if isinstance(candidate, str) and NATIVE.fullmatch(candidate):
                session = candidate
        except ValueError:
            pass
    directory = data / 'profiles' / 'investigador' / 'plugin-data' / 'saleads-meta-search' / 'receipts'
    urls = set()
    try:
        for path in islice(directory.iterdir(), MAX_RECEIPTS):
            if not re.fullmatch(r'[0-9a-f]{64}\.json', path.name) or not regular(path, data) or path.stat().st_size > MAX_RECEIPT_BYTES:
                continue
            try:
                receipt = json.loads(path.read_text())
            except (OSError, UnicodeError, ValueError):
                continue
            if not isinstance(receipt, dict) or receipt.get('status') != 'completed' or receipt.get('model') != 'muse-spark-1.3-contributor' or type(receipt.get('search_calls')) is not int or receipt['search_calls'] < 1:
                continue
            receipt_session = receipt.get('session_id')
            if receipt_session is not None and receipt_session != session:
                continue
            if not (receipt.get('task_id') == task['id'] or session and (receipt_session == session or receipt.get('task_id') == session)):
                continue
            citations = receipt.get('citations')
            if not isinstance(citations, list):
                continue
            for citation in citations[:MAX_SOURCES]:
                url = public_source_url(citation.get('url')) if isinstance(citation, dict) else None
                if url:
                    urls.add(url)
                if len(urls) >= MAX_SOURCES:
                    break
            if len(urls) >= MAX_SOURCES:
                break
    except OSError:
        # Optional evidence unavailable: never manufacture sources or completed work.
        pass
    return sorted(urls)

def append_research_sources(content, urls):
    existing = {source['url'] for source in sources(content)}
    addition = ''
    for url in urls:
        if url in existing:
            continue
        candidate = addition + ('\n\n## Research sources\n\n' if not addition else '') + '- <' + url + '>\n'
        if len((content + candidate).encode()) <= MAX_TEXT:
            addition = candidate
    return content + addition

def artifact(task, meta, content, kind='text/markdown', source_urls=None):
    raw = content.encode()
    citations = sources(content) if source_urls is None else [{'title': urlsplit(url).hostname, 'url': url} for url in source_urls[:MAX_SOURCES]]
    return {'id': hashlib.sha256((task['id'] + ':' + content).encode()).hexdigest(), 'task_id': task['id'], 'stage': meta['stage'], 'revision': meta['revision'], 'title': str(task['title'] or '')[:200], 'content_type': kind, 'content': content, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'response_locale': meta['response_locale'], 'sources': citations}

def export(data: Path):
    db = data / 'kanban.db'
    if not regular(db, data):
        raise ValueError('kanban_missing')
    conn = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        required = {'tasks': {'id', 'title', 'body', 'assignee', 'status', 'tenant', 'result'}, 'task_runs': {'id', 'task_id', 'profile', 'status', 'ended_at', 'outcome', 'summary', 'metadata'}, 'task_links': {'parent_id', 'child_id'}}
        for table, columns in required.items():
            actual = {x[1] for x in conn.execute('PRAGMA table_info(' + table + ')')}
            if not columns <= actual:
                raise ValueError('kanban_schema')
        tasks = [dict(x) for x in conn.execute('SELECT * FROM tasks WHERE tenant IS NOT NULL LIMIT 10001')]
        if len(tasks) > 10000:
            raise ValueError('kanban_bound')
        runs = {}
        for x in conn.execute('SELECT id,task_id,profile,status,ended_at,outcome,summary,metadata FROM task_runs ORDER BY ended_at DESC,id DESC LIMIT 10001'):
            runs.setdefault(x['task_id'], []).append(dict(x))
        links = {}
        for x in conn.execute('SELECT parent_id,child_id FROM task_links LIMIT 10001'):
            links.setdefault(x['child_id'], []).append(x['parent_id'])
        groups = {}
        for task in tasks:
            business, profile = str(task.get('tenant') or ''), task.get('assignee')
            meta = marker(task.get('body'))
            work = str(meta.get('work_id', '')) if meta else ''
            if not UUID.fullmatch(work) or not UUID.fullmatch(business) or profile not in PROFILES or not NATIVE.fullmatch(str(task['id'])) or not meta or meta['business_id'] != business or meta['stage'] != PROFILES[profile]:
                continue
            key = (work, business)
            item = groups.setdefault(key, {'work_id': work, 'business_id': business, 'tasks': [], 'artifacts': []})
            own_runs = [r for r in runs.get(task['id'], []) if r['profile'] == profile and NATIVE.fullmatch(str(r['id']))]
            verified_runs = [r for r in own_runs if r['status'] == 'done' and r['outcome'] == 'completed']
            verified = bool(verified_runs)
            item['tasks'].append({'id': task['id'], 'profile': profile, 'stage': meta['stage'], 'revision': meta['revision'], 'title': str(task['title'] or '')[:200], 'status': STATUS.get(task['status'], 'unknown'), 'native_status': str(task['status'])[:50], 'parents': [p for p in links.get(task['id'], []) if NATIVE.fullmatch(str(p))][:100], 'run_refs': [str(r['id']) for r in own_runs][:100], 'execution_verified': verified, 'updated_at': next((instant(r['ended_at']) for r in own_runs if instant(r['ended_at'])), None)})
            content = clean_text(task.get('result'))
            if not content and verified_runs:
                content = run_content(verified_runs[0])
            source_urls = None
            if content and verified_runs and profile == 'investigador':
                receipt_urls = research_receipt_sources(data, task, verified_runs[0])
                if receipt_urls:
                    # Preserve exact provider URLs; do not reparse punctuation from Markdown.
                    source_urls = list(dict.fromkeys(receipt_urls + [s['url'] for s in sources(content)]))[:MAX_SOURCES]
                    content = append_research_sources(content, receipt_urls)
            if content:
                item['artifacts'].append(artifact(task, meta, content, source_urls=source_urls))
            # Attachments are optional. Only bounded regular text files below this exact work workspace.
            table_exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_attachments'").fetchone()
            if table_exists:
                workspace = data / 'saleads' / 'first-loop' / 'works' / work
                for att in conn.execute('SELECT stored_path,content_type FROM task_attachments WHERE task_id=? LIMIT 10', [task['id']]):
                    p = Path(att['stored_path'])
                    if not p.is_absolute():
                        p = workspace / p
                    if not regular(p, workspace) or p.suffix not in ('.md', '.txt', '.json') or p.stat().st_size > MAX_TEXT:
                        continue
                    try:
                        content = clean_text(p.read_text())
                    except (OSError, UnicodeError):
                        continue
                    if content:
                        kind = 'application/json' if p.suffix == '.json' else 'text/markdown' if p.suffix == '.md' else 'text/plain'
                        item['artifacts'].append(artifact(task, meta, content, kind))
        conn.rollback()
    finally:
        conn.close()
    briefs = []
    flow_dir = data / 'saleads' / 'first-loop' / 'flows'
    if flow_dir.is_dir() and not flow_dir.is_symlink():
        for p in sorted(flow_dir.glob('*/brief.json'))[:100]:
            if not UUID.fullmatch(p.parent.name) or not regular(p, flow_dir) or p.stat().st_size > MAX_TEXT:
                continue
            try:
                b = json.loads(p.read_text())
                if b.get('flow_id') == p.parent.name and UUID.fullmatch(str(b.get('business_id', ''))) and isinstance(b.get('brief_revision'), int) and set(b) == {'flow_id', 'business_id', 'brief_revision', 'brief', 'missing_fields'}:
                    briefs.append(b)
            except (ValueError, OSError):
                continue
    value = {'briefs': briefs, 'works': list(groups.values())[:100]}
    return {'schema_version': 'first-loop-projection/1', 'observed_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'generation': hashlib.sha256(encoded(value)).hexdigest(), **value}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    args = parser.parse_args()
    data = Path(args.data_dir).absolute()
    result = export(data)
    directory = data / 'saleads' / 'first-loop'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise ValueError('output_symlink')
    descriptor, name = tempfile.mkstemp(dir=directory, prefix='.snapshot-')
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(gzip.compress(encoded(result), mtime=0))
        os.chmod(name, 0o600)
        os.replace(name, directory / 'snapshot.json.gz')
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print(json.dumps({'status': 'ok', 'works': len(result['works']), 'briefs': len(result['briefs'])}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Categories only: SQLite/IO errors can otherwise include paths and business content.
        print(json.dumps({'status': 'failed', 'category': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
