//! Held-identity cleanup for an exclusively created empty inheritance template.
use std::ffi::CStr;
use std::fs::File;
use std::marker::PhantomData;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;

use crate::profile_api::{NativeFailure, NativeIdentity, Profile};

pub(crate) struct EmptyTemplate<'a, P: Profile> {
    file: Option<File>,
    parent: &'a File,
    temporary: &'a CStr,
    stage: &'a File,
    payload: &'a CStr,
    identity: Option<NativeIdentity>,
    _profile: PhantomData<P>,
}

impl<'a, P: Profile> EmptyTemplate<'a, P> {
    pub(crate) fn new(
        file: File,
        parent: &'a File,
        temporary: &'a CStr,
        stage: &'a File,
        payload: &'a CStr,
    ) -> Result<Self, NativeFailure> {
        let mut guard = Self {
            file: Some(file),
            parent,
            temporary,
            stage,
            payload,
            identity: None,
            _profile: PhantomData,
        };
        guard.identity =
            Some(P::identity(guard.file()).map_err(|_| NativeFailure::CleanupUncertain)?);
        Ok(guard)
    }
    pub(crate) fn file(&self) -> &File {
        self.file.as_ref().expect("template guard owns file")
    }
    pub(crate) fn transfer(mut self) -> File {
        self.file.take().expect("template guard owns file")
    }

    pub(crate) fn abort(mut self) -> Result<(), NativeFailure> {
        let result = self.cleanup(self.file());
        self.file.take();
        result.map_err(|_| NativeFailure::CleanupUncertain)
    }

    fn candidate(&self, directory: &File, name: &CStr, file: &File) -> Result<bool, NativeFailure> {
        let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                name.as_ptr(),
                info.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
                Ok(false)
            } else {
                Err(NativeFailure::Unsupported)
            };
        }
        let info = unsafe { info.assume_init() };
        let identity = P::identity(file)?;
        Ok(Some(identity) == self.identity
            && info.st_mode & libc::S_IFMT == libc::S_IFREG
            && info.st_nlink == 1
            && info.st_dev as u64 == identity.node_dev
            && info.st_ino as u64 == identity.node_ino)
    }

    fn cleanup(&self, file: &File) -> Result<(), NativeFailure> {
        Self::verify_owned_empty(file)?;
        let in_parent = self.candidate(self.parent, self.temporary, file)?;
        let in_stage = self.candidate(self.stage, self.payload, file)?;
        let (directory, name) = match (in_parent, in_stage) {
            (true, false) => (self.parent, self.temporary),
            (false, true) => (self.stage, self.payload),
            _ => return Err(NativeFailure::Changed),
        };
        Self::verify_owned_empty(file)?;
        if !self.candidate(directory, name, file)? {
            return Err(NativeFailure::Changed);
        }
        if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
            return Err(NativeFailure::Unsupported);
        }
        directory.sync_all().map_err(|_| NativeFailure::Unsupported)
    }

    fn verify_owned_empty(file: &File) -> Result<(), NativeFailure> {
        let info = file.metadata().map_err(|_| NativeFailure::Unsupported)?;
        if !info.is_file()
            || info.nlink() != 1
            || info.uid() != unsafe { libc::geteuid() }
            || info.len() != 0
        {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
}

impl<P: Profile> Drop for EmptyTemplate<'_, P> {
    fn drop(&mut self) {
        if let Some(file) = &self.file {
            let _ = self.cleanup(file);
        }
    }
}
