//! Descriptor-bound macOS filesystem metadata profile; acceptance remains gated.
use std::os::fd::{AsRawFd, RawFd};
use std::ptr;

const COPYFILE_METADATA: libc::c_uint = 7;
const QUARANTINE: &[u8] = b"com.apple.quarantine\0";
const MAX_QUARANTINE_BYTES: usize = 64 * 1024;
const MAX_ACL_BYTES: usize = 64 * 1024;
const MAX_ATTRIBUTE_COUNT: usize = 128;
const MAX_ATTRIBUTE_BYTES: usize = 1024 * 1024;
const SUPPORTED_FLAGS: u32 = libc::UF_NODUMP | libc::UF_HIDDEN;

extern "C" {
    fn fcopyfile(
        from: libc::c_int,
        to: libc::c_int,
        state: *mut libc::c_void,
        flags: libc::c_uint,
    ) -> libc::c_int;
    fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
    fn acl_size(acl: *mut libc::c_void) -> libc::ssize_t;
    fn acl_copy_ext(
        buffer: *mut libc::c_void,
        acl: *mut libc::c_void,
        size: libc::ssize_t,
    ) -> libc::ssize_t;
    fn acl_free(value: *mut libc::c_void) -> libc::c_int;
    fn filesec_init() -> *mut libc::c_void;
    fn filesec_free(value: *mut libc::c_void);
    fn filesec_set_property(
        value: *mut libc::c_void,
        property: libc::c_int,
        input: *const libc::c_void,
    ) -> libc::c_int;
    fn fchmodx_np(fd: libc::c_int, security: *mut libc::c_void) -> libc::c_int;
    fn filesec_query_property(
        value: *mut libc::c_void,
        property: libc::c_int,
        present: *mut libc::c_int,
    ) -> libc::c_int;
    fn fstatx_np(
        fd: libc::c_int,
        info: *mut libc::stat,
        security: *mut libc::c_void,
    ) -> libc::c_int;
}

/// Fixed internal failures carry no paths, attribute values or native error messages.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MetadataCopyFailure {
    Inspection,
    Limit,
    Copy,
    Changed,
    Verification,
}

struct Acl(*mut libc::c_void);
struct FileSecurity(*mut libc::c_void);

impl Drop for FileSecurity {
    fn drop(&mut self) {
        unsafe { filesec_free(self.0) };
    }
}

impl Drop for Acl {
    fn drop(&mut self) {
        // The pointer came from acl_get_fd and remains owned here until this call.
        unsafe { acl_free(self.0) };
    }
}

/// Capture only an explicitly returned ACL. An absent or unreadable ACL is not
/// interpreted as empty by this helper.
#[allow(dead_code)]
pub(crate) fn capture_explicit_acl(fd: RawFd) -> Result<Vec<u8>, MetadataCopyFailure> {
    let pointer = unsafe { acl_get_fd(fd) };
    if pointer.is_null() {
        return Err(MetadataCopyFailure::Inspection);
    }
    let acl = Acl(pointer);
    let length = unsafe { acl_size(acl.0) };
    if length < 0 {
        return Err(MetadataCopyFailure::Inspection);
    }
    let size = usize::try_from(length).map_err(|_| MetadataCopyFailure::Limit)?;
    if size > MAX_ACL_BYTES {
        return Err(MetadataCopyFailure::Limit);
    }
    let mut bytes = vec![0; size];
    let written = unsafe { acl_copy_ext(bytes.as_mut_ptr().cast(), acl.0, length) };
    if written != length {
        return Err(MetadataCopyFailure::Inspection);
    }
    Ok(bytes)
}

#[repr(C)]
struct VolumeCapabilities {
    length: u32,
    capabilities: [u32; 4],
    valid: [u32; 4],
}

/// Do not treat an unsupported or unreadable ACL interface as an empty ACL.
pub(crate) fn capture_acl(fd: RawFd) -> Result<Option<Vec<u8>>, MetadataCopyFailure> {
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(fd, filesystem.as_mut_ptr()) } != 0 {
        return Err(MetadataCopyFailure::Inspection);
    }
    let filesystem = unsafe { filesystem.assume_init() };
    let name: Vec<u8> = filesystem
        .f_fstypename
        .iter()
        .map(|value| *value as u8)
        .collect();
    let end = name
        .iter()
        .position(|value| *value == 0)
        .ok_or(MetadataCopyFailure::Inspection)?;
    if filesystem.f_flags & libc::MNT_LOCAL as u32 == 0 || &name[..end] != b"apfs" {
        return Err(MetadataCopyFailure::Inspection);
    }
    let mut request = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut caps = VolumeCapabilities {
        length: 0,
        capabilities: [0; 4],
        valid: [0; 4],
    };
    if unsafe {
        libc::fgetattrlist(
            fd,
            (&mut request as *mut libc::attrlist).cast(),
            (&mut caps as *mut VolumeCapabilities).cast(),
            std::mem::size_of::<VolumeCapabilities>(),
            0,
        )
    } != 0
        || usize::try_from(caps.length).ok() != Some(std::mem::size_of::<VolumeCapabilities>())
    {
        return Err(MetadataCopyFailure::Inspection);
    }
    let index = libc::VOL_CAPABILITIES_INTERFACES;
    let bit = libc::VOL_CAP_INT_EXTENDED_SECURITY;
    if caps.valid[index] & bit == 0 || caps.capabilities[index] & bit == 0 {
        return Err(MetadataCopyFailure::Inspection);
    }
    let security = unsafe { filesec_init() };
    if security.is_null() {
        return Err(MetadataCopyFailure::Inspection);
    }
    let security = FileSecurity(security);
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { fstatx_np(fd, info.as_mut_ptr(), security.0) } != 0 {
        return Err(MetadataCopyFailure::Inspection);
    }
    let mut present = 0;
    // FILESEC_ACL is 5 in Apple's sys/fcntl.h; query reports validity, not an ACL evaluator.
    if unsafe { filesec_query_property(security.0, 5, &mut present) } != 0 {
        return Err(MetadataCopyFailure::Inspection);
    }
    if present == 0 {
        return Ok(None);
    }
    capture_explicit_acl(fd).map(Some)
}

fn quarantine(fd: RawFd) -> Result<Option<Vec<u8>>, MetadataCopyFailure> {
    // Null buffer asks the OS for the required byte count; no raw error leaves this module.
    let length =
        unsafe { libc::fgetxattr(fd, QUARANTINE.as_ptr().cast(), ptr::null_mut(), 0, 0, 0) };
    if length < 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOATTR) {
            return Ok(None);
        }
        return Err(MetadataCopyFailure::Inspection);
    }
    let size = usize::try_from(length).map_err(|_| MetadataCopyFailure::Limit)?;
    if size > MAX_QUARANTINE_BYTES {
        return Err(MetadataCopyFailure::Limit);
    }
    let mut bytes = vec![0; size];
    let actual = unsafe {
        libc::fgetxattr(
            fd,
            QUARANTINE.as_ptr().cast(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            0,
            0,
        )
    };
    if actual != length {
        return Err(MetadataCopyFailure::Changed);
    }
    Ok(Some(bytes))
}

/// Copy to a private stage and reapply/verify exact quarantine bytes. This helper
/// alone does not prove other xattrs, ACLs, identity, access, or publication.
#[allow(dead_code)]
pub(crate) fn copy_metadata_with_quarantine(
    source: RawFd,
    stage: RawFd,
) -> Result<(), MetadataCopyFailure> {
    let before = quarantine(source)?;
    if unsafe { fcopyfile(source, stage, ptr::null_mut(), COPYFILE_METADATA) } != 0 {
        return Err(MetadataCopyFailure::Copy);
    }
    #[cfg(test)]
    crate::test_hooks::hit("partial-metadata");
    if let Some(bytes) = &before {
        if unsafe {
            libc::fsetxattr(
                stage,
                QUARANTINE.as_ptr().cast(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
                0,
            )
        } != 0
        {
            return Err(MetadataCopyFailure::Copy);
        }
    }
    if quarantine(source)? != before {
        return Err(MetadataCopyFailure::Changed);
    }
    if quarantine(stage)? != before {
        return Err(MetadataCopyFailure::Verification);
    }
    Ok(())
}

/// A narrower ACL-present experiment. Absence or unreadability refuses; the
/// other metadata, access, staging and publication contracts remain unproven.
#[cfg(test)]
pub(crate) fn copy_explicit_acl_and_quarantine(
    source: RawFd,
    stage: RawFd,
) -> Result<(), MetadataCopyFailure> {
    let before = capture_explicit_acl(source)?;
    copy_metadata_with_quarantine(source, stage)?;
    if capture_explicit_acl(source)? != before {
        return Err(MetadataCopyFailure::Changed);
    }
    if capture_explicit_acl(stage)? != before {
        return Err(MetadataCopyFailure::Verification);
    }
    Ok(())
}

// Unsupported flags, metadata, and filesystem behavior deliberately refuse.
pub(crate) struct MacosProfile;

#[allow(dead_code)]
#[derive(PartialEq, Eq)]
pub(crate) struct MacosExistingSnapshot {
    source: SourceState,
    acl: Option<Vec<u8>>,
    attributes: Vec<(Vec<u8>, Vec<u8>)>,
}

#[derive(PartialEq, Eq)]
struct SourceState {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    flags: u32,
    size: u64,
    mtime: i64,
    mtime_nsec: i64,
    ctime: i64,
    ctime_nsec: i64,
}

#[allow(dead_code)]
#[derive(PartialEq, Eq)]
pub(crate) struct MacosParentSnapshot {
    dev: u64,
    ino: u64,
    uid: u32,
    gid: u32,
    mode: u32,
    flags: u32,
    acl: Option<Vec<u8>>,
    attributes: Vec<(Vec<u8>, Vec<u8>)>,
    effective_uid: u32,
    effective_gid: u32,
    groups: Vec<libc::gid_t>,
    creation_mask: u32,
}

#[allow(dead_code)]
pub(crate) struct MacosNewFileSnapshot {
    state: SourceState,
    acl: Option<Vec<u8>>,
    attributes: Vec<(Vec<u8>, Vec<u8>)>,
}

/// macOS 27 provides a read-only API. Older systems do not fall back to mutating umask.
pub(crate) fn get_creation_mask() -> Option<libc::mode_t> {
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, b"getumask\0".as_ptr().cast()) };
    if symbol.is_null() {
        return None;
    }
    // The fixed system symbol has the public `mode_t getumask(void)` ABI.
    let get: unsafe extern "C" fn() -> libc::mode_t = unsafe { std::mem::transmute(symbol) };
    Some(unsafe { get() })
}

fn observed_mask(host_mask: Option<u32>) -> Result<u32, crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    if host_mask.is_some_and(|mask| mask > 0o777) {
        return Err(NativeFailure::Unsupported);
    }
    match (get_creation_mask().map(u32::from), host_mask) {
        (Some(native), Some(host)) if native != host => Err(NativeFailure::Changed),
        (Some(native), _) => Ok(native),
        (None, Some(host)) => Ok(host),
        (None, None) => Err(NativeFailure::Unsupported),
    }
}

fn parent_snapshot(
    parent: &std::fs::File,
    host_mask: Option<u32>,
) -> Result<MacosParentSnapshot, crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    use std::os::unix::fs::MetadataExt;
    let mask = observed_mask(host_mask)?;
    if mask & 0o700 != 0 {
        return Err(NativeFailure::Unsupported);
    }
    let info = parent.metadata().map_err(|_| NativeFailure::Unsupported)?;
    if !info.is_dir() {
        return Err(NativeFailure::Unsupported);
    }
    let flags = native_flags(parent)?;
    if flags & !SUPPORTED_FLAGS != 0 {
        return Err(NativeFailure::Unsupported);
    }
    let count = unsafe { libc::getgroups(0, ptr::null_mut()) };
    if !(0..=1024).contains(&count) {
        return Err(NativeFailure::Unsupported);
    }
    let mut groups = vec![0; usize::try_from(count).map_err(|_| NativeFailure::Unsupported)?];
    let received = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
    if received != count {
        return Err(NativeFailure::Changed);
    }
    groups.sort_unstable();
    Ok(MacosParentSnapshot {
        dev: info.dev(),
        ino: info.ino(),
        uid: info.uid(),
        gid: info.gid(),
        mode: info.mode(),
        flags,
        acl: capture_acl(parent.as_raw_fd()).map_err(|_| NativeFailure::Unsupported)?,
        attributes: supported_xattrs(parent.as_raw_fd())?,
        effective_uid: unsafe { libc::geteuid() },
        effective_gid: unsafe { libc::getegid() },
        groups,
        creation_mask: mask,
    })
}

fn native_flags(file: &std::fs::File) -> Result<u32, crate::profile_api::NativeFailure> {
    let mut native = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), native.as_mut_ptr()) } != 0 {
        return Err(crate::profile_api::NativeFailure::Unsupported);
    }
    // fstat succeeded and initialized the complete platform stat structure.
    Ok(unsafe { native.assume_init() }.st_flags)
}

fn source_state(file: &std::fs::File) -> Result<SourceState, crate::profile_api::NativeFailure> {
    use std::os::unix::fs::MetadataExt;
    let info = file
        .metadata()
        .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
    if !info.is_file() || info.nlink() != 1 || info.mode() & 0o7000 != 0 {
        return Err(crate::profile_api::NativeFailure::Unsupported);
    }
    let flags = native_flags(file)?;
    if flags & !SUPPORTED_FLAGS != 0 {
        return Err(crate::profile_api::NativeFailure::Unsupported);
    }
    Ok(SourceState {
        dev: info.dev(),
        ino: info.ino(),
        uid: info.uid(),
        gid: info.gid(),
        mode: info.mode(),
        flags,
        size: info.size(),
        mtime: info.mtime(),
        mtime_nsec: info.mtime_nsec(),
        ctime: info.ctime(),
        ctime_nsec: info.ctime_nsec(),
    })
}

fn verify_private_directory_handle(
    directory: &std::fs::File,
) -> Result<(), crate::profile_api::NativeFailure> {
    use std::os::unix::fs::MetadataExt;
    let info = directory
        .metadata()
        .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
    if !info.is_dir()
        || info.uid() != unsafe { libc::geteuid() }
        || info.mode() & 0o7777 != 0o700
        || native_flags(directory)? & !SUPPORTED_FLAGS != 0
        || capture_acl(directory.as_raw_fd())
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?
            .is_some()
    {
        return Err(crate::profile_api::NativeFailure::Unsupported);
    }
    Ok(())
}

fn check_write_access(
    path: &std::path::Path,
    operation: crate::profile_api::WriteOperation,
    expected: &SourceState,
) -> Result<(), crate::profile_api::NativeFailure> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    if matches!(operation, crate::profile_api::WriteOperation::Append) {
        options.append(true);
    }
    let access = options
        .open(path)
        .map_err(|_| crate::profile_api::NativeFailure::AccessDenied)?;
    let actual = source_state(&access)?;
    if &actual != expected {
        return Err(crate::profile_api::NativeFailure::Changed);
    }
    Ok(())
}

fn supported_xattrs(
    fd: RawFd,
) -> Result<Vec<(Vec<u8>, Vec<u8>)>, crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    let length = unsafe { libc::flistxattr(fd, ptr::null_mut(), 0, 0) };
    if length < 0 {
        return Err(NativeFailure::Unsupported);
    }
    let size = usize::try_from(length).map_err(|_| NativeFailure::Unsupported)?;
    if size > 16 * 1024 {
        return Err(NativeFailure::Unsupported);
    }
    let mut names = vec![0_u8; size];
    let actual = unsafe { libc::flistxattr(fd, names.as_mut_ptr().cast(), names.len(), 0) };
    if actual != length {
        return Err(NativeFailure::Changed);
    }
    let mut result = Vec::new();
    if names.is_empty() {
        return Ok(result);
    }
    if names.last() != Some(&0) {
        return Err(NativeFailure::Unsupported);
    }
    let mut total = size;
    for name in names[..names.len() - 1].split(|byte| *byte == 0) {
        if name != b"com.apple.quarantine"
            && name != b"com.apple.provenance"
            && !(name.starts_with(b"user.") && name.len() > b"user.".len())
        {
            return Err(NativeFailure::Unsupported);
        }
        if result.len() >= MAX_ATTRIBUTE_COUNT {
            return Err(NativeFailure::Unsupported);
        }
        let native_name = std::ffi::CString::new(name).map_err(|_| NativeFailure::Unsupported)?;
        let length = unsafe { libc::fgetxattr(fd, native_name.as_ptr(), ptr::null_mut(), 0, 0, 0) };
        let length = usize::try_from(length).map_err(|_| NativeFailure::Unsupported)?;
        if length > MAX_QUARANTINE_BYTES {
            return Err(NativeFailure::Unsupported);
        }
        total = total
            .checked_add(length)
            .ok_or(NativeFailure::Unsupported)?;
        if total > MAX_ATTRIBUTE_BYTES {
            return Err(NativeFailure::Unsupported);
        }
        let mut value = vec![0; length];
        let actual = unsafe {
            libc::fgetxattr(
                fd,
                native_name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        if usize::try_from(actual).ok() != Some(length) {
            return Err(NativeFailure::Changed);
        }
        result.push((name.to_vec(), value));
    }
    result.sort_by(|left, right| left.0.cmp(&right.0));
    if result.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(NativeFailure::Unsupported);
    }
    Ok(result)
}

impl crate::profile_api::Profile for MacosProfile {
    type ExistingSnapshot = MacosExistingSnapshot;
    type ParentSnapshot = MacosParentSnapshot;
    type NewFileSnapshot = MacosNewFileSnapshot;

    fn identity(
        file: &std::fs::File,
    ) -> Result<crate::profile_api::NativeIdentity, crate::profile_api::NativeFailure> {
        use std::os::unix::fs::MetadataExt;
        let info = file
            .metadata()
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        Ok(crate::profile_api::NativeIdentity {
            volume: info.dev(),
            object: u128::from(info.ino()),
            node_dev: info.dev(),
            node_ino: info.ino(),
        })
    }
    fn owner_identity() -> Result<String, crate::profile_api::NativeFailure> {
        Ok(unsafe { libc::geteuid() }.to_string())
    }

    fn open_parent(
        path: &std::path::Path,
    ) -> Result<std::fs::File, crate::profile_api::NativeFailure> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        let opened = parent
            .metadata()
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        let path_info = std::fs::symlink_metadata(path)
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        if !opened.is_dir()
            || path_info.file_type().is_symlink()
            || opened.dev() != path_info.dev()
            || opened.ino() != path_info.ino()
        {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        Ok(parent)
    }
    fn capture_existing(
        source: &std::fs::File,
        path: &std::path::Path,
        operation: crate::profile_api::WriteOperation,
    ) -> Result<Self::ExistingSnapshot, crate::profile_api::NativeFailure> {
        let before = source_state(source)?;
        check_write_access(path, operation, &before)?;
        let acl = capture_acl(source.as_raw_fd())
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        let attributes = supported_xattrs(source.as_raw_fd())?;
        if source_state(source)? != before {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        Ok(MacosExistingSnapshot {
            source: before,
            acl,
            attributes,
        })
    }
    fn recheck_existing(
        snapshot: &Self::ExistingSnapshot,
        source: &std::fs::File,
        path: &std::path::Path,
        operation: crate::profile_api::WriteOperation,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        if source_state(source)? != snapshot.source
            || capture_acl(source.as_raw_fd())
                .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?
                != snapshot.acl
            || supported_xattrs(source.as_raw_fd())? != snapshot.attributes
        {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        check_write_access(path, operation, &snapshot.source)
    }
    fn apply_and_verify_existing(
        snapshot: &Self::ExistingSnapshot,
        source: &std::fs::File,
        stage: &std::fs::File,
        stage_path: &std::path::Path,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        use std::os::unix::fs::MetadataExt;
        let path_info = std::fs::symlink_metadata(stage_path)
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        let before = source_state(stage)?;
        if path_info.file_type().is_symlink()
            || path_info.dev() != before.dev
            || path_info.ino() != before.ino
        {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        if source_state(source)? != snapshot.source {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        if capture_acl(source.as_raw_fd())
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?
            != snapshot.acl
        {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        copy_metadata_with_quarantine(source.as_raw_fd(), stage.as_raw_fd())
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        if native_flags(stage)? != snapshot.source.flags
            && unsafe { libc::fchflags(stage.as_raw_fd(), snapshot.source.flags) } != 0
        {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        if capture_acl(source.as_raw_fd())
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?
            != snapshot.acl
            || source_state(source)? != snapshot.source
        {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        Self::verify_existing_stage(snapshot, stage, stage_path)
    }
    fn verify_existing_stage(
        snapshot: &Self::ExistingSnapshot,
        stage: &std::fs::File,
        stage_path: &std::path::Path,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        use std::os::unix::fs::MetadataExt;
        let after = source_state(stage)?;
        let path_info = std::fs::symlink_metadata(stage_path)
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        if path_info.file_type().is_symlink()
            || path_info.dev() != after.dev
            || path_info.ino() != after.ino
        {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        if after.uid != snapshot.source.uid
            || after.gid != snapshot.source.gid
            || after.mode != snapshot.source.mode
            || after.flags != snapshot.source.flags
            || capture_acl(stage.as_raw_fd())
                .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?
                != snapshot.acl
            || supported_xattrs(stage.as_raw_fd())? != snapshot.attributes
        {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        Ok(())
    }
    fn create_private_directory_owned(
        path: &std::path::Path,
        adopt: &mut dyn FnMut(&std::fs::File) -> Result<(), crate::profile_api::NativeFailure>,
    ) -> Result<std::fs::File, crate::profile_api::NativeFailure> {
        use crate::profile_api::NativeFailure;
        use std::os::fd::FromRawFd;
        let parent = Self::open_parent(path.parent().ok_or(NativeFailure::Unsupported)?)?;
        let name = publication_component(path.file_name().ok_or(NativeFailure::Unsupported)?)?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(NativeFailure::Unsupported);
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
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(NativeFailure::CleanupUncertain);
        }
        let directory = unsafe { std::fs::File::from_raw_fd(fd) };
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
            if capture_acl(guard.file().as_raw_fd())
                .map_err(|_| NativeFailure::Unsupported)?
                .is_some()
            {
                let security = unsafe { filesec_init() };
                if security.is_null() {
                    return Err(NativeFailure::Unsupported);
                }
                let security = FileSecurity(security);
                if unsafe { filesec_set_property(security.0, 5, 1_usize as *const libc::c_void) }
                    != 0
                    || unsafe { fchmodx_np(guard.file().as_raw_fd(), security.0) } != 0
                {
                    return Err(NativeFailure::Unsupported);
                }
            }
            if unsafe { libc::fchmod(guard.file().as_raw_fd(), 0o700) } != 0 {
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
    fn verify_private_directory(
        path: &std::path::Path,
        directory: &std::fs::File,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        use std::os::unix::fs::MetadataExt;
        let info = directory
            .metadata()
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        let path_info = std::fs::symlink_metadata(path)
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        verify_private_directory_handle(directory)?;
        if path_info.file_type().is_symlink()
            || info.dev() != path_info.dev()
            || info.ino() != path_info.ino()
        {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        Ok(())
    }
    fn create_private_file_owned(
        parent: &std::fs::File,
        name: &std::ffi::OsStr,
        adopt: &mut dyn FnMut(&std::fs::File) -> Result<(), crate::profile_api::NativeFailure>,
    ) -> Result<std::fs::File, crate::profile_api::NativeFailure> {
        use std::os::fd::FromRawFd;
        use std::os::unix::ffi::OsStrExt;
        verify_private_directory_handle(parent)?;
        let raw_name = name.as_bytes();
        if raw_name.is_empty() || raw_name == b"." || raw_name == b".." || raw_name.contains(&b'/')
        {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        let name = std::ffi::CString::new(raw_name)
            .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK,
                0o600,
            )
        };
        if fd < 0 {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let guard =
            crate::unix_private_guard::PrivateCreated::<Self>::new(file, parent, &name, false)?;
        let attempt = (|| {
            #[cfg(test)]
            if name.to_bytes() == b"payload" && crate::test_hooks::fail("private-file-open") {
                return Err(crate::profile_api::NativeFailure::Unsupported);
            }
            if unsafe { libc::fchmod(guard.file().as_raw_fd(), 0o600) } != 0 {
                return Err(crate::profile_api::NativeFailure::Unsupported);
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
    fn verify_private_file(file: &std::fs::File) -> Result<(), crate::profile_api::NativeFailure> {
        let info = source_state(file)?;
        if info.uid != unsafe { libc::geteuid() }
            || info.mode & 0o7777 != 0o600
            || capture_acl(file.as_raw_fd())
                .map_err(|_| crate::profile_api::NativeFailure::Unsupported)?
                .is_some()
        {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        Ok(())
    }
    fn verify_owned_file(file: &std::fs::File) -> Result<(), crate::profile_api::NativeFailure> {
        let info = source_state(file)?;
        if info.uid != unsafe { libc::geteuid() } {
            return Err(crate::profile_api::NativeFailure::Unsupported);
        }
        Ok(())
    }
    fn capture_parent(
        parent: &std::fs::File,
        host_mask: Option<u32>,
    ) -> Result<Self::ParentSnapshot, crate::profile_api::NativeFailure> {
        parent_snapshot(parent, host_mask)
    }
    fn recheck_parent(
        snapshot: &Self::ParentSnapshot,
        parent: &std::fs::File,
        host_mask: Option<u32>,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        if parent_snapshot(parent, host_mask)? != *snapshot {
            return Err(crate::profile_api::NativeFailure::Changed);
        }
        Ok(())
    }
    fn create_inherited_empty(
        parent: &std::fs::File,
        snapshot: &Self::ParentSnapshot,
        host_mask: Option<u32>,
        private_stage: &std::fs::File,
        temporary_name: &std::ffi::OsStr,
        stage_name: &std::ffi::OsStr,
        adopt: &mut dyn FnMut(&std::fs::File) -> Result<(), crate::profile_api::NativeFailure>,
    ) -> Result<std::fs::File, crate::profile_api::NativeFailure> {
        use crate::profile_api::NativeFailure;
        use std::os::fd::FromRawFd;
        use std::os::unix::ffi::OsStrExt;
        verify_private_directory_handle(private_stage)?;
        if !parent
            .metadata()
            .map_err(|_| NativeFailure::Unsupported)?
            .is_dir()
        {
            return Err(NativeFailure::Unsupported);
        }
        let mask = observed_mask(host_mask)?;
        if mask != snapshot.creation_mask {
            return Err(NativeFailure::Changed);
        }
        let temp_bytes = temporary_name.as_bytes();
        let stage_bytes = stage_name.as_bytes();
        if !temp_bytes.starts_with(b".relavium-fs-stage-v1.")
            || temp_bytes.contains(&b'/')
            || stage_bytes != b"payload"
        {
            return Err(NativeFailure::Unsupported);
        }
        let temp = std::ffi::CString::new(temp_bytes).map_err(|_| NativeFailure::Unsupported)?;
        let stage = std::ffi::CString::new(stage_bytes).map_err(|_| NativeFailure::Unsupported)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                temp.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_NONBLOCK,
                0o666,
            )
        };
        if fd < 0 {
            return Err(NativeFailure::Unsupported);
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let guard = crate::unix_template_guard::EmptyTemplate::<Self>::new(
            file,
            parent,
            &temp,
            private_stage,
            &stage,
        )?;
        let attempt = (|| {
            #[cfg(test)]
            if crate::test_hooks::fail("template-created") {
                return Err(NativeFailure::Unsupported);
            }
            let before = source_state(guard.file())?;
            if before.size != 0 || before.uid != unsafe { libc::geteuid() } {
                return Err(NativeFailure::Unsupported);
            }
            let acl =
                capture_acl(guard.file().as_raw_fd()).map_err(|_| NativeFailure::Unsupported)?;
            let attributes = supported_xattrs(guard.file().as_raw_fd())?;
            if observed_mask(host_mask)? != mask {
                return Err(NativeFailure::Changed);
            }
            if unsafe {
                libc::renameatx_np(
                    parent.as_raw_fd(),
                    temp.as_ptr(),
                    private_stage.as_raw_fd(),
                    stage.as_ptr(),
                    libc::RENAME_EXCL,
                )
            } != 0
            {
                return Err(NativeFailure::Unsupported);
            }
            #[cfg(test)]
            if crate::test_hooks::fail("template-moved") {
                return Err(NativeFailure::Unsupported);
            }
            adopt(guard.file())?;
            Ok((before, acl, attributes))
        })();
        let (before, acl, attributes) = match attempt {
            Ok(snapshot) => snapshot,
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
        let after = source_state(&file)?;
        if before.dev != after.dev
            || before.ino != after.ino
            || before.uid != after.uid
            || before.gid != after.gid
            || before.mode != after.mode
            || before.flags != after.flags
            || after.size != 0
            || capture_acl(file.as_raw_fd()).map_err(|_| NativeFailure::Unsupported)? != acl
            || supported_xattrs(file.as_raw_fd())? != attributes
            || observed_mask(host_mask)? != mask
        {
            return Err(NativeFailure::Changed);
        }
        Ok(file)
    }
    fn capture_inherited_stage(
        parent: &Self::ParentSnapshot,
        stage: &std::fs::File,
        stage_path: &std::path::Path,
    ) -> Result<Self::NewFileSnapshot, crate::profile_api::NativeFailure> {
        use crate::profile_api::NativeFailure;
        use std::os::unix::fs::MetadataExt;
        let state = source_state(stage)?;
        let path_info =
            std::fs::symlink_metadata(stage_path).map_err(|_| NativeFailure::Unsupported)?;
        if state.size != 0
            || state.uid != parent.effective_uid
            || path_info.file_type().is_symlink()
            || path_info.dev() != state.dev
            || path_info.ino() != state.ino
        {
            return Err(NativeFailure::Changed);
        }
        let acl = capture_acl(stage.as_raw_fd()).map_err(|_| NativeFailure::Unsupported)?;
        let attributes = supported_xattrs(stage.as_raw_fd())?;
        if source_state(stage)? != state {
            return Err(NativeFailure::Changed);
        }
        Ok(MacosNewFileSnapshot {
            state,
            acl,
            attributes,
        })
    }
    fn verify_inherited_stage(
        snapshot: &Self::NewFileSnapshot,
        stage: &std::fs::File,
        stage_path: &std::path::Path,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        use crate::profile_api::NativeFailure;
        use std::os::unix::fs::MetadataExt;
        let state = source_state(stage)?;
        let path_info =
            std::fs::symlink_metadata(stage_path).map_err(|_| NativeFailure::Unsupported)?;
        if path_info.file_type().is_symlink()
            || state.dev != snapshot.state.dev
            || state.ino != snapshot.state.ino
            || path_info.dev() != state.dev
            || path_info.ino() != state.ino
            || state.uid != snapshot.state.uid
            || state.gid != snapshot.state.gid
            || state.mode != snapshot.state.mode
            || state.flags != snapshot.state.flags
            || capture_acl(stage.as_raw_fd()).map_err(|_| NativeFailure::Unsupported)?
                != snapshot.acl
            || supported_xattrs(stage.as_raw_fd())? != snapshot.attributes
        {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn publish_existing(
        stage: &std::fs::File,
        stage_parent: &std::fs::File,
        stage_name: &std::ffi::OsStr,
        parent: &std::fs::File,
        target: &std::ffi::OsStr,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        let source = publication_component(stage_name)?;
        let target = publication_component(target)?;
        verify_publication_entry(stage_parent, &source, stage)?;
        if unsafe {
            libc::renameat(
                stage_parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err(crate::profile_api::NativeFailure::PossiblyPublished);
        }
        Ok(())
    }
    fn publish_new(
        stage: &std::fs::File,
        stage_parent: &std::fs::File,
        stage_name: &std::ffi::OsStr,
        parent: &std::fs::File,
        target: &std::ffi::OsStr,
    ) -> Result<(), crate::profile_api::NativeFailure> {
        let source = publication_component(stage_name)?;
        let target = publication_component(target)?;
        verify_publication_entry(stage_parent, &source, stage)?;
        if unsafe {
            libc::renameatx_np(
                stage_parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_EXCL,
            )
        } != 0
        {
            return Err(
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
                    crate::profile_api::NativeFailure::Changed
                } else {
                    crate::profile_api::NativeFailure::PossiblyPublished
                },
            );
        }
        Ok(())
    }
}

// Descriptor-relative publication only accepts a single component and proves that
// the directory entry still names the opened, single-linked stage inode.
fn publication_component(
    name: &std::ffi::OsStr,
) -> Result<std::ffi::CString, crate::profile_api::NativeFailure> {
    use std::os::unix::ffi::OsStrExt;
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes == b"." || bytes == b".." || bytes.contains(&b'/') {
        return Err(crate::profile_api::NativeFailure::Unsupported);
    }
    std::ffi::CString::new(bytes).map_err(|_| crate::profile_api::NativeFailure::Unsupported)
}

fn verify_publication_entry(
    parent: &std::fs::File,
    name: &std::ffi::CStr,
    stage: &std::fs::File,
) -> Result<(), crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    use std::os::unix::fs::MetadataExt;
    let metadata = stage.metadata().map_err(|_| NativeFailure::Unsupported)?;
    let mut entry = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            entry.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(NativeFailure::Changed);
    }
    let entry = unsafe { entry.assume_init() };
    if !metadata.is_file()
        || metadata.nlink() != 1
        || entry.st_mode & libc::S_IFMT != libc::S_IFREG
        || entry.st_dev as u64 != metadata.dev()
        || entry.st_ino != metadata.ino()
        || entry.st_nlink != 1
    {
        return Err(NativeFailure::Changed);
    }
    Ok(())
}
