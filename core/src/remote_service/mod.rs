//! The S1 remote program: a session started over SSH, with no port, socket,
//! daemon, or GPU access. package.rs packages and starts it; program.py
//! answers frames and, once watched, samples CPU, memory and the data root's
//! free space (program_tests.py, run from tests.rs). link.rs is Core's side
//! of one such session over one SSH connection, with protocol.rs checking
//! what it reads. registry.rs keeps the Workspace's sessions, one per
//! registered SSH machine, started only for `GET /api/machine-live`
//! (live.rs) while the user's interest lasts. No page asks for it yet: Home's
//! machine card is a later slice (PR5).

mod link;
mod live;
mod package;
mod protocol;
mod registry;

// The sshd fixture is jobs::ssh_mux_tests, built where it is.
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod link_tests;
#[cfg(test)]
mod protocol_tests;
#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod registry_tests;
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod machine_live_tests;
#[cfg(test)]
mod tests;

pub(crate) use live::router;
pub(crate) use package::boot_command;
pub(crate) use registry::{Closing, Registry};
