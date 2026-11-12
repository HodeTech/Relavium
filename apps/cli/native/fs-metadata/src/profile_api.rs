//! Internal OS profile interface. No profile is enabled by this declaration.
use std::ffi::OsStr;
use std::fs::File;
use std::path::Path;

#[derive(Clone, Copy)]
pub(crate) enum WriteOperation {
    Replace,
    Append,
}

/// Closed host-only failure vocabulary; no native error or metadata is returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeFailure {
    Unsupported,
    AccessDenied,
    Changed,
    Cancelled,
    PossiblyPublished,
}

/// Native full identity and separately proven Node-visible identity, host-private.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeIdentity {
    pub(crate) volume: u64,
    pub(crate) object: u128,
    pub(crate) node_dev: u64,
    pub(crate) node_ino: u64,
}

/// Methods run inside the common component's owned task, never as model capabilities.
/// Publication may only return success when the configured primitive meets atomicity;
/// documented incompatible partial-failure behavior cannot be enabled as uncertainty.
pub(crate) trait Profile {
    type ExistingSnapshot: Send;
    type ParentSnapshot: Send;
    type NewFileSnapshot: Send;

    fn identity(file: &File) -> Result<NativeIdentity, NativeFailure>;
    fn owner_identity() -> Result<String, NativeFailure>;
    fn open_parent(path: &Path) -> Result<File, NativeFailure>;
    fn capture_existing(
        source: &File,
        path: &Path,
        operation: WriteOperation,
    ) -> Result<Self::ExistingSnapshot, NativeFailure>;
    fn recheck_existing(
        snapshot: &Self::ExistingSnapshot,
        source: &File,
        path: &Path,
        operation: WriteOperation,
    ) -> Result<(), NativeFailure>;
    fn apply_and_verify_existing(
        snapshot: &Self::ExistingSnapshot,
        source: &File,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure>;
    fn verify_existing_stage(
        snapshot: &Self::ExistingSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure>;
    fn create_private_directory(path: &Path) -> Result<File, NativeFailure>;
    fn verify_private_directory(path: &Path, directory: &File) -> Result<(), NativeFailure>;
    fn create_private_file(parent: &File, name: &OsStr) -> Result<File, NativeFailure>;
    fn verify_private_file(file: &File) -> Result<(), NativeFailure>;
    /// Cleanup evidence only: regular, single-link, operator-owned; no private-mode claim.
    fn verify_owned_file(file: &File) -> Result<(), NativeFailure>;
    fn capture_parent(
        parent: &File,
        host_mask: Option<u32>,
    ) -> Result<Self::ParentSnapshot, NativeFailure>;
    fn recheck_parent(
        snapshot: &Self::ParentSnapshot,
        parent: &File,
        host_mask: Option<u32>,
    ) -> Result<(), NativeFailure>;

    /// Create empty with actual-parent OS inheritance, then move the same inode
    /// into the already private stage. This hook must not write payload bytes.
    fn create_inherited_empty(
        parent: &File,
        snapshot: &Self::ParentSnapshot,
        host_mask: Option<u32>,
        private_stage: &File,
        temporary_name: &OsStr,
        stage_name: &OsStr,
    ) -> Result<File, NativeFailure>;
    fn capture_inherited_stage(
        parent: &Self::ParentSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<Self::NewFileSnapshot, NativeFailure>;
    fn verify_inherited_stage(
        snapshot: &Self::NewFileSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure>;

    fn publish_existing(
        stage: &File,
        stage_parent: &File,
        stage_name: &OsStr,
        parent: &File,
        target: &OsStr,
    ) -> Result<(), NativeFailure>;
    fn publish_new(
        stage: &File,
        stage_parent: &File,
        stage_name: &OsStr,
        parent: &File,
        target: &OsStr,
    ) -> Result<(), NativeFailure>;
}
