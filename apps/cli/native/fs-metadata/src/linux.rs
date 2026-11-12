//! Closed, descriptor-bound Linux profile. Kernel ACL handling stays in the OS.
//!
//! Local ext4, XFS and overlayfs only; unsupported flags/attributes refuse.
//! Source metadata is never serialized through Node-API or logged.
use crate::profile_api::{NativeFailure, NativeIdentity, Profile, WriteOperation};
use std::ffi::{CString, OsStr};
use std::fs::{File, Metadata, OpenOptions};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;

const MAX_NAMES: usize = 65_536;
const MAX_ATTRIBUTES: usize = 128;
const MAX_VALUE: usize = 65_536;
const MAX_ATTRIBUTE_BYTES: usize = 1_048_576;
// Linux UAPI _IOR/_IOW('f', 1/2, long), on both approved 64-bit Linux targets.
const GET_FLAGS: libc::Ioctl = libc::_IOR::<libc::c_long>(b'f' as u32, 1);
const SET_FLAGS: libc::Ioctl = libc::_IOW::<libc::c_long>(b'f' as u32, 2);
const IMMUTABLE: i32 = 0x10;
const APPEND_ONLY: i32 = 0x20;
// NOCOW must be applied to an empty stage before writing; never retrofit it after payload.
const PRESERVED_FLAGS: i32 = 0x8 | 0x40 | 0x80 | 0x800000; // sync, nodump, noatime, nocow
const MANAGED_FLAGS: i32 = 0x1000 | 0x80000; // indexed directories, extent layout
const DIRECTORY_FLAGS: i32 = 0x10000; // dirsync; observed on parent, not reproduced

pub(crate) struct LinuxProfile;

#[derive(PartialEq, Eq)]
struct Credentials {
    uid: u32,
    gid: u32,
    groups: Vec<u32>,
    umask: u32,
}

#[derive(PartialEq, Eq)]
struct Policy {
    uid: u32,
    gid: u32,
    mode: u32,
    flags: i32,
    attributes: Vec<(Vec<u8>, Vec<u8>)>,
}

pub(crate) struct ExistingSnapshot {
    metadata: Metadata,
    policy: Policy,
    credentials: Credentials,
}

pub(crate) struct ParentSnapshot {
    dev: u64,
    ino: u64,
    policy: Policy,
    credentials: Credentials,
}

pub(crate) struct NewFileSnapshot {
    policy: Policy,
    credentials: Credentials,
}

fn failure() -> NativeFailure {
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::EACCES | libc::EPERM | libc::EROFS) => NativeFailure::AccessDenied,
        _ => NativeFailure::Unsupported,
    }
}

fn component(value: &OsStr) -> Result<CString, NativeFailure> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 255
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&b'/')
    {
        return Err(NativeFailure::Unsupported);
    }
    CString::new(bytes).map_err(|_| NativeFailure::Unsupported)
}

fn path_string(path: &Path) -> Result<CString, NativeFailure> {
    if !path.is_absolute() || path.as_os_str().as_bytes().len() > 4096 {
        return Err(NativeFailure::Unsupported);
    }
    CString::new(path.as_os_str().as_bytes()).map_err(|_| NativeFailure::Unsupported)
}

fn metadata(file: &File) -> Result<Metadata, NativeFailure> {
    file.metadata().map_err(|_| NativeFailure::Unsupported)
}

fn same_version(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.size() == right.size()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
        && right.nlink() == 1
        && right.is_file()
}

fn supported_filesystem(file: &File) -> Result<(), NativeFailure> {
    let mut observed = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // fstatfs initializes the whole output only on success; the descriptor is owned.
    if unsafe { libc::fstatfs(file.as_raw_fd(), observed.as_mut_ptr()) } != 0 {
        return Err(failure());
    }
    let kind = unsafe { observed.assume_init() }.f_type as u64;
    if !matches!(kind, 0xef53 | 0x5846_5342 | 0x794c_7630) {
        return Err(NativeFailure::Unsupported);
    }
    Ok(())
}

fn credentials() -> Result<Credentials, NativeFailure> {
    // Reading proc's Umask avoids temporarily changing the process-global mask.
    let status = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open("/proc/self/status")
        .map_err(|_| NativeFailure::Unsupported)?;
    let mut bytes = Vec::new();
    status
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| NativeFailure::Unsupported)?;
    if bytes.len() > 65_536 {
        return Err(NativeFailure::Unsupported);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| NativeFailure::Unsupported)?;
    let masks: Vec<&str> = text
        .lines()
        .filter_map(|line| line.strip_prefix("Umask:"))
        .collect();
    if masks.len() != 1 {
        return Err(NativeFailure::Unsupported);
    }
    let token = masks[0].trim();
    if token.len() != 4 || !token.bytes().all(|byte| (b'0'..=b'7').contains(&byte)) {
        return Err(NativeFailure::Unsupported);
    }
    let umask = u32::from_str_radix(token, 8).map_err(|_| NativeFailure::Unsupported)?;
    // libc accepts NULL when the count is zero. A racing group change refuses.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if !(0..=256).contains(&count) {
        return Err(NativeFailure::Unsupported);
    }
    let mut groups = vec![0; count as usize];
    let actual = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
    if actual != count {
        return Err(NativeFailure::Changed);
    }
    groups.sort_unstable();
    Ok(Credentials {
        uid: unsafe { libc::geteuid() },
        gid: unsafe { libc::getegid() },
        groups,
        umask,
    })
}

fn flags(file: &File, directory: bool) -> Result<i32, NativeFailure> {
    let mut value: libc::c_int = 0;
    // Linux ioctl_iflags takes int*, despite its long-sized request encoding.
    if unsafe { libc::ioctl(file.as_raw_fd(), GET_FLAGS, &mut value) } != 0 {
        return Err(failure());
    }
    if value & (IMMUTABLE | APPEND_ONLY) != 0 {
        return Err(NativeFailure::AccessDenied);
    }
    let allowed = PRESERVED_FLAGS | MANAGED_FLAGS | if directory { DIRECTORY_FLAGS } else { 0 };
    if value & !allowed != 0 {
        return Err(NativeFailure::Unsupported);
    }
    Ok(value & !MANAGED_FLAGS)
}

fn permitted_attribute(name: &[u8], directory: bool) -> bool {
    (name.starts_with(b"user.") && name.len() > 5)
        || name == b"system.posix_acl_access"
        || (directory && name == b"system.posix_acl_default")
        || name == b"security.selinux"
}

fn read_attribute(file: &File, name: &[u8]) -> Result<Option<Vec<u8>>, NativeFailure> {
    let key = CString::new(name).map_err(|_| NativeFailure::Unsupported)?;
    let mut value = vec![0_u8; MAX_VALUE];
    let length = unsafe {
        libc::fgetxattr(
            file.as_raw_fd(),
            key.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    if length < 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
            Ok(None)
        } else {
            Err(failure())
        };
    }
    let length = usize::try_from(length).map_err(|_| NativeFailure::Unsupported)?;
    if length > value.len() {
        return Err(NativeFailure::Unsupported);
    }
    value.truncate(length);
    Ok(Some(value))
}

fn attributes(file: &File, directory: bool) -> Result<Vec<(Vec<u8>, Vec<u8>)>, NativeFailure> {
    let mut names = vec![0_u8; MAX_NAMES];
    // Bounded buffers are fully owned; every FFI length is checked before slicing.
    let count =
        unsafe { libc::flistxattr(file.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
    if count < 0 || count as usize > names.len() {
        return Err(failure());
    }
    names.truncate(count as usize);
    if !names.is_empty() && names.last() != Some(&0) {
        return Err(NativeFailure::Unsupported);
    }
    let mut result = Vec::new();
    let mut aggregate = names.len();
    for name in names
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        if result.len() >= MAX_ATTRIBUTES
            || name.len() > 255
            || !permitted_attribute(name, directory)
        {
            return Err(NativeFailure::Unsupported);
        }
        let key = CString::new(name).map_err(|_| NativeFailure::Unsupported)?;
        let mut value = vec![0_u8; MAX_VALUE];
        let length = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                key.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        if length < 0 || length as usize > value.len() {
            return Err(failure());
        }
        value.truncate(length as usize);
        aggregate = aggregate
            .checked_add(value.len())
            .ok_or(NativeFailure::Unsupported)?;
        if aggregate > MAX_ATTRIBUTE_BYTES {
            return Err(NativeFailure::Unsupported);
        }
        result.push((name.to_vec(), value));
    }
    result.sort_by(|left, right| left.0.cmp(&right.0));
    if result.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(NativeFailure::Changed);
    }
    // Enumeration can omit inaccessible attributes. Explicit known-policy reads
    // distinguish ENODATA from access/unsupported failures; no empty-list ACL proof.
    let mut known = vec![
        b"system.posix_acl_access".as_slice(),
        b"security.selinux",
        b"security.capability",
        b"security.ima",
        b"security.evm",
    ];
    if directory {
        known.push(b"system.posix_acl_default");
    }
    for name in known {
        let direct = read_attribute(file, name)?;
        if direct.is_some() && !permitted_attribute(name, directory) {
            return Err(NativeFailure::Unsupported);
        }
        let listed = result
            .iter()
            .find(|entry| entry.0 == name)
            .map(|entry| &entry.1);
        if listed != direct.as_ref() {
            return Err(NativeFailure::Changed);
        }
    }
    Ok(result)
}

fn policy(file: &File, directory: bool) -> Result<Policy, NativeFailure> {
    supported_filesystem(file)?;
    let info = metadata(file)?;
    if (directory && !info.is_dir()) || (!directory && (!info.is_file() || info.nlink() != 1)) {
        return Err(NativeFailure::Unsupported);
    }
    // Existing special/privilege-bearing regular files have no enabled profile.
    if !directory && info.mode() & 0o7000 != 0 {
        return Err(NativeFailure::Unsupported);
    }
    Ok(Policy {
        uid: info.uid(),
        gid: info.gid(),
        mode: info.mode() & 0o7777,
        flags: flags(file, directory)?,
        attributes: attributes(file, directory)?,
    })
}

fn writable_source(
    source: &File,
    path: &Path,
    operation: WriteOperation,
) -> Result<(), NativeFailure> {
    let before = metadata(source)?;
    let name = path_string(path)?;
    let mode = libc::O_WRONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if matches!(operation, WriteOperation::Append) {
            libc::O_APPEND
        } else {
            0
        };
    // The kernel performs actual non-truncating access using effective credentials.
    let raw = unsafe { libc::open(name.as_ptr(), mode) };
    if raw < 0 {
        return Err(failure());
    }
    let writable = unsafe { File::from_raw_fd(raw) };
    if !same_version(&before, &metadata(&writable)?) {
        return Err(NativeFailure::Changed);
    }
    Ok(())
}

fn assert_entry(directory: &File, name: &CString, held: &File) -> Result<(), NativeFailure> {
    let mut observed = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            directory.as_raw_fd(),
            name.as_ptr(),
            observed.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(NativeFailure::Changed);
    }
    let observed = unsafe { observed.assume_init() };
    let pinned = metadata(held)?;
    if observed.st_dev != pinned.dev()
        || observed.st_ino != pinned.ino()
        || observed.st_mode & libc::S_IFMT != libc::S_IFREG
        || observed.st_nlink != 1
    {
        return Err(NativeFailure::Changed);
    }
    Ok(())
}

fn rename_noreplace(
    source_parent: &File,
    source_name: &CString,
    parent: &File,
    target: &CString,
) -> libc::c_long {
    // musl 1.2.5 has no renameat2 wrapper. Use libc's kernel ABI binding, not a
    // link/unlink emulation; ENOSYS/unsupported filesystem support refuses.
    unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            parent.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    }
}

impl Profile for LinuxProfile {
    type ExistingSnapshot = ExistingSnapshot;
    type ParentSnapshot = ParentSnapshot;
    type NewFileSnapshot = NewFileSnapshot;

    fn identity(file: &File) -> Result<NativeIdentity, NativeFailure> {
        let info = metadata(file)?;
        Ok(NativeIdentity {
            volume: info.dev(),
            object: u128::from(info.ino()),
            node_dev: info.dev(),
            node_ino: info.ino(),
        })
    }

    fn owner_identity() -> Result<String, NativeFailure> {
        Ok(unsafe { libc::geteuid() }.to_string())
    }

    fn open_parent(path: &Path) -> Result<File, NativeFailure> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| NativeFailure::Unsupported)?;
        supported_filesystem(&file)?;
        Ok(file)
    }

    fn capture_existing(
        source: &File,
        path: &Path,
        operation: WriteOperation,
    ) -> Result<ExistingSnapshot, NativeFailure> {
        let before = metadata(source)?;
        writable_source(source, path, operation)?;
        let policy = policy(source, false)?;
        let credentials = credentials()?;
        if !same_version(&before, &metadata(source)?) {
            return Err(NativeFailure::Changed);
        }
        Ok(ExistingSnapshot {
            metadata: before,
            policy,
            credentials,
        })
    }

    fn recheck_existing(
        snapshot: &ExistingSnapshot,
        source: &File,
        path: &Path,
        operation: WriteOperation,
    ) -> Result<(), NativeFailure> {
        if credentials()? != snapshot.credentials
            || !same_version(&snapshot.metadata, &metadata(source)?)
            || policy(source, false)? != snapshot.policy
        {
            return Err(NativeFailure::Changed);
        }
        writable_source(source, path, operation)?;
        if !same_version(&snapshot.metadata, &metadata(source)?) {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }

    fn apply_and_verify_existing(
        snapshot: &ExistingSnapshot,
        _source: &File,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        let before = metadata(stage)?;
        if !before.is_file() || before.nlink() != 1 || before.size() != 0 {
            return Err(NativeFailure::Changed);
        }
        if (before.uid() != snapshot.policy.uid || before.gid() != snapshot.policy.gid)
            && unsafe { libc::fchown(stage.as_raw_fd(), snapshot.policy.uid, snapshot.policy.gid) }
                != 0
        {
            return Err(failure());
        }
        if unsafe { libc::fchmod(stage.as_raw_fd(), snapshot.policy.mode) } != 0 {
            return Err(failure());
        }
        #[cfg(test)]
        crate::test_hooks::hit("partial-metadata");
        let current = attributes(stage, false)?;
        for (name, _) in &current {
            if !snapshot
                .policy
                .attributes
                .iter()
                .any(|(wanted, _)| wanted == name)
            {
                let name = CString::new(name.as_slice()).map_err(|_| NativeFailure::Unsupported)?;
                if unsafe { libc::fremovexattr(stage.as_raw_fd(), name.as_ptr()) } != 0 {
                    return Err(failure());
                }
            }
        }
        for (name, value) in &snapshot.policy.attributes {
            if current
                .iter()
                .any(|entry| &entry.0 == name && &entry.1 == value)
            {
                continue;
            }
            let name = CString::new(name.as_slice()).map_err(|_| NativeFailure::Unsupported)?;
            if unsafe {
                libc::fsetxattr(
                    stage.as_raw_fd(),
                    name.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            } != 0
            {
                return Err(failure());
            }
        }
        let mut desired = snapshot.policy.flags;
        if flags(stage, false)? != desired
            && unsafe { libc::ioctl(stage.as_raw_fd(), SET_FLAGS, &mut desired) } != 0
        {
            return Err(failure());
        }
        Self::verify_existing_stage(snapshot, stage, stage_path)?;
        // mtime/ctime reflect the newly written bytes; old timestamps are not copied.
        Ok(())
    }

    fn verify_existing_stage(
        snapshot: &ExistingSnapshot,
        stage: &File,
        _stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        if policy(stage, false)? != snapshot.policy || credentials()? != snapshot.credentials {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }

    fn create_private_directory_owned(
        path: &Path,
        adopt: &mut dyn FnMut(&File) -> Result<(), NativeFailure>,
    ) -> Result<File, NativeFailure> {
        let parent = Self::open_parent(path.parent().ok_or(NativeFailure::Unsupported)?)?;
        let name = component(path.file_name().ok_or(NativeFailure::Unsupported)?)?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(failure());
        }
        #[cfg(test)]
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".relavium-fs-stage-v1."))
            && crate::test_hooks::fail("private-dir-preopen")
        {
            return Err(NativeFailure::CleanupUncertain);
        }
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_DIRECTORY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(NativeFailure::CleanupUncertain);
        }
        let directory = unsafe { File::from_raw_fd(fd) };
        let guard = crate::unix_private_guard::PrivateCreated::<Self>::new(
            directory, &parent, &name, true,
        )?;
        let attempt = (|| {
            #[cfg(test)]
            if path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".relavium-fs-stage-v1."))
                && crate::test_hooks::fail("private-dir-open")
            {
                return Err(NativeFailure::Unsupported);
            }
            Self::verify_private_directory(path, guard.file())?;
            adopt(guard.file())
        })();
        if let Err(error) = attempt {
            guard.abort()?;
            return Err(error);
        }
        Ok(guard.transfer())
    }

    fn verify_private_directory(path: &Path, directory: &File) -> Result<(), NativeFailure> {
        let info = metadata(directory)?;
        let lexical = std::fs::symlink_metadata(path).map_err(|_| NativeFailure::Unsupported)?;
        if !info.is_dir()
            || !lexical.is_dir()
            || lexical.file_type().is_symlink()
            || info.dev() != lexical.dev()
            || info.ino() != lexical.ino()
            || info.uid() != unsafe { libc::geteuid() }
            || info.mode() & 0o7777 != 0o700
        {
            return Err(NativeFailure::AccessDenied);
        }
        // Linux POSIX ACL group entries are constrained by the mode's group mask.
        // mode0700 therefore grants no named-user/group access; the kernel evaluates ACLs.
        policy(directory, true)?;
        Ok(())
    }

    fn create_private_file_owned(
        parent: &File,
        name: &OsStr,
        adopt: &mut dyn FnMut(&File) -> Result<(), NativeFailure>,
    ) -> Result<File, NativeFailure> {
        let name = component(name)?;
        let raw = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if raw < 0 {
            return Err(failure());
        }
        let file = unsafe { File::from_raw_fd(raw) };
        let guard =
            crate::unix_private_guard::PrivateCreated::<Self>::new(file, parent, &name, false)?;
        let attempt = (|| {
            #[cfg(test)]
            if name.to_bytes() == b"payload" && crate::test_hooks::fail("private-file-open") {
                return Err(NativeFailure::Unsupported);
            }
            if unsafe { libc::fchmod(guard.file().as_raw_fd(), 0o600) } != 0 {
                return Err(NativeFailure::Unsupported);
            }
            Self::verify_private_file(guard.file())?;
            adopt(guard.file())
        })();
        if let Err(error) = attempt {
            guard.abort()?;
            return Err(error);
        }
        Ok(guard.transfer())
    }

    fn verify_private_file(file: &File) -> Result<(), NativeFailure> {
        let info = metadata(file)?;
        if !info.is_file()
            || info.nlink() != 1
            || info.uid() != unsafe { libc::geteuid() }
            || info.mode() & 0o7777 != 0o600
        {
            return Err(NativeFailure::AccessDenied);
        }
        policy(file, false)?;
        Ok(())
    }

    fn verify_owned_file(file: &File) -> Result<(), NativeFailure> {
        let info = metadata(file)?;
        if !info.is_file() || info.nlink() != 1 || info.uid() != unsafe { libc::geteuid() } {
            return Err(NativeFailure::AccessDenied);
        }
        Ok(())
    }

    fn capture_parent(
        parent: &File,
        _host_mask: Option<u32>,
    ) -> Result<ParentSnapshot, NativeFailure> {
        let info = metadata(parent)?;
        let policy = policy(parent, true)?;
        let credentials = credentials()?;
        if credentials.umask & 0o700 != 0 {
            return Err(NativeFailure::Unsupported);
        }
        let after = metadata(parent)?;
        if info.dev() != after.dev()
            || info.ino() != after.ino()
            || info.ctime() != after.ctime()
            || info.ctime_nsec() != after.ctime_nsec()
        {
            return Err(NativeFailure::Changed);
        }
        Ok(ParentSnapshot {
            dev: info.dev(),
            ino: info.ino(),
            policy,
            credentials,
        })
    }

    fn recheck_parent(
        snapshot: &ParentSnapshot,
        parent: &File,
        _host_mask: Option<u32>,
    ) -> Result<(), NativeFailure> {
        let info = metadata(parent)?;
        if info.dev() != snapshot.dev
            || info.ino() != snapshot.ino
            || policy(parent, true)? != snapshot.policy
            || credentials()? != snapshot.credentials
        {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }

    fn create_inherited_empty(
        parent: &File,
        snapshot: &ParentSnapshot,
        host_mask: Option<u32>,
        private_stage: &File,
        temporary_name: &OsStr,
        stage_name: &OsStr,
        adopt: &mut dyn FnMut(&File) -> Result<(), NativeFailure>,
    ) -> Result<File, NativeFailure> {
        Self::recheck_parent(snapshot, parent, host_mask)?;
        if !temporary_name
            .as_bytes()
            .starts_with(b".relavium-fs-stage-v1.")
        {
            return Err(NativeFailure::Unsupported);
        }
        let temporary = component(temporary_name)?;
        let destination = component(stage_name)?;
        let raw = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
                0o666,
            )
        };
        if raw < 0 {
            return Err(failure());
        }
        let file = unsafe { File::from_raw_fd(raw) };
        let guard = crate::unix_template_guard::EmptyTemplate::<Self>::new(
            file,
            parent,
            &temporary,
            private_stage,
            &destination,
        )?;
        let attempt = (|| {
            #[cfg(test)]
            if crate::test_hooks::fail("template-created") {
                return Err(NativeFailure::Unsupported);
            }
            let initial = policy(guard.file(), false)?;
            assert_entry(parent, &temporary, guard.file())?;
            let renamed = rename_noreplace(parent, &temporary, private_stage, &destination);
            if renamed != 0 {
                return Err(NativeFailure::Unsupported);
            }
            #[cfg(test)]
            if crate::test_hooks::fail("template-moved") {
                return Err(NativeFailure::Unsupported);
            }
            adopt(guard.file())?;
            Ok(initial)
        })();
        let initial = match attempt {
            Ok(initial) => initial,
            Err(error) => {
                guard.abort()?;
                return Err(error);
            }
        };
        let file = guard.transfer();
        #[cfg(test)]
        if crate::test_hooks::fail("template-adopted") {
            return Err(NativeFailure::Unsupported);
        }
        assert_entry(private_stage, &destination, &file)?;
        if metadata(&file)?.size() != 0 || policy(&file, false)? != initial {
            return Err(NativeFailure::Changed);
        }
        Self::recheck_parent(snapshot, parent, host_mask)?;
        Ok(file)
    }

    fn capture_inherited_stage(
        parent: &ParentSnapshot,
        stage: &File,
        _stage_path: &Path,
    ) -> Result<NewFileSnapshot, NativeFailure> {
        if credentials()? != parent.credentials || metadata(stage)?.size() != 0 {
            return Err(NativeFailure::Changed);
        }
        Ok(NewFileSnapshot {
            policy: policy(stage, false)?,
            credentials: credentials()?,
        })
    }

    fn verify_inherited_stage(
        snapshot: &NewFileSnapshot,
        stage: &File,
        _stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        if credentials()? != snapshot.credentials || policy(stage, false)? != snapshot.policy {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }

    fn publish_existing(
        stage: &File,
        stage_parent: &File,
        stage_name: &OsStr,
        parent: &File,
        target: &OsStr,
    ) -> Result<(), NativeFailure> {
        let source_name = component(stage_name)?;
        let target_name = component(target)?;
        assert_entry(stage_parent, &source_name, stage)?;
        if unsafe {
            libc::renameat(
                stage_parent.as_raw_fd(),
                source_name.as_ptr(),
                parent.as_raw_fd(),
                target_name.as_ptr(),
            )
        } != 0
        {
            return Err(NativeFailure::PossiblyPublished);
        }
        Ok(())
    }

    fn publish_new(
        stage: &File,
        stage_parent: &File,
        stage_name: &OsStr,
        parent: &File,
        target: &OsStr,
    ) -> Result<(), NativeFailure> {
        let source_name = component(stage_name)?;
        let target_name = component(target)?;
        assert_entry(stage_parent, &source_name, stage)?;
        if rename_noreplace(stage_parent, &source_name, parent, &target_name) != 0 {
            return Err(
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
                    NativeFailure::Changed
                } else {
                    NativeFailure::PossiblyPublished
                },
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "relavium-linux-profile-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .expect("fresh fixture");
            Self(path)
        }
        fn source(&self) -> File {
            let mut source = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o640)
                .open(self.0.join("source"))
                .expect("fixture source");
            source.write_all(b"old\n").expect("fixture bytes");
            source
        }
        fn stage(&self) -> (PathBuf, File, File) {
            let path = self.0.join(".relavium-fs-stage-v1.fixture");
            let directory = LinuxProfile::create_private_directory(&path).expect("private stage");
            let payload = LinuxProfile::create_private_file(&directory, OsStr::new("payload"))
                .expect("private empty payload");
            (path, directory, payload)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // This test-only fixture has a fresh private root and no user inputs.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn set_attribute(file: &File, name: &[u8], bytes: &[u8]) {
        let name = CString::new(name).expect("fixture attribute name");
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    0,
                )
            },
            0,
            "fixture attribute setup"
        );
    }
    fn fixture_acl(default: bool) -> Vec<u8> {
        // Linux UAPI POSIX ACL xattr v2 provisioning, not an ACL evaluator.
        let mut bytes = 2_u32.to_le_bytes().to_vec();
        let named = unsafe { libc::geteuid() }
            .checked_add(1)
            .expect("fixture uid");
        let entries = [
            (1_u16, if default { 7_u16 } else { 6_u16 }, u32::MAX),
            (2, 4, named),
            (4, if default { 5 } else { 0 }, u32::MAX),
            (16, if default { 5 } else { 4 }, u32::MAX),
            (32, 0, u32::MAX),
        ];
        for (tag, permissions, uid) in entries {
            bytes.extend_from_slice(&tag.to_le_bytes());
            bytes.extend_from_slice(&permissions.to_le_bytes());
            bytes.extend_from_slice(&uid.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn linux_owned_child_mask_and_default_acl_matrix() {
        for mask in ["0022", "0077", "0002", "0777"] {
            let status =
                std::process::Command::new(std::env::current_exe().expect("test executable"))
                    .args(["--ignored", "--exact", "linux::tests::linux_umask_child"])
                    .env("RELAVIUM_TEST_LINUX_MASK", mask)
                    .status()
                    .expect("joined mask child");
            assert!(status.success());
        }
    }

    #[test]
    #[ignore = "owned subprocess fixture run by linux_owned_child_mask_and_default_acl_matrix"]
    fn linux_umask_child() {
        let fixture = Fixture::new();
        let mask = u32::from_str_radix(
            &std::env::var("RELAVIUM_TEST_LINUX_MASK").expect("fixture mask"),
            8,
        )
        .expect("octal mask");
        unsafe {
            libc::umask(mask.try_into().expect("mode mask"));
        }
        let parent = LinuxProfile::open_parent(&fixture.0).expect("parent");
        set_attribute(&parent, b"system.posix_acl_default", &fixture_acl(true));
        let snapshot = LinuxProfile::capture_parent(&parent, None);
        let stage_path = fixture.0.join(".relavium-fs-stage-v1.matrix");
        if mask & 0o700 != 0 {
            assert!(matches!(snapshot, Err(NativeFailure::Unsupported)));
            assert!(!stage_path.exists());
            return;
        }
        let snapshot = snapshot.expect("parent policy");
        let stage_parent =
            LinuxProfile::create_private_directory(&stage_path).expect("private stage");
        let private = LinuxProfile::create_private_file(&stage_parent, OsStr::new("private"))
            .expect("private file");
        LinuxProfile::verify_private_file(&private).expect("private file policy");
        let inherited = LinuxProfile::create_inherited_empty(
            &parent,
            &snapshot,
            None,
            &stage_parent,
            OsStr::new(".relavium-fs-stage-v1.matrix-template"),
            OsStr::new("payload"),
            &mut |_| Ok(()),
        )
        .expect("kernel inherited template");
        let direct = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(fixture.0.join("direct"))
            .expect("direct kernel creation");
        assert!(
            policy(&inherited, false).expect("inherited policy")
                == policy(&direct, false).expect("direct policy")
        );
        LinuxProfile::recheck_parent(&snapshot, &parent, None).expect("parent remains bound");
    }

    #[test]
    fn linux_existing_acl_xattr_and_nodump_survive_changed_bytes() {
        let fixture = Fixture::new();
        let source = fixture.source();
        set_attribute(&source, b"user.relavium.fixture", b"opaque fixture");
        set_attribute(&source, b"system.posix_acl_access", &fixture_acl(false));
        let mut original_flags: libc::c_int = 0;
        assert_eq!(
            unsafe { libc::ioctl(source.as_raw_fd(), GET_FLAGS, &mut original_flags) },
            0
        );
        let mut desired = original_flags | 0x40;
        assert_eq!(
            unsafe { libc::ioctl(source.as_raw_fd(), SET_FLAGS, &mut desired) },
            0
        );
        let snapshot = LinuxProfile::capture_existing(
            &source,
            &fixture.0.join("source"),
            WriteOperation::Replace,
        )
        .expect("supported existing source");
        let (stage_path, stage_parent, mut stage) = fixture.stage();
        LinuxProfile::apply_and_verify_existing(
            &snapshot,
            &source,
            &stage,
            &stage_path.join("payload"),
        )
        .expect("apply exact policy");
        stage.write_all(b"new exact\n").expect("write new bytes");
        LinuxProfile::verify_existing_stage(&snapshot, &stage, &stage_path.join("payload"))
            .expect("post-write policy equality");
        LinuxProfile::recheck_existing(
            &snapshot,
            &source,
            &fixture.0.join("source"),
            WriteOperation::Replace,
        )
        .expect("source still current");
        stage.sync_all().expect("stage sync");
        let parent = LinuxProfile::open_parent(&fixture.0).expect("parent");
        LinuxProfile::publish_existing(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &parent,
            OsStr::new("source"),
        )
        .expect("atomic replacement");
        assert_eq!(
            std::fs::read(fixture.0.join("source")).expect("published bytes"),
            b"new exact\n"
        );
        assert!(policy(&stage, false).expect("published policy") == snapshot.policy);
    }

    #[test]
    fn linux_metadata_only_change_is_detected_and_source_stays_unchanged() {
        let fixture = Fixture::new();
        let source = fixture.source();
        let snapshot = LinuxProfile::capture_existing(
            &source,
            &fixture.0.join("source"),
            WriteOperation::Append,
        )
        .expect("snapshot");
        set_attribute(&source, b"user.relavium.fixture", b"changed policy");
        assert_eq!(
            LinuxProfile::recheck_existing(
                &snapshot,
                &source,
                &fixture.0.join("source"),
                WriteOperation::Append
            ),
            Err(NativeFailure::Changed)
        );
        assert_eq!(
            std::fs::read(fixture.0.join("source")).expect("unchanged bytes"),
            b"old\n"
        );
    }

    #[test]
    fn linux_actual_parent_inheritance_matches_direct_creation_and_rejects_parent_change() {
        let fixture = Fixture::new();
        let parent = LinuxProfile::open_parent(&fixture.0).expect("parent");
        set_attribute(&parent, b"system.posix_acl_default", &fixture_acl(true));
        let snapshot = LinuxProfile::capture_parent(&parent, None).expect("parent snapshot");
        let stage_path = fixture.0.join(".relavium-fs-stage-v1.fixture");
        let stage_parent = LinuxProfile::create_private_directory(&stage_path)
            .expect("private stage under inherited ACL");
        let inherited = LinuxProfile::create_inherited_empty(
            &parent,
            &snapshot,
            None,
            &stage_parent,
            OsStr::new(".relavium-fs-stage-v1.empty"),
            OsStr::new("payload"),
            &mut |_| Ok(()),
        )
        .expect("OS inherited empty file");
        let direct = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(fixture.0.join("direct"))
            .expect("direct OS creation");
        assert!(
            policy(&inherited, false).expect("inherited policy")
                == policy(&direct, false).expect("direct policy")
        );
        let new_snapshot = LinuxProfile::capture_inherited_stage(
            &snapshot,
            &inherited,
            &stage_path.join("payload"),
        )
        .expect("new security snapshot");
        let mut writer = &inherited;
        writer
            .write_all(b"new inherited content")
            .expect("private payload");
        LinuxProfile::verify_inherited_stage(
            &new_snapshot,
            &inherited,
            &stage_path.join("payload"),
        )
        .expect("inherited policy after content");
        LinuxProfile::recheck_parent(&snapshot, &parent, None)
            .expect("ordinary directory entries do not change policy");
        std::fs::set_permissions(&fixture.0, std::fs::Permissions::from_mode(0o750))
            .expect("change parent mode");
        assert_eq!(
            LinuxProfile::recheck_parent(&snapshot, &parent, None),
            Err(NativeFailure::Changed)
        );
    }

    #[test]
    fn linux_new_file_racer_is_never_clobbered() {
        let fixture = Fixture::new();
        let (_path, stage_parent, mut stage) = fixture.stage();
        stage.write_all(b"proposed").expect("private proposal");
        std::fs::write(fixture.0.join("target"), b"racer").expect("racing target");
        let parent = LinuxProfile::open_parent(&fixture.0).expect("parent");
        assert_eq!(
            LinuxProfile::publish_new(
                &stage,
                &stage_parent,
                OsStr::new("payload"),
                &parent,
                OsStr::new("target")
            ),
            Err(NativeFailure::Changed)
        );
        assert_eq!(
            std::fs::read(fixture.0.join("target")).expect("racer bytes"),
            b"racer"
        );
        assert_eq!(
            std::fs::read(fixture.0.join(".relavium-fs-stage-v1.fixture/payload"))
                .expect("proposal retained"),
            b"proposed"
        );
        std::fs::remove_file(fixture.0.join("target")).expect("remove owned racing fixture");
        LinuxProfile::publish_new(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &parent,
            OsStr::new("target"),
        )
        .expect("publish after target is actually absent");
        assert_eq!(
            std::fs::read(fixture.0.join("target")).expect("new exact bytes"),
            b"proposed"
        );
    }

    #[test]
    fn linux_actual_nontruncating_access_denial_preserves_source() {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "run permission controls as an ordinary user"
        );
        let fixture = Fixture::new();
        let source = fixture.source();
        std::fs::set_permissions(
            fixture.0.join("source"),
            std::fs::Permissions::from_mode(0o400),
        )
        .expect("deny effective writes");
        for operation in [WriteOperation::Replace, WriteOperation::Append] {
            assert!(matches!(
                LinuxProfile::capture_existing(&source, &fixture.0.join("source"), operation),
                Err(NativeFailure::AccessDenied)
            ));
        }
        assert_eq!(
            std::fs::read(fixture.0.join("source")).expect("unchanged denied source"),
            b"old\n"
        );
        assert_eq!(
            metadata(&source).expect("source policy").mode() & 0o777,
            0o400
        );
    }

    #[test]
    fn linux_stage_alias_and_privilege_bits_refuse_without_publication() {
        let fixture = Fixture::new();
        let source = fixture.source();
        std::fs::set_permissions(
            fixture.0.join("source"),
            std::fs::Permissions::from_mode(0o4640),
        )
        .expect("privilege-bearing fixture");
        assert!(matches!(
            LinuxProfile::capture_existing(
                &source,
                &fixture.0.join("source"),
                WriteOperation::Replace
            ),
            Err(NativeFailure::Unsupported)
        ));
        let (stage_path, stage_parent, stage) = fixture.stage();
        LinuxProfile::verify_owned_file(&stage).expect("owned stage");
        std::fs::set_permissions(
            stage_path.join("payload"),
            std::fs::Permissions::from_mode(0o640),
        )
        .expect("final policy");
        LinuxProfile::verify_owned_file(&stage).expect("final permissions do not waive ownership");
        std::fs::hard_link(stage_path.join("payload"), fixture.0.join("alias"))
            .expect("synthetic external alias");
        assert_eq!(
            LinuxProfile::verify_owned_file(&stage),
            Err(NativeFailure::AccessDenied)
        );
        let parent = LinuxProfile::open_parent(&fixture.0).expect("parent");
        assert_eq!(
            LinuxProfile::publish_existing(
                &stage,
                &stage_parent,
                OsStr::new("payload"),
                &parent,
                OsStr::new("source")
            ),
            Err(NativeFailure::Changed)
        );
        assert_eq!(
            std::fs::read(fixture.0.join("source")).expect("source unchanged"),
            b"old\n"
        );
    }
}
