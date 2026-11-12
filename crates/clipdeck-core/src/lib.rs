//! Core logic for the clip manager.
//!
//! Nothing in this crate knows about Tauri or the UI, so it can be built and
//! tested on its own with `cargo test`.

pub mod db;
pub mod error;
pub mod games;
pub mod library;
pub mod live;
pub mod media;
pub mod obs;
pub mod obs_setup;
pub mod organize;
pub mod scan;
pub mod sounds;

pub use error::{Error, Result};
