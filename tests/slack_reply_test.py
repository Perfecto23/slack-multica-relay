import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.error import HTTPError
from email.message import Message
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('slack_reply', Path(__file__).resolve().parents[1] / 'scripts/slack-reply.py')
reply = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reply)
CONFIG = {'displayName': '🤖 Example', 'agentId': 'A1', 'teamId': 'T1'}
EVENT = {'teamId': 'T1', 'channelId': 'C1', 'threadTs': '100.000001'}


class StartReactionTests(unittest.TestCase):
    config = {'teamId': 'T1', 'startReaction': {'name': 'eyes', 'userId': 'U1', 'tokenEnv': 'SLACK_USER_TOKEN'}}
    envelope = {'eventPayload': {'teamId': 'T1', 'channelId': 'C1', 'messageTs': '2.000001', 'threadTs': '1.000001'}}

    def message(self, users):
        return {'ok': True, 'type': 'message', 'channel': 'C1', 'message': {
            'ts': '2.000001', 'reactions': [{'name': 'eyes', 'users': users, 'count': len(users)},
                                         {'name': 'heart', 'users': ['U1'], 'count': 1}]}}

    def run_cleanup(self, replies, dry_run=False):
        with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'test'}), patch.object(reply, 'slack_call', side_effect=replies) as call:
            result = reply.clear_start_reaction(self.config, self.envelope, dry_run)
        return result, call

    def test_removes_only_configured_actor_emoji_on_current_message_and_verifies(self):
        result, call = self.run_cleanup([{'user_id': 'U1', 'team_id': 'T1'}, self.message(['U1', 'U2']), {'ok': True}, self.message(['U2'])])
        self.assertEqual(result, {'ok': True, 'action': 'removed'})
        self.assertEqual([c.args[1] for c in call.call_args_list], ['auth.test', 'reactions.get', 'reactions.remove', 'reactions.get'])
        self.assertEqual(call.call_args_list[2].kwargs['payload'], {'channel': 'C1', 'timestamp': '2.000001', 'name': 'eyes'})

    def test_wrong_actor_prevents_read_and_remove(self):
        with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'test'}), patch.object(reply, 'slack_call', return_value={'user_id': 'U2', 'team_id': 'T1'}) as call:
            with self.assertRaisesRegex(ValueError, 'reaction_actor_mismatch'):
                reply.clear_start_reaction(self.config, self.envelope)
            self.assertEqual(call.call_count, 1)

    def test_already_absent_and_dry_run_make_no_writes(self):
        for users, dry_run, action in [(['U2'], False, 'already_absent'), (['U1'], True, 'would_remove')]:
            result, call = self.run_cleanup([{'user_id': 'U1', 'team_id': 'T1'}, self.message(users)], dry_run)
            self.assertEqual(result['action'], action)
            self.assertEqual(call.call_count, 2)

    def test_uncertain_remove_reads_back_without_repeating_write(self):
        result, call = self.run_cleanup([{'user_id': 'U1', 'team_id': 'T1'}, self.message(['U1']), TimeoutError(), self.message([])])
        self.assertEqual(result['action'], 'removed')
        self.assertEqual(sum(c.args[1] == 'reactions.remove' for c in call.call_args_list), 1)

    def test_still_present_after_remove_is_not_success(self):
        with self.assertRaisesRegex(ValueError, 'reaction_cleanup_unverified'):
            self.run_cleanup([{'user_id': 'U1', 'team_id': 'T1'}, self.message(['U1']), {'ok': True}, self.message(['U1'])])

    def test_other_message_or_channel_cannot_be_cleaned(self):
        for key in ['ts', 'channel']:
            data = self.message(['U1'])
            if key == 'ts': data['message']['ts'] = '1.000001'
            else: data['channel'] = 'C2'
            with self.assertRaisesRegex(ValueError, 'reaction_message_mismatch'):
                self.run_cleanup([{'user_id': 'U1', 'team_id': 'T1'}, data])

    def test_missing_config_or_cross_team_source_never_calls_slack(self):
        for config, envelope, code in [({}, self.envelope, 'invalid_start_reaction_config'),
                (self.config, {'eventPayload': {**self.envelope['eventPayload'], 'teamId': 'T2'}}, 'invalid_reaction_source')]:
            with patch.object(reply, 'slack_call') as call, self.assertRaisesRegex(ValueError, code):
                reply.clear_start_reaction(config, envelope)
            call.assert_not_called()


class WakeupDeliveryTests(unittest.TestCase):
    config = {'workspaceId': 'W1', 'projectId': 'P1', 'agentId': 'A1'}
    run_id = '11111111-1111-4111-8111-111111111111'

    def source(self, run_changes=None, rule_changes=None, comment_id='C1'):
        run = {'id': self.run_id, 'issue_id': 'I1', 'workspace_id': 'W1', 'status': 'running',
               'agent_id': 'A1', 'wakeup_id': 'WUP1', 'trigger_comment_id': 'C1', **(run_changes or {})}
        rule = {'id': 'WUP1', 'issue_id': 'I1', 'workspace_id': 'W1', 'agent_id': 'A1',
                'kind': 'cron', 'parent_comment_id': 'C1', **(rule_changes or {})}
        with patch.object(reply, 'multica_json', side_effect=[[run], rule]), patch.object(reply, 'read_reply_source', return_value=({'eventPayload': EVENT}, 'relay')) as read:
            result = reply.read_wakeup_source(self.config, 'I1', comment_id, self.run_id)
            read.assert_called_once_with(self.config, 'I1', 'C1', reply.subprocess.run)
            return result

    def test_scheduled_occurrence_keeps_route_but_has_its_own_stable_delivery_identity(self):
        envelope, comment_id, occurrence = self.source()
        self.assertEqual(envelope['eventPayload'], EVENT)
        self.assertEqual(comment_id, 'C1')
        original = reply.delivery_identity(self.config, 'I1', 'C1')
        scheduled = reply.delivery_identity(self.config, 'I1', 'C1', occurrence)
        self.assertNotEqual(original, scheduled)
        self.assertEqual(scheduled, reply.delivery_identity(self.config, 'I1', 'C1', occurrence))
        self.assertNotEqual(scheduled, reply.delivery_identity(self.config, 'I1', 'C1', occurrence + '-next'))

    def test_manual_or_completed_or_foreign_run_cannot_get_a_new_delivery_identity(self):
        for changes in [{'wakeup_id': None}, {'status': 'completed'}, {'issue_id': 'I2'}, {'workspace_id': 'W2'}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'invalid_wakeup_run'):
                self.source(run_changes=changes)

    def test_rule_and_source_must_match_the_actual_run(self):
        for changes in [{'agent_id': 'A2'}, {'parent_comment_id': 'OTHER'}, {'kind': 'event'}, {'issue_id': 'I2'}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'invalid_wakeup_source'):
                self.source(rule_changes=changes)
        with self.assertRaisesRegex(ValueError, 'wakeup_comment_mismatch'):
            self.source(comment_id='OTHER')


class SessionStatusTests(unittest.TestCase):
    config = {'teamId': 'T1', 'sessionStatus': {'userId': 'U1', 'tokenEnv': 'SLACK_BOT_TOKEN'}}
    envelope = {'eventPayload': EVENT}

    def test_completed_reply_clears_own_session_using_bot_identity(self):
        with patch.dict(os.environ, {'SLACK_BOT_TOKEN': 'test', 'MULTICA_TASK_ID': 'R1'}), \
                patch.object(reply, 'multica_json', return_value=[{'id': 'R1', 'status': 'running'}]), \
                patch.object(reply, 'slack_call', side_effect=[{'team_id': 'T1', 'user_id': 'U1'}, {'ok': True}]) as call:
            self.assertEqual(reply.update_session_status(self.config, self.envelope, 'I1', 'active'), 'active')
            self.assertEqual(call.call_args_list[-1].kwargs['payload'], {'channel_id': 'C1', 'thread_ts': '100.000001', 'status': 'active'})

    def test_older_run_does_not_clear_a_newer_active_run(self):
        with patch.dict(os.environ, {'SLACK_BOT_TOKEN': 'test', 'MULTICA_TASK_ID': 'R1'}), \
                patch.object(reply, 'multica_json', return_value=[{'id': 'R1', 'status': 'running'}, {'id': 'R2', 'status': 'queued'}]), \
                patch.object(reply, 'slack_call') as call:
            self.assertEqual(reply.update_session_status(self.config, self.envelope, 'I1', 'active'), 'other_run_active')
            call.assert_not_called()

    def test_presentation_failure_does_not_turn_sent_reply_into_a_send_retry(self):
        with patch.dict(os.environ, {'SLACK_BOT_TOKEN': 'test'}), patch.object(reply, 'slack_call', side_effect=TimeoutError()):
            self.assertEqual(reply.update_session_status(self.config, self.envelope, 'I1', 'processing'), 'unavailable')


class ReplyTests(unittest.TestCase):
    def test_renders_verified_run_statistics_and_github_association(self):
        context = {'version': 1, 'issue_id': 'I1', 'run_id': 'R1', 'issue_identifier': 'DEMO-12', 'issue_url': 'https://multica.example/demo/issues/I1', 'statistics': {
            'duration_seconds': 187, 'model': 'gpt-6-astra', 'model_source': 'agent_config',
            'tools': 18, 'skills': 1}}
        github = {'version': 1, 'pullRequests': [{
            'repository': 'example/app', 'branch': 'feature/calendar',
            'number': 123, 'url': 'https://github.com/example/app/pull/123'}]}
        with tempfile.TemporaryDirectory() as directory:
            run_path, github_path = Path(directory) / 'run.json', Path(directory) / 'github.json'
            run_path.write_text(json.dumps(context)); github_path.write_text(json.dumps(github))
            stats = reply.run_statistics(run_path, 'I1', 'R1')
            rows = reply.github_footers(github_path)
        result = reply.render_reply(CONFIG, {'eventPayload': EVENT}, 'approved', statistics=stats, github_rows=rows)
        self.assertEqual(result['blocks'][-3]['elements'][0]['text'],
                         '⏱️ 3m 07s · 🤖 gpt-6-astra · 🔧 18 tools · 🪄 1 skills · ↗️ <https://multica.example/demo/issues/I1|DEMO-12>')
        self.assertEqual(result['blocks'][-2]['elements'][0]['text'],
                         '🔗 app · `feature/calendar` · <https://github.com/example/app/pull/123|PR #123>')
        self.assertEqual(result['blocks'][-1]['elements'][0]['text'], '🤖 Example')
        self.assertIn('PR #123', result['text'])

    def test_private_icons_and_verified_branch_without_pr_render_once(self):
        config = {**CONFIG, 'icons': {'github': ':custom_github:'}}
        github = {'version': 1, 'pullRequests': [], 'branches': [
            {'repository': 'owner/repo', 'branch': 'feature/a&b'},
            {'repository': 'owner/repo', 'branch': 'feature/a&b'}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'github.json'
            path.write_text(json.dumps(github))
            rows = reply.github_footers(path, config)
        result = reply.render_reply(config, {'eventPayload': EVENT}, 'branch ready', github_rows=rows)
        self.assertEqual(rows, [':custom_github: repo · `feature/a&amp;b`'])
        self.assertIn(rows[0], result['text'])
        self.assertNotIn('PR #', result['text'])

    def test_foreign_issue_link_is_omitted_without_losing_statistics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'run.json'
            path.write_text(json.dumps({'version': 1, 'issue_id': 'I1', 'run_id': 'R1',
                'issue_identifier': 'DEMO-12', 'issue_url': 'https://multica.example/demo/issues/OTHER',
                'statistics': {'tools': 2}}))
            footer = reply.run_statistics(path, 'I1', 'R1')
        self.assertEqual(footer, '🔧 2 tools')

    def test_rejects_unscoped_run_context_and_mismatched_github_link(self):
        with tempfile.TemporaryDirectory() as directory:
            run_path, github_path = Path(directory) / 'run.json', Path(directory) / 'github.json'
            run_path.write_text(json.dumps({'version': 1, 'issue_id': 'other', 'statistics': {}}))
            github_path.write_text(json.dumps({'version': 1, 'pullRequests': [{
                'repository': 'owner/repo', 'branch': 'feature', 'number': 1,
                'url': 'https://github.com/other/repo/pull/1'}]}))
            with self.assertRaisesRegex(ValueError, 'invalid_run_context'):
                reply.run_statistics(run_path, 'I1')
            run_path.write_text(json.dumps({'version': 1, 'issue_id': 'I1', 'run_id': 'other', 'statistics': {}}))
            with self.assertRaisesRegex(ValueError, 'invalid_run_context'):
                reply.run_statistics(run_path, 'I1', 'R1')
            with self.assertRaisesRegex(ValueError, 'invalid_github_context'):
                reply.github_footers(github_path)

    def test_always_adds_attribution_even_with_no_model(self):
        result = reply.render_reply(CONFIG, {'eventPayload': EVENT}, 'hello')
        self.assertEqual(result['text'], 'hello\n\n🤖 Example')
        self.assertEqual(result['blocks'][-1], {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': '🤖 Example'}]})
        self.assertEqual(result['thread_ts'], EVENT['threadTs'])

    def test_display_name_is_the_complete_label(self):
        for label in ('🤖 Relay Assistant', ':wave: Changed', 'Changed'):
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

    def test_compact_schema_5_keeps_reply_route_and_footer(self):
        payload = {'schemaVersion': 5, 'eventPayload': EVENT,
                   'context': {'timeline': {'messages': [
                       {'ts': '100.000001', 'authorId': 'U1', 'text': 'hello'}]}}}
        text = '<!-- relay-thread:x -->\n<!-- relay-payload:v1 -->\n```json\n' + json.dumps(payload, separators=(',', ':')) + '\n```\n<!-- /relay-payload -->'
        parsed = reply.envelope_from_text(text)
        rendered = reply.render_reply(CONFIG, parsed, 'result')
        self.assertEqual(rendered['channel'], EVENT['channelId'])
        self.assertEqual(rendered['thread_ts'], EVENT['threadTs'])
        self.assertEqual(rendered['blocks'][-1]['elements'][0]['text'], CONFIG['displayName'])

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
                messages = ([{'ts': '100.000001'}] if lookup_count == 1 else
                            [{'ts': '102.000001', 'blocks': posted[0]['blocks']}])
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
        self.assertEqual(lookup_count, 2)

    def test_fresh_send_rejects_missing_exact_thread_before_post(self):
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        calls = []
        def opener(request, timeout=0):
            calls.append((request.get_method(), request.data))
            return io.BytesIO(json.dumps({'ok': True, 'messages': [{'ts': '99.000001'}]}).encode())
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); text_path.write_text('answer')
            with patch.object(reply, 'read_source', return_value=envelope), \
                    patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}):
                with self.assertRaisesRegex(ValueError, 'slack_thread_not_found'):
                    reply.main(['--config', str(config_path), '--issue-id', 'I1',
                                '--text-file', str(text_path)], opener=opener)
        self.assertEqual(calls, [('GET', None)])

    def test_delivers_only_current_task_attachments_through_slack_skill(self):
        task_id = '11111111-1111-4111-8111-111111111111'
        attachment_id = '22222222-2222-4222-8222-222222222222'
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        calls, posted = [], []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slack_cli = root / 'slack.py'; slack_cli.write_text('# fake')
            config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                      'serverUrl': 'https://multica.test', 'slackCliPath': str(slack_cli)}
            config_path, text_path = root / 'config.json', root / 'body.txt'
            config_path.write_text(json.dumps(config)); text_path.write_text('answer')

            def runner(command, **kwargs):
                calls.append(command)
                if command[0] == 'multica' and command[5:8] == ['issue', 'comment', 'list']:
                    self.assertNotIn('--roots-only', command)
                    self.assertIn('--full', command)
                    body = [
                        {'source_task_id': '33333333-3333-4333-8333-333333333333', 'attachments': [
                            {'id': '44444444-4444-4444-8444-444444444444',
                             'filename': 'stale.xlsx', 'size_bytes': 5}]},
                        {'source_task_id': task_id, 'parent_id': 'trigger-comment', 'attachments': [
                            {'id': attachment_id, 'filename': 'report.xlsx', 'size_bytes': 5}]},
                    ]
                    return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
                if command[0] == 'multica' and command[5:7] == ['attachment', 'download']:
                    output_dir = Path(command[command.index('--output-dir') + 1])
                    (output_dir / 'report.xlsx').write_bytes(b'abcde')
                    return subprocess.CompletedProcess(command, 0, 'downloaded', '')
                if command[:2] == [sys.executable, str(slack_cli)]:
                    self.assertEqual(kwargs['env']['SLACK_SKILL_ALLOWED_CHANNELS'], 'C1')
                    self.assertIn('files_upload', command)
                    self.assertEqual(command[command.index('--as') + 1], 'user')
                    self.assertEqual(command[command.index('--thread-ts') + 1], '100.000001')
                    self.assertEqual(command.count('--file'), 1)
                    self.assertEqual(command.count('--sha256'), 1)
                    body = {'operation_status': 'succeeded', 'uploaded': [{'id': 'F123ABC'}],
                            'actor': {'selected': 'user', 'team_id': 'T1'},
                            'channel': {'id': 'C1'}, 'thread_ts': '100.000001'}
                    return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
                self.fail(f'unexpected command: {command}')

            lookup_count = 0
            def opener(request, timeout=0):
                nonlocal lookup_count
                if request.data is not None:
                    posted.append(json.loads(request.data))
                    return io.BytesIO(json.dumps({'ok': True, 'channel': 'C1', 'ts': '102.000001'}).encode())
                lookup_count += 1
                messages = ([{'ts': '100.000001'}] if 'limit=1' in request.full_url else
                            [{'ts': '102.000001', 'blocks': posted[0]['blocks']}])
                return io.BytesIO(json.dumps({'ok': True, 'messages': messages}).encode())

            output = io.StringIO()
            with patch.object(reply, 'read_source', return_value=envelope), \
                    patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test', 'MULTICA_TASK_ID': task_id}), \
                    redirect_stdout(output):
                reply.main(['--config', str(config_path), '--issue-id', 'I1',
                            '--text-file', str(text_path), '--deliver-task-attachments'],
                           opener=opener, runner=runner)
            report = json.loads(output.getvalue())
            self.assertEqual(report['attachments'],
                             {'duplicate': False, 'count': 1, 'file_ids': ['F123ABC']})
            self.assertEqual(len([call for call in calls if 'files_upload' in call]), 1)

    def test_attachment_attempting_state_never_reuploads(self):
        attachments = [{'id': '22222222-2222-4222-8222-222222222222',
                        'filename': 'report.xlsx', 'size_bytes': 5}]
        envelope = {'eventPayload': EVENT}
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                  'serverUrl': 'https://multica.test', 'slackCliPath': '/unused/slack.py'}
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / 'config.json'; config_path.write_text(json.dumps(config))
            identity = reply.delivery_identity(config, 'I1', None)
            state_path, _ = reply.attachment_delivery_paths(config_path, identity, attachments[0])
            reply.write_delivery_state(state_path, {'version': 1, 'phase': 'attempting',
                                                    'attemptedAt': '100.000001'})
            with self.assertRaisesRegex(ValueError, 'slack_attachment_delivery_unknown'):
                reply.upload_task_attachments(config_path, config, envelope, identity, attachments,
                                              runner=lambda *_args, **_kwargs: self.fail('must not retry'))

    def test_retry_safe_attachment_rejection_clears_intent(self):
        attachments = [{'id': '22222222-2222-4222-8222-222222222222',
                        'filename': 'report.xlsx', 'size_bytes': 5}]
        envelope = {'eventPayload': EVENT}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slack_cli = root / 'slack.py'; slack_cli.write_text('# fake')
            config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                      'serverUrl': 'https://multica.test', 'slackCliPath': str(slack_cli)}
            config_path = root / 'config.json'; config_path.write_text(json.dumps(config))
            identity = reply.delivery_identity(config, 'I1', None)
            def runner(command, **_kwargs):
                if command[0] == 'multica':
                    output_dir = Path(command[command.index('--output-dir') + 1])
                    (output_dir / 'report.xlsx').write_bytes(b'abcde')
                    return subprocess.CompletedProcess(command, 0, 'downloaded', '')
                failure = {'status': 'failed', 'operation_status': 'failed', 'retry_safe': True,
                           'reason': 'missing_scope'}
                return subprocess.CompletedProcess(command, 4, json.dumps(failure), '')
            with patch.object(reply, 'verify_reply_root'), \
                    self.assertRaisesRegex(ValueError, 'slack_attachment_send_rejected'):
                reply.upload_task_attachments(config_path, config, envelope, identity, attachments,
                                              runner=runner, token='xoxp-test')
            state_path, _ = reply.attachment_delivery_paths(config_path, identity, attachments[0])
            self.assertFalse(state_path.exists())

    def test_sent_body_does_not_allow_upload_to_a_deleted_root(self):
        task_id = '11111111-1111-4111-8111-111111111111'
        attachment = {'id': '22222222-2222-4222-8222-222222222222',
                      'filename': 'report.xlsx', 'size_bytes': 5}
        envelope = {'eventPayload': EVENT}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slack_cli = root / 'slack.py'; slack_cli.write_text('# fake')
            config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                      'serverUrl': 'https://multica.test', 'slackCliPath': str(slack_cli)}
            config_path = root / 'config.json'; config_path.write_text(json.dumps(config))
            body = root / 'body.txt'; body.write_text('answer')
            identity = reply.delivery_identity(config, 'I1', None)
            state_path, _ = reply.delivery_paths(config_path, identity)
            reply.write_delivery_state(state_path, {'version': 1, 'phase': 'sent', 'messageTs': '102.000001'})
            def runner(command, **_kwargs):
                self.assertEqual(command[5:7], ['attachment', 'download'])
                output_dir = Path(command[command.index('--output-dir') + 1])
                (output_dir / 'report.xlsx').write_bytes(b'abcde')
                return subprocess.CompletedProcess(command, 0, '', '')
            def opener(request, **_kwargs):
                self.assertIsNone(request.data)
                return io.BytesIO(b'{"ok":true,"messages":[]}')
            with patch.object(reply, 'read_source', return_value=envelope), \
                    patch.object(reply, 'task_attachments', return_value=[attachment]), \
                    patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test', 'MULTICA_TASK_ID': task_id}), \
                    self.assertRaisesRegex(ValueError, 'slack_thread_not_found'):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(body),
                            '--deliver-task-attachments'], runner=runner, opener=opener)
            attachment_state, _ = reply.attachment_delivery_paths(config_path, identity, attachment)
            self.assertFalse(attachment_state.exists())
            self.assertEqual(reply.read_delivery_state(state_path)['phase'], 'sent')

    def test_attachment_receipts_survive_reordering_and_added_files(self):
        attachments = [{'id': f'{index}' * 8 + '-2222-4222-8222-222222222222',
                        'filename': f'{index}.txt', 'size_bytes': 5} for index in (1, 2, 3)]
        envelope = {'eventPayload': EVENT}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slack_cli = root / 'slack.py'; slack_cli.write_text('# fake')
            config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                      'serverUrl': 'https://multica.test', 'slackCliPath': str(slack_cli)}
            config_path = root / 'config.json'; config_path.write_text(json.dumps(config))
            identity = reply.delivery_identity(config, 'I1', None)
            uploads = []
            def runner(command, **_kwargs):
                if command[0] == 'multica':
                    item = next(item for item in attachments if item['id'] in command)
                    output_dir = Path(command[command.index('--output-dir') + 1])
                    (output_dir / item['filename']).write_bytes(b'abcde')
                    return subprocess.CompletedProcess(command, 0, '', '')
                name = Path(command[command.index('--file') + 1]).name
                uploads.append(name)
                report = {'operation_status': 'succeeded', 'uploaded': [{'id': 'F' + name[0]}],
                          'actor': {'selected': 'user', 'team_id': 'T1'},
                          'channel': {'id': 'C1'}, 'thread_ts': '100.000001'}
                return subprocess.CompletedProcess(command, 0, json.dumps(report), '')
            with patch.object(reply, 'verify_reply_root'):
                reply.upload_task_attachments(config_path, config, envelope, identity, attachments[:2],
                                              runner=runner, token='xoxp-test')
                result = reply.upload_task_attachments(config_path, config, envelope, identity, attachments[::-1],
                                                      runner=runner, token='xoxp-test')
            self.assertEqual(uploads, ['1.txt', '2.txt', '3.txt'])
            self.assertEqual(result['count'], 3)

    def test_unknown_attachment_result_is_not_repeated_after_collection_changes(self):
        attachment = {'id': '22222222-2222-4222-8222-222222222222',
                      'filename': 'report.xlsx', 'size_bytes': 5}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slack_cli = root / 'slack.py'; slack_cli.write_text('# fake')
            config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                      'serverUrl': 'https://multica.test', 'slackCliPath': str(slack_cli)}
            config_path = root / 'config.json'; config_path.write_text(json.dumps(config))
            identity = reply.delivery_identity(config, 'I1', None)
            uploads = []
            def runner(command, **_kwargs):
                if command[0] == 'multica':
                    output_dir = Path(command[command.index('--output-dir') + 1])
                    (output_dir / 'report.xlsx').write_bytes(b'abcde')
                    return subprocess.CompletedProcess(command, 0, '', '')
                uploads.append(command)
                raise subprocess.TimeoutExpired(command, 180)
            with patch.object(reply, 'verify_reply_root'):
                for items in ([attachment], [attachment, {**attachment, 'id': '33333333-3333-4333-8333-333333333333'}]):
                    with self.assertRaisesRegex(ValueError, 'slack_attachment_delivery_unknown'):
                        reply.upload_task_attachments(config_path, config, {'eventPayload': EVENT}, identity, items,
                                                      runner=runner, token='xoxp-test')
            self.assertEqual(len(uploads), 1)

    def test_upload_unknown_keeps_file_id_and_rejects_mismatched_success(self):
        attachment = {'id': '22222222-2222-4222-8222-222222222222',
                      'filename': 'report.xlsx', 'size_bytes': 5}
        cases = [
            (5, {'status': 'unknown', 'retry_safe': False, 'delivery_phase': 'complete_upload',
                 'completed_files': [{'id': 'F123', 'title': 'private filename'}]}),
            (0, {'operation_status': 'succeeded', 'uploaded': [{'id': 'F123'}],
                 'actor': {'selected': 'user', 'team_id': 'T1'},
                 'channel': {'id': 'C1'}, 'thread_ts': '999.000001'}),
            (0, []),
        ]
        for returncode, report in cases:
            with self.subTest(report=report), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                slack_cli = root / 'slack.py'; slack_cli.write_text('# fake')
                config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1',
                          'serverUrl': 'https://multica.test', 'slackCliPath': str(slack_cli)}
                config_path = root / 'config.json'; config_path.write_text(json.dumps(config))
                identity = reply.delivery_identity(config, 'I1', None)
                def runner(command, **_kwargs):
                    if command[0] == 'multica':
                        output_dir = Path(command[command.index('--output-dir') + 1])
                        (output_dir / 'report.xlsx').write_bytes(b'abcde')
                        return subprocess.CompletedProcess(command, 0, '', '')
                    return subprocess.CompletedProcess(command, returncode, json.dumps(report), '')
                with patch.object(reply, 'verify_reply_root'), \
                        self.assertRaisesRegex(ValueError, 'slack_attachment_delivery_unknown'):
                    reply.upload_task_attachments(config_path, config, {'eventPayload': EVENT}, identity,
                                                  [attachment], runner=runner, token='xoxp-test')
                state_path, _ = reply.attachment_delivery_paths(config_path, identity, attachment)
                receipt = reply.read_attachment_state(state_path)
                self.assertEqual(receipt['phase'], 'attempting')
                if returncode:
                    self.assertEqual(receipt['fileIds'], ['F123'])
                    self.assertEqual(receipt['deliveryPhase'], 'complete_upload')
                    self.assertNotIn('private filename', state_path.read_text())

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

    def test_ambiguous_send_results_keep_intent_and_recover_without_another_post(self):
        cases = ['internal_error', 'fatal_error', 'service_unavailable', 'unrecognized_error', 'malformed', 'http_503']
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        for failure in cases:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                config_path, body_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
                config_path.write_text(json.dumps(config)); body_path.write_text('answer')
                calls, posted = [], []
                def opener(request, timeout=0):
                    calls.append(request.get_method())
                    if request.data is not None:
                        posted.append(json.loads(request.data))
                        if failure == 'http_503':
                            raise HTTPError(request.full_url, 503, 'unavailable', {}, io.BytesIO(b'private response'))
                        if failure == 'malformed':
                            return io.BytesIO(b'not json')
                        return io.BytesIO(json.dumps({'ok': False, 'error': failure}).encode())
                    return io.BytesIO(json.dumps({'ok': True, 'messages': [
                        {'ts': '102.000001', 'blocks': posted[0]['blocks']}]}).encode())
                args = ['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(body_path)]
                with patch.object(reply, 'read_source', return_value=envelope), \
                        patch.object(reply, 'verify_reply_root'), \
                        patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), redirect_stdout(io.StringIO()):
                    with self.assertRaises((ValueError, OSError)):
                        reply.main(args, opener=opener)
                    state_path, _ = reply.delivery_paths(config_path, reply.delivery_identity(config, 'I1', None))
                    self.assertEqual(reply.read_delivery_state(state_path)['phase'], 'attempting')
                    reply.main(args, opener=opener)
                    self.assertEqual(reply.read_delivery_state(state_path)['phase'], 'sent')
                self.assertEqual(calls, ['POST', 'GET'])

    def test_rate_limits_persist_retry_after_then_allow_a_single_send(self):
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        for error_code in ('http_429', 'rate_limited', 'ratelimited'):
            with self.subTest(error_code=error_code), tempfile.TemporaryDirectory() as directory:
                config_path, body_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
                config_path.write_text(json.dumps(config)); body_path.write_text('answer')
                calls, posted = [], []
                def opener(request, timeout=0):
                    calls.append(request.get_method())
                    if len(calls) == 1:
                        headers = Message(); headers['Retry-After'] = '30'
                        if error_code == 'http_429':
                            raise HTTPError(request.full_url, 429, 'Too Many Requests', headers, io.BytesIO(b'ratelimited'))
                        response = io.BytesIO(json.dumps({'ok': False, 'error': error_code}).encode())
                        response.headers = headers
                        return response
                    if request.data is not None:
                        posted.append(json.loads(request.data))
                        return io.BytesIO(json.dumps({'ok': True, 'channel': 'C1', 'ts': '131.000001'}).encode())
                    return io.BytesIO(json.dumps({'ok': True, 'messages': [
                        {'ts': '131.000001', 'blocks': posted[0]['blocks']}]}).encode())
                args = ['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(body_path)]
                with patch.object(reply, 'read_source', return_value=envelope), \
                        patch.object(reply, 'verify_reply_root'), \
                        patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), \
                        patch.object(reply.time, 'time', return_value=1000.0) as now, redirect_stdout(io.StringIO()):
                    with self.assertRaises((ValueError, OSError)):
                        reply.main(args, opener=opener)
                    state_path, _ = reply.delivery_paths(config_path, reply.delivery_identity(config, 'I1', None))
                    self.assertEqual(reply.read_delivery_state(state_path)['phase'], 'rate_limited')
                    now.return_value = 1010.0
                    with self.assertRaisesRegex(ValueError, 'slack_rate_limited'):
                        reply.main(args, opener=opener)
                    self.assertEqual(calls, ['POST'])
                    now.return_value = 1030.0
                    reply.main(args, opener=opener)
                    self.assertEqual(reply.read_delivery_state(state_path)['phase'], 'sent')
                self.assertEqual(calls, ['POST', 'POST', 'GET'])
                self.assertEqual(len(posted), 1)


    def test_definite_json_rejection_allows_a_later_corrected_send(self):
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        with tempfile.TemporaryDirectory() as directory:
            config_path, body_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); body_path.write_text('answer')
            calls, posted = [], []
            def opener(request, timeout=0):
                calls.append(request.get_method())
                if len(calls) == 1:
                    return io.BytesIO(b'{"ok":false,"error":"invalid_blocks"}')
                if request.data is not None:
                    posted.append(json.loads(request.data))
                    return io.BytesIO(b'{"ok":true,"channel":"C1","ts":"102.000001"}')
                return io.BytesIO(json.dumps({'ok': True, 'messages': [
                    {'ts': '102.000001', 'blocks': posted[0]['blocks']}]}).encode())
            args = ['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(body_path)]
            with patch.object(reply, 'read_source', return_value=envelope), \
                    patch.object(reply, 'verify_reply_root'), \
                    patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, 'slack_send_rejected'):
                    reply.main(args, opener=opener)
                body_path.write_text('corrected body')
                reply.main(args, opener=opener)
            self.assertEqual(calls, ['POST', 'POST', 'GET'])
            self.assertEqual(len(posted), 1)

    def test_rate_limited_readback_keeps_the_accepted_send(self):
        config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
        envelope = {'eventPayload': {**EVENT, 'messageTs': '101.000001'}}
        with tempfile.TemporaryDirectory() as directory:
            config_path, body_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(config)); body_path.write_text('answer')
            identity = reply.delivery_identity(config, 'I1', None)
            state_path, _ = reply.delivery_paths(config_path, identity)
            state = {'version': 1, 'phase': 'accepted', 'messageTs': '102.000001'}
            reply.write_delivery_state(state_path, state)
            def opener(request, timeout=0):
                self.assertIsNone(request.data)
                headers = Message(); headers['Retry-After'] = '30'
                raise HTTPError(request.full_url, 429, 'Too Many Requests', headers, io.BytesIO())
            args = ['--config', str(config_path), '--issue-id', 'I1', '--text-file', str(body_path)]
            with patch.object(reply, 'read_source', return_value=envelope), patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}):
                with self.assertRaisesRegex(ValueError, 'slack_rate_limited'):
                    reply.main(args, opener=opener)
            self.assertEqual(reply.read_delivery_state(state_path), state)

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


OWNER = '244bf422-d836-43a3-96cf-36533e64d17d'


class OwnerCommentSourceTests(unittest.TestCase):
    config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test',
              'ownerMulticaUserId': OWNER}
    thread = {'eventPayload': {**EVENT, 'messageTs': '100.000001'}}

    def runner(self, comment, nested=False, description=None):
        commands = []
        def run(command, **_kwargs):
            commands.append(command)
            if command[5:8] == ['issue', 'get', 'I1']:
                body = {'workspace_id': 'W1', 'project_id': 'P1', 'assignee_id': 'A1', 'assignee_type': 'agent',
                        'description': description if description is not None
                        else '<!-- relay-thread:x -->\n' + json.dumps(self.thread)}
            elif '--tail' in command:
                body = [{'id': 'ROOT', 'author_type': 'agent', 'content': 'agent result'}] if nested else [comment]
            else:
                body = [{'id': 'ROOT', 'author_type': 'agent', 'content': 'agent result'}, comment]
            return subprocess.CompletedProcess(command, 0, json.dumps(body), '')
        return run, commands

    def comment(self, **fields):
        return {'id': 'C9', 'issue_id': 'I1', 'author_type': 'member', 'author_id': OWNER,
                'content': '回 Slack 说已经处理好了', **fields}

    def test_owner_comment_replies_to_issue_thread_with_its_own_delivery_identity(self):
        run, _ = self.runner(self.comment())
        envelope, kind = reply.read_reply_source(self.config, 'I1', 'C9', run)
        self.assertEqual((envelope['eventPayload'], kind), (self.thread['eventPayload'], 'owner_comment'))
        self.assertNotEqual(reply.delivery_identity(self.config, 'I1', 'C9'),
                            reply.delivery_identity(self.config, 'I1', None))

    def test_nested_owner_reply_is_found_in_the_full_thread(self):
        run, commands = self.runner(self.comment(), nested=True)
        self.assertEqual(reply.read_reply_source(self.config, 'I1', 'C9', run)[1], 'owner_comment')
        self.assertIn('--full', commands[-1])

    def test_other_authors_agents_and_unconfigured_owner_are_rejected(self):
        cases = [(self.config, self.comment(author_id='11111111-1111-1111-1111-111111111111')),
                 (self.config, self.comment(author_type='agent')),
                 (self.config, self.comment(issue_id='I2')),
                 ({**self.config, 'ownerMulticaUserId': None}, self.comment()),
                 ({**self.config, 'ownerMulticaUserId': 'Perfecto'}, self.comment())]
        for config, comment in cases:
            run, _ = self.runner(comment)
            with self.subTest(config=config.get('ownerMulticaUserId'), comment=comment), \
                    self.assertRaisesRegex(ValueError, 'invalid_relay_source'):
                reply.read_reply_source(config, 'I1', 'C9', run)

    def test_owner_comment_requires_a_relay_issue(self):
        run, _ = self.runner(self.comment(), description='manual issue')
        with self.assertRaisesRegex(ValueError, 'invalid_relay_source'):
            reply.read_reply_source(self.config, 'I1', 'C9', run)

    def test_relay_marker_wins_even_when_posted_as_owner(self):
        marked = self.comment(content='<!-- relay-message:x -->\n' + json.dumps(
            {'eventPayload': {**EVENT, 'messageTs': '105.000001'}}))
        run, _ = self.runner(marked)
        envelope, kind = reply.read_reply_source(self.config, 'I1', 'C9', run)
        self.assertEqual((envelope['eventPayload']['messageTs'], kind), ('105.000001', 'relay'))

    def test_start_reaction_cleanup_is_not_applicable_and_touches_no_slack(self):
        run, _ = self.runner(self.comment())
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / 'config.json'
            config_path.write_text(json.dumps(self.config))
            output = io.StringIO()
            with patch.object(reply, 'slack_call') as call, redirect_stdout(output):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--comment-id', 'C9',
                            '--clear-start-reaction'], runner=run)
        call.assert_not_called()
        self.assertEqual(json.loads(output.getvalue()),
                         {'ok': True, 'action': 'not_applicable', 'session_status': 'disabled'})

    def test_cleanup_still_resets_session_and_rejects_extra_arguments(self):
        run, _ = self.runner(self.comment())
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / 'config.json'
            config_path.write_text(json.dumps(self.config))
            base = ['--config', str(config_path), '--issue-id', 'I1', '--comment-id', 'C9', '--clear-start-reaction']
            with self.assertRaisesRegex(ValueError, 'invalid_cleanup_arguments'):
                reply.main(base + ['--run-context-file', 'x'], runner=run)
            with patch.object(reply, 'update_session_status', return_value='active') as status, \
                    redirect_stdout(io.StringIO()):
                reply.main(base, runner=run)
        status.assert_called_once()
        self.assertEqual(status.call_args.args[3], 'active')

    def test_both_lookups_missing_is_source_comment_missing(self):
        run, _ = self.runner(self.comment(id='OTHER'), nested=True)
        with self.assertRaisesRegex(ValueError, 'source_comment_missing'):
            reply.read_reply_source(self.config, 'I1', 'C9', run)

    def test_found_root_does_not_read_the_full_thread(self):
        run, commands = self.runner(self.comment())
        reply.read_reply_source(self.config, 'I1', 'C9', run)
        self.assertFalse(any('--full' in command for command in commands))

    def test_missing_comment_issue_id_is_rejected(self):
        comment = self.comment()
        del comment['issue_id']
        run, _ = self.runner(comment)
        with self.assertRaisesRegex(ValueError, 'invalid_relay_source'):
            reply.read_reply_source(self.config, 'I1', 'C9', run)

    def test_scheduled_wakeup_cannot_descend_from_an_owner_comment(self):
        with patch.object(reply, 'multica_json', side_effect=[
                [{'id': '11111111-1111-4111-8111-111111111111', 'issue_id': 'I1', 'workspace_id': 'W1', 'status': 'running',
                  'wakeup_id': 'WK', 'agent_id': 'A1', 'trigger_comment_id': 'C9'}],
                {'id': 'WK', 'workspace_id': 'W1', 'issue_id': 'I1', 'agent_id': 'A1',
                 'parent_comment_id': 'C9', 'kind': 'at'}]), \
                patch.object(reply, 'read_reply_source', return_value=(self.thread, 'owner_comment')):
            with self.assertRaisesRegex(ValueError, 'invalid_wakeup_source'):
                reply.read_wakeup_source(self.config, 'I1', None, '11111111-1111-4111-8111-111111111111')

    def test_owner_comment_retry_returns_the_persisted_send(self):
        run, _ = self.runner(self.comment())
        posted = []
        def opener(request, timeout=0):
            if request.full_url.endswith('/chat.postMessage'):
                posted.append(json.loads(request.data))
                body = {'ok': True, 'channel': 'C1', 'ts': '102.000001'}
            else:
                messages = ([{'ts': '102.000001', 'blocks': posted[0]['blocks']}] if posted
                            else [{'ts': '100.000001', 'blocks': []}])
                body = {'ok': True, 'messages': messages, 'response_metadata': {'next_cursor': ''}}
            return io.BytesIO(json.dumps(body).encode())
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(self.config)); text_path.write_text('answer')
            args = ['--config', str(config_path), '--issue-id', 'I1', '--comment-id', 'C9', '--text-file', str(text_path)]
            results = []
            for _ in range(2):
                output = io.StringIO()
                with patch.dict(os.environ, {'SLACK_USER_TOKEN': 'xoxp-test'}), redirect_stdout(output):
                    reply.main(args, opener=opener, runner=run)
                results.append(json.loads(output.getvalue()))
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0]['thread_ts'], EVENT['threadTs'])
        self.assertEqual([r['duplicate'] for r in results], [False, True])



class CurrentRunTests(unittest.TestCase):
    config = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.test'}
    task = '22222222-2222-4222-8222-222222222222'

    def resolve(self, run=None, wakeup=None, comment_id=None, task=None):
        run = {'id': self.task, 'issue_id': 'I1', 'workspace_id': 'W1', 'status': 'running',
               'trigger_comment_id': 'C7', **(run or {})}
        replies = [[run]] + ([wakeup] if wakeup is not None else [])
        with patch.object(reply, 'multica_json', side_effect=replies):
            return reply.resolve_current_run(self.config, 'I1', comment_id, task or self.task)

    def test_follow_up_uses_the_runs_own_trigger_comment(self):
        self.assertEqual(self.resolve(), ('C7', False))
        self.assertEqual(self.resolve(run={'trigger_comment_id': None}), (None, False))

    def test_only_time_wakeups_become_scheduled_occurrences(self):
        self.assertEqual(self.resolve(run={'wakeup_id': 'WK'}, wakeup={'kind': 'cron'}), ('C7', True))
        self.assertEqual(self.resolve(run={'wakeup_id': 'WK'}, wakeup={'kind': 'event'}), ('C7', False))

    def test_wrong_or_finished_run_and_mismatched_comment_are_rejected(self):
        for changes in [{'status': 'completed'}, {'issue_id': 'I2'}, {'workspace_id': 'W2'}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'invalid_current_run'):
                self.resolve(run=changes)
        with self.assertRaisesRegex(ValueError, 'invalid_current_run'):
            self.resolve(task='not-a-uuid')
        with self.assertRaisesRegex(ValueError, 'current_run_comment_mismatch'):
            self.resolve(comment_id='OTHER')

    def test_main_collects_statistics_and_routes_the_trigger_comment(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(self.config)); text_path.write_text('answer')
            with patch.object(reply, 'resolve_current_run', return_value=('C7', False)) as resolve, \
                    patch.object(reply, 'collect_run_context', return_value=None) as collect, \
                    patch.object(reply, 'read_source', return_value={'eventPayload': {**EVENT, 'messageTs': '101.000001'}}) as read, \
                    redirect_stdout(io.StringIO()):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--current-run',
                            '--text-file', str(text_path), '--dry-run'])
        resolve.assert_called_once()
        collect.assert_called_once()
        self.assertEqual(read.call_args.args[2], 'C7')

    def test_scheduled_cleanup_is_not_applicable_and_wakeup_flag_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / 'config.json'
            config_path.write_text(json.dumps(self.config))
            base = ['--config', str(config_path), '--issue-id', 'I1', '--current-run']
            output = io.StringIO()
            with patch.object(reply, 'resolve_current_run', return_value=('C7', True)), \
                    patch.object(reply, 'read_wakeup_source', return_value=({'eventPayload': EVENT}, 'C7', 'occ')), \
                    patch.object(reply, 'update_session_status', return_value='active') as status, \
                    redirect_stdout(output):
                reply.main(base + ['--clear-start-reaction'])
            self.assertEqual(json.loads(output.getvalue()), {'ok': True, 'action': 'not_applicable', 'session_status': 'active'})
            self.assertEqual(status.call_args.args[3], 'active')
            with self.assertRaisesRegex(ValueError, 'invalid_current_run_arguments'):
                reply.main(base + ['--wakeup-run', '--text-file', 'x'])

    def test_failed_statistics_collection_returns_none(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / 'run_context.py'
            script.write_text('raise SystemExit(1)')
            failing = lambda command, **kwargs: subprocess.CompletedProcess(command, 1, '', '')
            self.assertIsNone(reply.collect_run_context('I1', failing, script))
            self.assertIsNone(reply.collect_run_context('I1', failing, Path(directory) / 'missing.py'))

    def test_collected_statistics_are_removed_and_a_bad_file_never_blocks_the_reply(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path, text_path = Path(directory) / 'config.json', Path(directory) / 'body.txt'
            config_path.write_text(json.dumps(self.config)); text_path.write_text('answer')
            stats_dir = Path(tempfile.mkdtemp()); stats = stats_dir / 'run-context.json'
            stats.write_text(json.dumps({'version': 1, 'issue_id': 'OTHER'}))
            output = io.StringIO()
            with patch.object(reply, 'resolve_current_run', return_value=(None, False)), \
                    patch.object(reply, 'collect_run_context', return_value=str(stats)), \
                    patch.object(reply, 'read_source', return_value={'eventPayload': {**EVENT, 'messageTs': '101.000001'}}), \
                    redirect_stdout(output):
                reply.main(['--config', str(config_path), '--issue-id', 'I1', '--current-run',
                            '--text-file', str(text_path), '--dry-run'])
            self.assertFalse(stats_dir.exists())
            self.assertEqual(json.loads(output.getvalue())['thread_ts'], EVENT['threadTs'])

    def test_successful_collection_returns_the_written_file(self):
        def runner(command, **kwargs):
            Path(command[command.index('--output') + 1]).write_text('{}')
            return subprocess.CompletedProcess(command, 0, '', '')
        path = reply.collect_run_context('I1', runner)
        try:
            self.assertTrue(Path(path).is_file())
        finally:
            shutil.rmtree(Path(path).parent)


class TeamReplyTests(unittest.TestCase):
    def config(self, **fields):
        return {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1', 'serverUrl': 'https://multica.example',
                'assigneeType': 'squad', 'assigneeId': 'S1', **fields}

    def source(self, config, kind, target):
        issue = {'workspace_id': 'W1', 'project_id': 'P1', 'assignee_type': kind, 'assignee_id': target,
                 'description': '<!-- relay-thread:test -->\n' + json.dumps({'eventPayload': EVENT})}
        runner = lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, json.dumps(issue))
        return reply.read_source(config, 'I1', None, runner)

    def test_team_accepts_its_source_and_rejects_other_assignment(self):
        config = self.config()
        self.assertEqual(self.source(config, 'squad', 'S1')['eventPayload'], EVENT)
        for kind, target in [('agent', 'S1'), ('squad', 'other'), ('agent', 'A1')]:
            with self.assertRaisesRegex(ValueError, 'invalid_issue_scope'):
                self.source(config, kind, target)

    def test_migration_preserves_existing_delivery_identity_and_requires_legacy_scope(self):
        old = {**CONFIG, 'workspaceId': 'W1', 'projectId': 'P1'}
        migrated = self.config(threadScopeId='A1', legacyAgentId='A1')
        self.assertEqual(reply.delivery_identity(old, 'I1', 'C1'), reply.delivery_identity(migrated, 'I1', 'C1'))
        self.assertEqual(self.source(migrated, 'agent', 'A1')['eventPayload'], EVENT)
        with self.assertRaisesRegex(ValueError, 'invalid_migration_scope'):
            self.source(self.config(legacyAgentId='A1'), 'agent', 'A1')

    def test_members_share_a_ledger_scope_and_team_hides_old_agent_snapshot(self):
        config = self.config()
        self.assertEqual(reply.delivery_identity(config, 'I1', None),
                         reply.delivery_identity({**config, 'agentId': 'another-member'}, 'I1', None))
        envelope = {'replyContext': {'type': 'slack_reply_context', 'source': 'agent_config',
                    'status': 'available', 'agentId': 'A1', 'model': 'old-model'}}
        self.assertEqual(reply.footer_for(config, envelope), CONFIG['displayName'])

    def test_fast_marker_uses_verified_tier_with_current_model(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'stats.json'
            for tier, source, fast in [('priority', 'agent_config', True), ('default', 'agent_config', False),
                                       ('priority', None, False), ('unknown', 'agent_config', False)]:
                path.write_text(json.dumps({'version': 1, 'issue_id': 'I1', 'run_id': 'R1', 'statistics': {
                    'model': 'model', 'model_source': 'agent_config', 'service_tier': tier, 'service_tier_source': source}}))
                self.assertEqual('⚡ Fast' in reply.run_statistics(path, 'I1', 'R1'), fast)

if __name__ == '__main__':
    unittest.main()
