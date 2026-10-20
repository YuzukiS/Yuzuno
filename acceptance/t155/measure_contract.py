"""Size of the tool contract Core's MCP server gives every Agent, from the
dump that `contract_dump` (core/src/collaboration_mcp.rs) writes; with a
second dump, the change between them.

Characters are Unicode code points, as Python counts them; bytes are UTF-8.
Definitions are measured as compact JSON. Neither is a token count.

usage: measure_contract.py DUMP [AFTER_DUMP]
"""
import collections, json, sys


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def measure(path):
    dump = json.load(open(path))
    tools = dump['tools']
    whole = {t['name']: compact(t) for t in tools}
    texts = collections.Counter()

    def walk(node):
        if isinstance(node, dict):
            if isinstance(node.get('description'), str):
                texts[node['description']] += 1
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    for tool in tools:
        walk(tool['inputSchema'])
    return {
        'tools': len(tools),
        'instructions': {'chars': len(dump['instructions']), 'bytes': len(dump['instructions'].encode())},
        'definitions': {'chars': sum(map(len, whole.values())), 'bytes': sum(len(w.encode()) for w in whole.values())},
        'descriptions': {'chars': sum(len(t['description']) for t in tools)},
        'parameterDescriptions': {'chars': sum(len(k) * n for k, n in texts.items()),
                                  'repeatedChars': sum(len(k) * (n - 1) for k, n in texts.items() if n > 1)},
        'perTool': {name: len(text) for name, text in whole.items()},
    }


def main(paths):
    before = measure(paths[0])
    if len(paths) == 1:
        top = sorted(before['perTool'].items(), key=lambda item: -item[1])[:10]
        print(json.dumps({k: v for k, v in before.items() if k != 'perTool'} | {'largest': top}, indent=2))
        return
    after = measure(paths[1])
    names = set(before['perTool']) | set(after['perTool'])
    changed = {n: [before['perTool'].get(n), after['perTool'].get(n)] for n in sorted(names)
               if before['perTool'].get(n) != after['perTool'].get(n)}
    print(json.dumps({
        'tools': [before['tools'], after['tools']],
        'onlyBefore': sorted(set(before['perTool']) - set(after['perTool'])),
        'onlyAfter': sorted(set(after['perTool']) - set(before['perTool'])),
        **{key: [before[key], after[key]] for key in ['instructions', 'definitions', 'descriptions', 'parameterDescriptions']},
        'changedTools': changed,
    }, indent=2))


if __name__ == '__main__':
    if not 1 <= len(sys.argv) - 1 <= 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
