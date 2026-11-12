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
fn token_data(class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>, NativeFailure> {
    let token = token()?;
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
fn credentials() -> Result<Vec<u8>, NativeFailure> {
    let data = token_data(TokenStatistics)?;
    let stats = unsafe { &*data.as_ptr().cast::<TOKEN_STATISTICS>() };
    let mut bytes = Vec::new();
    for luid in [&stats.TokenId, &stats.AuthenticationId, &stats.ModifiedId] {
        bytes.extend_from_slice(&luid.LowPart.to_le_bytes());
        bytes.extend_from_slice(&luid.HighPart.to_le_bytes());
    }
    Ok(bytes)
}
fn current_sid() -> Result<Vec<u8>, NativeFailure> {
    let data = token_data(TokenUser)?;
    sid_bytes(unsafe { (*data.as_ptr().cast::<TOKEN_USER>()).User.Sid })
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
            return if data_seen {
                Ok(zone)
            } else {
                Err(NativeFailure::Unsupported)
            };
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
    Ok(ExistingSnapshot {
        identity: identity(file)?,
        policy: policy(file)?,
        attributes: value.dwFileAttributes,
        size: u64::from(value.nFileSizeHigh) << 32 | u64::from(value.nFileSizeLow),
        write_time: u64::from(value.ftLastWriteTime.dwHighDateTime) << 32
            | u64::from(value.ftLastWriteTime.dwLowDateTime),
        change_time: basic.ChangeTime,
        zone: streams(file)?,
        credentials: credentials()?,
    })
}

fn private_security() -> Result<(SECURITY_DESCRIPTOR, Vec<u64>, Vec<u8>), NativeFailure> {
    let mut sid = current_sid()?;
    let size = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>() + sid.len();
    let mut acl = vec![0u64; size.div_ceil(8)];
    let acl_ptr = acl.as_mut_ptr().cast();
    let mut descriptor = SECURITY_DESCRIPTOR::default();
    if unsafe { InitializeAcl(acl_ptr, size as u32, ACL_REVISION) } == 0
        || unsafe {
            AddAccessAllowedAceEx(
                acl_ptr,
                ACL_REVISION,
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
                FILE_ALL,
                sid.as_mut_ptr().cast(),
            )
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
    let actual = policy(file)?;
    let (_, mut acl, sid) = private_security()?;
    let raw = acl.as_mut_ptr().cast::<ACL>();
    if !directory {
        // Expected one-ACE result for this closed private-directory profile,
        // constructed using the OS ACL APIs. No permission evaluator is used.
        if unsafe { InitializeAcl(raw, u32::from((*raw).AclSize), ACL_REVISION) } == 0
            || unsafe {
                AddAccessAllowedAceEx(
                    raw,
                    ACL_REVISION,
                    INHERITED_ACE,
                    FILE_ALL,
                    sid.as_ptr().cast_mut().cast(),
                )
            } == 0
        {
            return Err(failure());
        }
    }
    let expected = unsafe { std::slice::from_raw_parts(raw.cast::<u8>(), (*raw).AclSize as usize) };
    if actual.owner != sid
        || (directory && actual.control & SE_DACL_PROTECTED == 0)
        || (!directory && actual.control & SE_DACL_PROTECTED != 0)
        || actual.dacl != expected
    {
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

impl Profile for WindowsProfile {
    type ExistingSnapshot = ExistingSnapshot;
    type ParentSnapshot = ParentSnapshot;
    type NewFileSnapshot = ExistingSnapshot;
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
            FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | READ_CONTROL_ACCESS,
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
        if identity(source)? != snapshot.identity
            || !same_policy(&policy(source)?, &snapshot.policy)
            || streams(source)? != snapshot.zone
        {
            return Err(NativeFailure::Changed);
        }
        bind(stage, stage_path, false)?;
        if streams(stage)?.is_some() {
            return Err(NativeFailure::Unsupported);
        }
        if let Some(value) = &snapshot.zone {
            let path = zone_path(stage_path);
            let mut stream = open(
                &path,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                CREATE_NEW,
                0,
                ptr::null(),
            )?;
            if identity(&stream)? != identity(stage)? {
                return Err(NativeFailure::Changed);
            }
            stream
                .write_all(value)
                .map_err(|_| NativeFailure::Unsupported)?;
            stream.sync_all().map_err(|_| NativeFailure::Unsupported)?;
        }
        #[cfg(test)]
        crate::test_hooks::hit("partial-metadata");
        let protection = if snapshot.policy.control & SE_DACL_PROTECTED != 0 {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            0
        };
        // Stage files start unprotected, inside a protected private directory.
        // Omitting UNPROTECTED avoids requesting inheritance from the staging
        // parent; the captured inherited ACEs themselves are supplied unchanged.
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
        Ok(())
    }
    fn verify_existing_stage(
        snapshot: &ExistingSnapshot,
        stage: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure> {
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
    fn create_private_directory(path: &Path) -> Result<File, NativeFailure> {
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
        )?;
        Self::verify_private_directory(path, &result)?;
        Ok(result)
    }
    fn verify_private_directory(path: &Path, directory: &File) -> Result<(), NativeFailure> {
        bind(directory, path, true)?;
        verify_private(directory, true)
    }
    fn create_private_file(parent: &File, name: &OsStr) -> Result<File, NativeFailure> {
        Self::verify_private_directory(&path_for(parent)?, parent)?;
        let file = open(
            &child(parent, name)?,
            FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | DELETE_ACCESS
                | WRITE_DAC_ACCESS
                | WRITE_OWNER_ACCESS,
            CREATE_NEW,
            0,
            ptr::null(),
        )?;
        Self::verify_private_file(&file)?;
        Ok(file)
    }
    fn verify_private_file(file: &File) -> Result<(), NativeFailure> {
        verify_private(file, false)
    }
    fn verify_owned_file(file: &File) -> Result<(), NativeFailure> {
        ntfs(file)?;
        let observed = info(file)?;
        if observed.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 || observed.nNumberOfLinks != 1
        {
            return Err(NativeFailure::Unsupported);
        }
        // Recovery is allowed to see a stage after its final DACL was applied.
        // Ownership is an independent check: neither privacy nor a permissive
        // final DACL substitutes for the current operator's actual owner SID.
        if policy(file)?.owner != current_sid()? {
            return Err(NativeFailure::AccessDenied);
        }
        Ok(())
    }
    fn capture_parent(
        parent: &File,
        _host_mask: Option<u32>,
    ) -> Result<ParentSnapshot, NativeFailure> {
        ntfs(parent)?;
        let attributes = info(parent)?.dwFileAttributes;
        if attributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || attributes & !(ORDINARY_ATTRIBUTES | FILE_ATTRIBUTE_DIRECTORY) != 0
        {
            return Err(NativeFailure::Unsupported);
        }
        Ok(ParentSnapshot {
            identity: identity(parent)?,
            policy: policy(parent)?,
            attributes,
            credentials: credentials()?,
        })
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
    ) -> Result<File, NativeFailure> {
        Self::recheck_parent(snapshot, parent, None)?;
        let stage_path = path_for(private_stage)?;
        Self::verify_private_directory(&stage_path, private_stage)?;
        let path = child(parent, temporary_name)?;
        let file = open(
            &path,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE_ACCESS,
            CREATE_NEW,
            0,
            ptr::null(),
        )?;
        let inherited = policy(&file)?;
        if info(&file)?.nNumberOfLinks != 1
            || info(&file)?.nFileSizeLow != 0
            || info(&file)?.nFileSizeHigh != 0
        {
            return Err(NativeFailure::Unsupported);
        }
        Self::recheck_parent(snapshot, parent, None)?;
        rename(&file, private_stage, stage_name, false)?;
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
    fn windows_recovery_ownership_accepts_final_dacl_and_refuses_links_or_directories() {
        let fixture = Fixture::new();
        let file = fixture.file("source", b"owned stage bytes");
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
