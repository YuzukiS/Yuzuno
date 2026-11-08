"""Start one Claude Code session as a claude-swap account (YN-34 S1b).

    <claude-swap's python> -u cswap-run.py <account number> -- <claude arguments>...

It runs claude-swap's own `cswap run <account> --require-session -- ...`
(docs/claude-swap.md), which execs Claude Code with that account's profile.
The Agent SDK reads Claude's JSON from stdout, and claude-swap 1.0.0 prints
its notices ("Launching Account-2 ...") to stdout before the exec, with no
quiet option. So Python's own `sys.stdout` is pointed at stderr, which
writes through at once, and file descriptor 1 is never touched: the exec'd
Claude writes its JSON to the original stdout.

`--require-session` refuses the account that is the host's current default
login; Core does not ask for that one here, it starts plain `claude` for it.
"""
import sys

USAGE = "usage: cswap-run.py <account number> -- <claude arguments>..."


def main(argv):
    if len(argv) < 2 or not argv[0].isdigit() or argv[1] != "--":
        print(USAGE, file=sys.stderr)
        return 2
    account, claude = argv[0], argv[2:]
    # Anything Python prints from here goes to stderr, at once; fd 1 stays
    # Claude's.
    sys.stderr.reconfigure(line_buffering=True, write_through=True)
    sys.stdout.flush()
    sys.stdout = sys.stderr
    try:
        from claude_swap.cli import main as cswap
    except ImportError as error:
        print(f"claude-swap is not importable with {sys.executable}: {error}", file=sys.stderr)
        return 3
    sys.argv = ["cswap", "run", account, "--require-session", "--", *claude]
    result = cswap()
    return result if isinstance(result, int) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
