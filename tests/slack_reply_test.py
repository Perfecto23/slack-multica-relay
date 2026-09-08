import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('slack_reply', Path(__file__).resolve().parents[1] / 'scripts/slack-reply.py')
reply = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reply)
CONFIG = {'displayName': '🤖 Example', 'agentId': 'A1', 'teamId': 'T1'}
EVENT = {'teamId': 'T1', 'channelId': 'C1', 'threadTs': '100.000001'}


class ReplyTests(unittest.TestCase):
    def test_always_adds_attribution_even_with_no_model(self):
        result = reply.render_reply(CONFIG, {'eventPayload': EVENT}, 'hello')
        self.assertEqual(result['text'], 'hello\n\n🤖 Example')
        self.assertEqual(result['blocks'][-1], {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': '🤖 Example'}]})
        self.assertEqual(result['thread_ts'], EVENT['threadTs'])

    def test_display_name_is_the_complete_label(self):
        for label in ('🤖 Little Perf', ':wave: Changed', 'Changed'):
            config = {**CONFIG, 'displayName': label}
            result = reply.render_reply(config, {'eventPayload': EVENT}, 'hello')
            self.assertEqual(result['blocks'][-1]['elements'][0]['text'], label)
            self.assertEqual(result['text'], 'hello\n\n' + label)
        config = {**CONFIG, 'displayName': ':wave: Changed'}
        result = reply.render_reply(config, {'eventPayload': EVENT}, ':wave: Changed: hello')
        self.assertEqual(result['blocks'][0]['text']['text'], 'hello')
        result = reply.render_reply({**CONFIG, 'displayName': 'Changed'}, {'eventPayload': EVENT}, 'Changed the plan')
        self.assertEqual(result['blocks'][0]['text']['text'], 'Changed the plan')
        for invalid in (None, '', 'a' * 65, '<@U123>', '\n'):
            with self.assertRaises(ValueError):
                reply.render_reply({**CONFIG, 'displayName': invalid}, {'eventPayload': EVENT}, 'hello')

    def test_only_valid_snapshot_adds_model_and_fast(self):
        snapshot = {'type': 'slack_reply_context', 'source': 'agent_config', 'status': 'available', 'agentId': 'A1', 'model': 'model-test', 'serviceTier': 'priority'}
        envelope = {'eventPayload': EVENT, 'replyContext': snapshot}
        self.assertEqual(reply.footer_for(CONFIG, envelope), '🤖 Example · 配置模型：model-test · ⚡ Fast')
        snapshot['serviceTier'] = None
        self.assertNotIn('Fast', reply.footer_for(CONFIG, envelope))
        snapshot['agentId'] = 'wrong'
        self.assertEqual(reply.footer_for(CONFIG, envelope), '🤖 Example')

    def test_legacy_prefix_does_not_duplicate_and_quoted_body_survives(self):
        result = reply.render_reply(CONFIG, {'eventPayload': EVENT}, '🤖 Example：正文里引用 🤖 Example 不应被删除')
        self.assertEqual(result['blocks'][0]['text']['text'], '正文里引用 🤖 Example 不应被删除')
        self.assertEqual(result['blocks'][-1]['elements'][0]['text'], '🤖 Example')

    def test_scope_and_body_limits(self):
        with self.assertRaises(ValueError):
            reply.render_reply(CONFIG, {'eventPayload': {**EVENT, 'teamId': 'other'}}, 'hello')
        with self.assertRaises(ValueError):
            reply.render_reply(CONFIG, {'eventPayload': EVENT}, '')
        result = reply.render_reply(CONFIG, {'eventPayload': EVENT}, 'a' * 7000)
        self.assertTrue(all(len(block['text']['text']) <= 3000 for block in result['blocks'][:-1]))

    def test_legacy_and_current_payload_formats(self):
        payload = {'eventPayload': EVENT, 'context': {'selection': {'mode': 'focused'}}}
        raw = json.dumps(payload)
        self.assertEqual(reply.envelope_from_text('<!-- relay-thread:x -->\n' + raw), payload)
        text = '<!-- relay-thread:x -->\n## source\n<!-- relay-payload:v1 -->\n```json\n' + raw + '\n```\n<!-- /relay-payload -->'
        self.assertEqual(reply.envelope_from_text(text), payload)
        with self.assertRaises(ValueError):
            reply.envelope_from_text(text.replace('<!-- /relay-payload -->', ''))

    def test_main_reads_exact_comment_and_verifies_one_slack_send(self):
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        marker_text = '<!-- relay-message:x -->\n' + json.dumps(envelope)
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        commands, posted = [], []

        def runner(command, **_kwargs):
            commands.append(command)
            if command[5:8] == ['issue', 'get', 'I1']:
                body = {'workspace_id': 'W1', 'project_id': 'P1', 'assignee_id': 'A1',
                        'assignee_type': 'agent', 'description': 'unused'}
            else:
                self.assertEqual(command[5:12], ['issue', 'comment', 'list', 'I1', '--thread', 'C1', '--tail'])
                body = [{'id': 'C1', 'content': marker_text}]
            return subprocess.CompletedProcess(command, 0, json.dumps(body), '')

        lookup_count = 0
        def opener(request, timeout=0):
            nonlocal lookup_count
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 20)
            if request.full_url.endswith('/chat.postMessage'):
                posted.append(json.loads(request.data))
                body = {'ok': True, 'channel': 'C1', 'ts': '102.000001'}
            else:
                lookup_count += 1
                messages = [{'ts': '102.000001', 'blocks': posted[0]['blocks']}]
                body = {'ok': True, 'messages': messages, 'response_metadata': {'next_cursor': ''}}
            return io.BytesIO(json.dumps(body).encode())

        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); text_path.write_text('answer')
            output = io.StringIO()
            with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), redirect_stdout(output):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--comment-id', 'C1',
                            '--text-file', str(text_path)], opener=opener, runner=runner)
        self.assertEqual(len(posted), 1)
        self.assertTrue(posted[0]['blocks'][-1]['block_id'].startswith('relay-delivery-'))
        self.assertEqual(json.loads(output.getvalue())['duplicate'], False)
        self.assertEqual(len(commands), 2)

    def test_persisted_sent_delivery_skips_history_and_post_even_for_a_long_thread(self):
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        marker_text = '<!-- relay-thread:x -->\n' + json.dumps(envelope)
        def runner(command, **_kwargs):
            body = {'workspace_id': 'W1', 'project_id': 'P1', 'assignee_id': 'A1', 'assignee_type': 'agent',
                    'description': marker_text}
            return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
        def opener(request, timeout=0):
            self.fail('persisted sent delivery must not call Slack again')
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); text_path.write_text('answer')
            identity = reply.delivery_identity(config, 'I1', None)
            state_path, _ = reply.delivery_paths(config_path, identity)
            reply.write_delivery_state(state_path, {'version': 1, 'phase': 'sent', 'messageTs': '102.000001'})
            output = io.StringIO()
            with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), redirect_stdout(output):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(text_path)],
                           opener=opener, runner=runner)
        self.assertEqual(json.loads(output.getvalue())['duplicate'], True)

    def test_unknown_attempt_recovers_marker_from_attempt_time_without_posting(self):
        envelope = {'eventPayload': {**EVENT, 'messageTs': '1.000001'}}
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        marker_text = '<!-- relay-thread:x -->\n' + json.dumps(envelope)
        def runner(command, **_kwargs):
            body = {'workspace_id': 'W1', 'project_id': 'P1', 'assignee_id': 'A1', 'assignee_type': 'agent',
                    'description': marker_text}
            return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
        calls = []
        def opener(request, timeout=0):
            calls.append(request.full_url)
            self.assertIsNone(request.data)
            block_id = 'relay-delivery-' + reply.delivery_identity(config, 'I1', None)
            body = {'ok': True, 'messages': [{'ts': '102.000001', 'blocks': [
                {'type': 'context', 'block_id': block_id, 'elements': []}]}]}
            return io.BytesIO(json.dumps(body).encode())
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); text_path.write_text('answer')
            identity = reply.delivery_identity(config, 'I1', None)
            state_path, _ = reply.delivery_paths(config_path, identity)
            reply.write_delivery_state(state_path, {'version': 1, 'phase': 'attempting', 'attemptedAt': '100.000001',
                                                    'lookupFromTs': '1.000001'})
            output = io.StringIO()
            with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), redirect_stdout(output):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(text_path)],
                           opener=opener, runner=runner)
            self.assertEqual(reply.read_delivery_state(state_path)['phase'], 'sent')
        self.assertEqual(len(calls), 1)
        self.assertEqual(json.loads(output.getvalue())['duplicate'], True)

    def test_unknown_attempt_without_marker_never_reposts(self):
        envelope = {'eventPayload': {**EVENT, 'messageTs': '1.000001'}}
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        marker_text = '<!-- relay-thread:x -->\n' + json.dumps(envelope)
        def runner(command, **_kwargs):
            body = {'workspace_id': 'W1', 'project_id': 'P1', 'assignee_id': 'A1', 'assignee_type': 'agent',
                    'description': marker_text}
            return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
        calls = []
        def opener(request, timeout=0):
            calls.append((request.full_url, request.data))
            return io.BytesIO(json.dumps({'ok': True, 'messages': []}).encode())
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); text_path.write_text('answer')
            identity = reply.delivery_identity(config, 'I1', None)
            state_path, _ = reply.delivery_paths(config_path, identity)
            state = {'version': 1, 'phase': 'attempting', 'attemptedAt': '100.000001', 'lookupFromTs': '1.000001'}
            reply.write_delivery_state(state_path, state)
            with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}):
                with self.assertRaisesRegex(ValueError, 'slack_delivery_unknown'):
                    reply.main(['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(text_path)],
                               opener=opener, runner=runner)
            self.assertEqual(reply.read_delivery_state(state_path), state)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(calls[0][1])

    def test_delivery_state_syncs_file_and_parent_directory(self):
        real_fsync = os.fsync
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / 'config.json'; config_path.write_text('{}')
            state_path, _ = reply.delivery_paths(config_path, 'a' * 64)
            with patch.object(reply.os, 'fsync', side_effect=real_fsync) as synced:
                reply.write_delivery_state(state_path, {'version': 1, 'phase': 'sent', 'messageTs': '1.000001'})
            self.assertEqual(synced.call_count, 2)
            self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(state_path.parent.stat().st_mode & 0o777, 0o700)

    def test_delivery_lock_fails_fast_for_same_source(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / 'delivery.lock'
            with reply.delivery_lock(lock_path):
                with self.assertRaisesRegex(ValueError, 'reply_delivery_busy'):
                    reply.delivery_lock(lock_path)

    def test_source_read_rejects_wrong_issue_scope(self):
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        def runner(command, **_kwargs):
            body = {'workspace_id': 'OTHER', 'project_id': 'P1', 'assignee_id': 'A1', 'assignee_type': 'agent',
                    'description': '<!-- relay-thread:x -->\n{}'}
            return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
        with self.assertRaisesRegex(ValueError, 'invalid_issue_scope'):
            reply.read_source(config, 'I1', None, runner)


if __name__ == '__main__':
    unittest.main()
