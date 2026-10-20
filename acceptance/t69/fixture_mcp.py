"""A controlled stand-in for Yuzuno Core's `yuzuno` MCP server (stdio).

Tool descriptions come from the Core source of the checkout given with
--core-source, so they match the Core under test; input schemas are the
relevant fields only. Every call is appended to $FIXTURE_LOG and answered with
canned results for $FIXTURE_SCENARIO. Nothing reaches a real Core, GitHub or
the machine's Jobs. $FIXTURE_DROP lists tools to omit, standing in for an
older Core.
"""
import json, os, pathlib, re, sys

args = sys.argv[1:]
source = pathlib.Path(args[args.index('--core-source') + 1])
scenario = os.environ.get('FIXTURE_SCENARIO', '')
log = pathlib.Path(os.environ['FIXTURE_LOG'])
dropped = set(filter(None, os.environ.get('FIXTURE_DROP', '').split(',')))

INSTRUCTIONS = None
DESCRIPTIONS = {}
for path in sorted((source / 'core/src').rglob('*.rs')):
    text = path.read_text()
    for name, description in re.findall(r'(?:definition|make)\(\s*"([a-z_]+)",\s*"((?:[^"\\]|\\.)*)"', text, re.S):
        DESCRIPTIONS.setdefault(name, json.loads('"' + description.replace('\n', ' ') + '"'))
    found = re.search(r'with_instructions\(\s*"((?:[^"\\]|\\.)*)"', text, re.S)
    if found:
        INSTRUCTIONS = re.sub(r'\\\n\s*', '', found.group(1))
DESCRIPTIONS.setdefault('github_links', 'List, explicitly link, or unlink existing GitHub.com Issue/PR URLs on a task. Multiple PRs allowed; Issues optional. Project tasks require the repo already linked to that Project. This never changes GitHub or task status, and does not certify review/deployment. Cached facts retain SHA and observation time; stale snapshots are marked.')

S, I = {'type': 'string'}, {'type': 'integer'}
TASK = {'type': 'string', 'description': 'Existing task ID, for example T-1.'}
REQ = {'type': 'string', 'description': 'Stable retry key. Reuse only when retrying exactly this operation and payload.'}
SCHEMAS = {
    'task_get': ({'taskId': TASK, 'dispatchId': S, 'afterSeq': I, 'limit': I}, ['taskId']),
    'task_update': ({'requestId': REQ, 'taskId': TASK, 'expectedVersion': I, 'patch': {'type': 'object'}}, ['requestId', 'taskId', 'expectedVersion', 'patch']),
    'task_comment': ({'requestId': REQ, 'taskId': TASK, 'body': S}, ['requestId', 'taskId', 'body']),
    'task_submit_result': ({'requestId': REQ, 'taskId': TASK, 'expectedVersion': I, 'dispatchId': S, 'summary': S,
                            'links': {'type': 'array', 'items': {'type': 'object'}}, 'status': {'type': 'string', 'enum': ['review', 'done']}},
                           ['requestId', 'taskId', 'expectedVersion', 'summary']),
    'peer_send': ({'requestId': REQ, 'toAgentId': S, 'body': S, 'taskId': TASK, 'replyTo': S, 'priority': {'type': 'string', 'enum': ['normal', 'urgent']}}, ['requestId', 'toAgentId', 'body']),
    'peer_read': ({'afterSeq': I, 'limit': I, 'priority': {'type': 'string', 'enum': ['normal', 'urgent']}}, []),
    'peers_list': ({}, []),
    'job_budget': ({}, []),
    'job_submit': ({'requestId': REQ, 'taskId': TASK, 'name': S, 'cwd': S, 'argv': {'type': 'array', 'items': S}, 'env': {'type': 'object'},
                    'resources': {'type': 'object', 'properties': {'cpuMillis': I, 'memoryMiB': I, 'swapMiB': I}}, 'timeoutSeconds': I,
                    'guardGit': {'type': 'boolean'}, 'inputs': {'type': 'array', 'items': S}, 'outputs': {'type': 'array', 'items': S}},
                   ['requestId', 'taskId', 'name', 'cwd', 'argv', 'resources']),
    'job_get': ({'jobId': S}, ['jobId']),
    'job_logs': ({'jobId': S}, ['jobId']),
    'job_list': ({'taskId': TASK}, []),
    'job_cancel': ({'jobId': S}, ['jobId']),
    'review_start': ({'requestId': REQ, 'taskId': TASK, 'linkId': S, 'baseSha': S, 'headSha': S}, ['requestId', 'taskId', 'linkId']),
    'review_list': ({'taskId': TASK, 'before': I}, ['taskId']),
    'review_get': ({'reviewId': S, 'taskId': TASK}, ['reviewId']),
    'github_links': ({'taskId': TASK, 'action': {'type': 'string', 'enum': ['list', 'link', 'unlink']}, 'input': S, 'linkId': S}, ['taskId']),
    'ci_subscribe': ({'requestId': REQ, 'taskId': TASK, 'url': S, 'expectedSha': S}, ['requestId', 'taskId', 'url', 'expectedSha']),
    'ci_get': ({'runKey': S, 'page': I}, ['runKey']),
    'ci_list': ({'agentId': S, 'taskId': TASK}, []),
    'ci_refresh': ({'agentId': S, 'taskId': TASK, 'runKey': S, 'pages': I}, []),
}

HEAD, BASE = '1' * 40, '2' * 40
LINK = '1418243850:pull:12'
REVIEW = {'id': 'rev-7', 'requestId': 'dev-t7-r1-1111111', 'taskId': 'T-7', 'linkId': LINK, 'baseSha': BASE, 'headSha': HEAD,
          'round': 1, 'status': 'running', 'conclusion': None}


def answer(name, arguments):
    a = arguments or {}
    if name == 'task_get':
        # The task matches the request, so the request is the only variable.
        title, goal = {
            'short': ('Prepare the CI refresh change', 'Start from a clean checkout of the feature branch.'),
            'heavy': ('Verify the workspace test suite', 'Run the full Rust test suite for this checkout and report the outcome.'),
        }.get(scenario, ('Faster CI refresh', 'Make the CI view refresh from GitHub on demand; deliver it as PR #12.'))
        task = {'id': 'T-7', 'title': title, 'status': 'doing', 'version': 3, 'assignee': {'name': 'You'},
                'description': goal, 'progress': ''}
        if scenario == 'result':
            task['dispatch'] = {'id': 'd-123', 'active': True, 'notificationRecipient': {'id': 'lead', 'name': 'Dev Lead'}}
        return {'task': task, 'activities': [], 'hasMore': False}
    if name == 'job_budget':
        return {'budget': {'cpuMillis': 4000, 'memoryMiB': 8192, 'swapMiB': 0}, 'available': {'cpuMillis': 2000, 'memoryMiB': 4096, 'swapMiB': 0},
                'activeCount': 2, 'queuedCount': 1, 'collectorOverhead': {'cpuMillis': 100, 'memoryMiB': 64, 'swapMiB': 0}}
    if name == 'job_submit':
        return {'id': 'job-7a', 'requestId': a.get('requestId'), 'status': 'queued', 'reason': 'Waiting for shared machine capacity', 'taskRef': 'T-7'}
    if name in ('job_get', 'job_logs'):
        return {'id': a.get('jobId'), 'status': 'queued', 'reason': 'Waiting for shared machine capacity', 'result': None}
    if name == 'job_list':
        return {'jobs': [], 'hasMore': False}
    if name == 'review_start':
        if a.get('requestId') == REVIEW['requestId']:
            return dict(REVIEW)  # The identical retry returns the existing run.
        return dict(REVIEW, id='rev-8', requestId=a.get('requestId'), status='preparing')
    # In "result" the record agrees with the request: CI passed, rev-9 found nothing.
    done = dict(REVIEW, id='rev-9', requestId='dev-t7-r1-1111111', status='completed', conclusion='no_findings', findings=[])
    if name == 'review_list':
        return {'reviews': [REVIEW] if scenario == 'lost' else [done] if scenario == 'result' else [], 'hasMore': False}
    if name == 'review_get':
        return done if scenario == 'result' else dict(REVIEW)
    if name == 'github_links':
        return {'links': [{'id': LINK, 'kind': 'pull', 'number': 12, 'repository': 'YuzukiS/Yuzuno',
                           'snapshot': {'headSha': HEAD, 'baseSha': BASE, 'state': 'open'}}]}
    if name == 'ci_get' and scenario == 'result':
        return {'run': {'id': a.get('runKey'), 'runId': '555', 'status': 'passed', 'rawStatus': 'completed', 'conclusion': 'success',
                        'headSha': HEAD, 'observedAt': '2026-10-16T01:58:00Z'},
                'details': {'jobs': [{'name': 'Core (build and test)', 'status': 'passed'}], 'observedAt': '2026-10-16T01:58:00Z'}, 'error': None}
    if name == 'ci_get':
        # As in Core: the run is the stored observation; the jobs page comes
        # through a short shared cache and may be newer.
        return {'run': {'id': a.get('runKey'), 'status': 'running', 'rawStatus': 'in_progress', 'headSha': HEAD, 'observedAt': '2026-10-16T01:58:00Z'},
                'details': {'jobs': [{'name': 'Core (build and test)', 'status': 'running', 'steps': [{'name': 'Build', 'status': 'in_progress'}]}],
                            'observedAt': '2026-10-16T02:00:20Z'}, 'error': None}
    if name == 'ci_refresh':
        return {'status': 'checked', 'checkedAt': '2026-10-16T02:00:00Z', 'retryAt': None, 'error': None}
    if name in ('ci_subscribe', 'ci_list'):
        return {'id': 'sub-1', 'active': True, 'runs': [], 'subscriptions': []}
    if name == 'task_submit_result':
        return {'task': {'id': 'T-7', 'status': a.get('status', 'review'), 'version': 4}, 'notified': 'dispatcher' if a.get('dispatchId') else None}
    if name == 'peer_read':
        return {'messages': [], 'hasMore': False}
    if name == 'peers_list':
        return {'peers': [{'id': 'lead', 'name': 'Dev Lead'}, {'id': 'dev-2', 'name': 'Dev 2'}]}
    return {'ok': True}


def send(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    method, id = request.get('method'), request.get('id')
    if id is None:
        continue
    if method == 'initialize':
        send({'jsonrpc': '2.0', 'id': id, 'result': {
            'protocolVersion': request['params'].get('protocolVersion', '2025-06-18'),
            'capabilities': {'tools': {}}, 'serverInfo': {'name': 'yuzuno-collaboration', 'version': 'fixture'},
            'instructions': INSTRUCTIONS}})
    elif method == 'tools/list':
        send({'jsonrpc': '2.0', 'id': id, 'result': {'tools': [
            {'name': name, 'description': DESCRIPTIONS[name],
             'inputSchema': {'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}}
            for name, (props, required) in SCHEMAS.items() if name not in dropped and name in DESCRIPTIONS]}})
    elif method == 'tools/call':
        name, arguments = request['params']['name'], request['params'].get('arguments')
        with log.open('a') as f:
            f.write(json.dumps({'tool': name, 'arguments': arguments}) + '\n')
        send({'jsonrpc': '2.0', 'id': id, 'result': {'content': [{'type': 'text', 'text': json.dumps(answer(name, arguments))}], 'isError': False}})
    elif method == 'ping':
        send({'jsonrpc': '2.0', 'id': id, 'result': {}})
    else:
        send({'jsonrpc': '2.0', 'id': id, 'error': {'code': -32601, 'message': 'method not found'}})
