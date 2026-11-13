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

The real auto memory folder (YN-93). claude-swap shares chat history by
linking the profile's `projects/` to `~/.claude/projects` (its README, "Chat
history"), and Claude Code keeps auto memory in `<config dir>/projects/
<project>/memory/`. Claude Code checks a write both at the path asked for
and at the path it resolves to, and allows auto memory writes only inside
its auto memory folder as spelled: through the link every memory write asks
for permission. When Core asks for it (YUZUNO_CSWAP_REAL_MEMORY=1, which it
leaves out at the read-only level), this names that same folder by its real
path as `autoMemoryDirectory` in `--settings`, which Claude Code reads from
`--settings` like any settings scope (code.claude.com/docs/en/memory). It
does so only at the moment claude-swap execs Claude, the one point where the
profile (CLAUDE_CONFIG_DIR) is known, and only when it can name the folder
as Claude Code 2.1.318 does; otherwise Claude's arguments stay as they were.
"""
import json
import os
import sys
import unicodedata

USAGE = "usage: cswap-run.py <account number> -- <claude arguments>..."

# Set by Core for an executor that may write (YN-93).
REAL_MEMORY = "YUZUNO_CSWAP_REAL_MEMORY"
# Each of these makes Claude Code put auto memory somewhere else.
MEMORY_ELSEWHERE = ("CLAUDE_CODE_PROJECT_DIR_NAME", "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE", "CLAUDE_CODE_REMOTE_MEMORY_DIR")
# Claude Code adds a hash of its own to a longer folder name.
NAME_LIMIT = 200


def read_text(path):
    with open(path, encoding="utf-8") as file:
        return file.read().strip()


def git_root(start):
    """The nearest folder at or above `start` with a `.git`, as Claude Code finds it."""
    path = os.path.abspath(start)
    while True:
        dot_git = os.path.join(path, ".git")
        if os.path.isdir(dot_git) or os.path.isfile(dot_git):
            return path
        parent = os.path.dirname(path)
        if parent == path:
            return None
        path = parent


def main_checkout(root):
    """A linked worktree's main checkout, Claude Code's rule for one auto memory
    folder per repository; `root` for any other checkout; None when unsure."""
    if os.path.isdir(os.path.join(root, ".git")):
        return root
    text = read_text(os.path.join(root, ".git"))
    if not text.startswith("gitdir:"):
        return root
    gitdir = os.path.normpath(os.path.join(root, text[len("gitdir:"):].strip()))
    if not os.path.isfile(os.path.join(gitdir, "commondir")):
        return root
    common = os.path.normpath(os.path.join(gitdir, read_text(os.path.join(gitdir, "commondir"))))
    if os.path.dirname(gitdir) != os.path.join(common, "worktrees") or not os.path.isfile(os.path.join(gitdir, "gitdir")):
        return root
    back = os.path.join(gitdir, read_text(os.path.join(gitdir, "gitdir")))
    if os.path.realpath(back) != os.path.join(os.path.realpath(root), ".git"):
        return root
    # A bare repository's worktree is not followed here.
    return os.path.dirname(common) if os.path.basename(common) == ".git" else None


def folder_name(path):
    """Claude Code's folder name: each UTF-16 unit but a-z, A-Z, 0-9 becomes '-'."""
    name = "".join(c if c.isascii() and c.isalnum() else "-" * (2 if ord(c) > 0xFFFF else 1) for c in path)
    return name if len(name) <= NAME_LIMIT else None


def chooses_memory_folder(config, folders):
    """Whether a settings file Claude reads here names its own memory folder,
    or cannot be read (then it is not second-guessed)."""
    files = [os.path.join(config, "settings.json")]
    files += [os.path.join(folder, ".claude", name) for folder in folders for name in ("settings.json", "settings.local.json")]
    for path in files:
        try:
            with open(path, encoding="utf-8") as file:
                settings = json.load(file)
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            return True
        if not isinstance(settings, dict) or settings.get("autoMemoryDirectory") is not None:
            return True
    return False


def real_memory_folder(env, cwd):
    """The real path of this session's auto memory folder, when a link under
    the profile's `projects/` puts it elsewhere; otherwise None."""
    config = env.get("CLAUDE_CONFIG_DIR")
    if not config or any(env.get(name) for name in MEMORY_ELSEWHERE):
        return None
    root = git_root(cwd)
    project = cwd if root is None else main_checkout(root)
    if project is None or unicodedata.normalize("NFC", project) != project:
        return None
    name = folder_name(project)
    if name is None or chooses_memory_folder(config, {cwd, project}):
        return None
    config = os.path.abspath(config)
    real = os.path.realpath(os.path.join(config, "projects", name, "memory"))
    return None if real == os.path.join(os.path.realpath(config), "projects", name, "memory") else real


def with_real_memory(argv, env, cwd):
    """`argv` (the program first) with the real memory folder in --settings."""
    if any(arg == "--settings" or arg.startswith("--settings=") for arg in argv[1:]):
        return argv
    try:
        folder = real_memory_folder(env, cwd)
    except (OSError, UnicodeError) as error:
        print(f"cswap-run: the auto memory folder was not looked up: {error}", file=sys.stderr)
        return argv
    if folder is None:
        return argv
    print(f"cswap-run: auto memory folder {folder} (its real path)", file=sys.stderr)
    return [argv[0], "--settings", json.dumps({"autoMemoryDirectory": folder}), *argv[1:]]


def name_real_memory_at_exec():
    """claude-swap execs Claude with os.execvpe on POSIX (docs/claude-swap.md);
    Claude's arguments get the real memory folder there."""
    exec_claude = os.execvpe

    def execvpe(file, args, env):
        return exec_claude(file, with_real_memory(list(args), env, os.getcwd()), env)

    os.execvpe = execvpe


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
    # Core's request for this launcher only: Claude does not inherit it.
    if os.environ.pop(REAL_MEMORY, None) == "1":
        name_real_memory_at_exec()
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
