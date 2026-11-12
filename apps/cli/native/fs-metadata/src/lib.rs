//! CLI-private filesystem metadata adapter; platform acceptance remains gated.

// First-failure diagnostics are compiled only into native test binaries.
macro_rules! trace_failure {
    ($boundary:literal, $operation:expr) => {{
        #[cfg(test)]
        {
            crate::test_hooks::first_failure($boundary, $operation)
        }
        #[cfg(not(test))]
        {
            $operation
        }
    }};
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
#[allow(dead_code)]
mod common;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[allow(dead_code)]
mod profile_api;
#[allow(dead_code)]
mod stage_index;
#[cfg(unix)]
mod unix_private_guard;
#[cfg(unix)]
mod unix_template_guard;
#[cfg(windows)]
mod windows;

#[cfg(test)]
mod test_hooks {
    use std::io::Write;
    thread_local! { static FAILURE: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) }; }

    thread_local! {
        static FIRST_FAILURE: std::cell::Cell<Option<(&'static str, crate::profile_api::NativeFailure)>> = const { std::cell::Cell::new(None) };
    }
    pub(crate) fn remember_failure(
        boundary: &'static str,
        error: crate::profile_api::NativeFailure,
    ) {
        FIRST_FAILURE.with(|slot| {
            if slot.get().is_none() {
                slot.set(Some((boundary, error)));
            }
        });
    }
    pub(crate) fn first_failure<T>(
        boundary: &'static str,
        result: Result<T, crate::profile_api::NativeFailure>,
    ) -> Result<T, crate::profile_api::NativeFailure> {
        if let Err(error) = &result {
            remember_failure(boundary, *error);
        }
        result
    }
    #[test]
    fn first_failure_preserves_primary_and_evaluates_once() {
        use crate::profile_api::NativeFailure;
        FIRST_FAILURE.with(|slot| slot.set(None));
        let evaluations = std::cell::Cell::new(0);
        let success: Result<(), NativeFailure> = trace_failure!("first-source-recheck", {
            evaluations.set(evaluations.get() + 1);
            Ok(())
        });
        assert!(success.is_ok());
        assert_eq!(evaluations.get(), 1);
        assert_eq!(FIRST_FAILURE.with(|slot| slot.get()), None);
        // An unwrapped setup operation fails before a wrapped cleanup operation.
        let unwrapped_source: Result<(), NativeFailure> = Err(NativeFailure::Changed);
        if let Err(error) = unwrapped_source {
            remember_failure("first-setup", error);
            let _: Result<(), NativeFailure> =
                first_failure("first-lock-acquire", Err(NativeFailure::Unsupported));
        }
        assert_eq!(
            FIRST_FAILURE.with(|slot| slot.get()),
            Some(("first-setup", NativeFailure::Changed))
        );
        FIRST_FAILURE.with(|slot| slot.set(None));
        let _: Result<(), NativeFailure> =
            first_failure("first-pin-record-write", Err(NativeFailure::Changed));
        remember_failure("first-setup", NativeFailure::Unsupported);
        assert_eq!(
            FIRST_FAILURE.with(|slot| slot.get()),
            Some(("first-pin-record-write", NativeFailure::Changed))
        );
        FIRST_FAILURE.with(|slot| slot.set(None));
        remember_failure("first-reservation-finish", NativeFailure::Changed);
        let _: Result<(), NativeFailure> =
            first_failure("first-lock-acquire", Err(NativeFailure::Unsupported));
        assert_eq!(
            FIRST_FAILURE.with(|slot| slot.get()),
            Some(("first-reservation-finish", NativeFailure::Changed))
        );
        FIRST_FAILURE.with(|slot| slot.set(None));
    }
    pub(crate) fn observed_first_failure(
    ) -> Option<(&'static str, crate::profile_api::NativeFailure)> {
        FIRST_FAILURE.with(|slot| slot.get())
    }
    pub(crate) fn clear_first_failure() {
        FIRST_FAILURE.with(|slot| slot.set(None));
    }
    pub(crate) fn emit_first_failure(returned: crate::profile_api::NativeFailure) {
        use crate::profile_api::NativeFailure;
        let (boundary, class) = FIRST_FAILURE
            .with(|slot| slot.get())
            .unwrap_or(("first-unclassified", returned));
        checkpoint(boundary);
        checkpoint(match class {
            NativeFailure::Unsupported => "failure-unsupported",
            NativeFailure::AccessDenied => "failure-access-denied",
            NativeFailure::Changed => "failure-changed",
            NativeFailure::Cancelled => "failure-cancelled",
            NativeFailure::PossiblyPublished => "failure-possibly-published",
            NativeFailure::CleanupUncertain => "failure-cleanup-uncertain",
        });
    }

    pub(crate) fn inject_failure(phase: Option<&'static str>) {
        FAILURE.set(phase);
    }
    pub(crate) fn fail(phase: &str) -> bool {
        FAILURE.get() == Some(phase)
    }

    pub(crate) fn selected(phase: &str) -> bool {
        std::env::var("RELAVIUM_TEST_NATIVE_PHASE").ok().as_deref() == Some(phase)
    }

    pub(crate) fn checkpoint(code: &'static str) {
        if std::env::var_os("RELAVIUM_TEST_NATIVE_PHASE").is_some() {
            println!("RELAVIUM_NATIVE_CHECKPOINT:{code}");
            std::io::stdout().flush().expect("test checkpoint");
        }
    }

    pub(crate) fn hit(phase: &str) {
        if selected(phase) {
            println!("RELAVIUM_NATIVE_PHASE:{phase}:{}", std::process::id());
            std::io::stdout().flush().expect("test phase receipt");
            loop {
                std::thread::park();
            }
        }
    }
}

use napi_derive::napi;

/// Identifies the protocol without granting any filesystem operation.
#[napi]
pub fn protocol_version() -> u32 {
    1
}

/// Fixed platform capability; it does not capture or cache the creation mask.
#[napi]
pub fn requires_creation_mask_probe() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::macos::get_creation_mask().is_none()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_mechanism_tests {
    use crate::profile_api::{NativeFailure, Profile, WriteOperation};
    use std::ffi::CString;
    use std::fs::{self, File, OpenOptions};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.0.join("source"));
            let _ = fs::remove_file(self.0.join("destination"));
            let _ = fs::remove_dir(&self.0);
        }
    }

    fn fixture_mask() -> u32 {
        let output = Command::new("/bin/sh")
            .args(["-c", "umask"])
            .output()
            .expect("fixture mask");
        assert!(output.status.success());
        u32::from_str_radix(
            std::str::from_utf8(&output.stdout)
                .expect("mask text")
                .trim(),
            8,
        )
        .expect("octal mask")
    }

    fn attribute(file: &File, name: &CString) -> Vec<u8> {
        let mut value = vec![0_u8; 1024];
        // This test reads a bounded attribute from its own fresh fixture.
        let length = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert!(length >= 0);
        value.truncate(usize::try_from(length).expect("nonnegative attribute length"));
        value
    }

    #[test]
    fn macos_quarantine_copy_and_explicit_reapply() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-spike-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh test directory");
        let fixture = Fixture(directory);
        let create = |name: &str| {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(fixture.0.join(name))
                .expect("fresh test file")
        };
        let source = create("source");
        let destination = create("destination");
        let name = CString::new("com.apple.quarantine").expect("static name");
        let initial = b"0081;00000000;RelaviumProbe;";
        // Only synthetic fixture bytes cross this FFI boundary; no metadata is logged.
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    source.as_raw_fd(),
                    name.as_ptr(),
                    initial.as_ptr().cast(),
                    initial.len(),
                    0,
                    0,
                )
            },
            0
        );
        let captured = attribute(&source, &name);
        let custom_name = CString::new("com.relavium.fixture").expect("static name");
        let custom_value = b"synthetic-attribute";
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    source.as_raw_fd(),
                    custom_name.as_ptr(),
                    custom_value.as_ptr().cast(),
                    custom_value.len(),
                    0,
                    0,
                )
            },
            0
        );
        let custom_captured = attribute(&source, &custom_name);
        assert!(super::macos::copy_metadata_with_quarantine(
            source.as_raw_fd(),
            destination.as_raw_fd()
        )
        .is_ok());
        assert!(attribute(&destination, &name) == captured);
        assert!(attribute(&destination, &custom_name) == custom_captured);
    }

    #[test]
    fn macos_copyfile_preserves_fixture_deny_acl() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-acl-spike-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh test directory");
        let fixture = Fixture(directory);
        let source_path = fixture.0.join("source");
        let destination_path = fixture.0.join("destination");
        let source_fixture = File::create(&source_path).expect("fresh source");
        let quarantine = CString::new("com.apple.quarantine").expect("static name");
        let value = b"0081;00000000;RelaviumProbe;";
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    source_fixture.as_raw_fd(),
                    quarantine.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            },
            0
        );
        let quarantine_before = attribute(&source_fixture, &quarantine);
        drop(source_fixture);
        let destination = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&destination_path)
            .expect("fresh destination");
        // The external utility provisions only this synthetic fixture; it is not part of the addon.
        let output = Command::new("/bin/chmod")
            .arg("+a")
            .arg("everyone deny write,append")
            .arg(&source_path)
            .output()
            .expect("fixture ACL setup");
        assert!(output.status.success());
        assert!(OpenOptions::new().append(true).open(&source_path).is_err());
        let source = File::open(&source_path).expect("readable source");
        assert!(matches!(
            super::macos::MacosProfile::capture_existing(
                &source,
                &source_path,
                WriteOperation::Append
            ),
            Err(NativeFailure::AccessDenied)
        ));
        let original = super::macos::capture_explicit_acl(source.as_raw_fd()).expect("fixture ACL");
        assert!(super::macos::copy_explicit_acl_and_quarantine(
            source.as_raw_fd(),
            destination.as_raw_fd()
        )
        .is_ok());
        // Compare opaque native representations without printing metadata on failure.
        let source_after =
            super::macos::capture_explicit_acl(source.as_raw_fd()).expect("fixture ACL");
        let copied =
            super::macos::capture_explicit_acl(destination.as_raw_fd()).expect("fixture ACL");
        assert!(source_after == original && copied == original);
        assert!(attribute(&destination, &quarantine) == quarantine_before);
        assert!(OpenOptions::new()
            .append(true)
            .open(&destination_path)
            .is_err());
    }

    #[test]
    fn macos_explicit_acl_preparation_is_read_only_and_rechecks() {
        use std::io::Write;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-prepare-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh test directory");
        let fixture = Fixture(directory);
        let source_path = fixture.0.join("source");
        let mut output = File::create(&source_path).expect("fresh source");
        output.write_all(b"synthetic").expect("fixture bytes");
        drop(output);
        let status = Command::new("/bin/chmod")
            .arg("+a")
            .arg("everyone allow read")
            .arg(&source_path)
            .output()
            .expect("fixture ACL setup");
        assert!(status.status.success());
        let source = File::open(&source_path).expect("read source");
        let snapshot = super::macos::MacosProfile::capture_existing(
            &source,
            &source_path,
            WriteOperation::Replace,
        )
        .expect("capture");
        assert!(super::macos::MacosProfile::recheck_existing(
            &snapshot,
            &source,
            &source_path,
            WriteOperation::Replace
        )
        .is_ok());
        let stage_path = fixture.0.join("destination");
        let mut stage = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&stage_path)
            .expect("private empty stage");
        assert!(super::macos::MacosProfile::apply_and_verify_existing(
            &snapshot,
            &source,
            &stage,
            &stage_path,
        )
        .is_ok());
        stage.write_all(b"reviewed").expect("synthetic stage bytes");
        assert!(
            super::macos::MacosProfile::verify_existing_stage(&snapshot, &stage, &stage_path,)
                .is_ok()
        );
        assert!(fs::read(&source_path).expect("fixture bytes") == b"synthetic");
    }

    #[test]
    fn macos_no_acl_preparation_uses_volume_capability_evidence() {
        use std::io::Write;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-no-acl-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let status = Command::new("/bin/chmod")
            .arg("-N")
            .arg(&fixture.0)
            .output()
            .expect("clear fixture ACL");
        assert!(status.status.success());
        let source_path = fixture.0.join("source");
        let mut writer = File::create(&source_path).expect("fresh source");
        writer.write_all(b"ordinary").expect("synthetic source");
        let custom_name = CString::new("user.relavium.note").expect("static name");
        let custom = b"synthetic-note";
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    writer.as_raw_fd(),
                    custom_name.as_ptr(),
                    custom.as_ptr().cast(),
                    custom.len(),
                    0,
                    0,
                )
            },
            0
        );
        drop(writer);
        let source = File::open(&source_path).expect("source");
        assert!(matches!(
            super::macos::capture_acl(source.as_raw_fd()),
            Ok(None)
        ));
        let snapshot = super::macos::MacosProfile::capture_existing(
            &source,
            &source_path,
            WriteOperation::Replace,
        )
        .expect("capture no-ACL source");
        let stage_path = fixture.0.join("destination");
        let mut stage = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&stage_path)
            .expect("stage");
        assert!(super::macos::MacosProfile::apply_and_verify_existing(
            &snapshot,
            &source,
            &stage,
            &stage_path
        )
        .is_ok());
        stage.write_all(b"reviewed").expect("synthetic stage");
        assert!(
            super::macos::MacosProfile::verify_existing_stage(&snapshot, &stage, &stage_path)
                .is_ok()
        );
        assert!(attribute(&stage, &custom_name) == custom);
        assert!(fs::read(&source_path).expect("source bytes") == b"ordinary");
    }

    #[test]
    fn macos_private_stage_requires_owner_only_mode_and_no_acl() {
        use std::os::unix::fs::PermissionsExt;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-private-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh parent");
        let fixture = Fixture(directory);
        let stage_path = fixture.0.join("stage");
        let stage = super::macos::MacosProfile::create_private_directory(&stage_path)
            .expect("private stage");
        assert_eq!(
            unsafe { libc::fchflags(stage.as_raw_fd(), libc::UF_NODUMP | libc::UF_HIDDEN) },
            0
        );
        assert!(super::macos::MacosProfile::verify_private_directory(&stage_path, &stage).is_ok());
        assert_eq!(unsafe { libc::fchflags(stage.as_raw_fd(), 0) }, 0);
        let payload = super::macos::MacosProfile::create_private_file(
            &stage,
            std::ffi::OsStr::new("payload"),
        )
        .expect("private payload");
        assert!(super::macos::MacosProfile::verify_private_file(&payload).is_ok());
        fs::set_permissions(&stage_path, fs::Permissions::from_mode(0o755)).expect("fixture chmod");
        assert!(super::macos::MacosProfile::verify_private_directory(&stage_path, &stage).is_err());
        fs::set_permissions(&stage_path, fs::Permissions::from_mode(0o700)).expect("fixture chmod");
        let status = Command::new("/bin/chmod")
            .arg("+a")
            .arg("everyone allow read")
            .arg(&stage_path)
            .output()
            .expect("fixture ACL setup");
        assert!(status.status.success());
        assert!(super::macos::MacosProfile::verify_private_directory(&stage_path, &stage).is_err());
        drop(payload);
        fs::remove_file(stage_path.join("payload")).expect("remove fixture payload");
        drop(stage);
        fs::remove_dir(stage_path).expect("remove fixture stage");
    }

    #[test]
    fn macos_refuses_immutable_append_and_unknown_flags_before_publication() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-flags-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let path = fixture.0.join("source");
        fs::write(&path, b"unchanged").expect("fixture bytes");
        let source = File::open(&path).expect("source");
        for flag in [libc::UF_IMMUTABLE, libc::UF_APPEND, libc::UF_OPAQUE] {
            assert_eq!(unsafe { libc::fchflags(source.as_raw_fd(), flag) }, 0);
            let result = super::macos::MacosProfile::capture_existing(
                &source,
                &path,
                WriteOperation::Replace,
            );
            assert_eq!(unsafe { libc::fchflags(source.as_raw_fd(), 0) }, 0);
            assert!(matches!(result, Err(NativeFailure::Unsupported)));
            assert_eq!(fs::read(&path).expect("source remains"), b"unchanged");
        }
    }

    #[test]
    fn macos_refuses_unknown_attribute_namespace() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-attribute-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let path = fixture.0.join("source");
        fs::write(&path, b"unchanged").expect("fixture bytes");
        let source = File::open(&path).expect("source");
        let name = CString::new("com.relavium.unknown").expect("name");
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    source.as_raw_fd(),
                    name.as_ptr(),
                    b"synthetic".as_ptr().cast(),
                    9,
                    0,
                    0,
                )
            },
            0
        );
        assert!(matches!(
            super::macos::MacosProfile::capture_existing(&source, &path, WriteOperation::Replace),
            Err(NativeFailure::Unsupported)
        ));
        assert_eq!(fs::read(&path).expect("source remains"), b"unchanged");
    }

    #[test]
    fn macos_refuses_attribute_count_above_profile_limit() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-attr-limit-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let path = fixture.0.join("source");
        fs::write(&path, b"unchanged").expect("fixture bytes");
        let source = File::open(&path).expect("source");
        for index in 0..129 {
            let name = CString::new(format!("user.relavium.attribute.{index}")).expect("name");
            assert_eq!(
                unsafe {
                    libc::fsetxattr(
                        source.as_raw_fd(),
                        name.as_ptr(),
                        b"v".as_ptr().cast(),
                        1,
                        0,
                        0,
                    )
                },
                0
            );
        }
        assert!(matches!(
            super::macos::MacosProfile::capture_existing(&source, &path, WriteOperation::Replace),
            Err(NativeFailure::Unsupported)
        ));
        assert_eq!(fs::read(&path).expect("source remains"), b"unchanged");
    }

    #[test]
    fn macos_publication_checks_stage_identity_and_new_target_exclusivity() {
        use std::ffi::OsStr;
        use std::io::Write;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-publish-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let parent = super::macos::MacosProfile::open_parent(&fixture.0).expect("parent");
        let stage_path = fixture.0.join("stage");
        let stage_parent = super::macos::MacosProfile::create_private_directory(&stage_path)
            .expect("stage directory");
        let mut payload =
            super::macos::MacosProfile::create_private_file(&stage_parent, OsStr::new("payload"))
                .expect("payload");
        payload.write_all(b"reviewed").expect("payload bytes");
        fs::write(fixture.0.join("destination"), b"original").expect("target");
        assert!(matches!(
            super::macos::MacosProfile::publish_new(
                &payload,
                &stage_parent,
                OsStr::new("payload"),
                &parent,
                OsStr::new("destination")
            ),
            Err(NativeFailure::Changed)
        ));
        assert_eq!(
            fs::read(fixture.0.join("destination")).expect("unchanged"),
            b"original"
        );
        fs::hard_link(stage_path.join("payload"), fixture.0.join("source")).expect("alias");
        assert!(matches!(
            super::macos::MacosProfile::publish_existing(
                &payload,
                &stage_parent,
                OsStr::new("payload"),
                &parent,
                OsStr::new("destination")
            ),
            Err(NativeFailure::Changed)
        ));
        fs::remove_file(fixture.0.join("source")).expect("remove alias");
        super::macos::MacosProfile::publish_existing(
            &payload,
            &stage_parent,
            OsStr::new("payload"),
            &parent,
            OsStr::new("destination"),
        )
        .expect("publish");
        assert_eq!(
            fs::read(fixture.0.join("destination")).expect("published"),
            b"reviewed"
        );
        drop(stage_parent);
        fs::remove_dir(stage_path).expect("remove stage");
    }

    #[test]
    fn macos_private_stage_removes_inherited_acl_before_use() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-private-inherit-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh parent");
        let fixture = Fixture(directory);
        let output = Command::new("/bin/chmod")
            .arg("+a")
            .arg("everyone allow read,file_inherit,directory_inherit")
            .arg(&fixture.0)
            .output()
            .expect("ACL setup");
        assert!(output.status.success());
        let stage_path = fixture.0.join("stage");
        let stage = super::macos::MacosProfile::create_private_directory(&stage_path)
            .expect("private inherited stage");
        assert!(super::macos::MacosProfile::verify_private_directory(&stage_path, &stage).is_ok());
        drop(stage);
        fs::remove_dir(stage_path).expect("remove stage");
    }

    #[test]
    fn macos_parent_snapshot_detects_policy_only_change() {
        use std::os::unix::fs::PermissionsExt;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-parent-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let parent = super::macos::MacosProfile::open_parent(&fixture.0).expect("parent");
        let mask = fixture_mask();
        let snapshot = super::macos::MacosProfile::capture_parent(&parent, Some(mask))
            .expect("parent snapshot");
        assert!(super::macos::MacosProfile::recheck_parent(&snapshot, &parent, Some(mask)).is_ok());
        fs::set_permissions(&fixture.0, fs::Permissions::from_mode(0o755)).expect("fixture chmod");
        assert!(matches!(
            super::macos::MacosProfile::recheck_parent(&snapshot, &parent, Some(mask)),
            Err(NativeFailure::Changed)
        ));
    }

    #[test]
    fn macos_new_file_template_matches_direct_parent_creation() {
        use std::io::Write;
        use std::os::unix::fs::MetadataExt;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "relavium-native-create-{}-{nonce}",
            std::process::id()
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .expect("fresh directory");
        let fixture = Fixture(directory);
        let parent = super::macos::MacosProfile::open_parent(&fixture.0).expect("parent");
        let mask = fixture_mask();
        let snapshot = super::macos::MacosProfile::capture_parent(&parent, Some(mask))
            .expect("parent snapshot");
        let reference = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(fixture.0.join("source"))
            .expect("direct creation");
        let reference_info = reference.metadata().expect("direct metadata");
        let reference_acl = super::macos::capture_acl(reference.as_raw_fd()).expect("direct ACL");
        let stage_path = fixture.0.join("stage");
        let stage_dir = super::macos::MacosProfile::create_private_directory(&stage_path)
            .expect("stage directory");
        let mut file = super::macos::MacosProfile::create_inherited_empty(
            &parent,
            &snapshot,
            Some(mask),
            &stage_dir,
            std::ffi::OsStr::new(".relavium-fs-stage-v1.template"),
            std::ffi::OsStr::new("payload"),
            &mut |_| Ok(()),
        )
        .expect("inherited empty");
        let actual_info = file.metadata().expect("stage metadata");
        assert!(
            reference_info.mode() == actual_info.mode()
                && reference_info.gid() == actual_info.gid()
        );
        assert!(super::macos::capture_acl(file.as_raw_fd()).expect("stage ACL") == reference_acl);
        let inherited = super::macos::MacosProfile::capture_inherited_stage(
            &snapshot,
            &file,
            &stage_path.join("payload"),
        )
        .expect("inherited snapshot");
        file.write_all(b"synthetic").expect("synthetic payload");
        assert!(super::macos::MacosProfile::verify_inherited_stage(
            &inherited,
            &file,
            &stage_path.join("payload")
        )
        .is_ok());
        assert!(super::macos::MacosProfile::recheck_parent(&snapshot, &parent, Some(mask)).is_ok());
        drop(file);
        fs::remove_file(stage_path.join("payload")).expect("remove payload");
        drop(stage_dir);
        fs::remove_dir(stage_path).expect("remove stage");
    }
}
