//! The S1 remote program: a session started over SSH, with no port, socket,
//! daemon, or GPU access. This slice packages and starts it (PR2); sampling,
//! Core's connection manager and Home are later slices.

mod package;

#[cfg(test)]
mod tests;

pub(crate) use package::boot_command;
