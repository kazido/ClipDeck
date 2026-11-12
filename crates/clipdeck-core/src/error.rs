use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{tool} was not found. Install FFmpeg and make sure it is on your PATH.")]
    ToolNotFound { tool: &'static str },

    #[error("file not found: {0}")]
    FileNotFound(PathBuf),

    #[error("{tool} failed: {message}")]
    ToolFailed { tool: &'static str, message: String },

    #[error("could not read ffprobe output: {0}")]
    BadProbeOutput(String),

    #[error("no video stream in {0}")]
    NoVideoStream(PathBuf),

    #[error("not a folder: {0}")]
    NotADirectory(PathBuf),

    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}
