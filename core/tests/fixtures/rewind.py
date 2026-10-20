#!/usr/bin/env python3
"""Per-test native history fixture; all files are in a unique temporary cwd."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method, p = request['method'], request.get('params', {})
    with (root/'calls.jsonl').open('a') as log: log.write(json.dumps(request)+'\n')
    turns = json.loads((root / 'native.json').read_text())
    error = None
    if method in ('thread/read', 'thread/resume'):
        result = {'thread': {'id': 'native-thread', 'historyMode': 'legacy' if (root/'legacy').exists() else 'paginated', 'ephemeral': False, 'cliVersion':'0.162.1', 'status': {'type':'idle'}}}
        if p.get('includeTurns') or method == 'thread/resume': result['thread']['turns'] = turns
    elif method == 'thread/turns/list':
        if p.get('sortDirection') == 'desc':
            turns = list(reversed(turns))
        offset, limit = int(p.get('cursor') or 0), min(p.get('limit', 3), 2)
        result = {'data': turns[offset:offset+limit], 'nextCursor': str(offset+limit) if offset+limit < len(turns) else None}
    elif method == 'thread/revert':
        with (root/'writes').open('a') as out: out.write(p['beforeTurnId']+'\n')
        if (root/'disconnect-before').exists(): sys.exit(0)
        if (root/'refuse').exists():
            error = {'code':-32600,'message':'Native refusal'}
        else:
            index = next(i for i,t in enumerate(turns) if t['id'] == p['beforeTurnId'])
            (root/'native.json').write_text(json.dumps(turns[:index]))
            if (root/'disconnect').exists():
                sys.exit(0)
        result = {'thread': {'id':'native-thread','turns':[]}}
    elif method == 'thread/unsubscribe':
        result = {'status':'unsubscribed'}
    elif method == 'config/read':
        result = {'config': {'model_context_window':None, 'model_auto_compact_token_limit':None}}
    elif method == 'model/list':
        result = {'data':[{'id':'fixture','model':'fixture','defaultReasoningEffort':'low',
            'supportedReasoningEfforts':[{'reasoningEffort':'low'},{'reasoningEffort':'high'}]}], 'nextCursor':None}
    else:
        result = {}
    print(json.dumps({'id': request['id'], **({'error':error} if error else {'result':result})}), flush=True)
