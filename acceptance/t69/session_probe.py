"""When do skill changes reach a running or resumed session? Asks the same
question in turn 1, after adding a skill and editing another's body (turn 2,
same live session), and again after resuming (turn 3), in a throwaway repo.

usage: session_probe.py --out DIR --harness claude|codex [--model M]
"""
import argparse, json, pathlib, shutil, subprocess, sys

QUESTION = ('List, comma-separated, the names of the skills available to you that start with "probe-". '
            'Then use the probe-a skill and reply with its answer word. Format: SKILLS: <names>; WORD: <word>')


def skill(root, folder, name, word):
    path = root / folder / name
    path.mkdir(parents=True, exist_ok=True)
    (path / 'SKILL.md').write_text(f'---\nname: {name}\ndescription: Probe skill {name}; use only when asked about probe skills.\n---\n\n'
                                   f'The answer word is {word}.\n')


def repo(path, folder):
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    subprocess.run(['git', 'init', '-q', str(path)], check=True)
    skill(path, folder, 'probe-a', 'APPLE')


def change(path, folder):
    skill(path, folder, 'probe-a', 'BANANA')
    skill(path, folder, 'probe-late', 'CHERRY')


def claude(out, model):
    root = out / 'claude-repo'
    repo(root, '.claude/skills')
    base = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--allowedTools', 'Skill', 'Read',
            '--strict-mcp-config']
    proc = subprocess.Popen(base + ['--input-format', 'stream-json'], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True)
    answers, session, listed = [], None, []

    def turn(text):
        proc.stdin.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': text}}) + '\n')
        proc.stdin.flush()
        for line in proc.stdout:
            event = json.loads(line)
            if event.get('type') == 'system' and event.get('subtype') == 'init':
                listed.append(sorted(s for s in event.get('skills', []) if s.startswith('probe-')))
            if event.get('type') == 'result':
                return event.get('session_id'), event.get('result', '')

    session, text = turn(QUESTION)
    answers.append(('start', text))
    change(root, '.claude/skills')
    _, text = turn(QUESTION)
    answers.append(('same live session after the change', text))
    proc.stdin.close()
    proc.wait(timeout=120)
    resumed = subprocess.run(base + ['--resume', session, QUESTION], cwd=root, capture_output=True, text=True, timeout=300)
    for line in resumed.stdout.splitlines():
        event = json.loads(line)
        if event.get('type') == 'system' and event.get('subtype') == 'init':
            listed.append(sorted(s for s in event.get('skills', []) if s.startswith('probe-')))
        if event.get('type') == 'result':
            answers.append(('resumed in a new process', event.get('result', '')))
    return {'answers': answers, 'initSkillLists': listed}


def codex(out, model):
    root = out / 'codex-repo'
    repo(root, '.agents/skills')
    common = ['--json', '--ignore-user-config', '-m', model, '-c', 'model_reasoning_effort="low"']
    base = ['codex', 'exec'] + common + ['-s', 'read-only']

    def run(args):
        # `exec resume` finds sessions by the current directory and takes no -s/-C.
        proc = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
        (out / f'codex-run-{len(answers) if "answers" in locals() else 0}.stderr').write_text(proc.stderr[-5000:])
        thread, text = None, ''
        for line in proc.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            thread = event.get('thread_id', thread)
            if (event.get('item') or {}).get('type') == 'agent_message':
                text = event['item'].get('text', '')
        return thread, text

    thread, text = run(base + [QUESTION])
    answers = [('start', text)]
    change(root, '.agents/skills')
    _, text = run(['codex', 'exec', 'resume'] + common + [thread, QUESTION])
    answers.append(('resumed thread after the change', text))
    _, text = run(base + ['--ephemeral', QUESTION])
    answers.append(('new thread after the change', text))
    return {'answers': answers, 'thread': thread}


def codex_live(out, model):
    """Two turns in one live app-server thread, as Core runs a Codex Agent."""
    root = out / 'codex-live-repo'
    repo(root, '.agents/skills')
    proc = subprocess.Popen(['codex', 'app-server', '-c', 'model_reasoning_effort="low"'], cwd=root, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    ids = iter(range(1, 100))

    def request(method, params):
        id = next(ids)
        proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}) + '\n')
        proc.stdin.flush()
        return id

    def wait(match):
        for line in proc.stdout:
            message = json.loads(line)
            if 'method' in message and 'id' in message:  # A server request: refuse.
                proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32000, 'message': 'denied'}}) + '\n')
                proc.stdin.flush()
                continue
            found = match(message)
            if found is not None:
                return found
        raise RuntimeError('app-server closed')

    try:
        id = request('initialize', {'clientInfo': {'name': 't69_probe', 'title': 'T-69 probe', 'version': '0'}, 'capabilities': {'experimentalApi': True}})
        wait(lambda m: m if m.get('id') == id else None)
        proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'initialized'}) + '\n')
        id = request('thread/start', {'model': model, 'cwd': str(root), 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True})
        thread = wait(lambda m: m['result']['thread']['id'] if m.get('id') == id else None)
        answers = []
        for label in ('start', 'same live thread after the change'):
            if answers:
                change(root, '.agents/skills')
            request('turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': QUESTION, 'text_elements': []}]})
            text = ''
            while True:
                message = wait(lambda m: m if m.get('method') in ('item/completed', 'turn/completed') else None)
                item = message.get('params', {}).get('item') or {}
                if item.get('type') == 'agentMessage':
                    text = item.get('text', '')
                if message['method'] == 'turn/completed':
                    break
            answers.append((label, text))
        return {'answers': answers, 'thread': thread}
    finally:
        proc.kill()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--harness', choices=['claude', 'codex', 'codex-live'], required=True)
    parser.add_argument('--model')
    a = parser.parse_args()
    out = pathlib.Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if a.harness == 'claude':
        result = claude(out, a.model or 'claude-haiku-4-5-20251001')
    elif a.harness == 'codex':
        result = codex(out, a.model or 'gpt-6-astra')
    else:
        result = codex_live(out, a.model or 'gpt-6-astra')
    (out / f'session-{a.harness}.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
