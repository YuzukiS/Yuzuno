"""A stub model provider for the OpenCode 2.x lab probe (T-32 slice 4a): an
OpenAI-compatible chat completions server on loopback, so that a real
`opencode serve` runs a prompt with no network and no real provider.

`python3 stub_provider.py <log>` prints its port, then serves
`POST /v1/chat/completions`. Each request is appended to <log> as one JSON
line: its path, its Authorization header, whether it streams, the names of
the tools it offers, its model and messages. It answers by the newest user
message's keyword:
- `probe-4a tools`: some text, then one call of OpenCode's `read` tool for
  `a.txt`; once that tool's result is back, a last text.
- `probe-4a image`: a short text.
- `probe-4a slow`: nothing for 30 seconds, so the run can be interrupted.
- `probe-4a ask`: one call of OpenCode's `shell` tool, which the probe's
  config makes OpenCode ask permission for.
- `probe-4a form`: one call of OpenCode's `question` tool, which opens a form.
- `probe-61 mcp` (T-61 slice 1): one call of the Workspace MCP's
  `yuzuno_peers_list`; once its result is back, a last text.
- 2.x's summary prompt (T-61 slice 4: "You MUST summarize the conversation
  above", 2.2.5 core/src/session/compaction.ts), with or without tools: a
  summary in 2.x's template, which 2.x checks by its headings.
A request without tools (OpenCode's own title, say) is answered with a
title, streamed when it asks for a stream, as OpenCode does.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[1]


def chunk(delta, finish=None):
    return {'id': 'chatcmpl-stub', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fake',
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}


USAGE = {'id': 'chatcmpl-stub', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fake', 'choices': [],
         'usage': {'prompt_tokens': 11, 'completion_tokens': 7, 'total_tokens': 18}}


# A summary in 2.x's template (2.2.5 checks it has one of its `##` headings).
SUMMARY = '## Objective\n- probe-61 compaction summary.\n\n## Next Move\n1. (none)'


def text_of(message):
    content = message.get('content')
    if isinstance(content, str):
        return content
    return ' '.join(part.get('text', '') for part in content or [] if isinstance(part, dict))


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        messages = body.get('messages') or []
        with open(LOG, 'a') as out:
            out.write(json.dumps({'path': self.path, 'authorization': self.headers.get('authorization'),
                                  'stream': bool(body.get('stream')), 'tools': bool(body.get('tools')),
                                  'toolNames': [t.get('function', {}).get('name') for t in body.get('tools') or []],
                                  'model': body.get('model'), 'messages': messages}) + '\n')
        users = [m for m in messages if m.get('role') == 'user']
        asked = text_of(users[-1]) if users else ''
        last = messages[-1].get('role') if messages else None
        if 'You MUST summarize the conversation above' in asked:
            if body.get('stream'):
                return self.stream([chunk({'role': 'assistant', 'content': SUMMARY}), chunk({}, 'stop')])
            return self.whole(SUMMARY)
        if not body.get('tools'):
            if body.get('stream'):
                return self.stream([chunk({'role': 'assistant', 'content': 'Stub title'}), chunk({}, 'stop')])
            return self.whole('Stub title')
        if 'probe-4a slow' in asked:
            time.sleep(30)
            return self.stream([chunk({'role': 'assistant', 'content': 'Too late.'}), chunk({}, 'stop')])
        if last != 'tool' and ('probe-4a ask' in asked or 'probe-4a form' in asked):
            name, arguments = ('shell', {'command': 'echo probe-4a'}) if 'probe-4a ask' in asked else \
                ('question', {'questions': [{'question': 'Which one?', 'header': 'Pick',
                                             'options': [{'label': 'A', 'description': 'the first'}]}]})
            call = {'index': 0, 'id': 'call_stub_2', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}
            return self.stream([chunk({'role': 'assistant', 'tool_calls': [call]}), chunk({}, 'tool_calls')])
        if 'probe-61 mcp' in asked:
            if last != 'tool':
                call = {'index': 0, 'id': 'call_stub_61', 'type': 'function',
                        'function': {'name': 'yuzuno_peers_list', 'arguments': '{}'}}
                return self.stream([chunk({'role': 'assistant', 'tool_calls': [call]}), chunk({}, 'tool_calls')])
            return self.stream([chunk({'role': 'assistant', 'content': 'Peers seen.'}), chunk({}, 'stop')])
        if 'probe-4a tools' in asked and last != 'tool':
            call = {'index': 0, 'id': 'call_stub_1', 'type': 'function',
                    'function': {'name': 'read', 'arguments': json.dumps({'path': 'a.txt'})}}
            return self.stream([chunk({'role': 'assistant', 'content': 'Looking'}), chunk({'content': ' at it.'}),
                                chunk({'tool_calls': [call]}), chunk({}, 'tool_calls')])
        if 'probe-4a tools' in asked:
            return self.stream([chunk({'role': 'assistant', 'content': 'Done'}), chunk({'content': '.'}), chunk({}, 'stop')])
        return self.stream([chunk({'role': 'assistant', 'content': 'Seen.'}), chunk({}, 'stop')])

    def whole(self, text):
        data = json.dumps({'id': 'chatcmpl-stub', 'object': 'chat.completion', 'created': 1, 'model': 'fake',
                           'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
                           'usage': USAGE['usage']}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream(self, chunks):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('cache-control', 'no-cache')
        self.send_header('connection', 'close')
        self.end_headers()
        self.close_connection = True
        try:
            for one in [*chunks, USAGE]:
                self.wfile.write(b'data: ' + json.dumps(one).encode() + b'\n\n')
                self.wfile.flush()
                time.sleep(0.05)
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
