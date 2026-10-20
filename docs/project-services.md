# Project services

A project service is a web service that already runs on one of a Project's
machines, such as a Vite dev server, Jupyter or TensorBoard. The user or an
Agent registers it on the Project (a name, the machine, the port the service
listens on there, and a path). Only the user opens it, from the Projects
dialog. Yuzuno never starts, stops or scans a service, and never makes one
public.

## Where it runs

Three computers can be involved: the client (browser or desktop app), the
Core host, and the machine the service runs on.

- **Opening** makes Core listen on one port `P` of a fixed range on the Core
  host's loopback (`4380–4389`; `YUZUNO_SERVICE_PORTS=first-last` changes it).
  Each connection to `P` is relayed, unchanged, to the service:
  - on the Core host itself, to `127.0.0.1:PORT`;
  - on an SSH machine, through `ssh -L 127.0.0.1:Q:127.0.0.1:PORT`, using the
    machine's own SSH settings and identity. Only Core connects to `Q`.
- **The client** opens `http://127.0.0.1:P`. That works:
  - on the Core host's own computer (Linux, or Windows through WSL's
    localhost forwarding);
  - from another computer whose own tunnel to Core forwards `P` too (a Mac:
    see [Connect from another computer](independent-core.md#project-services-from-a-mac)).

  Core cannot tell these apart from a request. A port `P` on the client may
  also be a different program there, which answers too.
- **The page proves the way before it offers the address.** Each open gives
  only the opening page a new challenge and its answer. Core answers
  `GET /.well-known/yuzuno-service/<challenge>` on `P` itself. The page asks
  that from the client and offers the link only if the exact answer comes back.
  Anything else on the client's `P` cannot answer it, so the page says this
  computer does not reach the service and offers no address. The service is
  shown as available only when it answered HTTP on its own port in time, not
  because SSH is running.

## States

| State | Meaning |
| --- | --- |
| Not open | Nothing is open for it (also after Core restarts) |
| Answering | Something answered HTTP on the service's port in time |
| Not running | The way is open, but nothing listens on the service's port there |
| Not answering yet | Something listens, but no HTTP response came in time |
| No free port | No port of the range was free on the Core host |
| Machine unreachable | SSH could not reach or sign in to the machine |
| SSH failed | SSH ended before listening, for another reason |
| Disconnected | SSH ended after it was open; Core stopped listening for it |

Opening again checks the open way again. After a disconnect it starts a new
one. Nothing reconnects or reopens by itself.

## Lifecycle

Core holds every part of an open service: its listener on `P`, each relayed
connection, and the SSH. SSH's remote command waits for the end of Core's
stdin pipe, so SSH ends with Core however Core ends. Clients connect only to
Core's port, never to SSH's, so no client connection can keep SSH running.
Closing or deleting a service ends its listener, its connections and its SSH
only. The service itself and other services are never touched, and nothing is
ever looked up or ended by process ID or port.

## Boundaries

- **Same-port WebSocket and HMR** pass through unchanged. A Vite dev server's
  hot reload uses the page's own port by default and works as is.
- **A page that names its own port** (Vite's `server.hmr.clientPort` or
  `hmr.port` set explicitly, an absolute redirect with a port) must be set to
  `P`, which is shown in the dialog.
- **A WebSocket on a separate port** is a service of its own: register that
  port too, and point the page at its `P`.
- **Not:** HTTPS, a public or LAN address, a service on a Windows machine, a
  port of the range or Core's own port as a service on the Core host, or a
  generic proxy for other addresses.

## Security

- Every listener is on loopback only. Each SSH forward names one port on the
  machine's own loopback.
- The service gets its own origin (`127.0.0.1:P`), never Core's. Core adds
  nothing to the service's traffic: no cookie, header or token.
- The challenge's answer proves only that a port reaches this Core. It is not
  a credential, and the list of services never contains it.
- A path is visible to every Agent in the Workspace. Never put a token or
  password in it; type a Jupyter token in the browser instead.

## For Agents

`service_register` (Agents only, with `requestId`) and `services_list`. Agents
cannot open, close or delete a service.

## What was tested

- `cargo test --lib services::` (core/src/services_tests.rs), with an SSH
  stand-in.
- `acceptance/t151-services/check.py`: an isolated Core with real OpenSSH and a
  user-level sshd on 127.0.0.1 (one physical host). It checks:
  - HTTP and WebSocket;
  - a service that is not running;
  - closing one service leaves the others alone;
  - the machine's sshd gone and back;
  - a Mac stand-in on `127.0.0.2` with its own restricted tunnel, which proves
    and opens a service, and refuses a port taken by another program
    answering 200;
  - Core killed with SIGKILL while a client holds a stream.
- Not yet tested: a real Mac, and a separate remote machine.
