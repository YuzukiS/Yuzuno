"""Minimal existing-login environment for the historical authenticated lab."""


def authenticated_environment(inherited, tools, node_bin):
    # Preserve the operator's login locations/tokens verbatim, never redirect
    # HOME. Do not inherit Core overrides, editor paths, proxies or shell state.
    login_keys = ('HOME', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR',
                  'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN')
    env = {key: inherited[key] for key in login_keys if key in inherited}
    env.update(LANG='C.UTF-8', PATH=f'{tools}:{node_bin}:/usr/local/bin:/usr/bin:/bin')
    return env
