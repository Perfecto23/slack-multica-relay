#!/usr/bin/env python3
"""Send a Relay reply with a code-generated attribution footer."""
import argparse
import fcntl
import hashlib
import json
import math
import os
import shutil
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.parse
from urllib.error import HTTPError
from pathlib import Path


def envelope_from_text(text):
    body = text.split('\n', 1)[1]
    lines = body.replace('\r\n', '\n').split('\n')
    start, end = '<!-- relay-payload:v1 -->', '<!-- /relay-payload -->'
    if start in lines or end in lines:
        if lines.count(start) != 1 or lines.count(end) != 1:
            raise ValueError('invalid_payload_block')
        block = '\n'.join(lines[lines.index(start) + 1:lines.index(end)]).strip()
        match = re.fullmatch(r'(`{3,})json\n([\s\S]*)\n\1', block)
        if not match:
            raise ValueError('invalid_payload_block')
        body = match[2]
    data = json.loads(body)
    if not isinstance(data, dict) or not isinstance(data.get('eventPayload'), dict):
        raise ValueError('invalid_payload')
    return data


def footer_for(config, envelope):
    name = config['displayName']
    if not isinstance(name, str) or not 1 <= len(name) <= 64 or re.search(r'[\n\r<>]', name):
        raise ValueError('invalid_display_name')
    footer = name
    snapshot = envelope.get('replyContext')
    if not isinstance(snapshot, dict):
        return footer
    if (snapshot.get('type') != 'slack_reply_context' or snapshot.get('source') != 'agent_config'
            or snapshot.get('status') != 'available' or reply_assignee(config) != ('agent', snapshot.get('agentId'))):
        return footer
    model = snapshot.get('model')
    if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}', model):
        return footer
    footer += ' · 配置模型：' + model
    if snapshot.get('serviceTier') == 'priority':
        footer += ' · ⚡ Fast'
    return footer


def format_duration(seconds):
    if not isinstance(seconds, int) or isinstance(seconds, bool) or not 0 <= seconds <= 604800:
        return None
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f'{hours}h {minutes:02d}m'
    if minutes:
        return f'{minutes}m {seconds:02d}s'
    return f'{seconds}s'


def icon(config, name):
    defaults = {'time': '⏱️', 'model': '🤖', 'tools': '🔧', 'skills': '🪄', 'github': '🔗', 'multica': '↗️'}
    value = config.get('icons', {}).get(name, defaults[name])
    if not isinstance(value, str) or not 1 <= len(value) <= 80 or re.search(r'[\r\n<>`|]', value):
        raise ValueError('invalid_footer_icon')
    return value


def run_statistics(path, issue_id, task_id=None, config=None):
    if not path:
        return None
    data = json.loads(Path(path).read_text())
    if (not isinstance(data, dict) or data.get('version') != 1 or data.get('issue_id') != issue_id
            or (task_id is not None and data.get('run_id') != task_id)):
        raise ValueError('invalid_run_context')
    stats = data.get('statistics')
    if not isinstance(stats, dict):
        raise ValueError('invalid_run_context')
    config = config or {}
    rendered = []
    duration = format_duration(stats.get('duration_seconds'))
    if duration:
        rendered.append(icon(config, 'time') + ' ' + duration)
    model = stats.get('model')
    if (stats.get('model_source') == 'agent_config' and isinstance(model, str)
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}', model)):
        fast = ' ⚡ Fast' if stats.get('service_tier_source') == 'agent_config' and stats.get('service_tier') == 'priority' else ''
        rendered.append(icon(config, 'model') + ' ' + model + fast)
    for key in ('tools', 'skills'):
        value = stats.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 10000:
            rendered.append(f'{icon(config, key)} {value} {key}')
    identifier, url = data.get('issue_identifier'), data.get('issue_url')
    if isinstance(identifier, str) and re.fullmatch(r'[A-Z][A-Z0-9]{0,31}-[1-9][0-9]{0,15}', identifier) and isinstance(url, str):
        target = urllib.parse.urlsplit(url)
        if (target.scheme == 'https' and target.hostname and not target.username and not target.password
                and not target.query and not target.fragment and not re.search(r'[\s<>|\\]', url)
                and re.fullmatch(r'/[a-z0-9]+(?:-[a-z0-9]+)*/issues/' + re.escape(issue_id), target.path)):
            rendered.append(f'{icon(config, "multica")} <{url}|{identifier}>')
    return ' · '.join(rendered) or None


def github_footers(path, config=None):
    if not path:
        return []
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('pullRequests'), list):
        raise ValueError('invalid_github_context')
    branches = data.get('branches', [])
    if not isinstance(branches, list) or len(data['pullRequests']) + len(branches) > 5:
        raise ValueError('invalid_github_context')
    rows, seen = [], set()
    for item in data['pullRequests']:
        if not isinstance(item, dict):
            raise ValueError('invalid_github_context')
        repository, branch, number, url = (item.get(key) for key in ('repository', 'branch', 'number', 'url'))
        if (not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)
                or not isinstance(branch, str) or not 1 <= len(branch) <= 200 or re.search(r'[\r\n`<>]', branch)
                or not isinstance(number, int) or isinstance(number, bool) or number < 1
                or url != f'https://github.com/{repository}/pull/{number}'):
            raise ValueError('invalid_github_context')
        if url in seen:
            continue
        seen.add(url)
        repo = repository.split('/', 1)[1]
        branch = branch.replace('&', '&amp;')
        rows.append(f'{icon(config or {}, "github")} {repo} · `{branch}` · <{url}|PR #{number}>')
    branch_keys = set()
    for item in branches:
        if not isinstance(item, dict):
            raise ValueError('invalid_github_context')
        repository, branch = item.get('repository'), item.get('branch')
        if (not isinstance(repository, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)
                or not isinstance(branch, str) or not 1 <= len(branch) <= 200 or re.search(r'[\r\n`<>]', branch)):
            raise ValueError('invalid_github_context')
        key = (repository, branch)
        if key in branch_keys or any(x['repository'] == repository and x['branch'] == branch for x in data['pullRequests']):
            continue
        branch_keys.add(key)
        rows.append(f'{icon(config or {}, "github")} {repository.split("/", 1)[1]} · `{branch.replace("&", "&amp;")}`')
    return rows


def render_reply(config, envelope, text, delivery_block_id=None, statistics=None, github_rows=None):
    event = envelope['eventPayload']
    if event.get('teamId') != config['teamId'] or not re.fullmatch(r'[CDG][A-Z0-9]+', event.get('channelId', '')):
        raise ValueError('invalid_reply_scope')
    if not re.fullmatch(r'\d+\.\d{1,6}', event.get('threadTs', '')):
        raise ValueError('invalid_thread')
    footer = footer_for(config, {} if statistics else envelope)
    body = text.strip()
    # Strip only an explicit attribution prefix, not a name in ordinary prose.
    body = re.sub(r'^\s*' + re.escape(config['displayName']) + r'\s*[:：]\s*', '', body, count=1).strip()
    if not body or len(body) > 35000:
        raise ValueError('invalid_reply_length')
    blocks = [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': body[i:i + 3000]}} for i in range(0, len(body), 3000)]
    context_lines = [line for line in [statistics, *(github_rows or []), footer] if line]
    for line in context_lines[:-1]:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': line}]})
    context = {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': context_lines[-1]}]}
    if delivery_block_id:
        context['block_id'] = delivery_block_id
    blocks.append(context)
    return {'channel': event['channelId'], 'thread_ts': event['threadTs'], 'text': body + '\n\n' + '\n'.join(context_lines),
            'blocks': blocks, 'unfurl_links': False, 'unfurl_media': False}


def reply_assignee(config):
    kind = config.get('assigneeType', 'agent')
    target = config.get('assigneeId') or (config.get('agentId') if kind == 'agent' else None)
    if kind not in ('agent', 'squad') or not isinstance(target, str) or not target.strip():
        raise ValueError('invalid_assignee_config')
    legacy = config.get('legacyAgentId')
    if legacy and (kind != 'squad' or config.get('threadScopeId') != legacy):
        raise ValueError('invalid_migration_scope')
    return kind, target


UUID_PATTERN = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'


def read_source(config, issue_id, comment_id, runner=subprocess.run):
    return read_reply_source(config, issue_id, comment_id, runner)[0]


def read_reply_source(config, issue_id, comment_id, runner=subprocess.run):
    """Return (envelope, kind); kind is 'relay', 'owner_comment' or 'handoff'."""
    issue = multica_json(config, ['issue', 'get', issue_id], runner)
    kind, target = reply_assignee(config)
    assigned = (issue.get('assignee_type'), issue.get('assignee_id'))
    legacy = kind == 'squad' and config.get('legacyAgentId') and assigned == ('agent', config['legacyAgentId'])
    if (issue.get('workspace_id') != config['workspaceId'] or issue.get('project_id') != config['projectId']
            or (assigned != (kind, target) and not legacy)):
        raise ValueError('invalid_issue_scope')
    source = issue.get('description', '')
    if comment_id:
        rows = multica_json(config, ['issue', 'comment', 'list', issue_id,
                                     '--thread', comment_id, '--tail', '0'], runner)
        if not isinstance(rows, list):
            raise ValueError('multica_read_failed')
        row = next((row for row in rows if isinstance(row, dict) and row.get('id') == comment_id), None)
        if not row:
            # `--tail 0` returns only the thread root; an owner reply nested in a thread needs the full thread.
            rows = multica_json(config, ['issue', 'comment', 'list', issue_id,
                                         '--thread', comment_id, '--full'], runner)
            if not isinstance(rows, list):
                raise ValueError('multica_read_failed')
            row = next((row for row in rows if isinstance(row, dict) and row.get('id') == comment_id), None)
        if not row:
            raise ValueError('source_comment_missing')
        content = row.get('content', '')
        if isinstance(content, str) and content.startswith('<!-- relay-message:'):
            return envelope_from_text(content), 'relay'
        # The Relay may also post as the owner, so markers are checked first. An owner's own
        # Multica comment carries no Slack envelope; it replies to the Issue's original thread.
        owner = config.get('ownerMulticaUserId')
        if (isinstance(owner, str) and re.fullmatch(UUID_PATTERN, owner)
                and row.get('author_type') == 'member' and row.get('author_id') == owner
                and row.get('issue_id') == issue_id
                and isinstance(source, str) and source.startswith('<!-- relay-thread:')):
            return envelope_from_text(source), 'owner_comment'
        # A squad member hands its result back to the leader with its own comment. The reply still
        # answers the Slack request that started the comment thread, or the Issue's first request.
        if kind == 'squad' and row.get('author_type') == 'agent' and row.get('issue_id') == issue_id:
            root = next((r for r in rows if isinstance(r, dict) and not r.get('parent_id')), None)
            root_content = root.get('content', '') if root else ''
            if isinstance(root_content, str) and root_content.startswith('<!-- relay-message:'):
                return envelope_from_text(root_content), 'handoff'
            if isinstance(source, str) and source.startswith('<!-- relay-thread:'):
                return envelope_from_text(source), 'handoff'
        raise ValueError('invalid_relay_source')
    if not source.startswith('<!-- relay-thread:'):
        raise ValueError('invalid_relay_source')
    return envelope_from_text(source), 'relay'


def read_wakeup_source(config, issue_id, comment_id, task_id, runner=subprocess.run):
    if not isinstance(task_id, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', task_id):
        raise ValueError('invalid_wakeup_run')
    runs = multica_json(config, ['issue', 'runs', issue_id], runner)
    if not isinstance(runs, list):
        raise ValueError('invalid_wakeup_run')
    run = next((item for item in runs if isinstance(item, dict) and item.get('id') == task_id), None)
    if (not run or run.get('issue_id') != issue_id or run.get('workspace_id') != config['workspaceId']
            or run.get('status') != 'running' or not isinstance(run.get('wakeup_id'), str)):
        raise ValueError('invalid_wakeup_run')
    kind, target = reply_assignee(config)
    if kind == 'agent' and run.get('agent_id') != target:
        raise ValueError('invalid_wakeup_run')
    wakeup = multica_json(config, ['issue', 'wakeup', 'get', issue_id, run['wakeup_id']], runner)
    if (not isinstance(wakeup, dict) or wakeup.get('id') != run['wakeup_id']
            or wakeup.get('workspace_id') != config['workspaceId'] or wakeup.get('issue_id') != issue_id
            or wakeup.get('agent_id') != run.get('agent_id')
            or wakeup.get('parent_comment_id') != run.get('trigger_comment_id')
            or wakeup.get('kind') not in ('cron', 'every', 'at')):
        raise ValueError('invalid_wakeup_source')
    source_comment_id = wakeup.get('parent_comment_id')
    if comment_id is not None and comment_id != source_comment_id:
        raise ValueError('wakeup_comment_mismatch')
    envelope, kind = read_reply_source(config, issue_id, source_comment_id, runner)
    if kind != 'relay':
        # A wakeup must descend from a Slack-authorized source; an Agent can schedule one off any comment.
        raise ValueError('invalid_wakeup_source')
    return envelope, source_comment_id, 'wakeup:' + wakeup['id'] + ':run:' + task_id


TIME_WAKEUP_KINDS = ('cron', 'every', 'at')
RUN_CONTEXT_SCRIPT = Path(__file__).resolve().parents[1] / 'multica-skills/multica-final-reply/scripts/run_context.py'


def resolve_current_run(config, issue_id, comment_id, task_id, runner=subprocess.run):
    """Return (trigger comment id, is scheduled wakeup) for the run named by MULTICA_TASK_ID."""
    if not isinstance(task_id, str) or not re.fullmatch(UUID_PATTERN, task_id):
        raise ValueError('invalid_current_run')
    runs = multica_json(config, ['issue', 'runs', issue_id], runner)
    run = next((item for item in runs if isinstance(item, dict) and item.get('id') == task_id), None) \
        if isinstance(runs, list) else None
    if (not run or run.get('issue_id') != issue_id or run.get('workspace_id') != config['workspaceId']
            or run.get('status') != 'running'):
        raise ValueError('invalid_current_run')
    trigger = run.get('trigger_comment_id') or None
    if comment_id is not None and comment_id != trigger:
        raise ValueError('current_run_comment_mismatch')
    scheduled = False
    if isinstance(run.get('wakeup_id'), str):
        wakeup = multica_json(config, ['issue', 'wakeup', 'get', issue_id, run['wakeup_id']], runner)
        # Event wakeups answer their trigger comment like any follow-up; only time wakeups get a new occurrence.
        scheduled = isinstance(wakeup, dict) and wakeup.get('kind') in TIME_WAKEUP_KINDS
    return trigger, scheduled


def collect_run_context(issue_id, runner=subprocess.run, script=RUN_CONTEXT_SCRIPT):
    """Best effort: statistics are omitted when collection fails, never block the reply."""
    if not script.is_file():
        print(json.dumps({'warning': 'run_context_script_missing'}), file=sys.stderr)
        return None
    directory = tempfile.mkdtemp(prefix='relay-run-context-')
    output = Path(directory) / 'run-context.json'
    try:
        # run_context.py may make three 30 s CLI reads.
        result = runner([sys.executable, str(script), '--issue', issue_id, '--output', str(output)],
                        capture_output=True, text=True, timeout=100)
        if result.returncode == 0 and output.is_file():
            return str(output)
    except (OSError, subprocess.SubprocessError):
        pass
    shutil.rmtree(directory, ignore_errors=True)
    return None


def multica_json(config, args, runner=subprocess.run, timeout=15):
    command = ['multica', '--server-url', config['serverUrl'],
               '--workspace-id', config['workspaceId'], *args, '--output', 'json']
    result = runner(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise ValueError('multica_read_failed')
    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        raise ValueError('multica_read_failed') from None


def task_attachments(config, issue_id, task_id, runner=subprocess.run):
    if not isinstance(task_id, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', task_id):
        raise ValueError('invalid_attachment_task')
    rows = multica_json(config, ['issue', 'comment', 'list', issue_id,
                                 '--full', '--summary'], runner)
    if not isinstance(rows, list):
        raise ValueError('invalid_task_attachments')
    attachments, seen, total = [], set(), 0
    for row in rows:
        if not isinstance(row, dict) or row.get('source_task_id') != task_id:
            continue
        items = row.get('attachments', [])
        if not isinstance(items, list):
            raise ValueError('invalid_task_attachments')
        for item in items:
            if not isinstance(item, dict):
                raise ValueError('invalid_task_attachments')
            attachment_id, filename, size = item.get('id'), item.get('filename'), item.get('size_bytes')
            if (not isinstance(attachment_id, str)
                    or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', attachment_id)
                    or not isinstance(filename, str) or not 1 <= len(filename) <= 255
                    or filename in ('.', '..') or Path(filename).name != filename
                    or re.search(r'[\\\x00-\x1f\x7f]', filename)
                    or not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= 25 * 1024 * 1024):
                raise ValueError('invalid_task_attachments')
            if attachment_id in seen:
                continue
            seen.add(attachment_id)
            total += size
            attachments.append({'id': attachment_id, 'filename': filename, 'size_bytes': size})
    if not attachments:
        raise ValueError('task_attachments_missing')
    if len(attachments) > 20 or total > 100 * 1024 * 1024:
        raise ValueError('task_attachments_too_large')
    return attachments


def delivery_identity(config, issue_id, comment_id, occurrence=None):
    kind, target = reply_assignee(config)
    scope = config.get('threadScopeId') or (target if kind == 'agent' else 'squad:' + target)
    fields = [config['workspaceId'], config['projectId'], scope, issue_id, comment_id or '']
    if occurrence is not None:
        fields.append(occurrence)
    return hashlib.sha256('\0'.join(fields).encode()).hexdigest()


class SlackRateLimited(ValueError):
    def __init__(self, retry_after):
        super().__init__('slack_rate_limited')
        self.retry_after = retry_after


def retry_after_seconds(headers):
    value = (headers or {}).get('Retry-After', '').strip()
    # Slack specifies seconds; a missing/malformed header gets a conservative
    # cooldown instead of an immediate retry loop.
    return int(value) if re.fullmatch(r'[0-9]+', value) else 60


def slack_call(token, method, payload=None, query=None, opener=urllib.request.urlopen, timeout=20):
    url = 'https://slack.com/api/' + method
    if query:
        url += '?' + urllib.parse.urlencode(query)
    request = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8'},
        method='GET' if payload is None else 'POST')
    try:
        with opener(request, timeout=timeout) as response:
            headers = getattr(response, 'headers', {})
            data = json.load(response)
    except HTTPError as error:
        try:
            if error.code == 429:
                raise SlackRateLimited(retry_after_seconds(error.headers)) from None
            raise ValueError('slack_lookup_failed' if payload is None else 'slack_delivery_unknown') from None
        finally:
            error.close()
    if not isinstance(data, dict) or data.get('ok') is not True:
        code = data.get('error') if isinstance(data, dict) else None
        if isinstance(data, dict) and data.get('ok') is False and code in ('rate_limited', 'ratelimited'):
            raise SlackRateLimited(retry_after_seconds(headers))
        if payload is None:
            raise ValueError('slack_lookup_failed')
        # Only documented admission/validation failures prove the message was
        # not sent. Server failures and unknown responses retain the intent.
        rejected = {
            'access_denied', 'accesslimited', 'account_inactive', 'app_access_restricted',
            'as_user_not_supported', 'attachment_payload_limit_exceeded', 'cannot_reply_to_message',
            'channel_not_found', 'ekm_access_denied', 'enterprise_is_restricted',
            'invalid_arg_name', 'invalid_arguments', 'invalid_array_arg', 'invalid_auth',
            'invalid_blocks', 'invalid_blocks_format', 'invalid_charset', 'invalid_form_data',
            'invalid_metadata_format', 'invalid_metadata_schema', 'invalid_post_type',
            'is_archived', 'markdown_text_conflict', 'metadata_must_be_sent_from_app',
            'metadata_too_large', 'missing_post_type', 'missing_scope', 'msg_blocks_too_long',
            'no_permission', 'no_text', 'not_allowed_token_type', 'not_authed', 'not_in_channel',
            'restricted_action', 'restricted_action_non_threadable_channel',
            'restricted_action_read_only_channel', 'restricted_action_thread_locked',
            'restricted_action_thread_only_channel', 'send_on_behalf_not_allowed',
            'team_access_not_granted', 'token_expired', 'token_revoked', 'too_many_attachments',
        }
        if isinstance(data, dict) and data.get('ok') is False and isinstance(code, str) and code in rejected:
            raise ValueError('slack_send_rejected')
        raise ValueError('slack_delivery_unknown')
    return data


def update_session_status(config, envelope, issue_id, status, runner=subprocess.run, opener=urllib.request.urlopen):
    setting = config.get('sessionStatus')
    if setting is None:
        return 'disabled'
    try:
        if (not isinstance(setting, dict) or setting.get('tokenEnv') != 'SLACK_BOT_TOKEN'
                or not isinstance(setting.get('userId'), str)):
            return 'invalid_config'
        token = os.environ.get(setting['tokenEnv'])
        if not token:
            return 'unavailable'
        if status != 'processing':
            runs = multica_json(config, ['issue', 'runs', issue_id], runner)
            current = os.environ.get('MULTICA_TASK_ID')
            if (not isinstance(runs, list) or not current
                    or not any(isinstance(r, dict) and r.get('id') == current for r in runs)):
                return 'unavailable'
            if any(r.get('id') != current and r.get('status') in
                   ('running', 'queued', 'dispatched', 'waiting_local_directory') for r in runs):
                return 'other_run_active'
        identity = slack_call(token, 'auth.test', opener=opener)
        if identity.get('user_id') != setting['userId'] or identity.get('team_id') != config['teamId']:
            return 'actor_mismatch'
        event = envelope['eventPayload']
        if event.get('teamId') != config['teamId']:
            return 'source_mismatch'
        slack_call(token, 'agents.sessions.setStatus', payload={
            'channel_id': event['channelId'], 'thread_ts': event['threadTs'], 'status': status}, opener=opener)
        return status
    except Exception:
        return 'unavailable'


def clear_start_reaction(config, envelope, dry_run=False, opener=urllib.request.urlopen):
    return clear_configured_reaction(config, envelope, 'startReaction', dry_run, opener)


def clear_queued_reaction(config, envelope, opener=urllib.request.urlopen):
    """Best effort: the queued marker is presentation only and must never fail a delivered reply."""
    if config.get('queuedReaction') is None:
        return 'disabled'
    try:
        return clear_configured_reaction(config, envelope, 'queuedReaction', False, opener)['action']
    except Exception:
        return 'unavailable'


def clear_configured_reaction(config, envelope, key, dry_run=False, opener=urllib.request.urlopen):
    setting = config.get(key)
    if (not isinstance(setting, dict)
            or not isinstance(setting.get('name'), str)
            or not re.fullmatch(r'[a-z0-9_+\-]+', setting['name'])
            or not isinstance(setting.get('userId'), str)
            or not re.fullmatch(r'[UW][A-Z0-9]+', setting['userId'])
            or setting.get('tokenEnv') not in ('SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN')):
        raise ValueError('invalid_start_reaction_config')
    event = envelope['eventPayload']
    channel, timestamp = event.get('channelId'), event.get('messageTs')
    if (not isinstance(channel, str) or not re.fullmatch(r'[CGD][A-Z0-9]+', channel)
            or not isinstance(timestamp, str) or not re.fullmatch(r'\d+\.\d{1,6}', timestamp)
            or event.get('teamId') != config.get('teamId')):
        raise ValueError('invalid_reaction_source')
    token = os.environ.get(setting['tokenEnv'])
    if not token:
        raise ValueError('reaction_token_missing')
    actor = slack_call(token, 'auth.test', opener=opener)
    if actor.get('user_id') != setting['userId'] or actor.get('team_id') != config['teamId']:
        raise ValueError('reaction_actor_mismatch')

    def present():
        result = slack_call(token, 'reactions.get', query={
            'channel': channel, 'timestamp': timestamp, 'full': 'true'}, opener=opener)
        message = result.get('message')
        if (not isinstance(message, dict) or message.get('ts') != timestamp
                or result.get('channel') != channel):
            raise ValueError('reaction_message_mismatch')
        reactions = message.get('reactions', [])
        if not isinstance(reactions, list):
            raise ValueError('invalid_reaction_response')
        found = False
        for reaction in reactions:
            if (not isinstance(reaction, dict) or not isinstance(reaction.get('name'), str)
                    or not isinstance(reaction.get('users'), list)
                    or any(not isinstance(user, str) for user in reaction['users'])):
                raise ValueError('invalid_reaction_response')
            if reaction['name'] == setting['name'] and setting['userId'] in reaction['users']:
                found = True
        return found

    exists = present()
    if dry_run:
        return {'ok': True, 'action': 'would_remove' if exists else 'already_absent',
                'channel': channel, 'ts': timestamp, 'reaction': setting['name'], 'user_id': setting['userId']}
    if not exists:
        return {'ok': True, 'action': 'already_absent'}
    try:
        slack_call(token, 'reactions.remove', payload={
            'channel': channel, 'timestamp': timestamp, 'name': setting['name']}, opener=opener)
    except Exception:
        # A timeout or no_reaction can follow a successful removal; read back before deciding.
        if not present():
            return {'ok': True, 'action': 'removed'}
        raise ValueError('reaction_cleanup_unverified') from None
    if present():
        raise ValueError('reaction_cleanup_unverified')
    return {'ok': True, 'action': 'removed'}


def verify_reply_root(token, envelope, opener=urllib.request.urlopen):
    event = envelope['eventPayload']
    data = slack_call(token, 'conversations.replies', query={
        'channel': event['channelId'], 'ts': event['threadTs'], 'inclusive': 'true', 'limit': '1'
    }, opener=opener)
    messages = data.get('messages')
    if not isinstance(messages, list):
        raise ValueError('slack_lookup_failed')
    if not any(isinstance(message, dict) and message.get('ts') == event['threadTs'] for message in messages):
        raise ValueError('slack_thread_not_found')


def find_delivered_reply(token, envelope, block_id, oldest, opener=urllib.request.urlopen):
    event = envelope['eventPayload']
    cursor, seen = '', set()
    deadline = time.monotonic() + 15
    for _ in range(10):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('slack_lookup_timeout')
        query = {'channel': event['channelId'], 'ts': event['threadTs'], 'oldest': oldest,
                 'inclusive': 'true', 'limit': '200'}
        if cursor:
            query['cursor'] = cursor
        data = slack_call(token, 'conversations.replies', query=query, opener=opener,
                          timeout=max(0.1, min(10, remaining)))
        messages = data.get('messages')
        if not isinstance(messages, list):
            raise ValueError('slack_lookup_failed')
        for message in messages:
            if not isinstance(message, dict) or not isinstance(message.get('blocks', []), list):
                continue
            if any(isinstance(block, dict) and block.get('block_id') == block_id for block in message['blocks']):
                message_ts = message.get('ts')
                if not isinstance(message_ts, str) or not re.fullmatch(r'\d+\.\d{1,6}', message_ts):
                    raise ValueError('slack_lookup_failed')
                return message_ts
        cursor = data.get('response_metadata', {}).get('next_cursor', '').strip()
        if not cursor:
            return None
        if cursor in seen:
            raise ValueError('slack_lookup_failed')
        seen.add(cursor)
    raise ValueError('reply_lookup_limit')


def delivery_paths(config_path, identity):
    root = config_path.resolve().parent / '.slack-reply-state'
    root.mkdir(mode=0o700, exist_ok=True)
    root.chmod(0o700)
    return root / (identity + '.json'), root / (identity + '.lock')


def attachment_delivery_paths(config_path, identity, attachment):
    # A changed comment order or another attachment must not bypass an earlier receipt.
    suffix = hashlib.sha256('\0'.join([identity, attachment['id']]).encode()).hexdigest()
    root = delivery_paths(config_path, identity)[0].parent
    return root / ('attachments-' + suffix + '.json'), root / ('attachments-' + suffix + '.lock')


def delivery_lock(lock_path):
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    handle = os.fdopen(fd, 'w')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise ValueError('reply_delivery_busy')
    return handle


def read_delivery_state(state_path):
    if not state_path.exists():
        return None
    state = json.loads(state_path.read_text())
    if (not isinstance(state, dict) or state.get('version') != 1
            or state.get('phase') not in ('attempting', 'accepted', 'sent', 'rate_limited')):
        raise ValueError('invalid_delivery_state')
    if state['phase'] == 'attempting' and not re.fullmatch(r'\d+\.\d{6}', state.get('attemptedAt', '')):
        raise ValueError('invalid_delivery_state')
    if state['phase'] == 'attempting' and not re.fullmatch(r'\d+\.\d{6}', state.get('lookupFromTs', '')):
        raise ValueError('invalid_delivery_state')
    if state['phase'] in ('accepted', 'sent') and not re.fullmatch(r'\d+\.\d{1,6}', state.get('messageTs', '')):
        raise ValueError('invalid_delivery_state')
    if state['phase'] == 'rate_limited' and not re.fullmatch(r'\d+\.\d{6}', state.get('retryAt', '')):
        raise ValueError('invalid_delivery_state')
    return state


def write_delivery_state(state_path, state):
    fd, temporary = tempfile.mkstemp(prefix='.delivery-', dir=state_path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(state, handle, separators=(',', ':'))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, state_path)
        directory_fd = os.open(state_path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_attachment_state(state_path):
    if not state_path.exists():
        return None
    state = json.loads(state_path.read_text())
    if (not isinstance(state, dict) or state.get('version') != 1
            or state.get('phase') not in ('attempting', 'sent')):
        raise ValueError('invalid_attachment_delivery_state')
    if not re.fullmatch(r'\d+\.\d{6}', state.get('attemptedAt', '')):
        raise ValueError('invalid_attachment_delivery_state')
    if state['phase'] == 'sent':
        if (not isinstance(state.get('fileIds'), list) or not state['fileIds']
                or not all(isinstance(value, str) and re.fullmatch(r'F[A-Z0-9]+', value)
                           for value in state['fileIds'])):
            raise ValueError('invalid_attachment_delivery_state')
    return state


def download_task_attachments(config, attachments, directory, runner=subprocess.run):
    downloaded = []
    for item in attachments:
        item_dir = Path(directory) / item['id']
        item_dir.mkdir(mode=0o700)
        command = ['multica', '--server-url', config['serverUrl'], '--workspace-id', config['workspaceId'],
                   'attachment', 'download', item['id'], '--output-dir', str(item_dir)]
        result = runner(command, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError('multica_attachment_download_failed')
        candidates = list(item_dir.iterdir())
        if len(candidates) != 1:
            raise ValueError('invalid_downloaded_attachment')
        path = candidates[0]
        metadata = path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_size != item['size_bytes'] or path.name != item['filename']):
            raise ValueError('invalid_downloaded_attachment')
        path.chmod(0o600)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        downloaded.append({'path': path, 'sha256': digest, **item})
    return downloaded


def upload_task_attachments(config_path, config, envelope, identity, attachments,
                            runner=subprocess.run, token=None, opener=urllib.request.urlopen):
    file_ids, duplicate = [], True
    for attachment in attachments:
        result = upload_task_attachment(config_path, config, envelope, identity, attachment,
                                        runner, token, opener)
        file_ids.extend(result['file_ids'])
        duplicate = duplicate and result['duplicate']
    return {'duplicate': duplicate, 'count': len(file_ids), 'file_ids': file_ids}


def upload_task_attachment(config_path, config, envelope, identity, attachment, runner, token, opener):
    state_path, lock_path = attachment_delivery_paths(config_path, identity, attachment)
    with delivery_lock(lock_path):
        state = read_attachment_state(state_path)
        if state and state['phase'] == 'sent':
            return {'duplicate': True, 'count': len(state['fileIds']), 'file_ids': state['fileIds']}
        if state and state['phase'] == 'attempting':
            raise ValueError('slack_attachment_delivery_unknown')

        if not token:
            raise ValueError('slack_user_token_missing')

        slack_cli = config.get('slackCliPath')
        if (not isinstance(slack_cli, str) or not os.path.isabs(slack_cli)
                or not Path(slack_cli).is_file() or Path(slack_cli).is_symlink()):
            raise ValueError('invalid_slack_cli_path')
        with tempfile.TemporaryDirectory(prefix='.slack-attachments-', dir=Path.cwd()) as directory:
            downloaded = download_task_attachments(config, [attachment], directory, runner)
            # The body may have been sent in an earlier invocation; recheck before each upload.
            verify_reply_root(token, envelope, opener)
            command = [sys.executable, slack_cli, 'files_upload', '--as', 'user',
                       '--channel', envelope['eventPayload']['channelId'],
                       '--thread-ts', envelope['eventPayload']['threadTs']]
            for item in downloaded:
                command.extend(['--file', str(item['path']), '--sha256', item['sha256']])
            attempted_at = slack_timestamp()
            write_delivery_state(state_path, {'version': 1, 'phase': 'attempting',
                                              'attemptedAt': attempted_at})
            child_env = os.environ.copy()
            child_env['SLACK_USER_TOKEN'] = token
            child_env['SLACK_SKILL_ALLOWED_CHANNELS'] = envelope['eventPayload']['channelId']
            try:
                result = runner(command, capture_output=True, text=True, timeout=180, env=child_env)
            except (OSError, subprocess.SubprocessError):
                raise ValueError('slack_attachment_delivery_unknown') from None
            if result.returncode:
                try:
                    failure = json.loads(result.stdout)
                except (json.JSONDecodeError, TypeError):
                    failure = None
                if (isinstance(failure, dict) and failure.get('status') == 'failed'
                        and failure.get('retry_safe') is True):
                    state_path.unlink(missing_ok=True)
                    raise ValueError('slack_attachment_send_rejected')
                if isinstance(failure, dict):
                    known_files = [failure.get('current_file', {})]
                    known_files += failure.get('completed_files', []) if isinstance(failure.get('completed_files'), list) else []
                    known_ids = [item['id'] for item in known_files if isinstance(item, dict)
                                 and isinstance(item.get('id'), str) and re.fullmatch(r'F[A-Z0-9]+', item['id'])]
                    receipt = {'version': 1, 'phase': 'attempting', 'attemptedAt': attempted_at,
                               'fileIds': list(dict.fromkeys(known_ids))}
                    stage = failure.get('delivery_phase')
                    if stage in ('get_upload_url', 'bytes_upload', 'complete_upload'):
                        receipt['deliveryPhase'] = stage
                    write_delivery_state(state_path, receipt)
                raise ValueError('slack_attachment_delivery_unknown')
            try:
                report = json.loads(result.stdout)
            except (json.JSONDecodeError, TypeError):
                raise ValueError('slack_attachment_delivery_unknown') from None
            if not isinstance(report, dict):
                raise ValueError('slack_attachment_delivery_unknown')
            uploaded = report.get('uploaded')
            if not isinstance(uploaded, list) or any(not isinstance(item, dict) for item in uploaded):
                raise ValueError('slack_attachment_delivery_unknown')
            file_ids = [item.get('id') for item in uploaded]
            actor, channel = report.get('actor'), report.get('channel')
            if (report.get('operation_status') != 'succeeded' or len(file_ids) != 1
                    or not isinstance(actor, dict) or actor.get('selected') != 'user'
                    or actor.get('team_id') != config['teamId']
                    or not isinstance(channel, dict) or channel.get('id') != envelope['eventPayload']['channelId']
                    or report.get('thread_ts') != envelope['eventPayload']['threadTs']
                    or not all(isinstance(value, str) and re.fullmatch(r'F[A-Z0-9]+', value)
                               for value in file_ids)):
                raise ValueError('slack_attachment_delivery_unknown')
            write_delivery_state(state_path, {'version': 1, 'phase': 'sent',
                                              'attemptedAt': attempted_at, 'fileIds': file_ids})
            return {'duplicate': False, 'count': len(file_ids), 'file_ids': file_ids}


def slack_timestamp(now=None):
    value = time.time() if now is None else now
    seconds = int(value)
    return f'{seconds}.{int((value-seconds)*1_000_000):06d}'


def main(argv=None, opener=urllib.request.urlopen, runner=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--issue-id', required=True)
    parser.add_argument('--comment-id')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--text-file')
    action.add_argument('--clear-start-reaction', action='store_true')
    action.add_argument('--session-status', choices=['processing', 'active', 'suspended'])
    parser.add_argument('--run-context-file')
    parser.add_argument('--github-context-file')
    parser.add_argument('--deliver-task-attachments', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--wakeup-run', action='store_true', help='Use the current verified scheduled run as a distinct delivery occurrence')
    parser.add_argument('--current-run', action='store_true',
                        help='Derive the trigger comment, scheduled wakeup and run statistics from MULTICA_TASK_ID')
    args = parser.parse_args(argv)
    config_path = Path(args.config)
    config = json.loads(config_path.read_text())
    occurrence, source_kind, collected_context = None, 'relay', None
    if args.current_run:
        if args.wakeup_run:
            raise ValueError('invalid_current_run_arguments')
        args.comment_id, args.wakeup_run = resolve_current_run(
            config, args.issue_id, args.comment_id, os.environ.get('MULTICA_TASK_ID'), runner)
        if args.clear_start_reaction and args.wakeup_run:
            # A scheduled run has no start reaction of its own; it may still have set processing.
            envelope = read_wakeup_source(config, args.issue_id, args.comment_id,
                                          os.environ.get('MULTICA_TASK_ID'), runner)[0]
            result = {'ok': True, 'action': 'not_applicable'}
            if not args.dry_run:
                result['session_status'] = update_session_status(
                    config, envelope, args.issue_id, 'active', runner, opener)
            print(json.dumps(result))
            return
        if args.text_file and not args.run_context_file:
            collected_context = collect_run_context(args.issue_id, runner)
            args.run_context_file = collected_context
    if args.wakeup_run:
        if args.clear_start_reaction:
            raise ValueError('invalid_cleanup_arguments')
        envelope, args.comment_id, occurrence = read_wakeup_source(
            config, args.issue_id, args.comment_id, os.environ.get('MULTICA_TASK_ID'), runner)
    elif args.clear_start_reaction and args.comment_id:
        envelope, source_kind = read_reply_source(config, args.issue_id, args.comment_id, runner)
    else:
        envelope = read_source(config, args.issue_id, args.comment_id, runner)
    if args.session_status:
        if args.dry_run:
            print(json.dumps({'ok': True, 'session_status': args.session_status, 'dry_run': True}))
        else:
            status = update_session_status(config, envelope, args.issue_id, args.session_status, runner, opener)
            print(json.dumps({'ok': status == args.session_status, 'session_status': status}))
        return
    if args.clear_start_reaction:
        if args.run_context_file or args.github_context_file or args.deliver_task_attachments:
            raise ValueError('invalid_cleanup_arguments')
        if source_kind in ('owner_comment', 'handoff'):
            # Only Relay messages get a start reaction; the root message's belongs to its own run.
            result = {'ok': True, 'action': 'not_applicable'}
        else:
            queued = 'dry_run' if args.dry_run else clear_queued_reaction(config, envelope, opener)
            result = clear_start_reaction(config, envelope, args.dry_run, opener)
            if not args.dry_run:
                result['queued_reaction'] = queued
        if not args.dry_run:
            result['session_status'] = update_session_status(config, envelope, args.issue_id, 'active', runner, opener)
        print(json.dumps(result))
        return
    identity = delivery_identity(config, args.issue_id, args.comment_id, occurrence)
    block_id = 'relay-delivery-' + identity
    try:
        stats = run_statistics(args.run_context_file, args.issue_id, os.environ.get('MULTICA_TASK_ID'), config)
    except (ValueError, OSError):
        if not collected_context:
            raise
        stats = None  # Self-collected statistics are best effort; the reply still goes out.
    finally:
        if collected_context:
            shutil.rmtree(Path(collected_context).parent, ignore_errors=True)
    github_rows = github_footers(args.github_context_file, config)
    payload = render_reply(config, envelope, Path(args.text_file).read_text(), block_id, stats, github_rows)
    attachments = None
    if args.deliver_task_attachments:
        attachments = task_attachments(config, args.issue_id, os.environ.get('MULTICA_TASK_ID'), runner)
    if args.dry_run:
        if attachments is not None:
            payload['attachment_count'] = len(attachments)
        print(json.dumps(payload, ensure_ascii=False))
        return
    token = os.environ.get('SLACK_USER_TOKEN')
    if not token:
        raise ValueError('slack_user_token_missing')
    state_path, lock_path = delivery_paths(config_path, identity)

    def finish(result):
        if attachments is not None:
            result['attachments'] = upload_task_attachments(
                config_path, config, envelope, identity, attachments, runner, token, opener)
        if config.get('sessionStatus') is not None:
            result['session_status'] = update_session_status(config, envelope, args.issue_id, 'active', runner, opener)
        result['queued_reaction'] = clear_queued_reaction(config, envelope, opener)
        print(json.dumps(result, ensure_ascii=False))

    with delivery_lock(lock_path):
        state = read_delivery_state(state_path)
        if state and state['phase'] == 'rate_limited':
            remaining = math.ceil(float(state['retryAt']) - time.time())
            if remaining > 0:
                raise SlackRateLimited(remaining)
        if state and state['phase'] == 'sent':
            finish({'ok': True, 'duplicate': True, 'channel': payload['channel'], 'message_ts': state['messageTs'],
                    'thread_ts': payload['thread_ts'], 'footer': payload['blocks'][-1]['elements'][0]['text']})
            return
        if state and state['phase'] == 'accepted':
            verified = find_delivered_reply(token, envelope, block_id, state['messageTs'], opener)
            if not verified:
                raise ValueError('slack_send_unverified')
            write_delivery_state(state_path, {'version': 1, 'phase': 'sent', 'messageTs': verified})
            finish({'ok': True, 'duplicate': True, 'channel': payload['channel'], 'message_ts': verified,
                    'thread_ts': payload['thread_ts'], 'footer': payload['blocks'][-1]['elements'][0]['text']})
            return
        if state and state['phase'] == 'attempting':
            existing = find_delivered_reply(token, envelope, block_id, state['lookupFromTs'], opener)
            if existing:
                write_delivery_state(state_path, {'version': 1, 'phase': 'sent', 'messageTs': existing})
                finish({'ok': True, 'duplicate': True, 'channel': payload['channel'], 'message_ts': existing,
                        'thread_ts': payload['thread_ts'], 'footer': payload['blocks'][-1]['elements'][0]['text']})
                return
            # Absence after an ambiguous POST is not proof that Slack did not commit it.
            raise ValueError('slack_delivery_unknown')
        verify_reply_root(token, envelope, opener)
        attempted_at = slack_timestamp()
        lookup_from = slack_timestamp(time.time() - 300)
        write_delivery_state(state_path, {'version': 1, 'phase': 'attempting', 'attemptedAt': attempted_at,
                                          'lookupFromTs': lookup_from})
        try:
            data = slack_call(token, 'chat.postMessage', payload=payload, opener=opener)
        except SlackRateLimited as error:
            write_delivery_state(state_path, {'version': 1, 'phase': 'rate_limited',
                                              'retryAt': slack_timestamp(time.time() + error.retry_after)})
            raise
        except ValueError as error:
            if str(error) == 'slack_send_rejected':
                state_path.unlink(missing_ok=True)
            raise
        message_ts = data.get('ts')
        if not isinstance(message_ts, str) or not re.fullmatch(r'\d+\.\d{1,6}', message_ts):
            raise ValueError('slack_send_unverified')
        write_delivery_state(state_path, {'version': 1, 'phase': 'accepted', 'messageTs': message_ts})
        verified = find_delivered_reply(token, envelope, block_id, message_ts, opener)
        if not verified:
            raise ValueError('slack_send_unverified')
        write_delivery_state(state_path, {'version': 1, 'phase': 'sent', 'messageTs': verified})
        finish({'ok': True, 'duplicate': False, 'channel': data.get('channel'), 'message_ts': verified,
                'thread_ts': payload['thread_ts'], 'footer': payload['blocks'][-1]['elements'][0]['text']})


if __name__ == '__main__':
    try:
        main()
    except SlackRateLimited as error:
        print(json.dumps({'ok': False, 'error': 'slack_rate_limited', 'retryable': True,
                          'retry_after_seconds': error.retry_after}), file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        # Never echo HTTP bodies, command output, authorization headers or private source content.
        message = str(error) if type(error) is ValueError and re.fullmatch(r'[a-z_]+', str(error)) else 'reply_failed_verify_before_retry'
        print(json.dumps({'ok': False, 'error': message}), file=sys.stderr)
        sys.exit(1)
