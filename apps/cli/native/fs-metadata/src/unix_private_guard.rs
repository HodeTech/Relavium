//! Identity-bound cleanup of freshly created private empty objects.
use std::ffi::CStr;
use std::fs::File;
use std::marker::PhantomData;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;

use crate::profile_api::{NativeFailure, NativeIdentity, Profile};

pub(crate) struct PrivateCreated<'a, P: Profile> {
    file: Option<File>,
    parent: &'a File,
    name: &'a CStr,
    identity: Option<NativeIdentity>,
    directory: bool,
    _profile: PhantomData<P>,
}
impl<'a, P: Profile> PrivateCreated<'a, P> {
    pub(crate) fn new(
        file: File,
        parent: &'a File,
        name: &'a CStr,
        directory: bool,
    ) -> Result<Self, NativeFailure> {
        let mut guard = Self {
            file: Some(file),
            parent,
            name,
            identity: None,
            directory,
            _profile: PhantomData,
        };
        guard.identity =
            Some(P::identity(guard.file()).map_err(|_| NativeFailure::CleanupUncertain)?);
        Ok(guard)
    }
    pub(crate) fn file(&self) -> &File {
        self.file.as_ref().expect("private guard owns file")
    }
    pub(crate) fn transfer(mut self) -> File {
        self.file.take().expect("private guard owns file")
    }
    pub(crate) fn abort(mut self) -> Result<(), NativeFailure> {
        let outcome = self.cleanup(self.file());
        self.file.take();
        outcome.map_err(|_| NativeFailure::CleanupUncertain)
    }
    fn cleanup(&self, file: &File) -> Result<(), NativeFailure> {
        let info = file.metadata().map_err(|_| NativeFailure::Unsupported)?;
        if info.uid() != unsafe { libc::geteuid() }
            || (self.directory && !info.is_dir())
            || (!self.directory && (!info.is_file() || info.nlink() != 1 || info.len() != 0))
            || Some(P::identity(file)?) != self.identity
        {
            return Err(NativeFailure::Changed);
        }
        let mut entry = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                entry.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(NativeFailure::Changed);
        }
        let entry = unsafe { entry.assume_init() };
        let expected_type = if self.directory {
            libc::S_IFDIR
        } else {
            libc::S_IFREG
        };
        let identity = self.identity.ok_or(NativeFailure::Changed)?;
        if entry.st_mode & libc::S_IFMT != expected_type
            || entry.st_dev as u64 != identity.node_dev
            || entry.st_ino as u64 != identity.node_ino
            || (!self.directory && entry.st_nlink != 1)
        {
            return Err(NativeFailure::Changed);
        }
        let flags = if self.directory {
            libc::AT_REMOVEDIR
        } else {
            0
        };
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), flags) } != 0 {
            return Err(NativeFailure::Unsupported);
        }
        self.parent
            .sync_all()
            .map_err(|_| NativeFailure::Unsupported)
    }
}
impl<P: Profile> Drop for PrivateCreated<'_, P> {
    fn drop(&mut self) {
        if let Some(file) = &self.file {
            let _ = self.cleanup(file);
        }
    }
}
