//! Joined Node-API tasks for prepared metadata, staged publication and recovery.
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, External};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;

#[cfg(target_os = "linux")]
use crate::linux::LinuxProfile as CurrentProfile;
#[cfg(target_os = "macos")]
use crate::macos::MacosProfile as CurrentProfile;
use crate::profile_api::{NativeIdentity, Profile, WriteOperation};
#[cfg(windows)]
use crate::windows::WindowsProfile as CurrentProfile;

#[cfg(unix)]
fn open_source(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}
#[cfg(windows)]
fn open_source(path: &Path) -> std::io::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

pub struct PreparedSource {
    source: File,
    path: PathBuf,
    operation: WriteOperation,
    snapshot: <CurrentProfile as Profile>::ExistingSnapshot,
    identity: NativeIdentity,
    parent: File,
    parent_path: PathBuf,
    parent_snapshot: <CurrentProfile as Profile>::ParentSnapshot,
}

type SharedPrepared = Arc<Mutex<Option<PreparedSource>>>;

fn refusal() -> Error {
    Error::new(
        Status::GenericFailure,
        "filesystem metadata preparation refused",
    )
}

pub struct PrepareExistingTask {
    path: PathBuf,
    operation: WriteOperation,
    mask: Option<u32>,
}

impl Task for PrepareExistingTask {
    type Output = SharedPrepared;
    type JsValue = External<SharedPrepared>;

    fn compute(&mut self) -> Result<Self::Output> {
        if !self.path.is_absolute() {
            return Err(refusal());
        }
        let source = open_source(&self.path).map_err(|_| refusal())?;
        let snapshot = CurrentProfile::capture_existing(&source, &self.path, self.operation)
            .map_err(|_| refusal())?;
        let identity = CurrentProfile::identity(&source).map_err(|_| refusal())?;
        let parent_path = self.path.parent().ok_or_else(refusal)?.to_path_buf();
        let parent = CurrentProfile::open_parent(&parent_path).map_err(|_| refusal())?;
        let parent_snapshot =
            CurrentProfile::capture_parent(&parent, self.mask).map_err(|_| refusal())?;
        Ok(Arc::new(Mutex::new(Some(PreparedSource {
            source,
            path: self.path.clone(),
            operation: self.operation,
            snapshot,
            identity,
            parent,
            parent_path,
            parent_snapshot,
        }))))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(External::new(output))
    }
}

#[napi(object)]
pub struct PreparedIdentity {
    pub dev: String,
    pub ino: String,
}

pub struct PreparedIdentityTask {
    prepared: SharedPrepared,
}

impl Task for PreparedIdentityTask {
    type Output = (String, String);
    type JsValue = PreparedIdentity;

    fn compute(&mut self) -> Result<Self::Output> {
        let guard = self.prepared.lock().map_err(|_| refusal())?;
        let identity = guard.as_ref().ok_or_else(refusal)?.identity;
        Ok((identity.node_dev.to_string(), identity.node_ino.to_string()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<PreparedIdentity> {
        Ok(PreparedIdentity {
            dev: output.0,
            ino: output.1,
        })
    }
}

/// Host-local identity binds the opaque source to the TypeScript byte snapshot.
#[napi]
pub fn existing_metadata_identity(
    prepared: External<SharedPrepared>,
) -> AsyncTask<PreparedIdentityTask> {
    AsyncTask::new(PreparedIdentityTask {
        prepared: Arc::clone(prepared.as_ref()),
    })
}

/// Capture the existing-file metadata and parent policy before approval.
#[napi]
pub fn prepare_existing_metadata(
    path: String,
    append: bool,
    mask: Option<u32>,
) -> AsyncTask<PrepareExistingTask> {
    let operation = if append {
        WriteOperation::Append
    } else {
        WriteOperation::Replace
    };
    AsyncTask::new(PrepareExistingTask {
        path: Path::new(&path).to_path_buf(),
        operation,
        mask,
    })
}

pub struct RecheckExistingTask {
    prepared: SharedPrepared,
}

impl Task for RecheckExistingTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        let guard = self.prepared.lock().map_err(|_| refusal())?;
        let state = guard.as_ref().ok_or_else(refusal)?;
        CurrentProfile::recheck_existing(
            &state.snapshot,
            &state.source,
            &state.path,
            state.operation,
        )
        .map_err(|_| refusal())?;
        Ok(true)
    }

    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

/// Revalidation remains read-only and does not publish or consume a preparation.
#[napi]
pub fn recheck_existing_metadata(
    prepared: External<SharedPrepared>,
) -> AsyncTask<RecheckExistingTask> {
    AsyncTask::new(RecheckExistingTask {
        prepared: Arc::clone(prepared.as_ref()),
    })
}

pub struct ReleaseExistingTask {
    prepared: SharedPrepared,
}

impl Task for ReleaseExistingTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut guard = self.prepared.lock().map_err(|_| refusal())?;
        guard.take();
        Ok(true)
    }

    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

/// Release joins the actual owned work before dropping the preparation.
#[napi]
pub fn release_existing_metadata(
    prepared: External<SharedPrepared>,
) -> AsyncTask<ReleaseExistingTask> {
    AsyncTask::new(ReleaseExistingTask {
        prepared: Arc::clone(prepared.as_ref()),
    })
}

// Private native state, accessed only through the trusted CLI adapter.
#[allow(dead_code)]
pub struct StagedExisting {
    prepared: PreparedSource,
    stage_directory: File,
    payload: File,
    owned: crate::stage_index::OwnedStage<CurrentProfile>,
}

#[allow(dead_code)]
fn stage_existing(
    prepared: PreparedSource,
    home: &Path,
    before: &[u8],
    after: &[u8],
    nonce: &str,
    mask: Option<u32>,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::result::Result<StagedExisting, crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::sync::atomic::Ordering;
    let check = || {
        if cancelled.load(Ordering::Acquire) {
            Err(NativeFailure::Cancelled)
        } else {
            Ok(())
        }
    };
    if before.len() > 8 * 1024 * 1024 || after.len() > 8 * 1024 * 1024 || !home.is_absolute() {
        return Err(NativeFailure::Unsupported);
    }
    check()?;
    CurrentProfile::recheck_existing(
        &prepared.snapshot,
        &prepared.source,
        &prepared.path,
        prepared.operation,
    )?;
    let mut source = prepared
        .source
        .try_clone()
        .map_err(|_| NativeFailure::Unsupported)?;
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| NativeFailure::Unsupported)?;
    let mut actual = Vec::with_capacity(before.len());
    source
        .take((before.len() + 1) as u64)
        .read_to_end(&mut actual)
        .map_err(|_| NativeFailure::Unsupported)?;
    if actual != before {
        return Err(NativeFailure::Changed);
    }
    CurrentProfile::recheck_existing(
        &prepared.snapshot,
        &prepared.source,
        &prepared.path,
        prepared.operation,
    )?;
    CurrentProfile::recheck_parent(&prepared.parent_snapshot, &prepared.parent, mask)?;
    if CurrentProfile::identity(&CurrentProfile::open_parent(&prepared.parent_path)?)?
        != CurrentProfile::identity(&prepared.parent)?
    {
        return Err(NativeFailure::Changed);
    }
    crate::stage_index::recover_with_cancel::<CurrentProfile>(home, cancelled)?;
    check()?;
    let mut owned = crate::stage_index::OwnedStage::<CurrentProfile>::reserve_with_cancel(
        home,
        &prepared.parent,
        &prepared.parent_path,
        nonce,
        cancelled,
    )?;
    let stage_path = owned.stage_path().to_path_buf();
    let payload_path = stage_path.join("payload");
    let setup = (|| {
        let stage_directory = CurrentProfile::create_private_directory(&stage_path)?;
        owned.adopt_directory(&stage_directory)?;
        let payload =
            CurrentProfile::create_private_file(&stage_directory, std::ffi::OsStr::new("payload"))?;
        owned.adopt_empty(&stage_directory, &payload)?;
        CurrentProfile::recheck_existing(
            &prepared.snapshot,
            &prepared.source,
            &prepared.path,
            prepared.operation,
        )?;
        CurrentProfile::recheck_parent(&prepared.parent_snapshot, &prepared.parent, mask)?;
        owned.pin_empty_with_cancel(&stage_directory, &payload, &stage_path, cancelled)?;
        CurrentProfile::apply_and_verify_existing(
            &prepared.snapshot,
            &prepared.source,
            &payload,
            &payload_path,
        )?;
        Ok((stage_directory, payload))
    })();
    let (stage_directory, mut payload) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ = owned.cleanup();
            return Err(error);
        }
    };
    let result = (|| {
        check()?;
        #[cfg(test)]
        if crate::test_hooks::selected("partial-payload") && after.len() > 1 {
            let split = after.len() / 2;
            payload
                .write_all(&after[..split])
                .map_err(|_| NativeFailure::Unsupported)?;
            payload.sync_all().map_err(|_| NativeFailure::Unsupported)?;
            crate::test_hooks::hit("partial-payload");
            payload
                .write_all(&after[split..])
                .map_err(|_| NativeFailure::Unsupported)?;
        } else {
            payload
                .write_all(after)
                .map_err(|_| NativeFailure::Unsupported)?;
        }
        #[cfg(not(test))]
        payload
            .write_all(after)
            .map_err(|_| NativeFailure::Unsupported)?;
        payload.sync_all().map_err(|_| NativeFailure::Unsupported)?;
        check()?;
        CurrentProfile::verify_existing_stage(&prepared.snapshot, &payload, &payload_path)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = owned.cleanup();
        return Err(error);
    }
    Ok(StagedExisting {
        prepared,
        stage_directory,
        payload,
        owned,
    })
}

#[allow(dead_code)]
fn publish_staged_existing(
    mut state: StagedExisting,
    mask: Option<u32>,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::result::Result<(), crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    use std::sync::atomic::Ordering;
    let result = (|| {
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeFailure::Cancelled);
        }
        if CurrentProfile::identity(&CurrentProfile::open_parent(&state.prepared.parent_path)?)?
            != CurrentProfile::identity(&state.prepared.parent)?
        {
            return Err(NativeFailure::Changed);
        }
        CurrentProfile::recheck_parent(
            &state.prepared.parent_snapshot,
            &state.prepared.parent,
            mask,
        )?;
        CurrentProfile::recheck_existing(
            &state.prepared.snapshot,
            &state.prepared.source,
            &state.prepared.path,
            state.prepared.operation,
        )?;
        CurrentProfile::verify_private_directory(state.owned.stage_path(), &state.stage_directory)?;
        CurrentProfile::verify_existing_stage(
            &state.prepared.snapshot,
            &state.payload,
            &state.owned.stage_path().join("payload"),
        )?;
        let target = state
            .prepared
            .path
            .file_name()
            .ok_or(NativeFailure::Unsupported)?;
        CurrentProfile::publish_existing(
            &state.payload,
            &state.stage_directory,
            std::ffi::OsStr::new("payload"),
            &state.prepared.parent,
            target,
        )
    })();
    let cleanup = state.owned.cleanup();
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(_)) => Err(NativeFailure::PossiblyPublished),
        (Err(error), _) => Err(error),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod producer_tests {
    use super::*;
    use std::os::unix::fs::DirBuilderExt;
    use std::sync::atomic::AtomicBool;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn owned_existing_stage_publishes_reviewed_bytes_after_pin() {
        let root = std::env::temp_dir().join(format!(
            "relavium-producer-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .expect("fixture");
        let home = root.join("home");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&home)
            .expect("home");
        let path = root.join("target");
        std::fs::write(&path, b"before").expect("source");
        let attribute = std::ffi::CString::new("user.relavium.note").expect("attribute name");
        let attribute_value = b"synthetic policy";
        let fixture_file = File::open(&path).expect("fixture source");
        use std::os::fd::AsRawFd;
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    fixture_file.as_raw_fd(),
                    attribute.as_ptr(),
                    attribute_value.as_ptr().cast(),
                    attribute_value.len(),
                    0,
                    0,
                )
            },
            0
        );
        let second = std::ffi::CString::new("user.workflow.origin").expect("second name");
        let second_value = b"second opaque value";
        let quarantine = std::ffi::CString::new("com.apple.quarantine").expect("quarantine name");
        let quarantine_value = b"0081;00000000;RelaviumProbe;";
        for (name, value) in [
            (&second, second_value.as_slice()),
            (&quarantine, quarantine_value.as_slice()),
        ] {
            assert_eq!(
                unsafe {
                    libc::fsetxattr(
                        fixture_file.as_raw_fd(),
                        name.as_ptr(),
                        value.as_ptr().cast(),
                        value.len(),
                        0,
                        0,
                    )
                },
                0
            );
        }
        assert_eq!(
            unsafe { libc::fchflags(fixture_file.as_raw_fd(), libc::UF_NODUMP | libc::UF_HIDDEN) },
            0
        );
        let acl_setup = std::process::Command::new("/bin/chmod")
            .arg("+a")
            .arg("everyone allow read")
            .arg(&path)
            .output()
            .expect("fixture ACL");
        assert!(acl_setup.status.success());
        let original_acl = crate::macos::capture_acl(fixture_file.as_raw_fd()).expect("source ACL");
        let source = File::open(&path).expect("open");
        let operation = WriteOperation::Replace;
        let snapshot =
            CurrentProfile::capture_existing(&source, &path, operation).expect("source snapshot");
        let identity = CurrentProfile::identity(&source).expect("identity");
        let parent = CurrentProfile::open_parent(&root).expect("parent");
        let mask_output = std::process::Command::new("/bin/sh")
            .args(["-c", "umask"])
            .output()
            .expect("fixture mask");
        let mask = u32::from_str_radix(
            std::str::from_utf8(&mask_output.stdout)
                .expect("text")
                .trim(),
            8,
        )
        .expect("octal");
        let parent_snapshot =
            CurrentProfile::capture_parent(&parent, Some(mask)).expect("parent snapshot");
        let prepared = PreparedSource {
            source,
            path: path.clone(),
            operation,
            snapshot,
            identity,
            parent,
            parent_path: root.clone(),
            parent_snapshot,
        };
        let cancelled = AtomicBool::new(false);
        let stage = stage_existing(
            prepared,
            &home,
            b"before",
            b"reviewed",
            "0123456789abcdef0123456789abcdef",
            Some(mask),
            &cancelled,
        )
        .expect("stage");
        assert_eq!(std::fs::read(&path).expect("source remains"), b"before");
        publish_staged_existing(stage, Some(mask), &cancelled).expect("publish");
        assert_eq!(std::fs::read(&path).expect("published"), b"reviewed");
        let published = File::open(&path).expect("published source");
        assert!(
            crate::macos::capture_acl(published.as_raw_fd()).expect("published ACL")
                == original_acl
        );
        let mut copied = [0_u8; 64];
        let length = unsafe {
            libc::fgetxattr(
                published.as_raw_fd(),
                attribute.as_ptr(),
                copied.as_mut_ptr().cast(),
                copied.len(),
                0,
                0,
            )
        };
        assert_eq!(length, attribute_value.len() as isize);
        assert_eq!(&copied[..attribute_value.len()], attribute_value);
        for (name, value) in [
            (&second, second_value.as_slice()),
            (&quarantine, quarantine_value.as_slice()),
        ] {
            let length = unsafe {
                libc::fgetxattr(
                    published.as_raw_fd(),
                    name.as_ptr(),
                    copied.as_mut_ptr().cast(),
                    copied.len(),
                    0,
                    0,
                )
            };
            assert_eq!(length, value.len() as isize);
            assert_eq!(&copied[..value.len()], value);
        }
        let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
        assert_eq!(
            unsafe { libc::fstat(published.as_raw_fd(), metadata.as_mut_ptr()) },
            0
        );
        assert_eq!(
            unsafe { metadata.assume_init() }.st_flags,
            libc::UF_NODUMP | libc::UF_HIDDEN
        );
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }
    #[test]
    fn owned_new_stage_uses_actual_parent_inheritance_and_exclusive_publish() {
        let root = std::env::temp_dir().join(format!(
            "relavium-producer-new-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .expect("fixture");
        let home = root.join("home");
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&home)
            .expect("home");
        let parent = CurrentProfile::open_parent(&root).expect("parent");
        let mask_output = std::process::Command::new("/bin/sh")
            .args(["-c", "umask"])
            .output()
            .expect("fixture mask");
        let mask = u32::from_str_radix(
            std::str::from_utf8(&mask_output.stdout)
                .expect("text")
                .trim(),
            8,
        )
        .expect("octal");
        let parent_snapshot =
            CurrentProfile::capture_parent(&parent, Some(mask)).expect("parent snapshot");
        let prepared = PreparedNew {
            parent,
            parent_path: root.clone(),
            parent_snapshot,
            target: "target".into(),
        };
        let cancelled = AtomicBool::new(false);
        let stage = stage_new(
            prepared,
            &home,
            b"reviewed",
            "fedcba9876543210fedcba9876543210",
            Some(mask),
            &cancelled,
        )
        .expect("stage");
        assert!(!root.join("target").exists());
        publish_staged_new(stage, Some(mask), &cancelled).expect("publish");
        assert_eq!(
            std::fs::read(root.join("target")).expect("published"),
            b"reviewed"
        );
        let parent = CurrentProfile::open_parent(&root).expect("parent");
        let parent_snapshot =
            CurrentProfile::capture_parent(&parent, Some(mask)).expect("parent snapshot");
        let prepared = PreparedNew {
            parent,
            parent_path: root.clone(),
            parent_snapshot,
            target: "cancelled".into(),
        };
        let staged = stage_new(
            prepared,
            &home,
            b"never published",
            "00112233445566778899aabbccddeeff",
            Some(mask),
            &cancelled,
        )
        .expect("second stage");
        let stage_path = staged.owned.stage_path().to_owned();
        cancelled.store(true, std::sync::atomic::Ordering::Release);
        assert!(matches!(
            publish_staged_new(staged, Some(mask), &cancelled),
            Err(crate::profile_api::NativeFailure::Cancelled)
        ));
        assert!(!root.join("cancelled").exists());
        assert!(!stage_path.exists());
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }
    #[test]
    fn private_access_and_new_file_policy_hold_under_child_umasks() {
        for mask in ["0022", "0077", "0002", "0777"] {
            let status =
                std::process::Command::new(std::env::current_exe().expect("test executable"))
                    .args([
                        "--ignored",
                        "--exact",
                        "common::producer_tests::private_umask_child",
                    ])
                    .env("RELAVIUM_TEST_CREATION_MASK", mask)
                    .status()
                    .expect("joined test child");
            assert!(status.success());
        }
    }

    #[test]
    #[ignore = "subprocess fixture run by private_access_and_new_file_policy_hold_under_child_umasks"]
    fn private_umask_child() {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let mask = u32::from_str_radix(
            &std::env::var("RELAVIUM_TEST_CREATION_MASK").expect("fixture mask"),
            8,
        )
        .expect("octal");
        let root =
            std::env::temp_dir().join(format!("relavium-umask-child-{}", std::process::id()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .expect("parent");
        unsafe {
            libc::umask(mask.try_into().expect("mode mask"));
        }
        let acl = std::process::Command::new("/bin/chmod")
            .arg("+a")
            .arg("everyone allow read,file_inherit,directory_inherit")
            .arg(&root)
            .output()
            .expect("fixture inherited ACL");
        assert!(acl.status.success());
        let parent = CurrentProfile::open_parent(&root).expect("parent handle");
        let policy = CurrentProfile::capture_parent(&parent, Some(mask));
        if mask & 0o700 != 0 {
            assert!(matches!(
                policy,
                Err(crate::profile_api::NativeFailure::Unsupported)
            ));
            assert!(!root.join("private").exists());
            std::fs::remove_dir_all(root).expect("cleanup");
            return;
        }
        let snapshot = policy.expect("policy");
        let private_path = root.join("private");
        let private =
            CurrentProfile::create_private_directory(&private_path).expect("private directory");
        let private_file =
            CurrentProfile::create_private_file(&private, std::ffi::OsStr::new("private-file"))
                .expect("private file");
        CurrentProfile::verify_private_file(&private_file).expect("private file policy");
        let direct = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(root.join("direct"))
            .expect("kernel policy");
        let inherited = CurrentProfile::create_inherited_empty(
            &parent,
            &snapshot,
            Some(mask),
            &private,
            std::ffi::OsStr::new(".relavium-fs-stage-v1.template"),
            std::ffi::OsStr::new("payload"),
        )
        .expect("inherited file");
        let expected = direct.metadata().expect("direct metadata");
        let actual = inherited.metadata().expect("inherited metadata");
        assert_eq!(expected.mode() & 0o7777, actual.mode() & 0o7777);
        assert_eq!(expected.gid(), actual.gid());
        use std::os::fd::AsRawFd;
        assert!(
            crate::macos::capture_acl(direct.as_raw_fd()).expect("direct ACL")
                == crate::macos::capture_acl(inherited.as_raw_fd()).expect("inherited ACL")
        );
        drop(inherited);
        drop(private_file);
        drop(private);
        drop(direct);
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}

#[allow(dead_code)]
pub struct PreparedNew {
    parent: File,
    parent_path: PathBuf,
    parent_snapshot: <CurrentProfile as Profile>::ParentSnapshot,
    target: std::ffi::OsString,
}

#[allow(dead_code)]
pub struct StagedNew {
    prepared: PreparedNew,
    stage_directory: File,
    payload: File,
    snapshot: <CurrentProfile as Profile>::NewFileSnapshot,
    owned: crate::stage_index::OwnedStage<CurrentProfile>,
}

#[allow(dead_code)]
fn stage_new(
    prepared: PreparedNew,
    home: &Path,
    after: &[u8],
    nonce: &str,
    mask: Option<u32>,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::result::Result<StagedNew, crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    use std::io::Write;
    use std::sync::atomic::Ordering;
    if after.len() > 8 * 1024 * 1024 || !home.is_absolute() {
        return Err(NativeFailure::Unsupported);
    }
    if cancelled.load(Ordering::Acquire) {
        return Err(NativeFailure::Cancelled);
    }
    CurrentProfile::recheck_parent(&prepared.parent_snapshot, &prepared.parent, mask)?;
    if CurrentProfile::identity(&CurrentProfile::open_parent(&prepared.parent_path)?)?
        != CurrentProfile::identity(&prepared.parent)?
    {
        return Err(NativeFailure::Changed);
    }
    crate::stage_index::recover_with_cancel::<CurrentProfile>(home, cancelled)?;
    let mut owned = crate::stage_index::OwnedStage::<CurrentProfile>::reserve_with_cancel(
        home,
        &prepared.parent,
        &prepared.parent_path,
        nonce,
        cancelled,
    )?;
    let stage_path = owned.stage_path().to_path_buf();
    let payload_path = stage_path.join("payload");
    let setup = (|| {
        let stage_directory = CurrentProfile::create_private_directory(&stage_path)?;
        owned.adopt_directory(&stage_directory)?;
        let template = format!(".relavium-fs-stage-v1.template.{nonce}");
        let payload = CurrentProfile::create_inherited_empty(
            &prepared.parent,
            &prepared.parent_snapshot,
            mask,
            &stage_directory,
            std::ffi::OsStr::new(&template),
            std::ffi::OsStr::new("payload"),
        )?;
        owned.adopt_empty(&stage_directory, &payload)?;
        let snapshot = CurrentProfile::capture_inherited_stage(
            &prepared.parent_snapshot,
            &payload,
            &payload_path,
        )?;
        owned.pin_empty_with_cancel(&stage_directory, &payload, &stage_path, cancelled)?;
        Ok((stage_directory, payload, snapshot))
    })();
    let (stage_directory, mut payload, snapshot) = match setup {
        Ok(value) => value,
        Err(error) => {
            let _ = owned.cleanup();
            return Err(error);
        }
    };
    let result = (|| {
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeFailure::Cancelled);
        }
        #[cfg(test)]
        if crate::test_hooks::selected("partial-payload") && after.len() > 1 {
            let split = after.len() / 2;
            payload
                .write_all(&after[..split])
                .map_err(|_| NativeFailure::Unsupported)?;
            payload.sync_all().map_err(|_| NativeFailure::Unsupported)?;
            crate::test_hooks::hit("partial-payload");
            payload
                .write_all(&after[split..])
                .map_err(|_| NativeFailure::Unsupported)?;
        } else {
            payload
                .write_all(after)
                .map_err(|_| NativeFailure::Unsupported)?;
        }
        #[cfg(not(test))]
        payload
            .write_all(after)
            .map_err(|_| NativeFailure::Unsupported)?;
        payload.sync_all().map_err(|_| NativeFailure::Unsupported)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeFailure::Cancelled);
        }
        CurrentProfile::verify_inherited_stage(&snapshot, &payload, &payload_path)
    })();
    if let Err(error) = result {
        let _ = owned.cleanup();
        return Err(error);
    }
    Ok(StagedNew {
        prepared,
        stage_directory,
        payload,
        snapshot,
        owned,
    })
}

#[allow(dead_code)]
fn publish_staged_new(
    mut state: StagedNew,
    mask: Option<u32>,
    cancelled: &std::sync::atomic::AtomicBool,
) -> std::result::Result<(), crate::profile_api::NativeFailure> {
    use crate::profile_api::NativeFailure;
    use std::sync::atomic::Ordering;
    let result = (|| {
        if cancelled.load(Ordering::Acquire) {
            return Err(NativeFailure::Cancelled);
        }
        if CurrentProfile::identity(&CurrentProfile::open_parent(&state.prepared.parent_path)?)?
            != CurrentProfile::identity(&state.prepared.parent)?
        {
            return Err(NativeFailure::Changed);
        }
        CurrentProfile::recheck_parent(
            &state.prepared.parent_snapshot,
            &state.prepared.parent,
            mask,
        )?;
        CurrentProfile::verify_private_directory(state.owned.stage_path(), &state.stage_directory)?;
        CurrentProfile::verify_inherited_stage(
            &state.snapshot,
            &state.payload,
            &state.owned.stage_path().join("payload"),
        )?;
        CurrentProfile::publish_new(
            &state.payload,
            &state.stage_directory,
            std::ffi::OsStr::new("payload"),
            &state.prepared.parent,
            &state.prepared.target,
        )
    })();
    let cleanup = state.owned.cleanup();
    match (result, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Ok(()), Err(_)) => Err(NativeFailure::PossiblyPublished),
        (Err(error), _) => Err(error),
    }
}

// These native methods are host-private building blocks. The CLI must keep the
// model write gate closed until the complete adapter and target controls pass.
type Cancellation = Arc<std::sync::atomic::AtomicBool>;
type SharedNew = Arc<Mutex<Option<PreparedNew>>>;
pub enum OwnedPreparedStage {
    Existing(StagedExisting),
    New(StagedNew),
}
type SharedStage = Arc<Mutex<Option<OwnedPreparedStage>>>;

fn native_error(error: crate::profile_api::NativeFailure) -> Error {
    use crate::profile_api::NativeFailure;
    let message = match error {
        NativeFailure::PossiblyPublished => "filesystem publication outcome uncertain",
        NativeFailure::Cancelled => "filesystem operation cancelled",
        NativeFailure::Changed => "filesystem preparation changed",
        NativeFailure::AccessDenied => "filesystem access denied",
        NativeFailure::Unsupported => "filesystem metadata protection unavailable",
    };
    Error::new(Status::GenericFailure, message)
}

#[napi]
pub fn create_write_cancellation() -> External<Cancellation> {
    External::new(Arc::new(std::sync::atomic::AtomicBool::new(false)))
}

#[napi]
pub fn cancel_write(cancellation: External<Cancellation>) {
    cancellation
        .as_ref()
        .store(true, std::sync::atomic::Ordering::Release);
}

pub struct PrepareNewTask {
    path: PathBuf,
    mask: Option<u32>,
}
impl Task for PrepareNewTask {
    type Output = SharedNew;
    type JsValue = External<SharedNew>;
    fn compute(&mut self) -> Result<Self::Output> {
        if !self.path.is_absolute() {
            return Err(refusal());
        }
        match std::fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            _ => return Err(refusal()),
        }
        let parent_path = self.path.parent().ok_or_else(refusal)?.to_path_buf();
        let target = self.path.file_name().ok_or_else(refusal)?.to_os_string();
        let parent = CurrentProfile::open_parent(&parent_path).map_err(native_error)?;
        let parent_snapshot =
            CurrentProfile::capture_parent(&parent, self.mask).map_err(native_error)?;
        Ok(Arc::new(Mutex::new(Some(PreparedNew {
            parent,
            parent_path,
            parent_snapshot,
            target,
        }))))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(External::new(output))
    }
}

#[napi]
pub fn prepare_new_metadata(path: String, mask: Option<u32>) -> AsyncTask<PrepareNewTask> {
    AsyncTask::new(PrepareNewTask {
        path: PathBuf::from(path),
        mask,
    })
}

pub struct StageExistingTask {
    prepared: SharedPrepared,
    home: PathBuf,
    before: Vec<u8>,
    after: Vec<u8>,
    nonce: String,
    mask: Option<u32>,
    cancelled: Cancellation,
}
impl Task for StageExistingTask {
    type Output = SharedStage;
    type JsValue = External<SharedStage>;
    fn compute(&mut self) -> Result<Self::Output> {
        let mut guard = self.prepared.lock().map_err(|_| refusal())?;
        let state = guard.take().ok_or_else(refusal)?;
        let staged = stage_existing(
            state,
            &self.home,
            &self.before,
            &self.after,
            &self.nonce,
            self.mask,
            &self.cancelled,
        )
        .map_err(native_error)?;
        Ok(Arc::new(Mutex::new(Some(OwnedPreparedStage::Existing(
            staged,
        )))))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(External::new(output))
    }
}
#[napi]
pub fn stage_existing_metadata(
    prepared: External<SharedPrepared>,
    home: String,
    before: napi::bindgen_prelude::Buffer,
    after: napi::bindgen_prelude::Buffer,
    nonce: String,
    mask: Option<u32>,
    cancellation: External<Cancellation>,
) -> AsyncTask<StageExistingTask> {
    AsyncTask::new(StageExistingTask {
        prepared: Arc::clone(prepared.as_ref()),
        home: PathBuf::from(home),
        before: before.to_vec(),
        after: after.to_vec(),
        nonce,
        mask,
        cancelled: Arc::clone(cancellation.as_ref()),
    })
}

pub struct StageNewTask {
    prepared: SharedNew,
    home: PathBuf,
    after: Vec<u8>,
    nonce: String,
    mask: Option<u32>,
    cancelled: Cancellation,
}
impl Task for StageNewTask {
    type Output = SharedStage;
    type JsValue = External<SharedStage>;
    fn compute(&mut self) -> Result<Self::Output> {
        let mut guard = self.prepared.lock().map_err(|_| refusal())?;
        let state = guard.take().ok_or_else(refusal)?;
        let staged = stage_new(
            state,
            &self.home,
            &self.after,
            &self.nonce,
            self.mask,
            &self.cancelled,
        )
        .map_err(native_error)?;
        Ok(Arc::new(Mutex::new(Some(OwnedPreparedStage::New(staged)))))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(External::new(output))
    }
}
#[napi]
pub fn stage_new_metadata(
    prepared: External<SharedNew>,
    home: String,
    after: napi::bindgen_prelude::Buffer,
    nonce: String,
    mask: Option<u32>,
    cancellation: External<Cancellation>,
) -> AsyncTask<StageNewTask> {
    AsyncTask::new(StageNewTask {
        prepared: Arc::clone(prepared.as_ref()),
        home: PathBuf::from(home),
        after: after.to_vec(),
        nonce,
        mask,
        cancelled: Arc::clone(cancellation.as_ref()),
    })
}

pub struct PublishTask {
    stage: SharedStage,
    mask: Option<u32>,
    cancelled: Cancellation,
}
impl Task for PublishTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<bool> {
        let mut guard = self.stage.lock().map_err(|_| refusal())?;
        let state = guard.take().ok_or_else(refusal)?;
        match state {
            OwnedPreparedStage::Existing(state) => {
                publish_staged_existing(state, self.mask, &self.cancelled)
            }
            OwnedPreparedStage::New(state) => publish_staged_new(state, self.mask, &self.cancelled),
        }
        .map_err(native_error)?;
        Ok(true)
    }
    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}
#[napi]
pub fn publish_metadata(
    stage: External<SharedStage>,
    mask: Option<u32>,
    cancellation: External<Cancellation>,
) -> AsyncTask<PublishTask> {
    AsyncTask::new(PublishTask {
        stage: Arc::clone(stage.as_ref()),
        mask,
        cancelled: Arc::clone(cancellation.as_ref()),
    })
}

pub struct ReleaseStageTask {
    stage: SharedStage,
}
impl Task for ReleaseStageTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<bool> {
        let state = self.stage.lock().map_err(|_| refusal())?.take();
        match state {
            Some(OwnedPreparedStage::Existing(mut state)) => {
                state.owned.cleanup().map_err(native_error)?
            }
            Some(OwnedPreparedStage::New(mut state)) => {
                state.owned.cleanup().map_err(native_error)?
            }
            None => (),
        }
        Ok(true)
    }
    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}
#[napi]
pub fn release_metadata_stage(stage: External<SharedStage>) -> AsyncTask<ReleaseStageTask> {
    AsyncTask::new(ReleaseStageTask {
        stage: Arc::clone(stage.as_ref()),
    })
}

pub struct ReleaseNewTask {
    prepared: SharedNew,
}
impl Task for ReleaseNewTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<bool> {
        self.prepared.lock().map_err(|_| refusal())?.take();
        Ok(true)
    }
    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}
#[napi]
pub fn release_new_metadata(prepared: External<SharedNew>) -> AsyncTask<ReleaseNewTask> {
    AsyncTask::new(ReleaseNewTask {
        prepared: Arc::clone(prepared.as_ref()),
    })
}

#[napi(object)]
pub struct RecoveryCounts {
    pub removed: u32,
    pub retained: u32,
}
pub struct RecoveryTask {
    home: PathBuf,
    cancelled: Cancellation,
}
impl Task for RecoveryTask {
    type Output = (u32, u32);
    type JsValue = RecoveryCounts;
    fn compute(&mut self) -> Result<Self::Output> {
        if !self.home.is_absolute() {
            return Err(refusal());
        }
        let counts =
            crate::stage_index::recover_with_cancel::<CurrentProfile>(&self.home, &self.cancelled)
                .map_err(native_error)?;
        Ok((
            u32::try_from(counts.removed).map_err(|_| refusal())?,
            u32::try_from(counts.retained).map_err(|_| refusal())?,
        ))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(RecoveryCounts {
            removed: output.0,
            retained: output.1,
        })
    }
}
/// Trusted-host operator recovery; it cannot publish or retry payloads.
#[napi]
pub fn recover_metadata_staging(
    home: String,
    cancellation: External<Cancellation>,
) -> AsyncTask<RecoveryTask> {
    AsyncTask::new(RecoveryTask {
        home: PathBuf::from(home),
        cancelled: Arc::clone(cancellation.as_ref()),
    })
}

pub struct RecheckNewTask {
    prepared: SharedNew,
    mask: Option<u32>,
}
impl Task for RecheckNewTask {
    type Output = bool;
    type JsValue = bool;
    fn compute(&mut self) -> Result<bool> {
        let guard = self.prepared.lock().map_err(|_| refusal())?;
        let state = guard.as_ref().ok_or_else(refusal)?;
        if CurrentProfile::identity(
            &CurrentProfile::open_parent(&state.parent_path).map_err(native_error)?,
        )
        .map_err(native_error)?
            != CurrentProfile::identity(&state.parent).map_err(native_error)?
        {
            return Err(native_error(crate::profile_api::NativeFailure::Changed));
        }
        CurrentProfile::recheck_parent(&state.parent_snapshot, &state.parent, self.mask)
            .map_err(native_error)?;
        Ok(true)
    }
    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}
#[napi]
pub fn recheck_new_metadata(
    prepared: External<SharedNew>,
    mask: Option<u32>,
) -> AsyncTask<RecheckNewTask> {
    AsyncTask::new(RecheckNewTask {
        prepared: Arc::clone(prepared.as_ref()),
        mask,
    })
}

#[cfg(test)]
mod producer_crash_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    struct TestChild(std::process::Child);
    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    #[ignore = "owned subprocess fixture run by native_producer_partial_crashes_recover"]
    fn crash_child() {
        let root =
            PathBuf::from(std::env::var_os("RELAVIUM_TEST_NATIVE_ROOT").expect("fixture root"));
        let is_new = std::env::var("RELAVIUM_TEST_NATIVE_NEW").expect("fixture case") == "1";
        let target = root.join("target");
        let home = root.join("home");
        #[cfg(target_os = "macos")]
        let mask = {
            let output = std::process::Command::new("/bin/sh")
                .args(["-c", "umask"])
                .output()
                .expect("fixture mask");
            Some(
                u32::from_str_radix(
                    std::str::from_utf8(&output.stdout)
                        .expect("mask text")
                        .trim(),
                    8,
                )
                .expect("mask"),
            )
        };
        #[cfg(not(target_os = "macos"))]
        let mask = None;
        let parent = CurrentProfile::open_parent(&root).expect("parent");
        let parent_snapshot =
            CurrentProfile::capture_parent(&parent, mask).expect("parent snapshot");
        let cancelled = AtomicBool::new(false);
        let after = vec![b'x'; 1024 * 1024];
        if is_new {
            let prepared = PreparedNew {
                parent,
                parent_path: root.clone(),
                parent_snapshot,
                target: "target".into(),
            };
            let _stage = stage_new(
                prepared,
                &home,
                &after,
                "00112233445566778899aabbccddeeff",
                mask,
                &cancelled,
            )
            .expect("stage new");
        } else {
            let source = open_source(&target).expect("source");
            let operation = WriteOperation::Replace;
            let snapshot = CurrentProfile::capture_existing(&source, &target, operation)
                .expect("source snapshot");
            let identity = CurrentProfile::identity(&source).expect("source identity");
            let prepared = PreparedSource {
                source,
                path: target,
                operation,
                snapshot,
                identity,
                parent,
                parent_path: root.clone(),
                parent_snapshot,
            };
            let _stage = stage_existing(
                prepared,
                &home,
                b"before",
                &after,
                "00112233445566778899aabbccddeeff",
                mask,
                &cancelled,
            )
            .expect("stage existing");
        }
        panic!("configured phase was not reached");
    }

    #[test]
    fn native_producer_partial_crashes_recover() {
        for (phase, is_new) in [
            ("partial-metadata", false),
            ("partial-payload", false),
            ("partial-payload", true),
        ] {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "relavium-native-cut-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&root).expect("fixture root");
            let home = root.join("home");
            drop(CurrentProfile::create_private_directory(&home).expect("private home"));
            let target = root.join("target");
            if !is_new {
                std::fs::write(&target, b"before").expect("fixture target");
            }
            #[cfg(target_os = "macos")]
            if phase == "partial-metadata" {
                use std::os::fd::AsRawFd;
                let source = File::open(&target).expect("source");
                let name = std::ffi::CString::new("com.apple.quarantine").expect("name");
                let value = b"0081;00000000;RelaviumProbe;";
                assert_eq!(
                    unsafe {
                        libc::fsetxattr(
                            source.as_raw_fd(),
                            name.as_ptr(),
                            value.as_ptr().cast(),
                            value.len(),
                            0,
                            0,
                        )
                    },
                    0
                );
            }
            #[cfg(target_os = "linux")]
            if phase == "partial-metadata" {
                use std::os::fd::AsRawFd;
                let source = File::open(&target).expect("source");
                let name = std::ffi::CString::new("user.relavium.fixture").expect("name");
                let value = b"synthetic";
                assert_eq!(
                    unsafe {
                        libc::fsetxattr(
                            source.as_raw_fd(),
                            name.as_ptr(),
                            value.as_ptr().cast(),
                            value.len(),
                            0,
                        )
                    },
                    0
                );
            }
            #[cfg(windows)]
            if phase == "partial-metadata" {
                std::fs::write(
                    root.join("target:Zone.Identifier"),
                    b"[ZoneTransfer]\r\nZoneId=3\r\n",
                )
                .expect("fixture zone");
            }
            let mut child = TestChild(
                std::process::Command::new(std::env::current_exe().expect("test executable"))
                    .args([
                        "--ignored",
                        "--exact",
                        "common::producer_crash_tests::crash_child",
                        "--nocapture",
                    ])
                    .env("RELAVIUM_TEST_NATIVE_ROOT", &root)
                    .env("RELAVIUM_TEST_NATIVE_NEW", if is_new { "1" } else { "0" })
                    .env("RELAVIUM_TEST_NATIVE_PHASE", phase)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .expect("fixture child"),
            );
            let pid = child.0.id();
            let stdout = child.0.stdout.take().expect("child stdout");
            let (send, receive) = mpsc::channel();
            let reader = std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line.contains("RELAVIUM_NATIVE_PHASE:") {
                        let _ = send.send(line);
                        break;
                    }
                }
            });
            let receipt = receive.recv_timeout(Duration::from_secs(15));
            if receipt.is_err() {
                let _ = child.0.kill();
                let _ = child.0.wait();
                let _ = reader.join();
                panic!("native phase did not arrive");
            }
            assert!(receipt
                .expect("phase")
                .contains(&format!("RELAVIUM_NATIVE_PHASE:{phase}:{pid}")));
            let stage = root.join(format!(
                ".relavium-fs-stage-v1.{pid}.00112233445566778899aabbccddeeff"
            ));
            let length = std::fs::metadata(stage.join("payload"))
                .expect("pinned payload")
                .len();
            if phase == "partial-payload" {
                assert_eq!(length, 512 * 1024);
            } else {
                assert_eq!(length, 0);
            }
            child.0.kill().expect("kill child");
            child.0.wait().expect("join child");
            reader.join().expect("join receipt reader");
            if is_new {
                assert!(!target.exists());
            } else {
                assert_eq!(std::fs::read(&target).expect("unchanged target"), b"before");
            }
            let recovered = crate::stage_index::recover::<CurrentProfile>(&home).expect("recovery");
            assert_eq!(recovered.removed, 1);
            assert!(!stage.exists());
            std::fs::remove_dir_all(root).expect("fixture cleanup");
        }
    }
}
