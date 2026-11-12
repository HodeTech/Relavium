//! Windows local-NTFS profile. Metadata is opaque to the Node-API boundary.
//!
//! This module uses one handle-bound rename, never ReplaceFileW's multi-step
//! merge/rename algorithm. Enabling this profile additionally requires native
//! Windows execution receipts; a cross build does not supply those receipts.
use crate::profile_api::{NativeFailure, NativeIdentity, Profile, WriteOperation};
use std::ffi::{c_void, OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Path, PathBuf};
use std::ptr;
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Threading::*;

const SECURITY_LIMIT: usize = 64 * 1024;
const STREAM_LIMIT: usize = 64 * 1024;
const PATH_LIMIT: usize = 32768;
const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const POLICY_INFO: u32 =
    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
const ORDINARY_ATTRIBUTES: u32 = FILE_ATTRIBUTE_ARCHIVE
    | FILE_ATTRIBUTE_HIDDEN
    | FILE_ATTRIBUTE_SYSTEM
    | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
    | FILE_ATTRIBUTE_NORMAL;
const FILE_ALL: u32 = 0x001f01ff;
const READ_CONTROL_ACCESS: u32 = 0x00020000;
const WRITE_DAC_ACCESS: u32 = 0x00040000;
const WRITE_OWNER_ACCESS: u32 = 0x00080000;
const DELETE_ACCESS: u32 = 0x00010000;
const DESCRIPTOR_REVISION: u32 = 1;
const RENAME_REPLACE: u32 = 1;
const RENAME_POSIX: u32 = 2;
const PERSISTENT_ACLS: u32 = 0x00000008;
const NAMED_STREAMS: u32 = 0x00040000;
const FIXED_DRIVE: u32 = 3;

pub(crate) struct WindowsProfile;

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    volume: u32,
    high: u32,
    low: u32,
}

#[derive(PartialEq, Eq)]
struct Policy {
    // u64 storage satisfies the native security descriptor's alignment.
    descriptor: Vec<u64>,
    owner: Vec<u8>,
    group: Vec<u8>,
    dacl: Vec<u8>,
    control: u16,
}

pub(crate) struct ExistingSnapshot {
    identity: Identity,
    policy: Policy,
    attributes: u32,
    size: u64,
    write_time: u64,
    change_time: i64,
    zone: Option<Vec<u8>>,
    credentials: Vec<u8>,
}

pub(crate) struct ParentSnapshot {
    identity: Identity,
    policy: Policy,
    attributes: u32,
    credentials: Vec<u8>,
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn handle(file: &File) -> HANDLE {
    file.as_raw_handle()
}
fn failure() -> NativeFailure {
    match unsafe { GetLastError() } {
        ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD | ERROR_SHARING_VIOLATION => {
            NativeFailure::AccessDenied
        }
        _ => NativeFailure::Unsupported,
    }
}
fn wide(path: &OsStr) -> Result<Vec<u16>, NativeFailure> {
    let mut value: Vec<u16> = path.encode_wide().collect();
    if value.is_empty() || value.len() >= PATH_LIMIT || value.contains(&0) {
        return Err(NativeFailure::Unsupported);
    }
    value.push(0);
    Ok(value)
}
fn component(name: &OsStr) -> Result<(), NativeFailure> {
    let value: Vec<u16> = name.encode_wide().collect();
    if value.is_empty()
        || value.len() > 255
        || value.iter().any(|c| matches!(*c, 0 | 47 | 58 | 92))
        || name == "."
        || name == ".."
    {
        return Err(NativeFailure::Unsupported);
    }
    Ok(())
}
fn open(
    path: &Path,
    access: u32,
    disposition: u32,
    flags: u32,
    attributes: *const SECURITY_ATTRIBUTES,
) -> Result<File, NativeFailure> {
    let path = wide(path.as_os_str())?;
    let result = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            SHARE,
            attributes,
            disposition,
            flags | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if result == INVALID_HANDLE_VALUE {
        return Err(failure());
    }
    // CreateFileW returned a uniquely owned synchronous disk handle.
    Ok(unsafe { File::from_raw_handle(result) })
}
fn reopen(file: &File, access: u32) -> Result<File, NativeFailure> {
    let result = unsafe { ReOpenFile(handle(file), access, SHARE, FILE_FLAG_OPEN_REPARSE_POINT) };
    if result == INVALID_HANDLE_VALUE {
        return Err(failure());
    }
    Ok(unsafe { File::from_raw_handle(result) })
}
fn info(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION, NativeFailure> {
    let mut value = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle(file), &mut value) } == 0 {
        return Err(failure());
    }
    if value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || unsafe { GetFileType(handle(file)) } != FILE_TYPE_DISK
    {
        return Err(NativeFailure::Unsupported);
    }
    Ok(value)
}
fn identity(file: &File) -> Result<Identity, NativeFailure> {
    let value = info(file)?;
    Ok(Identity {
        volume: value.dwVolumeSerialNumber,
        high: value.nFileIndexHigh,
        low: value.nFileIndexLow,
    })
}
fn ntfs(file: &File) -> Result<(), NativeFailure> {
    let mut name = [0u16; 16];
    let mut flags = 0;
    if unsafe {
        GetVolumeInformationByHandleW(
            handle(file),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            name.as_mut_ptr(),
            name.len() as u32,
        )
    } == 0
    {
        return Err(failure());
    }
    if name[..5] != [78, 84, 70, 83, 0]
        || flags & (PERSISTENT_ACLS | NAMED_STREAMS) != PERSISTENT_ACLS | NAMED_STREAMS
    {
        return Err(NativeFailure::Unsupported);
    }
    // A normalized DOS path beginning with \\?\UNC is a remote share, outside
    // this local-volume profile even when the server reports an NTFS name.
    let path: Vec<u16> = path_for(file)?.as_os_str().encode_wide().collect();
    if path.len() < 7
        || path[..4] != [92, 92, 63, 92]
        || !matches!(path[4], 65..=90 | 97..=122)
        || path[5..7] != [58, 92]
    {
        return Err(NativeFailure::Unsupported);
    }
    let mut root = path[..7].to_vec();
    root.push(0);
    if unsafe { GetDriveTypeW(root.as_ptr()) } != FIXED_DRIVE {
        return Err(NativeFailure::Unsupported);
    }
    Ok(())
}
fn path_for(file: &File) -> Result<PathBuf, NativeFailure> {
    let mut value = vec![0u16; PATH_LIMIT];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle(file),
            value.as_mut_ptr(),
            value.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if length == 0 || length >= value.len() {
        return Err(failure());
    }
    value.truncate(length);
    Ok(PathBuf::from(OsString::from_wide(&value)))
}
fn child(parent: &File, name: &OsStr) -> Result<PathBuf, NativeFailure> {
    component(name)?;
    Ok(path_for(parent)?.join(name))
}
fn bind(file: &File, path: &Path, directory: bool) -> Result<(), NativeFailure> {
    let observed = open(
        path,
        FILE_READ_ATTRIBUTES | READ_CONTROL_ACCESS,
        OPEN_EXISTING,
        if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        },
        ptr::null(),
    )?;
    if identity(file)? != identity(&observed)? {
        return Err(NativeFailure::Changed);
    }
    Ok(())
}
fn sid_bytes(sid: PSID) -> Result<Vec<u8>, NativeFailure> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(NativeFailure::Unsupported);
    }
    let length = unsafe { GetLengthSid(sid) } as usize;
    if length > SECURITY_MAX_SID_SIZE as usize {
        return Err(NativeFailure::Unsupported);
    }
    Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), length) }.to_vec())
}
fn policy(file: &File) -> Result<Policy, NativeFailure> {
    let mut allocated = ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            handle(file),
            SE_FILE_OBJECT,
            POLICY_INFO | LABEL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut allocated,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(NativeFailure::AccessDenied);
    }
    struct LocalDescriptor(*mut c_void);
    impl Drop for LocalDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let owned = LocalDescriptor(allocated);
    if allocated.is_null() || unsafe { IsValidSecurityDescriptor(allocated) } == 0 {
        return Err(NativeFailure::Unsupported);
    }
    let required = unsafe { GetSecurityDescriptorLength(allocated) } as usize;
    if required == 0 || required > SECURITY_LIMIT {
        return Err(NativeFailure::Unsupported);
    }
    let mut descriptor = vec![0u64; required.div_ceil(8)];
    unsafe {
        ptr::copy_nonoverlapping(
            allocated.cast::<u8>(),
            descriptor.as_mut_ptr().cast::<u8>(),
            required,
        );
    }
    drop(owned);
    let sd = descriptor.as_mut_ptr().cast();
    let (mut owner, mut group, mut acl, mut sacl) = (
        ptr::null_mut(),
        ptr::null_mut(),
        ptr::null_mut(),
        ptr::null_mut(),
    );
    let (mut defaulted, mut present, mut sacl_present, mut control, mut revision) = (0, 0, 0, 0, 0);
    if unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorGroup(sd, &mut group, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorSacl(sd, &mut sacl_present, &mut sacl, &mut defaulted) }
            == 0
        || unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) } == 0
    {
        return Err(failure());
    }
    // Explicit mandatory labels and null/absent DACLs need a separate profile.
    // Audit SACLs are privileged and are deliberately not claimed here.
    if present == 0
        || acl.is_null()
        || (sacl_present != 0 && !sacl.is_null() && unsafe { (*sacl).AceCount } != 0)
        || unsafe { IsValidAcl(acl) } == 0
    {
        return Err(NativeFailure::Unsupported);
    }
    let length = unsafe { (*acl).AclSize } as usize;
    if length > SECURITY_LIMIT {
        return Err(NativeFailure::Unsupported);
    }
    let dacl = unsafe { std::slice::from_raw_parts(acl.cast::<u8>(), length) }.to_vec();
    Ok(Policy {
        descriptor,
        owner: sid_bytes(owner)?,
        group: sid_bytes(group)?,
        dacl,
        control: control & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED),
    })
}
fn same_policy(left: &Policy, right: &Policy) -> bool {
    left.owner == right.owner
        && left.group == right.group
        && left.dacl == right.dacl
        && left.control == right.control
}
fn same_stage_attributes(left: u32, right: u32) -> bool {
    // A data write/rename may set ARCHIVE; NORMAL is the absence marker for
    // other attributes. Neither is an access policy or a content approval.
    let policy_mask = !(FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_NORMAL);
    left & policy_mask == right & policy_mask
}
fn token() -> Result<Handle, NativeFailure> {
    let mut result = ptr::null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut result) } == 0 {
        if unsafe { GetLastError() } != ERROR_NO_TOKEN
            || unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut result) } == 0
        {
            return Err(failure());
        }
    }
    Ok(Handle(result))
}
fn token_data(token: &Handle, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>, NativeFailure> {
    let mut required = 0;
    unsafe {
        GetTokenInformation(token.0, class, ptr::null_mut(), 0, &mut required);
    }
    if required == 0 || required as usize > SECURITY_LIMIT {
        return Err(NativeFailure::Unsupported);
    }
    let mut value = vec![0u64; (required as usize).div_ceil(8)];
    if unsafe {
        GetTokenInformation(
            token.0,
            class,
            value.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(failure());
    }
    Ok(value)
}
#[derive(PartialEq, Eq)]
struct TokenContext {
    user: Vec<u8>,
    owner: Vec<u8>,
    statistics: Vec<u8>,
}
fn statistics(token: &Handle) -> Result<Vec<u8>, NativeFailure> {
    let data = token_data(token, TokenStatistics)?;
    let stats = unsafe { &*data.as_ptr().cast::<TOKEN_STATISTICS>() };
    statistics_bytes(stats)
}
fn statistics_bytes(stats: &TOKEN_STATISTICS) -> Result<Vec<u8>, NativeFailure> {
    // Microsoft defines ImpersonationLevel only for impersonation tokens.
    let impersonation_level = if stats.TokenType == TokenPrimary {
        0
    } else if stats.TokenType == TokenImpersonation {
        stats.ImpersonationLevel
    } else {
        return Err(NativeFailure::Unsupported);
    };
    let mut bytes = Vec::new();
    for luid in [&stats.TokenId, &stats.AuthenticationId, &stats.ModifiedId] {
        bytes.extend_from_slice(&luid.LowPart.to_le_bytes());
        bytes.extend_from_slice(&luid.HighPart.to_le_bytes());
    }
    bytes.extend_from_slice(&stats.ExpirationTime.to_le_bytes());
    bytes.extend_from_slice(&stats.TokenType.to_le_bytes());
    bytes.extend_from_slice(&impersonation_level.to_le_bytes());
    bytes.extend_from_slice(&stats.DynamicCharged.to_le_bytes());
    bytes.extend_from_slice(&stats.DynamicAvailable.to_le_bytes());
    bytes.extend_from_slice(&stats.GroupCount.to_le_bytes());
    bytes.extend_from_slice(&stats.PrivilegeCount.to_le_bytes());
    Ok(bytes)
}
fn token_context() -> Result<TokenContext, NativeFailure> {
    let token = token()?;
    let before = statistics(&token)?;
    let user_data = token_data(&token, TokenUser)?;
    let user = sid_bytes(unsafe { (*user_data.as_ptr().cast::<TOKEN_USER>()).User.Sid })?;
    let owner_data = token_data(&token, TokenOwner)?;
    let owner = sid_bytes(unsafe { (*owner_data.as_ptr().cast::<TOKEN_OWNER>()).Owner })?;
    if statistics(&token)? != before {
        return Err(NativeFailure::Changed);
    }
    Ok(TokenContext {
        user,
        owner,
        statistics: before,
    })
}
impl TokenContext {
    fn admits_owner(&self, owner: &[u8]) -> bool {
        owner == self.user || owner == self.owner
    }
    fn encoded(&self) -> Vec<u8> {
        let mut value = self.statistics.clone();
        value.extend_from_slice(&(self.user.len() as u32).to_le_bytes());
        value.extend_from_slice(&self.user);
        value.extend_from_slice(&(self.owner.len() as u32).to_le_bytes());
        value.extend_from_slice(&self.owner);
        value
    }
}
fn credentials() -> Result<Vec<u8>, NativeFailure> {
    let value = token_context()?.encoded();
    #[cfg(test)]
    if crate::test_hooks::fail("changed-token-context") {
        let mut changed = value;
        changed[0] ^= 1;
        return Ok(changed);
    }
    Ok(value)
}
fn current_sid() -> Result<Vec<u8>, NativeFailure> {
    Ok(token_context()?.user)
}

struct Backup<'a> {
    file: &'a File,
    context: *mut c_void,
    buffer: [u8; 4096],
    start: usize,
    end: usize,
}
impl Drop for Backup<'_> {
    fn drop(&mut self) {
        let mut read = 0;
        unsafe {
            BackupRead(
                handle(self.file),
                ptr::null_mut(),
                0,
                &mut read,
                1,
                0,
                &mut self.context,
            );
        }
    }
}
impl Backup<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize, NativeFailure> {
        #[cfg(test)]
        {
            if crate::test_hooks::fail("RELAVIUM_NATIVE_BACKUP_EOF")
                || crate::test_hooks::fail("RELAVIUM_NATIVE_BACKUP_GROW")
            {
                return Ok(0);
            }
            if crate::test_hooks::fail("RELAVIUM_NATIVE_BACKUP_TRUNCATE") && !bytes.is_empty() {
                bytes[0] = 0;
                return Ok(1);
            }
        }
        let mut copied = 0;
        while copied < bytes.len() {
            if self.start == self.end {
                let mut read = 0;
                // The OS buffer exceeds WIN32_STREAM_ID's size, including when
                // the parser needs only a header or a short/empty ADS value.
                if unsafe {
                    BackupRead(
                        handle(self.file),
                        self.buffer.as_mut_ptr(),
                        self.buffer.len() as u32,
                        &mut read,
                        0,
                        0,
                        &mut self.context,
                    )
                } == 0
                {
                    return Err(failure());
                }
                self.start = 0;
                self.end = read as usize;
                if self.end == 0 {
                    break;
                }
            }
            let count = (bytes.len() - copied).min(self.end - self.start);
            bytes[copied..copied + count]
                .copy_from_slice(&self.buffer[self.start..self.start + count]);
            copied += count;
            self.start += count;
        }
        Ok(copied)
    }
    fn exact(&mut self, bytes: &mut [u8]) -> Result<(), NativeFailure> {
        if self.read(bytes)? != bytes.len() {
            Err(NativeFailure::Changed)
        } else {
            Ok(())
        }
    }
    fn skip(&mut self, length: u64) -> Result<(), NativeFailure> {
        let buffered = (self.end - self.start) as u64;
        if length <= buffered {
            self.start += length as usize;
            return Ok(());
        }
        self.start = self.end;
        let remaining = length - buffered;
        let (mut low, mut high) = (0, 0);
        if unsafe {
            BackupSeek(
                handle(self.file),
                remaining as u32,
                (remaining >> 32) as u32,
                &mut low,
                &mut high,
                &mut self.context,
            )
        } == 0
            || (u64::from(high) << 32 | u64::from(low)) != remaining
        {
            return Err(NativeFailure::Unsupported);
        }
        Ok(())
    }
}
fn streams(file: &File) -> Result<Option<Vec<u8>>, NativeFailure> {
    // BackupRead's documented stream inventory exposes EAs/object IDs/reparse
    // metadata as well as ADS. We refuse unknown types rather than equating an
    // empty FindFirstStream inventory with absence of extended metadata.
    let reader = reopen(file, FILE_GENERIC_READ)?;
    // Capture both held handles before inventory so an omitted BACKUP_DATA
    // header is accepted only when the kernel's primary stream was empty.
    let before_file = info(file)?;
    let before_reader = info(&reader)?;
    let before_identity = identity(file)?;
    let reader_identity = identity(&reader)?;
    let mut backup = Backup {
        file: &reader,
        context: ptr::null_mut(),
        buffer: [0; 4096],
        start: 0,
        end: 0,
    };
    let mut zone = None;
    let mut data_seen = false;
    for _ in 0..8 {
        let mut header = [0u8; 20];
        let read = backup.read(&mut header)?;
        if read == 0 {
            #[cfg(test)]
            if crate::test_hooks::fail("RELAVIUM_NATIVE_BACKUP_GROW") {
                let mut held = file;
                held.write_all(b"x")
                    .map_err(|_| NativeFailure::Unsupported)?;
                held.sync_all().map_err(|_| NativeFailure::Unsupported)?;
            }
            if data_seen {
                return Ok(zone);
            }
            let empty_regular = |value: &BY_HANDLE_FILE_INFORMATION| {
                value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
                    && value.nFileSizeHigh == 0
                    && value.nFileSizeLow == 0
            };
            // BackupRead exhausted successfully. Missing BACKUP_DATA may only
            // describe an actually empty held unnamed stream; all discovered
            // alternate streams have already passed the closed parser above.
            if empty_regular(&before_file)
                && empty_regular(&before_reader)
                && before_identity == reader_identity
                && ntfs(file).is_ok()
                && ntfs(&reader).is_ok()
                && empty_regular(&info(file)?)
                && empty_regular(&info(&reader)?)
                && identity(file)? == before_identity
                && identity(&reader)? == before_identity
            {
                return Ok(zone);
            }
            return trace_failure!(
                "first-stream-no-data-header",
                Err(NativeFailure::Unsupported)
            );
        }
        if read != header.len() {
            return Err(NativeFailure::Changed);
        }
        let id = u32::from_le_bytes(
            header[0..4]
                .try_into()
                .map_err(|_| NativeFailure::Unsupported)?,
        );
        let attributes = u32::from_le_bytes(
            header[4..8]
                .try_into()
                .map_err(|_| NativeFailure::Unsupported)?,
        );
        let size = u64::from_le_bytes(
            header[8..16]
                .try_into()
                .map_err(|_| NativeFailure::Unsupported)?,
        );
        let name_size = u32::from_le_bytes(
            header[16..20]
                .try_into()
                .map_err(|_| NativeFailure::Unsupported)?,
        ) as usize;
        if name_size > 512 || name_size % 2 != 0 || attributes != 0 {
            return Err(NativeFailure::Unsupported);
        }
        let mut name = vec![0u8; name_size];
        backup.exact(&mut name)?;
        if id == BACKUP_DATA && name_size == 0 && !data_seen {
            data_seen = true;
            backup.skip(size)?;
        } else if id == BACKUP_ALTERNATE_DATA
            && zone.is_none()
            && name
                == ":Zone.Identifier:$DATA"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>()
            && size <= STREAM_LIMIT as u64
        {
            let mut value = vec![0u8; size as usize];
            backup.exact(&mut value)?;
            zone = Some(value);
        } else {
            return Err(NativeFailure::Unsupported);
        }
    }
    Err(NativeFailure::Unsupported)
}
fn zone_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(":Zone.Identifier");
    PathBuf::from(value)
}
fn admitted(file: &File, operation: WriteOperation) -> Result<(), NativeFailure> {
    let access = match operation {
        WriteOperation::Replace => FILE_WRITE_DATA,
        WriteOperation::Append => FILE_APPEND_DATA,
    };
    // ReOpenFile binds this real OPEN_EXISTING, nontruncating access check to
    // the captured object, instead of merely checking parent delete rights.
    let opened = reopen(file, access)?;
    if identity(file)? != identity(&opened)? {
        return Err(NativeFailure::Changed);
    }
    Ok(())
}
fn capture(
    file: &File,
    path: &Path,
    operation: WriteOperation,
) -> Result<ExistingSnapshot, NativeFailure> {
    let context = token_context()?;
    ntfs(file)?;
    bind(file, path, false)?;
    let value = info(file)?;
    if value.nNumberOfLinks != 1 || value.dwFileAttributes & !ORDINARY_ATTRIBUTES != 0 {
        return Err(NativeFailure::Unsupported);
    }
    admitted(file, operation)?;
    let mut basic = FILE_BASIC_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle(file),
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(failure());
    }
    let source_policy = policy(file)?;
    if !context.admits_owner(&source_policy.owner) {
        return Err(NativeFailure::AccessDenied);
    }
    let snapshot = ExistingSnapshot {
        identity: identity(file)?,
        policy: source_policy,
        attributes: value.dwFileAttributes,
        size: u64::from(value.nFileSizeHigh) << 32 | u64::from(value.nFileSizeLow),
        write_time: u64::from(value.ftLastWriteTime.dwHighDateTime) << 32
            | u64::from(value.ftLastWriteTime.dwLowDateTime),
        change_time: basic.ChangeTime,
        zone: streams(file)?,
        credentials: context.encoded(),
    };
    if token_context()? != context {
        return Err(NativeFailure::Changed);
    }
    Ok(snapshot)
}

fn private_security() -> Result<(SECURITY_DESCRIPTOR, Vec<u64>, Vec<u8>), NativeFailure> {
    let mut sid = current_sid()?;
    let size = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid.len();
    let mut acl = vec![0u64; size.div_ceil(8)];
    let acl_ptr = acl.as_mut_ptr().cast();
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    if unsafe { InitializeAcl(acl_ptr, size as u32, ACL_REVISION) } == 0
        || unsafe {
            AddAccessAllowedAceEx(acl_ptr, ACL_REVISION, 0, FILE_ALL, sid.as_mut_ptr().cast())
        } == 0
        || unsafe {
            InitializeSecurityDescriptor(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                DESCRIPTOR_REVISION,
            )
        } == 0
        || unsafe {
            SetSecurityDescriptorOwner(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                sid.as_mut_ptr().cast(),
                0,
            )
        } == 0
        || unsafe {
            SetSecurityDescriptorDacl(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                1,
                acl_ptr,
                0,
            )
        } == 0
        || unsafe {
            SetSecurityDescriptorControl(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                SE_DACL_PROTECTED,
                SE_DACL_PROTECTED,
            )
        } == 0
    {
        return Err(failure());
    }
    Ok((descriptor, acl, sid))
}
fn verify_private(file: &File, directory: bool) -> Result<(), NativeFailure> {
    let value = info(file)?;
    if (value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || (!directory && value.nNumberOfLinks != 1)
    {
        return Err(NativeFailure::Unsupported);
    }
    #[cfg(test)]
    crate::test_hooks::checkpoint("private-policy-read");
    let actual = policy(file)?;
    #[cfg(test)]
    crate::test_hooks::checkpoint("private-expected-build");
    let (_, mut acl, sid) = private_security()?;
    let raw = acl.as_mut_ptr().cast::<ACL>();
    let expected = unsafe { std::slice::from_raw_parts(raw.cast::<u8>(), (*raw).AclSize as usize) };
    #[cfg(test)]
    {
        if actual.owner != sid {
            crate::test_hooks::checkpoint("private-owner-mismatch");
        }
        if actual.control & SE_DACL_PROTECTED == 0 {
            crate::test_hooks::checkpoint("private-protection-mismatch");
        }
        if actual.dacl != expected {
            crate::test_hooks::checkpoint("private-dacl-mismatch");
        }
    }
    if actual.owner != sid || actual.control & SE_DACL_PROTECTED == 0 || actual.dacl != expected {
        return Err(NativeFailure::AccessDenied);
    }
    Ok(())
}

fn rename(stage: &File, parent: &File, target: &OsStr, replace: bool) -> Result<(), NativeFailure> {
    component(target)?;
    ntfs(stage)?;
    ntfs(parent)?;
    if identity(stage)?.volume != identity(parent)?.volume {
        return Err(NativeFailure::Unsupported);
    }
    let name: Vec<u16> = target.encode_wide().collect();
    let length = offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
    let mut storage = vec![0u64; length.div_ceil(8)];
    let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        (*info).Anonymous.Flags = if replace {
            RENAME_REPLACE | RENAME_POSIX
        } else {
            0
        };
        (*info).RootDirectory = handle(parent);
        (*info).FileNameLength = (name.len() * 2) as u32;
        ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
    }
    // One namespace operation; no backup rename, unlink, merge, copy or retry.
    if unsafe {
        SetFileInformationByHandle(handle(stage), FileRenameInfoEx, info.cast(), length as u32)
    } == 0
    {
        return Err(NativeFailure::PossiblyPublished);
    }
    Ok(())
}

// This guard owns only a fresh empty inheritance template. Deletion uses the
// original DELETE-capable handle after both locator and identity proof.
struct EmptyTemplate {
    file: Option<File>,
    temporary: PathBuf,
    payload: PathBuf,
    identity: Option<NativeIdentity>,
}
impl EmptyTemplate {
    fn new(file: File, temporary: PathBuf, payload: PathBuf) -> Result<Self, NativeFailure> {
        let mut guard = Self {
            file: Some(file),
            temporary,
            payload,
            identity: None,
        };
        guard.identity = Some(
            WindowsProfile::identity(guard.file()).map_err(|_| NativeFailure::CleanupUncertain)?,
        );
        Ok(guard)
    }
    fn file(&self) -> &File {
        self.file.as_ref().expect("template guard owns file")
    }
    fn transfer(mut self) -> File {
        self.file.take().expect("template guard owns file")
    }
    fn abort(mut self) -> Result<(), NativeFailure> {
        let outcome =
            path_for(self.file()).and_then(|path| self.cleanup(self.file()).map(|()| path));
        self.file.take();
        let path = outcome.map_err(|_| NativeFailure::CleanupUncertain)?;
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(NativeFailure::CleanupUncertain),
        }
    }
    fn cleanup(&self, file: &File) -> Result<(), NativeFailure> {
        if Some(WindowsProfile::identity(file)?) != self.identity {
            return Err(NativeFailure::Changed);
        }
        WindowsProfile::verify_owned_file(file)?;
        let details = info(file)?;
        if details.nFileSizeLow != 0 || details.nFileSizeHigh != 0 {
            return Err(NativeFailure::Changed);
        }
        let path = path_for(file)?;
        if path != self.temporary && path != self.payload {
            return Err(NativeFailure::Changed);
        }
        bind(file, &path, false)?;
        if Some(WindowsProfile::identity(file)?) != self.identity {
            return Err(NativeFailure::Changed);
        }
        WindowsProfile::verify_owned_file(file)?;
        let details = info(file)?;
        if details.nFileSizeLow != 0 || details.nFileSizeHigh != 0 {
            return Err(NativeFailure::Changed);
        }
        let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                handle(file),
                FileDispositionInfo,
                (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(failure());
        }
        Ok(())
    }
}
impl Drop for EmptyTemplate {
    fn drop(&mut self) {
        if let Some(file) = &self.file {
            let _ = self.cleanup(file);
        }
    }
}

struct PrivateCreated {
    file: Option<File>,
    path: PathBuf,
    identity: Option<NativeIdentity>,
    directory: bool,
}
impl PrivateCreated {
    fn new(file: File, path: PathBuf, directory: bool) -> Result<Self, NativeFailure> {
        let mut guard = Self {
            file: Some(file),
            path,
            identity: None,
            directory,
        };
        guard.identity = Some(
            WindowsProfile::identity(guard.file()).map_err(|_| NativeFailure::CleanupUncertain)?,
        );
        Ok(guard)
    }
    fn file(&self) -> &File {
        self.file.as_ref().expect("private guard owns file")
    }
    fn transfer(mut self) -> File {
        self.file.take().expect("private guard owns file")
    }
    fn cleanup(&self, file: &File) -> Result<(), NativeFailure> {
        let details = info(file)?;
        if Some(WindowsProfile::identity(file)?) != self.identity
            || (details.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != self.directory
            || (!self.directory
                && (details.nNumberOfLinks != 1
                    || details.nFileSizeLow != 0
                    || details.nFileSizeHigh != 0))
            || policy(file)?.owner != current_sid()?
        {
            return Err(NativeFailure::Changed);
        }
        let observed = open(
            &self.path,
            FILE_READ_ATTRIBUTES | READ_CONTROL_ACCESS,
            OPEN_EXISTING,
            if self.directory {
                FILE_FLAG_BACKUP_SEMANTICS
            } else {
                0
            },
            ptr::null(),
        )?;
        if Some(WindowsProfile::identity(&observed)?) != self.identity {
            return Err(NativeFailure::Changed);
        }
        drop(observed);
        let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                handle(file),
                FileDispositionInfo,
                (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(failure());
        }
        Ok(())
    }
    fn abort(mut self) -> Result<(), NativeFailure> {
        let outcome = self.cleanup(self.file());
        self.file.take();
        outcome.map_err(|_| NativeFailure::CleanupUncertain)?;
        match std::fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(NativeFailure::CleanupUncertain),
        }
    }
}
impl Drop for PrivateCreated {
    fn drop(&mut self) {
        if let Some(file) = &self.file {
            let _ = self.cleanup(file);
        }
    }
}

impl Profile for WindowsProfile {
    type ExistingSnapshot = ExistingSnapshot;
    type ParentSnapshot = ParentSnapshot;
    type NewFileSnapshot = ExistingSnapshot;
    fn operation_context() -> Result<Vec<u8>, NativeFailure> {
        credentials()
    }
    fn identity(file: &File) -> Result<NativeIdentity, NativeFailure> {
        ntfs(file)?;
        let mut full = FILE_ID_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                handle(file),
                FileIdInfo,
                (&mut full as *mut FILE_ID_INFO).cast(),
                size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err(failure());
        }
        let witness = identity(file)?;
        Ok(NativeIdentity {
            volume: full.VolumeSerialNumber,
            object: u128::from_le_bytes(full.FileId.Identifier),
            node_dev: u64::from(witness.volume),
            node_ino: u64::from(witness.high) << 32 | u64::from(witness.low),
        })
    }
    fn owner_identity() -> Result<String, NativeFailure> {
        let sid = current_sid()?;
        let mut text = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid.as_ptr().cast_mut().cast(), &mut text) } == 0 {
            return Err(failure());
        }
        let mut length = 0;
        while length < 256 && unsafe { *text.add(length) } != 0 {
            length += 1;
        }
        let result = if length < 256 {
            String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
                .map_err(|_| NativeFailure::Unsupported)
        } else {
            Err(NativeFailure::Unsupported)
        };
        unsafe {
            LocalFree(text.cast());
        }
        result
    }
    fn open_parent(path: &Path) -> Result<File, NativeFailure> {
        let file = open(
            path,
            // FlushFileBuffers, used by File::sync_all on these handles, is
            // documented to require GENERIC_WRITE. This is an access check only;
            // opening the existing directory does not create or change entries.
            FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | READ_CONTROL_ACCESS | GENERIC_WRITE,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null(),
        )?;
        if info(&file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(NativeFailure::Unsupported);
        }
        ntfs(&file)?;
        Ok(file)
    }
    fn capture_existing(
        source: &File,
        path: &Path,
        operation: WriteOperation,
    ) -> Result<ExistingSnapshot, NativeFailure> {
        capture(source, path, operation)
    }
    fn recheck_existing(
        snapshot: &ExistingSnapshot,
        source: &File,
        path: &Path,
        operation: WriteOperation,
    ) -> Result<(), NativeFailure> {
        let current = capture(source, path, operation)?;
        if current.identity != snapshot.identity
            || !same_policy(&current.policy, &snapshot.policy)
            || current.attributes != snapshot.attributes
            || current.size != snapshot.size
            || current.write_time != snapshot.write_time
            || current.change_time != snapshot.change_time
            || current.zone != snapshot.zone
            || current.credentials != snapshot.credentials
        {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn apply_and_verify_existing(
        snapshot: &ExistingSnapshot,
        source: &File,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        let current_context = trace_failure!("first-metadata-credentials", credentials())?;
        if current_context != snapshot.credentials {
            return trace_failure!(
                "first-metadata-context-changed",
                Err(NativeFailure::Changed)
            );
        }
        if trace_failure!("first-metadata-source-identity", identity(source))? != snapshot.identity
            || !same_policy(
                &trace_failure!("first-metadata-source-policy", policy(source))?,
                &snapshot.policy,
            )
            || trace_failure!("first-metadata-source-streams", streams(source))? != snapshot.zone
        {
            return trace_failure!("first-metadata-source-changed", Err(NativeFailure::Changed));
        }
        trace_failure!("first-metadata-stage-bind", bind(stage, stage_path, false))?;
        if trace_failure!("first-metadata-stage-streams", streams(stage))?.is_some() {
            return trace_failure!(
                "first-metadata-stage-unexpected-stream",
                Err(NativeFailure::Unsupported)
            );
        }
        if let Some(value) = &snapshot.zone {
            let path = zone_path(stage_path);
            let mut stream = trace_failure!(
                "first-metadata-zone-open",
                open(
                    &path,
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    CREATE_NEW,
                    0,
                    ptr::null(),
                )
            )?;
            if trace_failure!("first-metadata-zone-identity", identity(&stream))?
                != trace_failure!("first-metadata-stage-identity", identity(stage))?
            {
                return trace_failure!("first-metadata-zone-mismatch", Err(NativeFailure::Changed));
            }
            trace_failure!(
                "first-metadata-zone-write",
                stream
                    .write_all(value)
                    .map_err(|_| NativeFailure::Unsupported)
            )?;
            trace_failure!(
                "first-metadata-zone-flush",
                stream.sync_all().map_err(|_| NativeFailure::Unsupported)
            )?;
        }
        #[cfg(test)]
        crate::test_hooks::hit("partial-metadata");
        let protection = if snapshot.policy.control & SE_DACL_PROTECTED != 0 {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
        // Private objects are protected and their parent has no inheritable
        // ACEs. Reproduce the target's protection bit and verify the resulting
        // ACL and control flags exactly; OS transformations refuse.
        let sd = snapshot.policy.descriptor.as_ptr().cast_mut().cast();
        let (mut owner, mut group, mut dacl) = (ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
        let (mut present, mut defaulted) = (0, 0);
        if unsafe { GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted) } == 0
            || unsafe { GetSecurityDescriptorGroup(sd, &mut group, &mut defaulted) } == 0
            || unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) }
                == 0
            || present == 0
            || dacl.is_null()
        {
            return Err(NativeFailure::Unsupported);
        }
        let status = unsafe {
            SetSecurityInfo(
                handle(stage),
                SE_FILE_OBJECT,
                POLICY_INFO | protection,
                owner,
                group,
                dacl,
                ptr::null(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(NativeFailure::AccessDenied);
        }
        let mut basic = FILE_BASIC_INFO {
            FileAttributes: snapshot.attributes,
            ..FILE_BASIC_INFO::default()
        };
        if unsafe {
            SetFileInformationByHandle(
                handle(stage),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(failure());
        }
        if !same_policy(&policy(stage)?, &snapshot.policy)
            || streams(stage)? != snapshot.zone
            || !same_stage_attributes(info(stage)?.dwFileAttributes, snapshot.attributes)
        {
            return Err(NativeFailure::Changed);
        }
        bind(stage, stage_path, false)?;
        if credentials()? != snapshot.credentials {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn verify_existing_stage(
        snapshot: &ExistingSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        if credentials()? != snapshot.credentials {
            return Err(NativeFailure::Changed);
        }
        bind(stage, stage_path, false)?;
        if !same_policy(&policy(stage)?, &snapshot.policy)
            || streams(stage)? != snapshot.zone
            || !same_stage_attributes(info(stage)?.dwFileAttributes, snapshot.attributes)
            || credentials()? != snapshot.credentials
        {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn create_private_directory_owned(
        path: &Path,
        adopt: &mut dyn FnMut(&File) -> Result<(), NativeFailure>,
    ) -> Result<File, NativeFailure> {
        let (mut descriptor, _acl, _sid) = private_security()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: 0,
        };
        let encoded = wide(path.as_os_str())?;
        if unsafe { CreateDirectoryW(encoded.as_ptr(), &attributes) } == 0 {
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
        let result = open(
            path,
            FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | DELETE_ACCESS
                | WRITE_DAC_ACCESS
                | WRITE_OWNER_ACCESS,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null(),
        )
        .map_err(|_| NativeFailure::CleanupUncertain)?;
        let guard = PrivateCreated::new(result, path.to_owned(), true)?;
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
        bind(directory, path, true)?;
        verify_private(directory, true)
    }
    fn create_private_file_owned(
        parent: &File,
        name: &OsStr,
        adopt: &mut dyn FnMut(&File) -> Result<(), NativeFailure>,
    ) -> Result<File, NativeFailure> {
        #[cfg(test)]
        crate::test_hooks::checkpoint("private-file-parent-check");
        Self::verify_private_directory(&path_for(parent)?, parent)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("private-file-open");
        let path = child(parent, name)?;
        let (mut descriptor, _acl, _sid) = private_security()?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: 0,
        };
        let file = open(
            &path,
            FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | DELETE_ACCESS
                | WRITE_DAC_ACCESS
                | WRITE_OWNER_ACCESS,
            CREATE_NEW,
            0,
            &attributes,
        )?;
        let guard = PrivateCreated::new(file, path, false)?;
        let attempt = (|| {
            #[cfg(test)]
            if name == OsStr::new("payload") && crate::test_hooks::fail("private-file-open") {
                return Err(NativeFailure::Unsupported);
            }
            #[cfg(test)]
            crate::test_hooks::checkpoint("private-file-verify");
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
        verify_private(file, false)
    }
    fn verify_owned_file(file: &File) -> Result<(), NativeFailure> {
        let context = token_context()?;
        ntfs(file)?;
        let observed = info(file)?;
        if observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 || observed.nNumberOfLinks != 1
        {
            return Err(NativeFailure::Unsupported);
        }
        // Recovery is allowed to see a stage after its final DACL was applied.
        // Ownership is an independent check: neither privacy nor a permissive
        // final DACL substitutes for the current effective token's closed owner pair.
        if !context.admits_owner(&policy(file)?.owner) {
            return Err(NativeFailure::AccessDenied);
        }
        if token_context()? != context {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn capture_parent(
        parent: &File,
        _host_mask: Option<u32>,
    ) -> Result<ParentSnapshot, NativeFailure> {
        let context = token_context()?;
        ntfs(parent)?;
        let attributes = info(parent)?.dwFileAttributes;
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || attributes & !(ORDINARY_ATTRIBUTES | FILE_ATTRIBUTE_DIRECTORY) != 0
        {
            return Err(NativeFailure::Unsupported);
        }
        let snapshot = ParentSnapshot {
            identity: identity(parent)?,
            policy: policy(parent)?,
            attributes,
            credentials: context.encoded(),
        };
        if token_context()? != context {
            return Err(NativeFailure::Changed);
        }
        Ok(snapshot)
    }
    fn recheck_parent(
        snapshot: &ParentSnapshot,
        parent: &File,
        _host_mask: Option<u32>,
    ) -> Result<(), NativeFailure> {
        let current = Self::capture_parent(parent, None)?;
        if current.identity != snapshot.identity
            || !same_policy(&current.policy, &snapshot.policy)
            || current.attributes != snapshot.attributes
            || current.credentials != snapshot.credentials
        {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn create_inherited_empty(
        parent: &File,
        snapshot: &ParentSnapshot,
        _host_mask: Option<u32>,
        private_stage: &File,
        temporary_name: &OsStr,
        stage_name: &OsStr,
        adopt: &mut dyn FnMut(&File) -> Result<(), NativeFailure>,
    ) -> Result<File, NativeFailure> {
        Self::recheck_parent(snapshot, parent, None)?;
        let stage_path = path_for(private_stage)?;
        Self::verify_private_directory(&stage_path, private_stage)?;
        let path = child(parent, temporary_name)?;
        let payload = child(private_stage, stage_name)?;
        let file = open(
            &path,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS,
            CREATE_NEW,
            0,
            ptr::null(),
        )?;
        let guard = EmptyTemplate::new(file, path, payload)?;
        let attempt = (|| {
            #[cfg(test)]
            if crate::test_hooks::fail("template-created") {
                return Err(NativeFailure::Unsupported);
            }
            let inherited = policy(guard.file())?;
            if info(guard.file())?.nNumberOfLinks != 1
                || info(guard.file())?.nFileSizeLow != 0
                || info(guard.file())?.nFileSizeHigh != 0
            {
                return Err(NativeFailure::Unsupported);
            }
            Self::recheck_parent(snapshot, parent, None)?;
            rename(guard.file(), private_stage, stage_name, false)?;
            #[cfg(test)]
            if crate::test_hooks::fail("template-moved") {
                return Err(NativeFailure::Unsupported);
            }
            adopt(guard.file())?;
            Ok(inherited)
        })();
        let inherited = match attempt {
            Ok(policy) => policy,
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
        if !same_policy(&inherited, &policy(&file)?) {
            return Err(NativeFailure::Changed);
        }
        bind(&file, &child(private_stage, stage_name)?, false)?;
        Ok(file)
    }
    fn capture_inherited_stage(
        parent: &ParentSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<ExistingSnapshot, NativeFailure> {
        let snapshot = capture(stage, stage_path, WriteOperation::Replace)?;
        if snapshot.identity.volume != parent.identity.volume
            || snapshot.credentials != parent.credentials
            || snapshot.size != 0
            || snapshot.zone.is_some()
        {
            return Err(NativeFailure::Changed);
        }
        Ok(snapshot)
    }
    fn verify_inherited_stage(
        snapshot: &ExistingSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        Self::verify_existing_stage(snapshot, stage, stage_path)
    }
    fn publish_existing(
        stage: &File,
        stage_parent: &File,
        stage_name: &OsStr,
        parent: &File,
        target: &OsStr,
    ) -> Result<(), NativeFailure> {
        bind(stage, &child(stage_parent, stage_name)?, false)?;
        rename(stage, parent, target, true)
    }
    fn publish_new(
        stage: &File,
        stage_parent: &File,
        stage_name: &OsStr,
        parent: &File,
        target: &OsStr,
    ) -> Result<(), NativeFailure> {
        bind(stage, &child(stage_parent, stage_name)?, false)?;
        rename(stage, parent, target, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        path: PathBuf,
        directory: File,
    }
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "relavium-windows-native-{}-{nonce}",
                std::process::id()
            ));
            let directory =
                WindowsProfile::create_private_directory(&path).expect("private NTFS fixture");
            Self { path, directory }
        }
        fn file(&self, name: &str, bytes: &[u8]) -> File {
            let mut file = WindowsProfile::create_private_file(&self.directory, OsStr::new(name))
                .expect("private fixture file");
            file.write_all(bytes).expect("fixture bytes");
            file.sync_all().expect("fixture flush");
            file
        }
        fn stage(&self) -> (PathBuf, File, File) {
            let path = self.path.join("stage");
            let directory = WindowsProfile::create_private_directory(&path).expect("private stage");
            let file = WindowsProfile::create_private_file(&directory, OsStr::new("payload"))
                .expect("empty stage");
            (path, directory, file)
        }
        fn bytes(&self, name: &str) -> Vec<u8> {
            std::fs::read(self.path.join(name)).expect("fixture read")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn set_user_acl(file: &File, deny: u32, extra_read: bool) {
        let sid = current_sid().expect("current user SID");
        let mut system = [0u32; 17];
        let mut system_size = (system.len() * 4) as u32;
        assert_ne!(
            unsafe {
                CreateWellKnownSid(
                    WinLocalSystemSid,
                    ptr::null_mut(),
                    system.as_mut_ptr().cast(),
                    &mut system_size,
                )
            },
            0
        );
        let mut acl = vec![0u64; 128];
        let raw = acl.as_mut_ptr().cast();
        assert_ne!(
            unsafe { InitializeAcl(raw, (acl.len() * 8) as u32, ACL_REVISION) },
            0
        );
        if deny != 0 {
            assert_ne!(
                unsafe {
                    AddAccessDeniedAceEx(raw, ACL_REVISION, 0, deny, sid.as_ptr().cast_mut().cast())
                },
                0
            );
        }
        assert_ne!(
            unsafe {
                AddAccessAllowedAceEx(
                    raw,
                    ACL_REVISION,
                    OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                    FILE_ALL,
                    sid.as_ptr().cast_mut().cast(),
                )
            },
            0
        );
        if extra_read {
            assert_ne!(
                unsafe {
                    AddAccessAllowedAceEx(
                        raw,
                        ACL_REVISION,
                        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                        FILE_GENERIC_READ,
                        system.as_mut_ptr().cast(),
                    )
                },
                0
            );
        }
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    handle(file),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    raw,
                    ptr::null(),
                )
            },
            ERROR_SUCCESS
        );
    }

    #[test]
    fn windows_default_owner_payload_uses_effective_token_and_private_files_remain_user_owned() {
        let fixture = Fixture::new();
        let context = token_context().expect("effective token");
        println!(
            "RELAVIUM_NATIVE_OWNER_CONTEXT:{}",
            if context.owner != context.user {
                "distinct"
            } else {
                "same"
            }
        );
        let path = fixture.path.join("ordinary-default-owner");
        let file = open(
            &path,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("ordinary OS-created file");
        let actual_owner = policy(&file).expect("ordinary policy").owner;
        assert_eq!(actual_owner, context.owner);
        WindowsProfile::verify_owned_file(&file).expect("effective owner eligible");
        let snapshot = capture(&file, &path, WriteOperation::Replace)
            .expect("actual OS write admission and eligible owner");
        assert_eq!(snapshot.credentials, context.encoded());
        let private = fixture.file("strict-private", b"");
        assert_eq!(
            policy(&private).expect("private policy").owner,
            context.user
        );
        WindowsProfile::verify_private_file(&private).expect("user-only private file");
        if context.owner != context.user {
            assert!(WindowsProfile::verify_private_file(&file).is_err());
        }
    }

    #[test]
    fn windows_token_context_owner_pair_is_closed_and_binds_identity() {
        for (code, category) in [
            (ERROR_ACCESS_DENIED, "rename-access-denied"),
            (ERROR_INVALID_PARAMETER, "rename-invalid-parameter"),
            (ERROR_NOT_SUPPORTED, "rename-not-supported"),
            (ERROR_INVALID_NAME, "rename-invalid-name"),
            (ERROR_NOT_SAME_DEVICE, "rename-not-same-device"),
            (ERROR_PRIVILEGE_NOT_HELD, "rename-privilege-not-held"),
            (ERROR_SHARING_VIOLATION, "rename-sharing-violation"),
            (ERROR_LOCK_VIOLATION, "rename-lock-violation"),
            (ERROR_FILE_NOT_FOUND, "rename-source-missing"),
            (ERROR_PATH_NOT_FOUND, "rename-source-missing"),
            (ERROR_ALREADY_EXISTS, "rename-destination-exists"),
            (ERROR_FILE_EXISTS, "rename-destination-exists"),
        ] {
            assert_eq!(
                crate::stage_index::rename_error_category(&std::io::Error::from_raw_os_error(
                    code as i32
                )),
                category
            );
        }
        assert_eq!(
            crate::stage_index::rename_error_category(&std::io::Error::other("test")),
            "rename-other"
        );
        let mut primary = TOKEN_STATISTICS {
            TokenType: TokenPrimary,
            ..TOKEN_STATISTICS::default()
        };
        let primary_initial = statistics_bytes(&primary).expect("primary token statistics");
        primary.ImpersonationLevel = 2;
        assert_eq!(
            statistics_bytes(&primary).expect("ignored primary level"),
            primary_initial
        );
        let mut impersonated = primary;
        impersonated.TokenType = TokenImpersonation;
        let impersonation_initial =
            statistics_bytes(&impersonated).expect("impersonation statistics");
        impersonated.ImpersonationLevel = 3;
        assert_ne!(
            statistics_bytes(&impersonated).expect("changed impersonation"),
            impersonation_initial
        );
        for field in 0..3 {
            let mut changed = primary;
            match field {
                0 => changed.TokenId.LowPart ^= 1,
                1 => changed.AuthenticationId.LowPart ^= 1,
                _ => changed.ModifiedId.LowPart ^= 1,
            }
            assert_ne!(
                statistics_bytes(&changed).expect("changed token identity"),
                primary_initial
            );
        }
        let mut unknown = primary;
        unknown.TokenType = 0;
        assert!(matches!(
            statistics_bytes(&unknown),
            Err(NativeFailure::Unsupported)
        ));
        let context = token_context().expect("effective token");
        assert!(context.admits_owner(&context.user));
        assert!(context.admits_owner(&context.owner));
        assert!(!context.admits_owner(&[]));
        let mut changed = context.encoded();
        changed[0] ^= 1;
        assert_ne!(changed, context.encoded());
    }

    #[test]
    fn windows_recovery_ownership_accepts_final_dacl_and_refuses_links_or_directories() {
        let fixture = Fixture::new();
        let file = fixture.file("source", b"owned stage bytes");
        let private = policy(&file).expect("private file policy");
        let (_, mut expected_acl, expected_owner) = private_security().expect("private policy");
        let expected = expected_acl.as_mut_ptr().cast::<ACL>();
        let expected_bytes = unsafe {
            std::slice::from_raw_parts(expected.cast::<u8>(), (*expected).AclSize as usize)
        };
        assert!(
            private.owner == expected_owner
                && private.dacl == expected_bytes
                && private.control & SE_DACL_PROTECTED != 0
        );
        set_user_acl(&file, 0, true);
        assert!(WindowsProfile::verify_private_file(&file).is_err());
        WindowsProfile::verify_owned_file(&file).expect("owned final-policy file");
        assert!(WindowsProfile::verify_owned_file(&fixture.directory).is_err());
        std::fs::hard_link(fixture.path.join("source"), fixture.path.join("alias"))
            .expect("fixture hard link");
        assert!(WindowsProfile::verify_owned_file(&file).is_err());
    }

    #[test]
    fn windows_profile_preserves_dacl_owner_group_zone_and_exact_bytes() {
        let fixture = Fixture::new();
        let source = fixture.file("source", b"old");
        let zone = b"[ZoneTransfer]\r\nZoneId=3\r\n";
        let mut stream = open(
            &zone_path(&fixture.path.join("source")),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("fixture Zone.Identifier");
        stream.write_all(zone).expect("zone bytes");
        drop(stream);
        let snapshot = WindowsProfile::capture_existing(
            &source,
            &fixture.path.join("source"),
            WriteOperation::Replace,
        )
        .expect("ordinary attributed source");
        assert!(snapshot.zone.as_deref() == Some(zone.as_slice()));
        let empty = fixture.file("empty-primary", b"");
        assert!(streams(&empty).expect("empty inventory").is_none());
        // Synthetic fault controls exercise the no-DATA decision independently
        // of the native NTFS inventory shape; ordinary controls remain above.
        struct ResetBackupFault;
        impl Drop for ResetBackupFault {
            fn drop(&mut self) {
                crate::test_hooks::inject_failure(None);
            }
        }
        let _reset_backup_fault = ResetBackupFault;
        crate::test_hooks::inject_failure(Some("RELAVIUM_NATIVE_BACKUP_EOF"));
        assert!(streams(&empty).expect("forced empty EOF").is_none());
        assert!(matches!(streams(&source), Err(NativeFailure::Unsupported)));
        crate::test_hooks::inject_failure(Some("RELAVIUM_NATIVE_BACKUP_TRUNCATE"));
        assert!(matches!(streams(&empty), Err(NativeFailure::Changed)));
        let grow = fixture.file("growing-primary", b"");
        crate::test_hooks::inject_failure(Some("RELAVIUM_NATIVE_BACKUP_GROW"));
        assert!(matches!(streams(&grow), Err(NativeFailure::Unsupported)));
        assert_eq!(info(&grow).expect("grown fixture").nFileSizeLow, 1);
        crate::test_hooks::inject_failure(None);
        let zone_only = fixture.file("zone-only", b"");
        let mut zone_stream = open(
            &zone_path(&fixture.path.join("zone-only")),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("zone-only stream");
        zone_stream.write_all(zone).expect("zone-only bytes");
        zone_stream.sync_all().expect("zone-only flush");
        drop(zone_stream);
        assert_eq!(
            streams(&zone_only).expect("zone-only inventory").as_deref(),
            Some(zone.as_slice())
        );
        let zone_snapshot = WindowsProfile::capture_existing(
            &zone_only,
            &fixture.path.join("zone-only"),
            WriteOperation::Replace,
        )
        .expect("zone-only snapshot");
        let (zone_stage_path, _zone_stage_parent, zone_stage) = fixture.stage();
        WindowsProfile::apply_and_verify_existing(
            &zone_snapshot,
            &zone_only,
            &zone_stage,
            &zone_stage_path.join("payload"),
        )
        .expect("copy zone-only metadata");
        assert_eq!(
            streams(&zone_stage)
                .expect("copied zone-only inventory")
                .as_deref(),
            Some(zone.as_slice())
        );
        drop(zone_stage);
        drop(_zone_stage_parent);
        std::fs::remove_dir_all(&zone_stage_path).expect("remove completed empty zone stage");
        let (stage_path, stage_parent, mut stage) = fixture.stage();
        WindowsProfile::apply_and_verify_existing(
            &snapshot,
            &source,
            &stage,
            &stage_path.join("payload"),
        )
        .expect("metadata copied before payload");
        stage
            .write_all(b"reviewed new bytes")
            .expect("reviewed stage");
        stage.sync_all().expect("stage flush");
        WindowsProfile::verify_existing_stage(&snapshot, &stage, &stage_path.join("payload"))
            .expect("metadata retained through payload");
        WindowsProfile::recheck_existing(
            &snapshot,
            &source,
            &fixture.path.join("source"),
            WriteOperation::Replace,
        )
        .expect("source unchanged");
        WindowsProfile::publish_existing(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("source"),
        )
        .expect("single rename publication");
        assert!(fixture.bytes("source") == b"reviewed new bytes");
        let final_file = File::open(fixture.path.join("source")).expect("published file");
        assert!(same_policy(
            &policy(&final_file).expect("final policy"),
            &snapshot.policy
        ));
        assert!(streams(&final_file).expect("final streams").as_deref() == Some(zone.as_slice()));
        assert!(!stage_path.join("payload").exists());

        // Build an actual unprotected source with an OS-inherited ACE from
        // the destination parent, then require exact metadata on the stage.
        let second = Fixture::new();
        set_user_acl(&second.directory, 0, false);
        let ordinary = open(
            &second.path.join("source"),
            FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | DELETE_ACCESS
                | WRITE_DAC_ACCESS
                | WRITE_OWNER_ACCESS,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("direct inherited source");
        let original = policy(&ordinary).expect("source descriptor");
        assert_eq!(original.control & SE_DACL_PROTECTED, 0);
        let descriptor = original.descriptor.as_ptr().cast_mut().cast();
        let (mut present, mut defaulted, mut dacl) = (0, 0, ptr::null_mut());
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            },
            0
        );
        assert_ne!(present, 0);
        let mut ace: *mut std::ffi::c_void = ptr::null_mut();
        assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
        let header = unsafe { std::ptr::read_unaligned(ace.cast::<ACE_HEADER>()) };
        assert_ne!(u32::from(header.AceFlags) & INHERITED_ACE, 0);
        let ordinary_snapshot = WindowsProfile::capture_existing(
            &ordinary,
            &second.path.join("source"),
            WriteOperation::Replace,
        )
        .expect("unprotected snapshot");
        let (second_path, _second_parent, second_stage) = second.stage();
        WindowsProfile::apply_and_verify_existing(
            &ordinary_snapshot,
            &ordinary,
            &second_stage,
            &second_path.join("payload"),
        )
        .expect("unprotected metadata copied exactly");
        assert!(same_policy(
            &policy(&second_stage).expect("unprotected stage"),
            &ordinary_snapshot.policy
        ));
    }

    #[test]
    fn windows_profile_denied_data_write_and_append_leave_source_unchanged() {
        let fixture = Fixture::new();
        let source = fixture.file("source", b"old");
        set_user_acl(&source, FILE_WRITE_DATA | FILE_APPEND_DATA, false);
        let before = policy(&source).expect("deny policy");
        for operation in [WriteOperation::Replace, WriteOperation::Append] {
            assert!(matches!(
                WindowsProfile::capture_existing(&source, &fixture.path.join("source"), operation),
                Err(NativeFailure::AccessDenied)
            ));
        }
        assert!(fixture.bytes("source") == b"old");
        assert!(same_policy(
            &before,
            &policy(&source).expect("unchanged deny policy")
        ));
        assert!(!fixture.path.join("stage").exists());
    }

    #[test]
    fn windows_profile_refuses_unknown_and_oversized_named_streams() {
        let fixture = Fixture::new();
        let source = fixture.file("source", b"old");
        let mut unknown = fixture.path.join("source").into_os_string();
        unknown.push(":unknown");
        let stream = open(
            Path::new(&unknown),
            FILE_GENERIC_WRITE,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("unknown fixture ADS");
        drop(stream);
        assert!(matches!(
            WindowsProfile::capture_existing(
                &source,
                &fixture.path.join("source"),
                WriteOperation::Replace
            ),
            Err(NativeFailure::Unsupported)
        ));
        std::fs::remove_file(Path::new(&unknown)).expect("remove unknown fixture ADS");
        let stream = open(
            &zone_path(&fixture.path.join("source")),
            FILE_GENERIC_WRITE,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("large fixture zone");
        stream
            .set_len((STREAM_LIMIT + 1) as u64)
            .expect("oversized fixture zone");
        assert!(matches!(
            WindowsProfile::capture_existing(
                &source,
                &fixture.path.join("source"),
                WriteOperation::Replace
            ),
            Err(NativeFailure::Unsupported)
        ));
        assert!(fixture.bytes("source") == b"old");
    }

    #[test]
    fn windows_profile_rechecks_metadata_only_changes_and_parent_policy() {
        let fixture = Fixture::new();
        let flush_parent = WindowsProfile::open_parent(&fixture.path).expect("flushable parent");
        flush_parent.sync_all().expect("parent directory flush");
        set_user_acl(&fixture.directory, FILE_ADD_FILE, false);
        let denied_parent = WindowsProfile::open_parent(&fixture.path);
        // Restore the fixture ACL before checking the result or performing cleanup.
        set_user_acl(&fixture.directory, 0, false);
        assert!(matches!(denied_parent, Err(NativeFailure::AccessDenied)));
        let source = fixture.file("source", b"old");
        let snapshot = WindowsProfile::capture_existing(
            &source,
            &fixture.path.join("source"),
            WriteOperation::Replace,
        )
        .expect("source snapshot");
        set_user_acl(&source, 0, true);
        assert_eq!(
            WindowsProfile::recheck_existing(
                &snapshot,
                &source,
                &fixture.path.join("source"),
                WriteOperation::Replace
            ),
            Err(NativeFailure::Changed)
        );
        let parent =
            WindowsProfile::capture_parent(&fixture.directory, None).expect("parent snapshot");
        let mut token_changed = WindowsProfile::capture_parent(&fixture.directory, None)
            .expect("token-bound parent snapshot");
        token_changed.credentials[0] ^= 1;
        assert_eq!(
            WindowsProfile::recheck_parent(&token_changed, &fixture.directory, None),
            Err(NativeFailure::Changed)
        );
        set_user_acl(&fixture.directory, 0, true);
        assert_eq!(
            WindowsProfile::recheck_parent(&parent, &fixture.directory, None),
            Err(NativeFailure::Changed)
        );
        assert!(fixture.bytes("source") == b"old");
    }

    #[test]
    fn windows_profile_new_file_matches_direct_destination_inheritance() {
        let fixture = Fixture::new();
        set_user_acl(&fixture.directory, 0, true);
        let parent =
            WindowsProfile::capture_parent(&fixture.directory, None).expect("parent snapshot");
        let direct = open(
            &fixture.path.join("direct"),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            CREATE_NEW,
            0,
            ptr::null(),
        )
        .expect("direct OS inherited file");
        let expected = policy(&direct).expect("direct inherited policy");
        let stage_path = fixture.path.join("stage");
        let stage_parent =
            WindowsProfile::create_private_directory(&stage_path).expect("private staging");
        let mut staged = WindowsProfile::create_inherited_empty(
            &fixture.directory,
            &parent,
            None,
            &stage_parent,
            OsStr::new("empty-template"),
            OsStr::new("payload"),
            &mut |_| Ok(()),
        )
        .expect("kernel inherited empty inode moved private");
        let inherited =
            WindowsProfile::capture_inherited_stage(&parent, &staged, &stage_path.join("payload"))
                .expect("pinned inherited stage");
        assert!(same_policy(&inherited.policy, &expected));
        staged
            .write_all(b"new content")
            .expect("payload only in private directory");
        WindowsProfile::verify_inherited_stage(&inherited, &staged, &stage_path.join("payload"))
            .expect("inherited policy after bytes");
        WindowsProfile::publish_new(
            &staged,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("new"),
        )
        .expect("no-clobber publication");
        let result = File::open(fixture.path.join("new")).expect("new file");
        assert!(same_policy(
            &policy(&result).expect("new policy"),
            &expected
        ));
        assert!(fixture.bytes("new") == b"new content");
    }

    #[test]
    fn windows_profile_no_clobber_and_replacement_failure_preserve_old_bytes() {
        let fixture = Fixture::new();
        drop(fixture.file("source", b"old"));
        let (stage_path, stage_parent, mut stage) = fixture.stage();
        stage.write_all(b"new").expect("fixture stage");
        assert!(WindowsProfile::publish_new(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("source")
        )
        .is_err());
        assert!(fixture.bytes("source") == b"old");
        assert!(stage_path.join("payload").exists());
        let encoded = wide(fixture.path.join("source").as_os_str()).expect("fixture path");
        assert_ne!(
            unsafe { SetFileAttributesW(encoded.as_ptr(), FILE_ATTRIBUTE_READONLY) },
            0
        );
        assert!(WindowsProfile::publish_existing(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("source")
        )
        .is_err());
        assert!(fixture.bytes("source") == b"old");
        assert!(stage_path.join("payload").exists());
        assert_ne!(
            unsafe { SetFileAttributesW(encoded.as_ptr(), FILE_ATTRIBUTE_NORMAL) },
            0
        );
        std::fs::create_dir(fixture.path.join("directory-target")).expect("directory target");
        assert!(WindowsProfile::publish_existing(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("directory-target")
        )
        .is_err());
        assert!(fixture.path.join("directory-target").is_dir());
        assert!(stage_path.join("payload").exists());
        // A non-sharing target handle is a native sharing failure, before the
        // final successful replacement with ordinary delete-sharing readers.
        let exclusive = unsafe {
            CreateFileW(
                encoded.as_ptr(),
                FILE_GENERIC_READ,
                0,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        };
        assert_ne!(exclusive, INVALID_HANDLE_VALUE);
        let exclusive = unsafe { File::from_raw_handle(exclusive) };
        assert!(WindowsProfile::publish_existing(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("source")
        )
        .is_err());
        let mut old_locked = Vec::new();
        (&exclusive)
            .read_to_end(&mut old_locked)
            .expect("exclusive old bytes");
        assert!(old_locked == b"old");
        assert!(stage_path.join("payload").exists());
        drop(exclusive);
        let locked = open(
            &fixture.path.join("source"),
            FILE_GENERIC_READ,
            OPEN_EXISTING,
            0,
            ptr::null(),
        )
        .expect("opened fixture");
        let mut old = Vec::new();
        (&locked).read_to_end(&mut old).expect("old read handle");
        assert!(old == b"old");
        WindowsProfile::publish_existing(
            &stage,
            &stage_parent,
            OsStr::new("payload"),
            &fixture.directory,
            OsStr::new("source"),
        )
        .expect("POSIX rename with open old handles");
        assert!(fixture.bytes("source") == b"new");
    }
}
