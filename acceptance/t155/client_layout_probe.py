"""Where does a native client put an MCP server's instructions and tool
descriptions in the request it sends its model? Runs the client once against
a throwaway stdio MCP server with marked text and a local endpoint that only
records request bodies (never headers) and answers 400. No model is called;
the client gets a dummy key and a temporary home.

usage: client_layout_probe.py --harness codex|claude --out DIR [--tools N] [--words W]
"""
import argparse, json, os, pathlib, subprocess, sys, textwrap, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVER = textwrap.dedent('''
    import json, sys
    INSTR = "PROBE-INSTRUCTIONS-START " + "rule. " * 60 + "PROBE-INSTRUCTIONS-END"
    TOOLS = [{"name": f"probe_{i:02d}", "description": f"PROBE-DESC-{i:02d}: " + "word " * int(sys.argv[2]),
              "inputSchema": {"type": "object", "properties": {"x": {"type": "string", "description": f"PROBE-PARAM-{i:02d}"}}}}
             for i in range(int(sys.argv[1]))]
    for line in sys.stdin:
        msg = json.loads(line)
        if "id" not in msg:
            continue
        if msg.get("method") == "initialize":
            result = {"protocolVersion": msg["params"].get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                      "serverInfo": {"name": "probe", "version": "0"}, "instructions": INSTR}
        elif msg.get("method") == "tools/list":
            result = {"tools": TOOLS}
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}), flush=True)
''')


def recorder(out):
    bodies = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('content-length', 0)))
            (out / f'request-{len(bodies)}.json').write_bytes(body)
            bodies.append(body)
            self.send_response(400)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":{"type":"invalid_request_error","message":"probe stops here"}}')

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, bodies


def run(harness, out, tools, words):
    out.mkdir(parents=True, exist_ok=True)
    (out / 'mcp_probe.py').write_text(SERVER)
    work = out / 'work'
    work.mkdir(exist_ok=True)
    server, bodies = recorder(out)
    url = f'http://127.0.0.1:{server.server_port}'
    command = [sys.executable, str(out / 'mcp_probe.py'), str(tools), str(words)]
    env = {k: v for k, v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'OPENAI_', 'CODEX_', 'CLAUDE_'))}
    if harness == 'codex':
        home = out / 'codex-home'
        home.mkdir(exist_ok=True)
        (home / 'config.toml').write_text(textwrap.dedent(f'''
            model = "gpt-5"
            model_provider = "probe"
            check_for_update_on_startup = false
            [model_providers.probe]
            name = "probe"
            base_url = "{url}/v1"
            env_key = "PROBE_KEY"
            wire_api = "responses"
            request_max_retries = 0
            stream_max_retries = 0
            [mcp_servers.probe]
            command = {json.dumps(command[0])}
            args = {json.dumps(command[1:])}
        '''))
        env |= {'CODEX_HOME': str(home), 'PROBE_KEY': 'dummy'}
        argv = ['codex', 'exec', '--skip-git-repo-check', 'hello']
    else:
        home = out / 'claude-home'
        home.mkdir(exist_ok=True)
        config = out / 'mcp.json'
        config.write_text(json.dumps({'mcpServers': {'probe': {'type': 'stdio', 'command': command[0], 'args': command[1:]}}}))
        env |= {'CLAUDE_CONFIG_DIR': str(home), 'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_API_KEY': 'dummy',
                'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        argv = ['claude', '-p', 'hello', '--mcp-config', str(config), '--strict-mcp-config']
    version = subprocess.run([argv[0], '--version'], capture_output=True, text=True, env=env).stdout.strip()
    subprocess.run(argv, cwd=work, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    server.shutdown()
    if not bodies:
        sys.exit(f'{harness} sent no request to the recorder')
    request = json.loads(bodies[0])
    text = json.dumps(request)
    entries = request.get('tools', [])
    probe = [t for t in entries if 'probe' in t.get('name', '')]
    report = {
        'harness': harness, 'version': version, 'toolsOffered': tools, 'descriptionChars': len('PROBE-DESC-00: ' + 'word ' * words),
        'instructionsCopies': text.count('PROBE-INSTRUCTIONS-START'),
        'firstToolDescriptionCopies': text.count('PROBE-DESC-00'),
        'probeEntries': [{'name': t.get('name'), 'type': t.get('type'), 'nested': len(t.get('tools', [])),
                          'descriptionStartsWithInstructions': str(t.get('description', '')).startswith('PROBE-INSTRUCTIONS')}
                         for t in probe],
        'requests': len(bodies),
    }
    (out / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--harness', choices=['codex', 'claude'], required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--tools', type=int, default=2)
    parser.add_argument('--words', type=int, default=20, help='words of 5 characters in each tool description')
    args = parser.parse_args()
    run(args.harness, args.out, args.tools, args.words)
