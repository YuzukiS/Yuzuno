//! The S1 remote program: a session started over SSH, with no port, socket,
//! daemon, or GPU access. package.rs packages and starts it; program.py
//! answers frames and, once watched, samples CPU, memory and the data root's
//! free space (program_tests.py, run from tests.rs). link.rs is Core's side
//! of one such session over one SSH connection, with protocol.rs checking
//! what it reads; no part of Core starts one yet. The Workspace's links, the
//! machine-live API and Home are later slices.

mod link;
mod package;
mod protocol;

// The sshd fixture is jobs::ssh_mux_tests, built where it is.
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod link_tests;
#[cfg(test)]
mod protocol_tests;
#[cfg(test)]
mod tests;

pub(crate) use package::boot_command;
