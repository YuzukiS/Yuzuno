//! The S1 remote program: a session started over SSH, with no port, socket,
//! daemon, or GPU access. package.rs packages and starts it; program.py
//! answers frames and, once watched, samples CPU, memory and the data root's
//! free space (program_tests.py, run from tests.rs). Core's connection
//! manager and Home are later slices.

mod package;

#[cfg(test)]
mod tests;

pub(crate) use package::boot_command;
