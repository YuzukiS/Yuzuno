#!/usr/bin/env python3
"""Real Codex acceptance, exclusively on the owned 4383 lab and a native fork.

run imports the probe's fork and sends exactly one bounded, read-only prompt.
recover checks the same Agent after the operator restarts this isolated lab.
cleanup closes only the recorded lab Agent, retaining all evidence.
"""
import argparse
import json
from pathlib import Path
import time
import uuid

from lab import LAB, api, owned, save, verify_daily

STATE = LAB / 'live-check.json'


def note(state, event, **details):
    state.setdefault('observations', []).append({'at': time.time(), 'event': event, **details})
    save(STATE, state)
    print(event, json.dumps(details, ensure_ascii=False), flush=True)


def current(state):
    detail = api('/agents/' + state['agentId'])
    assert detail['agent']['threadId'] == state['forkId'], 'Unexpected native session replacement'
    return detail


def ready(state, deadline=240):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        detail = current(state)
        if detail['pending']:
            raise RuntimeError('Inspect lab approval/question; no automatic approval: ' + state['agentId'])
        if detail['agent']['status'] in ('error', 'uncertain'):
            raise RuntimeError(detail['agent'].get('error') or 'Native result is unconfirmed')
        if detail['agent']['status'] == 'idle' and detail['agent']['connectionState'] == 'connected':
            return detail
        time.sleep(1)
    raise RuntimeError('Lab turn did not finish; inspect recorded Agent, never resend blindly')


def rss():
    parent = owned()
    if not parent:
        return None
    proc = Path('/proc') / str(parent['pid'])
    lines = (proc / 'status').read_text().splitlines()
    return {line.split(':')[0]: int(line.split()[1]) for line in lines
            if line.startswith(('VmRSS:', 'VmHWM:'))}


def run():
    assert owned(), 'Start the owned isolated Core first'
    assert not STATE.exists(), 'One-shot evidence: use recover/cleanup; do not send the prompt twice'
    probe = json.loads((LAB / 'native-probe.json').read_text())
    fork_id = probe['fork']['metadata']['id']
    assert fork_id != probe['sourceId']
    state = {'sourceId': probe['sourceId'], 'forkId': fork_id,
             'sourceResumed': False, 'sourceTurnSent': False,
             'kind': 'Real native fork + real Codex model + isolated Yuzuno Core',
             'beforeMemoryKiB': rss()}
    save(STATE, state)
    preview = api('/codex/sessions/preview', {'threadId': fork_id})
    assert preview['threadId'] == fork_id and preview['turnCount'] > 20
    assert preview['model'] == 'gpt-6-astra'
    note(state, 'native preview', model=preview['model'], reasoningEffort=preview.get('reasoningEffort'),
         turnCount=preview['turnCount'], cwd=preview['cwd'], memoryKiB=rss())
    request = {'threadId': fork_id, 'name': 'Session import · acceptance', 'permissionPreset': 'ask'}
    imported = api('/codex/sessions/import', request)
    state['agentId'] = imported['id']
    state['model'] = preview['model']
    state['reasoningEffort'] = preview.get('reasoningEffort')
    save(STATE, state)
    assert imported['threadId'] == fork_id and imported['status'] == 'offline'
    assert imported['connectionState'] == 'disconnected'
    assert imported['model'] == preview['model']
    assert imported['settings']['reasoningEffort'] == preview.get('reasoningEffort')
    initial = current(state)
    assert 0 < len(initial['turns']) <= 3
    assert initial['agent']['unreadCount'] == 0 and not initial['pending']
    state['initialTurnIds'] = [turn['id'] for turn in initial['turns']]
    state['initialHistory'] = initial.get('history')
    note(state, 'offline import keeps recent history without new unread',
         cachedTurns=len(initial['turns']), history=initial.get('history'), memoryKiB=rss())
    again = api('/codex/sessions/import', request)
    assert again['id'] == imported['id']
    matching = [a for a in api('/workspace')['agents'] if a.get('threadId') == fork_id]
    assert len(matching) == 1
    note(state, 'duplicate import returns the same Agent')
    api('/agents/' + imported['id'] + '/reconnect', {})
    resumed = ready(state)
    assert resumed['agent']['unreadCount'] == 0, 'Historical completions became unread'
    assert resumed['agent']['model'] == preview['model']
    assert resumed['agent']['settings']['reasoningEffort'] == preview.get('reasoningEffort')
    state['beforeTurnIds'] = [turn['id'] for turn in resumed['turns']]
    note(state, 'native resume keeps session, model and effort', memoryKiB=rss())
    prompt = (
        '这是一轮 Yuzuno 会话接续验收。只回答，不开发、不修改文件、不启动或停止任何进程，也不要启动子 Agent。'
        '请基于已经保留的此前对话，用简短中文回答三个问题：'
        '1. 我们约定 T-N 任务编号在哪个范围内唯一？'
        '2. 普通 peer message 和紧急 peer message 分别何时投递，正文如何取得？'
        '3. 同一个 Project 的 Agent 能否使用默认目录之外的 worktree？'
        '另请只调用一次 Yuzuno MCP 的 peers_list，以验证本会话接入 Workspace；不要发送消息、创建任务或调用其他工具。'
        '最后注明 peers_list 是否成功。此次验收到此结束。'
    )
    message_id = str(uuid.uuid4())
    state['messageId'] = message_id
    state['promptSubmitted'] = True  # reserve before the wire; ambiguous outcome is never replayed
    note(state, 'sending one read-only context and MCP check')
    receipt = api('/agents/' + imported['id'] + '/messages',
                  {'clientMessageId': message_id, 'text': prompt})
    state['receipt'] = receipt
    save(STATE, state)
    finished = ready(state)
    new_turns = [turn for turn in finished['turns'] if turn['id'] not in state['beforeTurnIds']]
    assert len(new_turns) == 1, 'Expected exactly one new native Turn'
    turn = new_turns[0]
    assert turn['status'] == 'completed'
    tool_calls = [item for item in turn.get('items', []) if item.get('type') == 'mcpToolCall']
    assert len(tool_calls) == 1 and tool_calls[0].get('server') == 'yuzuno'
    assert tool_calls[0].get('tool') == 'peers_list' and tool_calls[0].get('status') == 'completed'
    assert not any(item.get('type') in ('commandExecution', 'fileChange', 'collabAgentToolCall')
                   for item in turn.get('items', [])), 'Acceptance prompt exceeded its read-only scope'
    answers = [item.get('text', '') for item in turn.get('items', [])
               if item.get('type') == 'agentMessage' and item.get('phase') == 'final_answer']
    assert answers, 'Native final answer missing'
    state['turnId'] = turn['id']
    state['answer'] = '\n'.join(answers)
    state['itemTypes'] = [item.get('type') for item in turn.get('items', [])]
    assert 'Workspace' in state['answer'] or 'workspace' in state['answer']
    assert '门铃' in state['answer'] and 'worktree' in state['answer']
    # Human-reviewable response retained locally; do not commit transcript data.
    note(state, 'real continuation completed', turnId=turn['id'],
         answer=state['answer'], memoryKiB=rss())
    verify_daily()


def recover():
    assert owned()
    state = json.loads(STATE.read_text())
    before = current(state)
    assert before['agent']['status'] == 'offline', 'Restart only the isolated Core before recover'
    api('/agents/' + state['agentId'] + '/reconnect', {})
    after = ready(state)
    assert any(turn['id'] == state['turnId'] for turn in after['turns'])
    assert after['agent']['model'] == state['model']
    assert after['agent']['settings']['reasoningEffort'] == state['reasoningEffort']
    assert sum(turn['id'] not in state['beforeTurnIds'] for turn in after['turns']) == 1
    note(state, 'Core restart recovers the same session and new result', memoryKiB=rss())
    verify_daily()


def cleanup():
    assert owned()
    state = json.loads(STATE.read_text())
    detail = current(state)
    if not detail['agent'].get('closedAt'):
        assert detail['agent']['status'] not in ('working', 'waiting', 'uncertain')
        api('/agents/' + state['agentId'] + '/close', {})
    note(state, 'closed only the acceptance Agent; history retained', memoryKiB=rss())
    verify_daily()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run', 'recover', 'cleanup'))
    {'run': run, 'recover': recover, 'cleanup': cleanup}[parser.parse_args().action]()
