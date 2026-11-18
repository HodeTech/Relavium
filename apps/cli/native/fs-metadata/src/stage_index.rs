//! Private, bounded artifact ownership inventory. This is never an effect journal.
use crate::profile_api::{NativeFailure, NativeIdentity, Profile};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const MAX_RECORDS: usize = 128;
/// How far a SCAN tolerates the nonce count past `MAX_RECORDS`. `reserve` still refuses to allocate at
/// `MAX_RECORDS`, but a producer pins without the allocation claim, so a directory listing can omit an
/// entry that was renamed while it ran and `reserve` can then allocate one past the bound. Without the
/// slack every later scan, recovery included, would fail closed at the first overshoot and nothing
/// supported could clear it; with it the overshoot is transient.
const SCAN_SLACK: usize = 8;
const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_SCAN_BYTES: usize = 2 * 1024 * 1024;
const PREFIX: &str = ".relavium-fs-stage-v1.";
const MAGIC_V1: &[u8; 8] = b"RVSTG001";
const MAGIC_V2: &[u8; 8] = b"RVSTG002";

fn refused<T>() -> Result<T, NativeFailure> {
    Err(NativeFailure::Changed)
}
fn io<T>(result: std::io::Result<T>) -> Result<T, NativeFailure> {
    result.map_err(|_| NativeFailure::Changed)
}
#[cfg(all(test, windows))]
pub(crate) fn rename_error_category(error: &std::io::Error) -> &'static str {
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND,
        ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_LOCK_VIOLATION, ERROR_NOT_SAME_DEVICE,
        ERROR_NOT_SUPPORTED, ERROR_PATH_NOT_FOUND, ERROR_PRIVILEGE_NOT_HELD,
        ERROR_SHARING_VIOLATION,
    };
    match error.raw_os_error().map(|value| value as u32) {
        Some(ERROR_ACCESS_DENIED) => "rename-access-denied",
        Some(ERROR_INVALID_PARAMETER) => "rename-invalid-parameter",
        Some(ERROR_NOT_SUPPORTED) => "rename-not-supported",
        Some(ERROR_INVALID_NAME) => "rename-invalid-name",
        Some(ERROR_NOT_SAME_DEVICE) => "rename-not-same-device",
        Some(ERROR_PRIVILEGE_NOT_HELD) => "rename-privilege-not-held",
        Some(ERROR_SHARING_VIOLATION) => "rename-sharing-violation",
        Some(ERROR_LOCK_VIOLATION) => "rename-lock-violation",
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) => "rename-source-missing",
        Some(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS) => "rename-destination-exists",
        _ => "rename-other",
    }
}
fn tick(start: Instant, cancelled: Option<&AtomicBool>) -> Result<(), NativeFailure> {
    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(NativeFailure::Cancelled);
    }
    if start.elapsed() > operation_budget() {
        refused()
    } else {
        Ok(())
    }
}
/// The cooperative budget of one native operation: two seconds. Tests shorten it so that the budget
/// origin of work done under a claim can be proven without waiting for two real seconds.
fn operation_budget() -> Duration {
    #[cfg(test)]
    {
        OPERATION_BUDGET.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        Duration::from_secs(2)
    }
}
fn valid_nonce(nonce: &str) -> bool {
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn record_name(name: &str) -> Option<&str> {
    let (nonce, suffix) = name.split_once('.')?;
    if valid_nonce(nonce) && matches!(suffix, "reserved" | "prepare" | "record") {
        Some(nonce)
    } else {
        None
    }
}
/// A recorded producer id is a positive `i32`, the range the liveness probe can represent.
fn valid_pid(pid: u32) -> bool {
    pid != 0 && pid <= i32::MAX as u32
}
/// The only locator a record may carry: an absolute, normalized stage path (no `.` or `..` component, no
/// repeated or trailing separator: written exactly as `Path::components` would write it back, the same
/// rule the TypeScript reader applies as `resolve(stage) === stage`) whose last name is exactly
/// `PREFIX{pid}.{nonce}`. `Record::encode` and `Record::decode` share it, so a record that can be written
/// can always be read back by either reader (a locator that encoded but could not decode would make every
/// later scan of the index fail closed). `Path::components` drops a `.` or an empty component in the
/// MIDDLE of a path without a trace, so the string comparison is what rejects those.
fn valid_locator(stage: &Path, pid: u32, nonce: &str) -> bool {
    stage.is_absolute()
        && stage.as_os_str() == stage.components().collect::<PathBuf>().as_os_str()
        && stage.file_name() == Some(OsStr::new(&format!("{PREFIX}{pid}.{nonce}")))
        && !stage
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecordVersion {
    V1,
    V2,
}

#[derive(Clone)]
struct Record {
    version: RecordVersion,
    pid: u32,
    nonce: String,
    owner: String,
    stage: PathBuf,
    parent: NativeIdentity,
    directory: NativeIdentity,
    payload: NativeIdentity,
}
impl Record {
    fn encode(&self) -> Result<Vec<u8>, NativeFailure> {
        let stage = self
            .stage
            .to_str()
            .ok_or(NativeFailure::Changed)?
            .as_bytes();
        let owner = self.owner.as_bytes();
        if owner.is_empty()
            || owner.len() > 184
            || stage.is_empty()
            || stage.len() > 4096
            || !valid_nonce(&self.nonce)
            || !valid_pid(self.pid)
            || !valid_locator(&self.stage, self.pid, &self.nonce)
        {
            return refused();
        }
        let mut out = Vec::with_capacity(176 + owner.len() + stage.len());
        let (magic, version) = match self.version {
            RecordVersion::V1 => (MAGIC_V1, 1),
            RecordVersion::V2 => (MAGIC_V2, 2),
        };
        out.extend_from_slice(magic);
        out.push(version);
        out.extend_from_slice(&[0; 7]);
        out.extend_from_slice(&self.pid.to_le_bytes());
        out.extend_from_slice(
            &u16::try_from(owner.len())
                .map_err(|_| NativeFailure::Changed)?
                .to_le_bytes(),
        );
        out.extend_from_slice(
            &u16::try_from(stage.len())
                .map_err(|_| NativeFailure::Changed)?
                .to_le_bytes(),
        );
        out.extend_from_slice(self.nonce.as_bytes());
        out.extend_from_slice(owner);
        out.extend_from_slice(stage);
        for id in [self.parent, self.directory, self.payload] {
            out.extend_from_slice(&id.volume.to_le_bytes());
            out.extend_from_slice(&id.object.to_le_bytes());
            out.extend_from_slice(&id.node_dev.to_le_bytes());
            out.extend_from_slice(&id.node_ino.to_le_bytes());
        }
        Ok(out)
    }
    fn decode(bytes: &[u8]) -> Result<Self, NativeFailure> {
        if bytes.len() < 176 || bytes[9..16] != [0; 7] {
            return refused();
        }
        let version = match (&bytes[..8], bytes[8]) {
            (b"RVSTG001", 1) => RecordVersion::V1,
            (b"RVSTG002", 2) => RecordVersion::V2,
            _ => return refused(),
        };
        let pid = u32::from_le_bytes(
            bytes[16..20]
                .try_into()
                .map_err(|_| NativeFailure::Changed)?,
        );
        let owner_len = usize::from(u16::from_le_bytes(
            bytes[20..22]
                .try_into()
                .map_err(|_| NativeFailure::Changed)?,
        ));
        let path_len = usize::from(u16::from_le_bytes(
            bytes[22..24]
                .try_into()
                .map_err(|_| NativeFailure::Changed)?,
        ));
        if !valid_pid(pid)
            || owner_len == 0
            || owner_len > 184
            || path_len == 0
            || path_len > 4096
            || bytes.len() != 176 + owner_len + path_len
        {
            return refused();
        }
        let text = |range| {
            std::str::from_utf8(&bytes[range])
                .map(str::to_owned)
                .map_err(|_| NativeFailure::Changed)
        };
        let nonce = text(24..56)?;
        let owner = text(56..56 + owner_len)?;
        let stage = PathBuf::from(text(56 + owner_len..56 + owner_len + path_len)?);
        if !valid_nonce(&nonce) || !valid_locator(&stage, pid, &nonce) {
            return refused();
        }
        let mut offset = 56 + owner_len + path_len;
        let mut identity = || -> Result<NativeIdentity, NativeFailure> {
            let id = NativeIdentity {
                volume: u64::from_le_bytes(
                    bytes[offset..offset + 8]
                        .try_into()
                        .map_err(|_| NativeFailure::Changed)?,
                ),
                object: u128::from_le_bytes(
                    bytes[offset + 8..offset + 24]
                        .try_into()
                        .map_err(|_| NativeFailure::Changed)?,
                ),
                node_dev: u64::from_le_bytes(
                    bytes[offset + 24..offset + 32]
                        .try_into()
                        .map_err(|_| NativeFailure::Changed)?,
                ),
                node_ino: u64::from_le_bytes(
                    bytes[offset + 32..offset + 40]
                        .try_into()
                        .map_err(|_| NativeFailure::Changed)?,
                ),
            };
            offset += 40;
            Ok(id)
        };
        Ok(Self {
            version,
            pid,
            nonce,
            owner,
            stage,
            parent: identity()?,
            directory: identity()?,
            payload: identity()?,
        })
    }
}

// The retired development index is evidence, never an input to this profile.
fn require_legacy_absent<P: Profile>(
    home: &Path,
    canonical: &Path,
    home_id: NativeIdentity,
    start: Instant,
    cancelled: Option<&AtomicBool>,
) -> Result<(), NativeFailure> {
    let parent_path = canonical.join(".relavium");
    let check_home = || -> Result<(), NativeFailure> {
        tick(start, cancelled)?;
        if io(fs::canonicalize(home))? != canonical
            || P::identity(&P::open_parent(canonical)?)? != home_id
        {
            return refused();
        }
        Ok(())
    };
    tick(start, cancelled)?;
    let parent = match fs::symlink_metadata(&parent_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            check_home()?;
            tick(start, cancelled)?;
            return match fs::symlink_metadata(&parent_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => check_home(),
                _ => refused(),
            };
        }
        Ok(info) if info.is_dir() && !info.file_type().is_symlink() => {
            P::open_parent(&parent_path)?
        }
        _ => return refused(),
    };
    let parent_id = P::identity(&parent)?;
    if io(fs::canonicalize(&parent_path))? != parent_path {
        return refused();
    }
    let old = parent_path.join("fs-staging-v1");
    for _ in 0..2 {
        tick(start, cancelled)?;
        match fs::symlink_metadata(&old) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Err(NativeFailure::LegacyRecoveryRequired),
            Err(_) => return refused(),
        }
        check_home()?;
        let current = io(fs::symlink_metadata(&parent_path))?;
        if !current.is_dir()
            || current.file_type().is_symlink()
            || io(fs::canonicalize(&parent_path))? != parent_path
            || P::identity(&P::open_parent(&parent_path)?)? != parent_id
        {
            return refused();
        }
    }
    Ok(())
}

struct Index<P: Profile> {
    context: Vec<u8>,
    requested_home: PathBuf,
    home_path: PathBuf,
    home: File,
    home_id: NativeIdentity,
    parent_path: PathBuf,
    parent: File,
    parent_id: NativeIdentity,
    path: PathBuf,
    directory: File,
    id: NativeIdentity,
    _profile: PhantomData<P>,
}
impl<P: Profile> Index<P> {
    fn open(home: &Path, create: bool) -> Result<Self, NativeFailure> {
        Self::open_checked(home, create, Instant::now(), None)
    }
    fn open_checked(
        home: &Path,
        create: bool,
        start: Instant,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Self, NativeFailure> {
        let context = P::operation_context()?;
        if !home.is_absolute() {
            return refused();
        }
        tick(start, cancelled)?;
        let home_path = io(fs::canonicalize(home))?;
        tick(start, cancelled)?;
        let home_file = P::open_parent(&home_path)?;
        tick(start, cancelled)?;
        let home_id = P::identity(&home_file)?;
        require_legacy_absent::<P>(home, &home_path, home_id, start, cancelled)?;
        let parent_path = home_path.join(".relavium-fs-private-v1");
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("index-parent-open");
        let parent = private_dir::<P>(&parent_path, create)?;
        tick(start, cancelled)?;
        let parent_id = P::identity(&parent)?;
        if create {
            tick(start, cancelled)?;
            #[cfg(test)]
            crate::test_hooks::checkpoint("index-home-flush");
            io(home_file.sync_all())?;
        }
        let path = parent_path.join("fs-staging-v1");
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("index-directory-open");
        let directory = private_dir::<P>(&path, create)?;
        tick(start, cancelled)?;
        let id = P::identity(&directory)?;
        if create {
            tick(start, cancelled)?;
            #[cfg(test)]
            crate::test_hooks::checkpoint("index-parent-flush");
            io(parent.sync_all())?;
            #[cfg(test)]
            crate::test_hooks::checkpoint("index-parent-flush-done");
        }
        let index = Self {
            context,
            requested_home: home.to_owned(),
            home_path,
            home: home_file,
            home_id,
            parent_path,
            parent,
            parent_id,
            path,
            directory,
            id,
            _profile: PhantomData,
        };
        #[cfg(test)]
        crate::test_hooks::checkpoint("index-first-recheck");
        index.recheck_checked(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("index-first-recheck-done");
        Ok(index)
    }
    fn ensure_context(&self) -> Result<(), NativeFailure> {
        if P::operation_context()? != self.context {
            return Err(NativeFailure::Changed);
        }
        Ok(())
    }
    fn recheck(&self) -> Result<(), NativeFailure> {
        self.recheck_checked(Instant::now(), None)
    }
    fn recheck_checked(
        &self,
        start: Instant,
        cancelled: Option<&AtomicBool>,
    ) -> Result<(), NativeFailure> {
        self.recheck_proof(Some((start, cancelled)))
    }
    fn recheck_proof(
        &self,
        checks: Option<(Instant, Option<&AtomicBool>)>,
    ) -> Result<(), NativeFailure> {
        let checkpoint = || match checks {
            Some((start, cancelled)) => tick(start, cancelled),
            None => Ok(()),
        };
        self.ensure_context()?;
        checkpoint()?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-home-path");
        if io(fs::canonicalize(&self.requested_home))? != self.home_path {
            return refused();
        }
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-held-identities");
        for (file, expected) in [
            (&self.home, self.home_id),
            (&self.parent, self.parent_id),
            (&self.directory, self.id),
        ] {
            checkpoint()?;
            if P::identity(file)? != expected {
                return refused();
            }
        }
        checkpoint()?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-home-reopen");
        let current_home = P::open_parent(&self.home_path)?;
        checkpoint()?;
        if P::identity(&current_home)? != self.home_id {
            return refused();
        }
        checkpoint()?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-parent-private");
        P::verify_private_directory(&self.parent_path, &self.parent)?;
        checkpoint()?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-index-private");
        P::verify_private_directory(&self.path, &self.directory)?;
        self.ensure_context()
    }
    fn entries(
        &self,
        start: Instant,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Vec<(String, String)>, NativeFailure> {
        let mut nonces = BTreeSet::new();
        let mut entries = Vec::new();
        let mut total = 0_u64;
        let mut count = 0;
        for entry in io(fs::read_dir(&self.path))? {
            tick(start, cancelled)?;
            count += 1;
            if count > MAX_RECORDS * 3 + 1 {
                return refused();
            }
            let entry = io(entry)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| NativeFailure::Changed)?;
            tick(start, cancelled)?;
            #[cfg(test)]
            ON_ENTRY.with(|hook| {
                if let Some(hook) = hook.borrow_mut().as_mut() {
                    hook(&name);
                }
            });
            let Some(file) = open_scanned(&name, &entry.path())? else {
                // A producer finished with this uncommitted entry between the listing and the open.
                note_vanished(&name, &mut nonces, &mut entries)?;
                continue;
            };
            #[cfg(test)]
            ON_OPENED.with(|hook| {
                if let Some(hook) = hook.borrow_mut().as_mut() {
                    hook(&name);
                }
            });
            tick(start, cancelled)?;
            let Some(size) = verified_entry_size::<P>(&name, &entry.path(), &file)? else {
                // Removed after the open: see `verified_entry_size`.
                note_vanished(&name, &mut nonces, &mut entries)?;
                continue;
            };
            total += size;
            if size > MAX_RECORD_BYTES as u64 || total > MAX_SCAN_BYTES as u64 {
                return refused();
            }
            if name == "inventory.lock" {
                if size != 0 {
                    return refused();
                }
                continue;
            }
            let nonce = record_name(&name).ok_or(NativeFailure::Changed)?.to_owned();
            if name.ends_with(".record") {
                tick(start, cancelled)?;
                let mut reader = io(file.try_clone())?;
                let mut bytes = Vec::new();
                io((&mut reader)
                    .take((MAX_RECORD_BYTES + 1) as u64)
                    .read_to_end(&mut bytes))?;
                let record = Record::decode(&bytes)?;
                if bytes.len() as u64 != size
                    || record.nonce != nonce
                    || record.owner != P::owner_identity()?
                {
                    return refused();
                }
            }
            if name.ends_with(".reserved") && size != 0 {
                return refused();
            }
            nonces.insert(nonce.clone());
            entries.push((name, nonce));
            if nonces.len() > MAX_RECORDS + SCAN_SLACK {
                return refused();
            }
        }
        self.recheck_checked(start, cancelled)?;
        Ok(entries)
    }
    /// The claim for a CLEANUP: it waits under a fresh budget, ignores cancellation (cleanup completion
    /// suppresses it) and is never refused for being beyond the waiter limit (it cannot be retried: a
    /// refused cleanup after a publication is an uncertain write, one before a pin leaks a slot).
    fn allocation_lock(&self) -> Result<AllocationClaim, NativeFailure> {
        self.allocation_claim(Instant::now(), None, false)
    }
    /// The claim for a reservation: it waits inside the operation's own deadline and cancellation flag,
    /// and a caller beyond the waiter limit gets only the short grace.
    fn allocation_lock_checked(
        &self,
        start: Instant,
        cancelled: Option<&AtomicBool>,
    ) -> Result<AllocationClaim, NativeFailure> {
        self.allocation_claim(start, cancelled, true)
    }
    fn allocation_claim(
        &self,
        start: Instant,
        cancelled: Option<&AtomicBool>,
        limited: bool,
    ) -> Result<AllocationClaim, NativeFailure> {
        tick(start, cancelled)?;
        let path = self.path.join("inventory.lock");
        #[cfg(test)]
        crate::test_hooks::checkpoint("lock-create");
        let file = match P::create_private_file(&self.directory, OsStr::new("inventory.lock")) {
            Ok(file) => {
                #[cfg(test)]
                crate::test_hooks::checkpoint("lock-file-flush");
                trace_failure!("first-lock-file-flush", io(file.sync_all()))?;
                #[cfg(test)]
                crate::test_hooks::checkpoint("lock-directory-flush");
                trace_failure!("first-lock-directory-flush", io(self.directory.sync_all()))?;
                file
            }
            Err(_) => {
                #[cfg(test)]
                crate::test_hooks::checkpoint("lock-existing-open");
                trace_failure!("first-lock-open", open_nofollow(&path))?
            }
        };
        #[cfg(test)]
        crate::test_hooks::checkpoint("lock-private-verify");
        trace_failure!("first-lock-verify", P::verify_private_file(&file))?;
        if io(file.metadata())?.len() != 0 {
            return refused();
        }
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("lock-acquire");
        // Wait out another writer, cleanup or recovery pass that holds the allocation claim (concurrent
        // processes on one operator home are supported), inside this operation's deadline and flag.
        let held_since = trace_failure!(
            "first-lock-acquire",
            lock_within(&file, start, cancelled, limited)
        )?;
        // The wait can outlast the lock file's name: another process may have unlinked and recreated it,
        // and a claim on the orphaned inode would split the exclusion domain.
        require_same_lock::<P>(&path, &file)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("lock-recheck");
        // Checked against a budget that starts once the claim is held: a wait that used up the
        // operation's budget must not turn a claim that was just obtained into a refusal here.
        trace_failure!(
            "first-lock-recheck",
            self.recheck_checked(held_since, cancelled)
        )?;
        #[cfg(test)]
        under_claim_hook();
        Ok(AllocationClaim {
            _file: file,
            held_since,
        })
    }
}
/// The held allocation claim (released when dropped). `held_since` is the instant it was acquired: work
/// done under the claim measures its own budget from there, never from before the wait for it.
struct AllocationClaim {
    _file: File,
    held_since: Instant,
}
/// The lock file the claim was taken on must still be the file the name points at.
fn require_same_lock<P: Profile>(path: &Path, held: &File) -> Result<(), NativeFailure> {
    if P::identity(&open_nofollow(path)?)? != P::identity(held)? {
        return refused();
    }
    Ok(())
}
fn private_dir<P: Profile>(path: &Path, create: bool) -> Result<File, NativeFailure> {
    let file = if create {
        match P::create_private_directory(path) {
            Ok(file) => file,
            Err(_) => P::open_parent(path)?,
        }
    } else {
        P::open_parent(path)?
    };
    P::verify_private_directory(path, &file)?;
    Ok(file)
}

struct MarkerClaim(File);
impl MarkerClaim {
    fn acquire(file: File) -> Result<Self, NativeFailure> {
        lock(&file).map_err(|_| NativeFailure::CleanupUncertain)?;
        Ok(Self(file))
    }
}

struct EphemeralArtifact {
    file: File,
    identity: NativeIdentity,
}
pub(crate) struct OwnedStage<P: Profile> {
    index: Index<P>,
    parent_path: PathBuf,
    parent_id: NativeIdentity,
    nonce: String,
    path: PathBuf,
    reservation: File,
    record: Option<Record>,
    pinned_file: Option<MarkerClaim>,
    pending_claim: Option<MarkerClaim>,
    adopted_directory: Option<EphemeralArtifact>,
    adopted_payload: Option<EphemeralArtifact>,
    pending_record: Option<Record>,
    pending_file: Option<EphemeralArtifact>,
}
impl<P: Profile> OwnedStage<P> {
    pub(crate) fn recheck_authority(&self) -> Result<(), NativeFailure> {
        self.index.recheck()
    }
    pub(crate) fn reserve(
        home: &Path,
        destination_parent: &File,
        parent_path: &Path,
        nonce: &str,
    ) -> Result<Self, NativeFailure> {
        Self::reserve_checked(home, destination_parent, parent_path, nonce, None)
    }
    pub(crate) fn reserve_with_cancel(
        home: &Path,
        destination_parent: &File,
        parent_path: &Path,
        nonce: &str,
        cancelled: &AtomicBool,
    ) -> Result<Self, NativeFailure> {
        Self::reserve_checked(
            home,
            destination_parent,
            parent_path,
            nonce,
            Some(cancelled),
        )
    }
    fn reserve_checked(
        home: &Path,
        destination_parent: &File,
        parent_path: &Path,
        nonce: &str,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Self, NativeFailure> {
        let start = Instant::now();
        tick(start, cancelled)?;
        if !valid_nonce(nonce) || !parent_path.is_absolute() {
            return refused();
        }
        let index = trace_failure!(
            "first-index-open",
            Index::<P>::open_checked(home, true, start, cancelled)
        )?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("reserve-lock");
        let claim = trace_failure!(
            "first-reserve-lock",
            index.allocation_lock_checked(start, cancelled)
        )?;
        // The wait ran inside the operation's deadline; the work under the claim measures its own budget
        // from the instant the claim was acquired, so a wait that used the deadline up cannot make a claim
        // that was just obtained fail on its first step.
        let start = claim.held_since;
        #[cfg(test)]
        crate::test_hooks::checkpoint("reserve-entries");
        let entries = trace_failure!("first-reserve-entries", index.entries(start, cancelled))?;
        let nonces: BTreeSet<_> = entries.iter().map(|(_, nonce)| nonce).collect();
        if nonces.len() >= MAX_RECORDS || nonces.iter().any(|entry| entry.as_str() == nonce) {
            return refused();
        }
        tick(start, cancelled)?;
        let parent_id = P::identity(destination_parent)?;
        tick(start, cancelled)?;
        if P::identity(&P::open_parent(parent_path)?)? != parent_id {
            return refused();
        }
        tick(start, cancelled)?;
        let reservation = trace_failure!(
            "first-reservation-create",
            P::create_private_file(&index.directory, OsStr::new(&format!("{nonce}.reserved")))
        )?;
        trace_failure!(
            "first-reservation-finish",
            finish_reservation::<P>(&index, &reservation, nonce, start, cancelled)
        )?;
        Ok(Self {
            index,
            parent_path: parent_path.to_owned(),
            parent_id,
            nonce: nonce.to_owned(),
            path: parent_path.join(format!("{PREFIX}{}.{nonce}", std::process::id())),
            reservation,
            record: None,
            pinned_file: None,
            pending_claim: None,
            adopted_directory: None,
            adopted_payload: None,
            pending_record: None,
            pending_file: None,
        })
    }
    pub(crate) fn stage_path(&self) -> &Path {
        &self.path
    }
    /// Ephemeral proof only: no crash-recovery authority is persisted here.
    pub(crate) fn adopt_directory(&mut self, directory: &File) -> Result<(), NativeFailure> {
        self.index.recheck()?;
        if P::identity(&P::open_parent(&self.parent_path)?)? != self.parent_id {
            return refused();
        }
        P::verify_private_directory(&self.path, directory)?;
        let identity = P::identity(directory)?;
        if self
            .adopted_directory
            .as_ref()
            .is_some_and(|old| old.identity != identity)
        {
            return refused();
        }
        self.adopted_directory = Some(EphemeralArtifact {
            file: io(directory.try_clone())?,
            identity,
        });
        Ok(())
    }
    /// Called immediately after exclusive empty creation, before metadata or payload.
    pub(crate) fn adopt_empty(
        &mut self,
        directory: &File,
        payload: &File,
    ) -> Result<(), NativeFailure> {
        self.adopt_directory(directory)?;
        P::verify_owned_file(payload)?;
        let identity = P::identity(payload)?;
        if io(payload.metadata())?.len() != 0
            || P::identity(&open_nofollow(&self.path.join("payload"))?)? != identity
            || self
                .adopted_payload
                .as_ref()
                .is_some_and(|old| old.identity != identity)
        {
            return refused();
        }
        self.adopted_payload = Some(EphemeralArtifact {
            file: io(payload.try_clone())?,
            identity,
        });
        Ok(())
    }
    pub(crate) fn pin_empty(
        &mut self,
        stage_dir: &File,
        payload: &File,
        stage_path: &Path,
    ) -> Result<(), NativeFailure> {
        self.pin_empty_checked(stage_dir, payload, stage_path, None)
    }
    pub(crate) fn pin_empty_with_cancel(
        &mut self,
        stage_dir: &File,
        payload: &File,
        stage_path: &Path,
        cancelled: &AtomicBool,
    ) -> Result<(), NativeFailure> {
        self.pin_empty_checked(stage_dir, payload, stage_path, Some(cancelled))
    }
    fn pin_empty_checked(
        &mut self,
        stage_dir: &File,
        payload: &File,
        stage_path: &Path,
        cancelled: Option<&AtomicBool>,
    ) -> Result<(), NativeFailure> {
        let start = Instant::now();
        tick(start, cancelled)?;
        if self.record.is_some() || stage_path != self.path || io(payload.metadata())?.len() != 0 {
            return refused();
        }
        trace_failure!(
            "first-pin-index",
            self.index.recheck_checked(start, cancelled)
        )?;
        tick(start, cancelled)?;
        trace_failure!(
            "first-pin-reservation",
            P::verify_private_file(&self.reservation)
        )?;
        tick(start, cancelled)?;
        let parent = P::open_parent(&self.parent_path)?;
        tick(start, cancelled)?;
        if P::identity(&parent)? != self.parent_id {
            return refused();
        }
        tick(start, cancelled)?;
        trace_failure!(
            "first-pin-directory",
            P::verify_private_directory(stage_path, stage_dir)
        )?;
        tick(start, cancelled)?;
        trace_failure!("first-pin-owned-payload", P::verify_owned_file(payload))?;
        let record = Record {
            version: RecordVersion::V2,
            pid: std::process::id(),
            nonce: self.nonce.clone(),
            owner: P::owner_identity()?,
            stage: self.path.clone(),
            parent: self.parent_id,
            directory: P::identity(stage_dir)?,
            payload: P::identity(payload)?,
        };
        tick(start, cancelled)?;
        if P::identity(&open_nofollow(&stage_path.join("payload"))?)? != record.payload {
            return refused();
        }
        tick(start, cancelled)?;
        self.pending_record = Some(record.clone());
        let pending_file = &mut self.pending_file;
        let file = trace_failure!(
            "first-pin-record-create",
            P::create_private_file_owned(
                &self.index.directory,
                OsStr::new(&format!("{}.prepare", self.nonce)),
                &mut |file| {
                    *pending_file = Some(EphemeralArtifact {
                        identity: P::identity(file)?,
                        file: io(file.try_clone())?,
                    });
                    Ok(())
                },
            )
        )?;
        self.pending_claim = Some(MarkerClaim::acquire(file)?);
        let file = &mut self
            .pending_claim
            .as_mut()
            .ok_or(NativeFailure::CleanupUncertain)?
            .0;
        #[cfg(test)]
        if crate::test_hooks::fail("private-marker-adopted") {
            return Err(NativeFailure::Unsupported);
        }
        tick(start, cancelled)?;
        trace_failure!(
            "first-pin-record-write",
            io(file.write_all(&record.encode()?))
        )?;
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("pin-record-flush");
        trace_failure!("first-pin-record-flush", io(file.sync_all()))?;
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("pin-payload-flush");
        trace_failure!("first-pin-payload-flush", io(payload.sync_all()))?;
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("pin-stage-flush");
        trace_failure!("first-pin-directory-flush", io(stage_dir.sync_all()))?;
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("pin-parent-flush");
        trace_failure!("first-pin-parent-flush", io(parent.sync_all()))?;
        trace_failure!(
            "first-pin-postflush-recheck",
            self.index.recheck_checked(start, cancelled)
        )?;
        trace_failure!("first-pin-postflush-budget", tick(start, cancelled))?;
        #[cfg(windows)]
        trace_failure!(
            "first-pin-rename",
            P::publish_new(
                &file,
                &self.index.directory,
                OsStr::new(&format!("{}.prepare", self.nonce)),
                &self.index.directory,
                OsStr::new(&format!("{}.record", self.nonce)),
            )
        )?;
        #[cfg(not(windows))]
        trace_failure!(
            "first-pin-rename",
            io(fs::rename(
                self.index.path.join(format!("{}.prepare", self.nonce)),
                self.index.path.join(format!("{}.record", self.nonce)),
            ))
        )?;
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("pin-index-flush");
        trace_failure!("first-pin-index-flush", io(self.index.directory.sync_all()))?;
        // A failed pin never grants permission to write payload. Preserve its evidence.
        self.record = Some(record);
        self.pinned_file = self.pending_claim.take();
        tick(start, cancelled)?;
        trace_failure!(
            "first-pin-context-before-remove",
            self.index.ensure_context()
        )?;
        trace_failure!(
            "first-pin-reservation-remove",
            self.remove_own_reservation()
        )?;
        trace_failure!(
            "first-pin-context-after-remove",
            self.index.ensure_context()
        )?;
        tick(start, cancelled)?;
        trace_failure!("first-pin-final-flush", io(self.index.directory.sync_all()))?;
        Ok(())
    }
    /// Remove this producer's own empty reservation, but only the exact file it created: the name
    /// alone is not authority. `cleanup` and `cleanup_empty_reservation` re-prove the same identity
    /// before they unlink; the pin must not be the one place that deletes whatever holds the name.
    fn remove_own_reservation(&self) -> Result<(), NativeFailure> {
        let path = self.index.path.join(format!("{}.reserved", self.nonce));
        let current = open_nofollow(&path)?;
        P::verify_private_file(&self.reservation)?;
        P::verify_private_file(&current)?;
        if P::identity(&current)? != P::identity(&self.reservation)?
            || io(current.metadata())?.len() != 0
        {
            return refused();
        }
        io(fs::remove_file(path))
    }
    pub(crate) fn cleanup(&mut self) -> Result<(), NativeFailure> {
        #[cfg(test)]
        if crate::test_hooks::fail("diagnostic-unwrapped-primary") {
            return trace_failure!("first-lock-acquire", Err(NativeFailure::Unsupported));
        }
        if self.record.is_none() {
            return self.cleanup_ephemeral();
        }
        let record = self.record.as_ref().ok_or(NativeFailure::Changed)?;
        let file = &self.pinned_file.as_ref().ok_or(NativeFailure::Changed)?.0;
        let claim = self.index.allocation_lock()?;
        // The producer retains its original claim; never relock it.
        // Cancellation after the pinned rename may leave our zero-byte reservation.
        // Remove it only while the pinned record still protects all artifact aliases.
        let reservation_path = self.index.path.join(format!("{}.reserved", self.nonce));
        match fs::symlink_metadata(&reservation_path) {
            Ok(_) => {
                let current = open_nofollow(&reservation_path)?;
                P::verify_private_file(&self.reservation)?;
                P::verify_private_file(&current)?;
                if P::identity(&current)? != P::identity(&self.reservation)?
                    || io(current.metadata())?.len() != 0
                {
                    return refused();
                }
                self.index.ensure_context()?;
                io(fs::remove_file(&reservation_path))?;
                self.index.ensure_context()?;
                io(self.index.directory.sync_all())?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return refused(),
        }
        cleanup_record::<P>(&self.index, record, file, claim.held_since, false, None)?;
        self.record = None;
        self.pinned_file = None;
        Ok(())
    }
    fn cleanup_ephemeral(&mut self) -> Result<(), NativeFailure> {
        // The claim is waited for under its own two-second budget; the destructive steps below are
        // checked against a budget that starts only once it is held, so a long wait cannot leave them
        // half done (payload removed, stage directory and reservation left behind).
        let claim = self.index.allocation_lock()?;
        let start = claim.held_since;
        self.index.recheck()?;
        let reservation_path = self.index.path.join(format!("{}.reserved", self.nonce));
        let reservation = open_nofollow(&reservation_path)?;
        P::verify_private_file(&reservation)?;
        P::verify_private_file(&self.reservation)?;
        if P::identity(&reservation)? != P::identity(&self.reservation)?
            || io(reservation.metadata())?.len() != 0
        {
            return refused();
        }
        if P::identity(&P::open_parent(&self.parent_path)?)? != self.parent_id {
            return refused();
        }
        let marker_paths = self.ephemeral_markers(start)?;
        self.cleanup_ephemeral_payload(start)?;
        self.cleanup_ephemeral_markers(start, marker_paths)?;
        let _current = self.cleanup_ephemeral_reservation(&reservation_path)?;
        self.adopted_directory = None;
        self.adopted_payload = None;
        self.pending_record = None;
        self.pending_file = None;
        self.pending_claim = None;
        Ok(())
    }
    fn ephemeral_markers(&self, start: Instant) -> Result<Vec<PathBuf>, NativeFailure> {
        let mut marker_paths = Vec::new();
        if let Some(pending) = &self.pending_file {
            P::verify_private_file(&pending.file)?;
            if self.pending_claim.is_none() {
                return Err(NativeFailure::CleanupUncertain);
            }
        }
        for suffix in ["prepare", "record"] {
            tick(start, None)?;
            let path = self.index.path.join(format!("{}.{suffix}", self.nonce));
            match fs::symlink_metadata(&path) {
                Ok(_) => {
                    let pending = self.pending_file.as_ref().ok_or(NativeFailure::Changed)?;
                    let mut current = open_nofollow(&path)?;
                    P::verify_private_file(&current)?;
                    if P::identity(&current)? != pending.identity
                        || P::identity(&pending.file)? != pending.identity
                    {
                        return refused();
                    }
                    if suffix == "record" {
                        let expected = self
                            .pending_record
                            .as_ref()
                            .ok_or(NativeFailure::Changed)?
                            .encode()?;
                        let mut bytes = Vec::new();
                        io((&mut current)
                            .take((MAX_RECORD_BYTES + 1) as u64)
                            .read_to_end(&mut bytes))?;
                        if bytes != expected {
                            return refused();
                        }
                    }
                    marker_paths.push(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return refused(),
            }
        }
        Ok(marker_paths)
    }
    fn cleanup_ephemeral_payload(&self, start: Instant) -> Result<(), NativeFailure> {
        if let Some(directory) = &self.adopted_directory {
            tick(start, None)?;
            P::verify_private_directory(&self.path, &directory.file)?;
            if P::identity(&directory.file)? != directory.identity {
                return refused();
            }
            let payload_path = self.ephemeral_payload_path(start)?;
            self.index.recheck()?;
            if P::identity(&P::open_parent(&self.parent_path)?)? != self.parent_id {
                return refused();
            }
            P::verify_private_directory(&self.path, &directory.file)?;
            if let Some(path) = payload_path {
                tick(start, None)?;
                let payload = self
                    .adopted_payload
                    .as_ref()
                    .ok_or(NativeFailure::Changed)?;
                let current = open_nofollow(&path)?;
                P::verify_owned_file(&current)?;
                if P::identity(&current)? != payload.identity || io(current.metadata())?.len() != 0
                {
                    return refused();
                }
                self.index.ensure_context()?;
                io(fs::remove_file(path))?;
                self.index.ensure_context()?;
                io(directory.file.sync_all())?;
            }
            tick(start, None)?;
            P::verify_private_directory(&self.path, &directory.file)?;
            self.index.ensure_context()?;
            io(fs::remove_dir(&self.path))?;
            self.index.ensure_context()?;
            io(P::open_parent(&self.parent_path)?.sync_all())?;
        } else {
            match fs::symlink_metadata(&self.path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return refused(),
            }
        }
        Ok(())
    }
    fn ephemeral_payload_path(&self, start: Instant) -> Result<Option<PathBuf>, NativeFailure> {
        let mut payload_path = None;
        let mut count = 0;
        for entry in io(fs::read_dir(&self.path))? {
            tick(start, None)?;
            count += 1;
            if count > 8 {
                return refused();
            }
            let entry = io(entry)?;
            let payload = self
                .adopted_payload
                .as_ref()
                .ok_or(NativeFailure::Changed)?;
            if entry.file_name() != "payload" {
                return refused();
            }
            let current = open_nofollow(&entry.path())?;
            P::verify_owned_file(&current)?;
            P::verify_owned_file(&payload.file)?;
            if P::identity(&current)? != payload.identity
                || P::identity(&payload.file)? != payload.identity
                || io(current.metadata())?.len() != 0
                || io(payload.file.metadata())?.len() != 0
            {
                return refused();
            }
            payload_path = Some(entry.path());
        }
        if self.adopted_payload.is_some() && payload_path.is_none() {
            return refused();
        }
        Ok(payload_path)
    }
    fn cleanup_ephemeral_markers(
        &self,
        start: Instant,
        marker_paths: Vec<PathBuf>,
    ) -> Result<(), NativeFailure> {
        self.index.recheck()?;
        for path in marker_paths {
            tick(start, None)?;
            let pending = self.pending_file.as_ref().ok_or(NativeFailure::Changed)?;
            let current = open_nofollow(&path)?;
            P::verify_private_file(&current)?;
            if P::identity(&current)? != pending.identity {
                return refused();
            }
            self.index.ensure_context()?;
            io(fs::remove_file(path))?;
            self.index.ensure_context()?;
        }
        Ok(())
    }
    fn cleanup_ephemeral_reservation(
        &self,
        reservation_path: &Path,
    ) -> Result<File, NativeFailure> {
        let current = open_nofollow(&reservation_path)?;
        P::verify_private_file(&current)?;
        if P::identity(&current)? != P::identity(&self.reservation)?
            || io(current.metadata())?.len() != 0
        {
            return refused();
        }
        self.index.ensure_context()?;
        io(fs::remove_file(reservation_path))?;
        self.index.ensure_context()?;
        io(self.index.directory.sync_all())?;
        Ok(current)
    }
}

fn finish_reservation<P: Profile>(
    index: &Index<P>,
    reservation: &File,
    nonce: &str,
    start: Instant,
    cancelled: Option<&AtomicBool>,
) -> Result<(), NativeFailure> {
    // The caller cannot clean up until reserve returns an owned value. Keep
    // this exact newly-created marker guarded through cancellation/flush failure.
    let finish = (|| {
        tick(start, cancelled)?;
        io(reservation.sync_all())?;
        tick(start, cancelled)?;
        io(index.directory.sync_all())?;
        index.recheck_checked(start, cancelled)
    })();
    if let Err(failure) = finish {
        #[cfg(test)]
        crate::test_hooks::remember_failure("first-reservation-finish", failure);
        // The allocation claim remains held. Cleanup ignores cancellation but
        // preserves evidence if its identity/private-authority checks fail.
        let cleanup = cleanup_empty_reservation::<P>(index, reservation, nonce);
        return Err(if cleanup.is_err() {
            failure.with_cleanup(true)
        } else {
            failure
        });
    }
    Ok(())
}

fn cleanup_empty_reservation<P: Profile>(
    index: &Index<P>,
    reservation: &File,
    nonce: &str,
) -> Result<(), NativeFailure> {
    #[cfg(test)]
    if crate::test_hooks::fail("reservation-cleanup-failure") {
        return refused();
    }
    index.recheck()?;
    P::verify_private_file(reservation)?;
    let path = index.path.join(format!("{nonce}.reserved"));
    let current = open_nofollow(&path)?;
    P::verify_private_file(&current)?;
    if P::identity(&current)? != P::identity(reservation)?
        || io(current.metadata())?.len() != 0
        || io(reservation.metadata())?.len() != 0
    {
        return refused();
    }
    index.ensure_context()?;
    io(fs::remove_file(path))?;
    index.ensure_context()?;
    io(index.directory.sync_all())
}

#[derive(Default)]
pub(crate) struct RecoverySummary {
    pub(crate) removed: usize,
    pub(crate) retained: usize,
}
pub(crate) fn recover<P: Profile>(home: &Path) -> Result<RecoverySummary, NativeFailure> {
    recover_with_cancel::<P>(home, &AtomicBool::new(false))
}
pub(crate) fn recover_with_cancel<P: Profile>(
    home: &Path,
    cancelled: &AtomicBool,
) -> Result<RecoverySummary, NativeFailure> {
    let cancelled = Some(cancelled);
    let start = Instant::now();
    tick(start, cancelled)?;
    let Some(index) = open_existing_index::<P>(home, start, cancelled)? else {
        return Ok(RecoverySummary::default());
    };
    tick(start, cancelled)?;
    let lock_path = index.path.join("inventory.lock");
    let allocation = match fs::symlink_metadata(&lock_path) {
        Ok(_) => open_nofollow(&lock_path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A crash during hierarchy setup may leave an empty index. Recovery
            // never creates its lock, and nonempty evidence without it is unsafe.
            if index.entries(start, cancelled)?.is_empty() {
                return Ok(RecoverySummary::default());
            }
            return refused();
        }
        Err(_) => return refused(),
    };
    P::verify_private_file(&allocation)?;
    if io(allocation.metadata())?.len() != 0 {
        return refused();
    }
    tick(start, cancelled)?;
    // A recovery pass queues behind a writer's short allocation instead of failing the whole pass.
    let start = lock_within(&allocation, start, cancelled, true)?;
    require_same_lock::<P>(&lock_path, &allocation)?;
    #[cfg(test)]
    under_claim_hook();
    index.recheck_checked(start, cancelled)?;
    let entries = index.entries(start, cancelled)?;
    let mut summary = RecoverySummary::default();
    for (name, nonce) in entries {
        tick(start, cancelled)?;
        if !name.ends_with(".record") {
            summary.retained += 1;
            continue;
        }
        tick(start, cancelled)?;
        let mut file = open_nofollow(&index.path.join(&name))?;
        if lock(&file).is_err() {
            summary.retained += 1;
            continue;
        }
        tick(start, cancelled)?;
        P::verify_private_file(&file)?;
        let mut bytes = Vec::new();
        tick(start, cancelled)?;
        io((&mut file)
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes))?;
        let record = match Record::decode(&bytes) {
            Ok(record) => record,
            Err(_) => {
                summary.retained += 1;
                continue;
            }
        };
        if record.version != RecordVersion::V2
            || record.nonce != nonce
            || record.owner != P::owner_identity()?
            || !producer_dead(record.pid)
        {
            summary.retained += 1;
            continue;
        }
        tick(start, cancelled)?;
        match cleanup_record::<P>(&index, &record, &file, start, true, cancelled) {
            Ok(()) => summary.removed += 1,
            Err(NativeFailure::CleanupUncertain) => return Err(NativeFailure::CleanupUncertain),
            Err(_) => summary.retained += 1,
        }
    }
    Ok(summary)
}
/// Missing recovery state is a read-only result, never an invitation to create
/// directories under an operator's current (possibly restrictive) creation mask.
fn open_existing_index<P: Profile>(
    home: &Path,
    start: Instant,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<Index<P>>, NativeFailure> {
    let context = P::operation_context()?;
    if !home.is_absolute() {
        return refused();
    }
    tick(start, cancelled)?;
    let canonical = io(fs::canonicalize(home))?;
    tick(start, cancelled)?;
    let home_handle = P::open_parent(&canonical)?;
    let home_id = P::identity(&home_handle)?;
    require_legacy_absent::<P>(home, &canonical, home_id, start, cancelled)?;
    let recheck_home = || -> Result<(), NativeFailure> {
        tick(start, cancelled)?;
        if P::operation_context()? != context {
            return Err(NativeFailure::Changed);
        }
        if io(fs::canonicalize(home))? != canonical
            || P::identity(&P::open_parent(&canonical)?)? != home_id
        {
            return refused();
        }
        Ok(())
    };
    let parent_path = canonical.join(".relavium-fs-private-v1");
    tick(start, cancelled)?;
    match fs::symlink_metadata(&parent_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            recheck_home()?;
            return Ok(None);
        }
        Err(_) => return refused(),
        Ok(_) => {}
    }
    tick(start, cancelled)?;
    let parent = P::open_parent(&parent_path)?;
    P::verify_private_directory(&parent_path, &parent)?;
    let parent_id = P::identity(&parent)?;
    let path = parent_path.join("fs-staging-v1");
    tick(start, cancelled)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            recheck_home()?;
            P::verify_private_directory(&parent_path, &parent)?;
            if P::identity(&parent)? != parent_id {
                return refused();
            }
            return Ok(None);
        }
        Err(_) => return refused(),
        Ok(_) => {}
    }
    let index = Index::<P>::open_checked(home, false, start, cancelled)?;
    if index.context != context || index.home_id != home_id || index.parent_id != parent_id {
        return refused();
    }
    Ok(Some(index))
}

fn cleanup_record<P: Profile>(
    index: &Index<P>,
    record: &Record,
    marker: &File,
    start: Instant,
    orphan: bool,
    cancelled: Option<&AtomicBool>,
) -> Result<(), NativeFailure> {
    tick(start, cancelled)?;
    index.recheck_checked(start, cancelled)?;
    tick(start, cancelled)?;
    P::verify_private_file(marker)?;
    let marker_path = index.path.join(format!("{}.record", record.nonce));
    if P::identity(marker)? != P::identity(&open_nofollow(&marker_path)?)? {
        return refused();
    }
    let mut marker_bytes = Vec::new();
    tick(start, cancelled)?;
    let mut marker_reader = io(marker.try_clone())?;
    tick(start, cancelled)?;
    io(marker_reader.seek(SeekFrom::Start(0)))?;
    tick(start, cancelled)?;
    io(marker_reader
        .take((MAX_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut marker_bytes))?;
    if marker_bytes != record.encode()? {
        return refused();
    }
    let parent_path = record.stage.parent().ok_or(NativeFailure::Changed)?;
    tick(start, cancelled)?;
    let parent = P::open_parent(parent_path)?;
    if P::identity(&parent)? != record.parent {
        return refused();
    }
    tick(start, cancelled)?;
    let stage = P::open_parent(&record.stage)?;
    tick(start, cancelled)?;
    P::verify_private_directory(&record.stage, &stage)?;
    if P::identity(&stage)? != record.directory {
        return refused();
    }
    let mut payload = None;
    let mut count = 0;
    for entry in io(fs::read_dir(&record.stage))? {
        tick(start, cancelled)?;
        count += 1;
        if count > 8 {
            return refused();
        }
        let entry = io(entry)?;
        if entry.file_name() != "payload" {
            return refused();
        }
        tick(start, cancelled)?;
        let file = open_nofollow(&entry.path())?;
        tick(start, cancelled)?;
        P::verify_owned_file(&file)?;
        if P::identity(&file)? != record.payload {
            return refused();
        }
        payload = Some(file);
    }
    tick(start, cancelled)?;
    index.recheck_checked(start, cancelled)?;
    if orphan && !producer_dead(record.pid) {
        return refused();
    }
    if P::identity(&P::open_parent(parent_path)?)? != record.parent {
        return refused();
    }
    tick(start, cancelled)?;
    P::verify_private_directory(&record.stage, &stage)?;
    if let Some(file) = payload {
        let path = record.stage.join("payload");
        tick(start, cancelled)?;
        let current = open_nofollow(&path)?;
        tick(start, cancelled)?;
        P::verify_owned_file(&file)?;
        tick(start, cancelled)?;
        P::verify_owned_file(&current)?;
        if P::identity(&current)? != record.payload {
            return refused();
        }
        tick(start, cancelled)?;
        index.ensure_context()?;
        io(fs::remove_file(path))?;
        index.ensure_context()?;
        tick(start, cancelled)?;
        io(stage.sync_all())?;
    }
    tick(start, cancelled)?;
    P::verify_private_directory(&record.stage, &stage)?;
    tick(start, cancelled)?;
    index.ensure_context()?;
    io(fs::remove_dir(&record.stage))?;
    #[cfg(test)]
    if crate::test_hooks::fail("completion-cancel-after-rmdir") {
        if let Some(signal) = cancelled {
            signal.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[cfg(test)]
    if crate::test_hooks::fail("completion-deadline-after-rmdir") {
        std::thread::sleep(Duration::from_millis(2100));
    }
    // After rmdir, finish only the fixed proof and durability sequence. Every
    // failure is uncertain, including a failure after the marker was removed.
    (|| {
        index.ensure_context()?;
        #[cfg(test)]
        if crate::test_hooks::fail("completion-parent-flush") {
            return refused();
        }
        io(parent.sync_all())?;
        index.recheck_proof(None)?;
        if P::identity(marker)? != P::identity(&open_nofollow(&marker_path)?)? {
            return refused();
        }
        index.ensure_context()?;
        io(fs::remove_file(marker_path))?;
        index.ensure_context()?;
        #[cfg(test)]
        if crate::test_hooks::fail("completion-index-flush") {
            return refused();
        }
        io(index.directory.sync_all())
    })()
    .map_err(|_| NativeFailure::CleanupUncertain)
}
#[cfg(unix)]
fn open_nofollow_raw(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}
#[cfg(windows)]
fn open_nofollow_raw(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}
fn open_nofollow(path: &Path) -> Result<File, NativeFailure> {
    io(open_nofollow_raw(path))
}
/// An entry that may legitimately disappear while the index is scanned: a producer's `.prepare`
/// is renamed to `.record` and its `.reserved` removed WITHOUT the allocation claim, so the scan can
/// list them and then find them gone. A committed `.record` and the lock file are only ever removed
/// by a holder of the allocation claim, which the scanner also holds, so those never vanish.
fn may_vanish_during_scan(name: &str) -> bool {
    record_name(name).is_some() && (name.ends_with(".reserved") || name.ends_with(".prepare"))
}
/// Open one inventory entry for the scan. `None` means an uncommitted entry that is gone (skip it,
/// as the TypeScript reader does: a point-in-time scan cannot be exact for an uncommitted artifact);
/// every other failure, and the absence of any other entry, is a changed index and stays fatal.
fn open_scanned(name: &str, path: &Path) -> Result<Option<File>, NativeFailure> {
    match open_nofollow_raw(path) {
        Ok(file) => Ok(Some(file)),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound && may_vanish_during_scan(name) =>
        {
            Ok(None)
        }
        Err(_) => refused(),
    }
}
/// A skipped (vanished) uncommitted entry still counts toward the nonce bound and is listed: a producer
/// that pins without the allocation claim has usually just turned it into a `.record` that the listing
/// never reached, so leaving it out would let `reserve` allocate past the bound. A recovery pass
/// reports it as retained, which is what an entry that is mid-promotion is.
fn note_vanished(
    name: &str,
    nonces: &mut BTreeSet<String>,
    entries: &mut Vec<(String, String)>,
) -> Result<(), NativeFailure> {
    // Only an uncommitted entry can have vanished; anything else reaching here is a changed index.
    if !may_vanish_during_scan(name) {
        return refused();
    }
    let nonce = record_name(name).ok_or(NativeFailure::Changed)?.to_owned();
    nonces.insert(nonce.clone());
    entries.push((name.to_owned(), nonce));
    if nonces.len() > MAX_RECORDS + SCAN_SLACK {
        return refused();
    }
    Ok(())
}
fn is_absent(path: &Path) -> bool {
    matches!(
        fs::symlink_metadata(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    )
}
/// Verify one opened inventory entry and return its size. `None` means an uncommitted entry that was
/// removed AFTER it was opened: the producer unlinked the very file the scan holds, so its link count
/// reads zero and the private-file check refuses it. Skip it like one that was already gone. The
/// refusal only counts as a vanished entry when the name is really absent now; a file that is still
/// there and fails the check is a changed index and stays fatal.
fn verified_entry_size<P: Profile>(
    name: &str,
    path: &Path,
    file: &File,
) -> Result<Option<u64>, NativeFailure> {
    let verified =
        P::verify_private_file(file).and_then(|()| io(file.metadata()).map(|info| info.len()));
    match verified {
        Ok(size) => Ok(Some(size)),
        Err(_) if may_vanish_during_scan(name) && is_absent(path) => Ok(None),
        Err(error) => Err(error),
    }
}
/// Result of one nonblocking claim attempt. Only `Contended` (another handle holds the claim, or the
/// attempt was interrupted) can ever be waited out; every other failure is returned as an error.
enum Claim {
    Held,
    Contended,
}
/// Classify a failed claim attempt from its OS error code. Contention is "somebody else holds it":
/// `EWOULDBLOCK`/`EAGAIN` (and a signal-interrupted attempt) for `flock`, `ERROR_LOCK_VIOLATION`
/// for `LockFile`. A bad descriptor, a lock table that is full or any other code is a real failure
/// that retrying cannot fix, so it must never be mistaken for a holder that will go away.
fn claim_outcome(raw_os_error: Option<i32>) -> Result<Claim, NativeFailure> {
    #[cfg(unix)]
    let contended = matches!(
        raw_os_error,
        Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN || code == libc::EINTR
    );
    #[cfg(windows)]
    let contended = matches!(
        raw_os_error,
        Some(code) if code as u32 == windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION
    );
    if contended {
        Ok(Claim::Contended)
    } else {
        refused()
    }
}
#[cfg(unix)]
fn try_lock(file: &File) -> Result<Claim, NativeFailure> {
    use std::os::fd::AsRawFd;
    // Nonblocking, descriptor-bound kernel claim; process death releases it.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Claim::Held);
    }
    claim_outcome(std::io::Error::last_os_error().raw_os_error())
}
#[cfg(windows)]
fn try_lock(file: &File) -> Result<Claim, NativeFailure> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::LockFile;
    // LockFile is nonblocking. The kernel releases this exclusive claim on handle close/death.
    if unsafe {
        LockFile(
            file.as_raw_handle().cast(),
            (MAX_RECORD_BYTES + 1) as u32,
            0,
            1,
            0,
        )
    } != 0
    {
        return Ok(Claim::Held);
    }
    claim_outcome(std::io::Error::last_os_error().raw_os_error())
}
/// One attempt, no waiting. A held claim is a refusal: the per-record claim in `recover` and the
/// producer's own marker claim mean "a live producer owns this", never "try again".
fn lock(file: &File) -> Result<(), NativeFailure> {
    match try_lock(file)? {
        Claim::Held => Ok(()),
        Claim::Contended => refused(),
    }
}
/// How long to sleep between attempts while another process holds the allocation claim. A writer's or a
/// cleanup's critical section is a few synchronous flushes (a recovery pass holds the claim for a whole
/// scan, up to its own deadline), so a short poll keeps a waiter from being noticeably delayed; the
/// operation's own two-second deadline bounds the whole wait.
const CLAIM_POLL: Duration = Duration::from_millis(2);
/// Wait for a claim another handle holds, inside the operation's own deadline and cancellation
/// flag. Used only for the allocation claim (`inventory.lock`), whose holders always release when their
/// native call returns, so concurrent writers, cleanups and a recovery pass queue instead of failing the
/// write; the wait is bounded by the holder's call (a recovery scan can take up to its own deadline) and,
/// at the latest, by this operation's deadline. Cleanup after a publication and pre-pin cleanup call it
/// with a fresh deadline and no cancellation flag on purpose: cleanup completion suppresses cancellation.
/// Not for the per-record claim: a writer holds its record claim while it waits for the allocation
/// claim and `recover` holds the allocation claim while it tries a record claim, so waiting on both
/// would make a wait cycle.
fn lock_within(
    file: &File,
    start: Instant,
    cancelled: Option<&AtomicBool>,
    limited: bool,
) -> Result<Instant, NativeFailure> {
    let mut waiter = None;
    let mut grace_until = None;
    loop {
        match try_lock(file)? {
            Claim::Held => return Ok(Instant::now()),
            Claim::Contended => {
                // Cancellation and the deadline come first, so a cancelled caller is `cancelled` and not
                // `changed` whatever the waiter limit says.
                tick(start, cancelled)?;
                if waiter.is_none() {
                    // A cleanup always waits (and still counts toward the limit for the others).
                    waiter = if limited {
                        ClaimWaiter::enter()
                    } else {
                        Some(ClaimWaiter::enter_always())
                    };
                }
                if waiter.is_none() {
                    // Over the process-wide limit: only a short grace, so a holder that is merely busy
                    // (the usual case) still lets this caller through while a stuck one cannot park the
                    // whole worker pool. Past the grace this is the single-attempt refusal of old.
                    let until =
                        *grace_until.get_or_insert_with(|| Instant::now() + OVER_LIMIT_GRACE);
                    if Instant::now() >= until {
                        return refused();
                    }
                }
                #[cfg(test)]
                ON_CONTENDED.with(|hook| {
                    if let Some(hook) = hook.borrow_mut().as_mut() {
                        hook();
                    }
                });
                // They are checked between attempts, so a waiter leaves within one poll of either.
                std::thread::sleep(CLAIM_POLL);
            }
        }
    }
}
/// The size of Node's worker pool, read the way libuv reads it (`pool_size_from`). Every native call
/// runs on that pool, which also serves `fs`, `dns` and `crypto`.
fn worker_pool_size() -> usize {
    static SIZE: OnceLock<usize> = OnceLock::new();
    *SIZE.get_or_init(|| pool_size_from(std::env::var("UV_THREADPOOL_SIZE").ok().as_deref()))
}
/// libuv's rule for `UV_THREADPOOL_SIZE`: `atoi` (leading white space, an optional sign, then digits; a
/// value with nothing numeric is 0), 0 becomes 1, a negative value wraps to a huge unsigned number, and
/// anything above 1,024 is 1,024; unset is four.
fn pool_size_from(value: Option<&str>) -> usize {
    let Some(text) = value else {
        return 4;
    };
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let mut parsed = 0_u64;
    for byte in digits.bytes().take_while(u8::is_ascii_digit) {
        parsed = parsed
            .saturating_mul(10)
            .saturating_add(u64::from(byte - b'0'));
    }
    if negative && parsed != 0 {
        return 1024;
    }
    usize::try_from(parsed).unwrap_or(1024).clamp(1, 1024)
}
/// Threads that may be parked waiting for the allocation claim at once, process-wide: all but one of
/// the pool's. Parking every thread behind a stuck holder (a process stopped inside its critical
/// section, a slow network home) would stall every other async call in the CLI, provider connections
/// included. With the default pool of four that is three; the pool itself already allows one in-process
/// holder and three in-process waiters. A caller beyond the limit gets only `OVER_LIMIT_GRACE`.
fn max_claim_waiters() -> usize {
    worker_pool_size().saturating_sub(1)
}
/// How long a caller beyond the waiter limit may still poll. A holder's critical section is a few
/// synchronous flushes, so this lets a fourth concurrent caller behind a busy holder through, and it
/// bounds what a stuck holder can cost the one pool thread that is never parked for long.
const OVER_LIMIT_GRACE: Duration = Duration::from_millis(100);
static CLAIM_WAITERS: AtomicUsize = AtomicUsize::new(0);
struct ClaimWaiter;
impl ClaimWaiter {
    fn enter_always() -> Self {
        CLAIM_WAITERS.fetch_add(1, Ordering::AcqRel);
        Self
    }
    fn enter() -> Option<Self> {
        let limit = max_claim_waiters();
        CLAIM_WAITERS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |waiting| {
                (waiting < limit).then_some(waiting + 1)
            })
            .ok()
            .map(|_| Self)
    }
}
impl Drop for ClaimWaiter {
    fn drop(&mut self) {
        CLAIM_WAITERS.fetch_sub(1, Ordering::AcqRel);
    }
}
#[cfg(test)]
fn under_claim_hook() {
    ON_CLAIMED.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook();
        }
    });
}
#[cfg(test)]
thread_local! {
    /// Test hook, called on the waiting thread after every contended attempt: lets a test release a
    /// holder at the moment a waiter is proven to be waiting, and turn a wait that should have ended
    /// into a failure instead of a hang.
    static ON_CONTENDED: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
    /// Test hook, called with each entry name just before the scan opens it: lets a test make an
    /// entry vanish at exactly that moment.
    static ON_ENTRY: std::cell::RefCell<Option<Box<dyn FnMut(&str)>>> =
        const { std::cell::RefCell::new(None) };
    /// Test override of the two-second operation budget (see `operation_budget`).
    static OPERATION_BUDGET: std::cell::Cell<Duration> =
        const { std::cell::Cell::new(Duration::from_secs(2)) };
    /// Test hook, called once a claim is held and its post-claim checks are done: lets a test spend time
    /// under the claim, as slow work would.
    static ON_CLAIMED: std::cell::RefCell<Option<Box<dyn FnMut()>>> =
        const { std::cell::RefCell::new(None) };
    /// Test hook, called with each entry name right after the scan opened it and before it verifies it:
    /// lets a test unlink the file the scan is holding.
    static ON_OPENED: std::cell::RefCell<Option<Box<dyn FnMut(&str)>>> =
        const { std::cell::RefCell::new(None) };
}
#[cfg(unix)]
fn producer_dead(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // Only ESRCH proves absence. EPERM, live/reused PIDs and all unknown failures preserve.
    (unsafe { libc::kill(pid, 0) }) != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
#[cfg(windows)]
fn producer_dead(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // Unknown or inaccessible processes are preserved; a reused live PID is never reclaimed.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        }
        let mut code = 259;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code != 259
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::macos::MacosProfile;
    use std::os::unix::fs::DirBuilderExt;
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};
    // These cases exercise real flushes under the fixed cooperative scan budget.
    // Serialize their fixture lifetimes so the 140-cycle stress case does not
    // consume another case's two-second budget through competing fixture I/O.
    static FIXTURE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    struct Fixture(PathBuf, std::sync::MutexGuard<'static, ()>);
    impl Fixture {
        fn new() -> Self {
            let guard = FIXTURE_LOCK.lock().expect("fixture isolation");
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "relavium-index-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .expect("private fixture");
            Self(fs::canonicalize(path).expect("fixture path"), guard)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove synthetic fixture");
        }
    }
    fn pin(home: &Path, nonce: &str) -> OwnedStage<MacosProfile> {
        let parent_path = fs::canonicalize(home).expect("parent locator");
        let parent = MacosProfile::open_parent(&parent_path).expect("parent");
        let mut owned = OwnedStage::<MacosProfile>::reserve(home, &parent, &parent_path, nonce)
            .expect("reserve");
        let stage = MacosProfile::create_private_directory(owned.stage_path()).expect("stage");
        let payload =
            MacosProfile::create_private_file(&stage, OsStr::new("payload")).expect("payload");
        let path = owned.stage_path().to_owned();
        owned
            .pin_empty(&stage, &payload, &path)
            .expect("durable pin");
        owned
    }
    #[test]
    fn binary_protocol_is_closed_and_full_identity_roundtrips() {
        let id = NativeIdentity {
            volume: 7,
            object: u128::MAX,
            node_dev: 8,
            node_ino: 9,
        };
        let record = Record {
            version: RecordVersion::V2,
            pid: 1,
            nonce: "a".repeat(32),
            owner: "501".into(),
            stage: PathBuf::from(format!("/tmp/{PREFIX}1.{}", "a".repeat(32))),
            parent: id,
            directory: id,
            payload: id,
        };
        let bytes = record.encode().expect("encode");
        let parsed = Record::decode(&bytes).expect("decode");
        assert!(parsed.parent == id && parsed.directory == id && parsed.payload == id);
        for size in 0..bytes.len() {
            assert!(Record::decode(&bytes[..size]).is_err());
        }
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(Record::decode(&extra).is_err());
        let mut bad = bytes;
        bad[9] = 1;
        assert!(Record::decode(&bad).is_err());
    }
    #[test]
    fn producer_claim_is_noninheritable_and_duplicate_does_not_relock() {
        use std::os::fd::AsRawFd;
        let fixture = Fixture::new();
        let mut owned = pin(&fixture.0, &"d".repeat(32));
        let claim = &owned.pinned_file.as_ref().expect("claim").0;
        let duplicate = claim.try_clone().expect("duplicate");
        for file in [claim, &duplicate] {
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            assert_ne!(flags, -1);
            assert_ne!(flags & libc::FD_CLOEXEC, 0);
        }
        let independent = open_nofollow(&owned.index.path.join(format!("{}.record", owned.nonce)))
            .expect("independent");
        assert!(lock(&independent).is_err());
        drop(duplicate);
        owned.cleanup().expect("cleanup reuses original claim");
    }

    #[test]
    fn v1_record_decodes_and_mismatched_versions_are_rejected() {
        let fixture = Fixture::new();
        let mut owned = pin(&fixture.0, &"e".repeat(32));
        let record = owned.record.as_mut().expect("record");
        record.version = RecordVersion::V1;
        let bytes = record.encode().expect("v1");
        assert!(matches!(
            Record::decode(&bytes).expect("v1 decode").version,
            RecordVersion::V1
        ));
        let mut mismatched = bytes.clone();
        mismatched[8] = 2;
        assert!(Record::decode(&mismatched).is_err());
        record.version = RecordVersion::V2;
        owned.cleanup().expect("cleanup");
    }

    #[test]
    fn completion_finishes_after_cancellation_and_reports_post_rmdir_faults() {
        for phase in [
            "completion-cancel-after-rmdir",
            "completion-deadline-after-rmdir",
            "completion-parent-flush",
            "completion-index-flush",
        ] {
            let fixture = Fixture::new();
            let owned = pin(&fixture.0, &"f".repeat(32));
            let signal = AtomicBool::new(false);
            let marker_path = owned.index.path.join(format!("{}.record", owned.nonce));
            crate::test_hooks::inject_failure(Some(phase));
            let outcome = cleanup_record::<MacosProfile>(
                &owned.index,
                owned.record.as_ref().expect("record"),
                &owned.pinned_file.as_ref().expect("claim").0,
                Instant::now(),
                false,
                Some(&signal),
            );
            crate::test_hooks::inject_failure(None);
            assert!(!owned.path.exists());
            if phase == "completion-cancel-after-rmdir"
                || phase == "completion-deadline-after-rmdir"
            {
                assert!(outcome.is_ok());
                if phase == "completion-cancel-after-rmdir" {
                    assert!(signal.load(Ordering::SeqCst));
                }
                assert!(!marker_path.exists());
            } else {
                assert!(matches!(outcome, Err(NativeFailure::CleanupUncertain)));
                assert_eq!(marker_path.exists(), phase == "completion-parent-flush");
            }
        }
    }

    #[test]
    fn pin_is_empty_only_and_cleanup_is_exact() {
        let fixture = Fixture::new();
        let mut owned = pin(&fixture.0, &"a".repeat(32));
        let record = owned.index.path.join(format!("{}.record", "a".repeat(32)));
        assert!(record.is_file());
        fs::write(owned.path.join("payload"), b"synthetic").expect("after durable pin");
        let foreign = owned.path.join("foreign");
        fs::write(&foreign, b"preserve").expect("foreign child");
        assert!(owned.cleanup().is_err());
        assert!(record.is_file());
        assert!(owned.path.join("payload").is_file());
        fs::remove_file(foreign).expect("remove own fixture");
        owned.cleanup().expect("exact cleanup");
        assert!(!owned.path.exists() && !record.exists() && fixture.0.exists());
    }
    #[test]
    fn live_producer_and_hardlinked_payload_preserve_evidence() {
        let fixture = Fixture::new();
        let mut owned = pin(&fixture.0, &"b".repeat(32));
        let summary = recover::<MacosProfile>(&fixture.0).expect("scan");
        assert_eq!(summary.removed, 0);
        assert!(summary.retained > 0);
        let alias = fixture.0.join("alias");
        fs::hard_link(owned.path.join("payload"), &alias).expect("alias");
        assert!(owned.cleanup().is_err());
        assert!(owned.path.join("payload").exists());
        assert!(owned
            .index
            .path
            .join(format!("{}.record", "b".repeat(32)))
            .exists());
        fs::remove_file(alias).expect("fixture alias");
        owned.cleanup().expect("cleanup after alias removed");
    }
    #[test]
    fn inventory_capacity_never_evicts_or_allocates_untracked() {
        let fixture = Fixture::new();
        let index = Index::<MacosProfile>::open(&fixture.0, true).expect("index");
        for n in 0..MAX_RECORDS {
            let file = MacosProfile::create_private_file(
                &index.directory,
                OsStr::new(&format!("{n:032x}.reserved")),
            )
            .expect("reservation");
            file.sync_all().expect("flush");
        }
        let parent = MacosProfile::open_parent(&fixture.0).expect("parent");
        assert!(OwnedStage::<MacosProfile>::reserve(
            &fixture.0,
            &parent,
            &fixture.0,
            &"f".repeat(32)
        )
        .is_err());
        assert_eq!(
            fs::read_dir(&index.path).expect("entries").count(),
            MAX_RECORDS + 1
        );
    }
    #[test]
    fn recovery_never_creates_missing_index_state_or_trusts_malformed_ancestors() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        assert_eq!(
            recover::<MacosProfile>(&fixture.0)
                .expect("absent parent")
                .removed,
            0
        );
        let shared = fixture.0.join(".relavium");
        fs::create_dir(&shared).expect("ordinary shared parent");
        assert_eq!(
            recover::<MacosProfile>(&fixture.0)
                .expect("shared parent")
                .removed,
            0
        );
        let old = shared.join("fs-staging-v1");
        fs::create_dir(&old).expect("retired index");
        assert!(matches!(
            recover::<MacosProfile>(&fixture.0),
            Err(NativeFailure::LegacyRecoveryRequired)
        ));
        assert!(old.is_dir());
        assert!(matches!(
            Index::<MacosProfile>::open(&fixture.0, true),
            Err(NativeFailure::LegacyRecoveryRequired)
        ));
        assert!(!fixture.0.join(".relavium-fs-private-v1").exists());
        fs::remove_dir(&old).expect("own empty test index");
        let parent_path = fixture.0.join(".relavium-fs-private-v1");
        assert!(!parent_path.exists());
        let parent = MacosProfile::create_private_directory(&parent_path).expect("private parent");
        assert_eq!(
            recover::<MacosProfile>(&fixture.0)
                .expect("absent index")
                .removed,
            0
        );
        let index_path = parent_path.join("fs-staging-v1");
        assert!(!index_path.exists());
        let index =
            MacosProfile::create_private_directory(&index_path).expect("private empty index");
        assert_eq!(
            recover::<MacosProfile>(&fixture.0)
                .expect("empty index without lock")
                .removed,
            0
        );
        assert_eq!(fs::read_dir(&index_path).expect("empty index").count(), 0);
        let reserved = MacosProfile::create_private_file(
            &index,
            OsStr::new(&format!("{}.reserved", "a".repeat(32))),
        )
        .expect("unproven entry");
        assert!(recover::<MacosProfile>(&fixture.0).is_err());
        drop(reserved);
        fs::remove_file(index_path.join(format!("{}.reserved", "a".repeat(32))))
            .expect("fixture marker");
        drop(index);
        fs::remove_dir(&index_path).expect("fixture index");
        drop(parent);
        fs::remove_dir(&parent_path).expect("fixture parent");
        let elsewhere = fixture.0.join("elsewhere");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&elsewhere)
            .expect("fixture destination");
        symlink(&elsewhere, &parent_path).expect("malformed ancestor");
        assert!(recover::<MacosProfile>(&fixture.0).is_err());
        assert!(!elsewhere.join("fs-staging-v1").exists());
    }
    #[test]
    fn cancelled_recovery_and_exclusive_claims_preserve_artifacts() {
        let fixture = Fixture::new();
        let owned = pin(&fixture.0, &"d".repeat(32));
        assert!(matches!(
            recover_with_cancel::<MacosProfile>(&fixture.0, &AtomicBool::new(true)),
            Err(NativeFailure::Cancelled)
        ));
        let marker = owned.index.path.join(format!("{}.record", "d".repeat(32)));
        let first = open_nofollow(&marker).expect("claim");
        assert!(lock(&first).is_err());
        assert!(owned.path.join("payload").is_file());
        drop(owned);
        lock(&first).expect("kernel releases closed producer claim");
        let second = open_nofollow(&marker).expect("second descriptor");
        assert!(lock(&second).is_err());
        drop(first);
        lock(&second).expect("kernel releases closed claimant");
    }
    #[test]
    fn changed_home_authority_and_changed_marker_preserve_ownership_evidence() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let actual = fixture.0.join("actual");
        let replacement = fixture.0.join("replacement");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&actual)
            .expect("actual home");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&replacement)
            .expect("replacement home");
        let alias = fixture.0.join("home");
        symlink(&actual, &alias).expect("home alias");
        let mut owned = pin(&alias, &"e".repeat(32));
        fs::remove_file(&alias).expect("change authority");
        symlink(&replacement, &alias).expect("new authority");
        assert!(owned.cleanup().is_err());
        assert!(owned.path.join("payload").is_file());
        fs::remove_file(&alias).expect("restore authority");
        symlink(&actual, &alias).expect("original authority");
        let marker = owned.index.path.join(format!("{}.record", "e".repeat(32)));
        fs::write(&marker, b"changed marker").expect("marker mutation fixture");
        assert!(owned.cleanup().is_err());
        assert!(marker.is_file());
        assert!(owned.path.join("payload").is_file());
    }
    #[test]
    fn repeated_normal_pre_pin_cancellation_does_not_consume_inventory() {
        let fixture = Fixture::new();
        let parent = MacosProfile::open_parent(&fixture.0).expect("parent");
        for cycle in 0..140_u32 {
            let nonce = format!("{cycle:032x}");
            let mut owned =
                OwnedStage::<MacosProfile>::reserve(&fixture.0, &parent, &fixture.0, &nonce)
                    .expect("reclaimed capacity");
            if cycle % 3 != 0 {
                let directory =
                    MacosProfile::create_private_directory(owned.stage_path()).expect("stage");
                owned.adopt_directory(&directory).expect("adopt directory");
                if cycle % 3 == 2 {
                    let payload =
                        MacosProfile::create_private_file(&directory, OsStr::new("payload"))
                            .expect("empty payload");
                    owned
                        .adopt_empty(&directory, &payload)
                        .expect("adopt empty");
                    let path = owned.path.clone();
                    assert!(matches!(
                        owned.pin_empty_with_cancel(
                            &directory,
                            &payload,
                            &path,
                            &AtomicBool::new(true)
                        ),
                        Err(NativeFailure::Cancelled)
                    ));
                }
            }
            owned.cleanup().expect("normal pre-pin cleanup");
            assert!(!owned.path.exists());
            assert_eq!(
                fs::read_dir(&owned.index.path).expect("inventory").count(),
                1
            );
        }
    }
    #[test]
    fn cancellation_after_reservation_creation_reclaims_exact_marker_before_return() {
        let fixture = Fixture::new();
        let index = Index::<MacosProfile>::open(&fixture.0, true).expect("index");
        let _allocation = index.allocation_lock().expect("allocation claim");
        for cycle in 0..140_u32 {
            let nonce = format!("{cycle:032x}");
            let reservation = MacosProfile::create_private_file(
                &index.directory,
                OsStr::new(&format!("{nonce}.reserved")),
            )
            .expect("exclusive reservation");
            assert!(matches!(
                finish_reservation::<MacosProfile>(
                    &index,
                    &reservation,
                    &nonce,
                    Instant::now(),
                    Some(&AtomicBool::new(true))
                ),
                Err(NativeFailure::Cancelled)
            ));
            assert!(!index.path.join(format!("{nonce}.reserved")).exists());
        }
        assert_eq!(fs::read_dir(&index.path).expect("index").count(), 1);
    }
    #[test]
    fn reservation_cleanup_uncertainty_preserves_cancellation() {
        use crate::profile_api::NativePrimary;
        let fixture = Fixture::new();
        let index = Index::<MacosProfile>::open(&fixture.0, true).expect("index");
        let _allocation = index.allocation_lock().expect("allocation claim");
        let nonce = "9".repeat(32);
        let reservation = MacosProfile::create_private_file(
            &index.directory,
            OsStr::new(&format!("{nonce}.reserved")),
        )
        .expect("reservation");
        crate::test_hooks::inject_failure(Some("reservation-cleanup-failure"));
        let result = finish_reservation::<MacosProfile>(
            &index,
            &reservation,
            &nonce,
            Instant::now(),
            Some(&AtomicBool::new(true)),
        );
        crate::test_hooks::inject_failure(None);
        assert!(matches!(
            result,
            Err(NativeFailure::CleanupFacts {
                primary: NativePrimary::Cancelled,
                uncertain: true
            })
        ));
        assert!(index.path.join(format!("{nonce}.reserved")).exists());
    }

    #[test]
    fn pre_pin_cleanup_preserves_aliases_and_unknown_children() {
        let fixture = Fixture::new();
        let parent = MacosProfile::open_parent(&fixture.0).expect("parent");
        let mut owned =
            OwnedStage::<MacosProfile>::reserve(&fixture.0, &parent, &fixture.0, &"f".repeat(32))
                .expect("reserve");
        let directory = MacosProfile::create_private_directory(owned.stage_path()).expect("stage");
        owned.adopt_directory(&directory).expect("adopt directory");
        let payload =
            MacosProfile::create_private_file(&directory, OsStr::new("payload")).expect("payload");
        owned
            .adopt_empty(&directory, &payload)
            .expect("adopt payload");
        let alias = fixture.0.join("alias");
        fs::hard_link(owned.path.join("payload"), &alias).expect("alias");
        assert!(owned.cleanup().is_err());
        assert!(owned.path.join("payload").exists());
        fs::remove_file(alias).expect("remove fixture alias");
        let foreign = owned.path.join("foreign");
        fs::write(&foreign, b"foreign").expect("foreign child");
        assert!(owned.cleanup().is_err());
        assert!(owned.path.join("payload").exists());
        fs::remove_file(foreign).expect("remove fixture child");
        owned.cleanup().expect("proven cleanup");
    }
    #[test]
    fn pre_pin_cleanup_handles_owned_partial_and_renamed_marker_states() {
        for renamed in [false, true] {
            let fixture = Fixture::new();
            let parent = MacosProfile::open_parent(&fixture.0).expect("parent");
            let mut owned = OwnedStage::<MacosProfile>::reserve(
                &fixture.0,
                &parent,
                &fixture.0,
                &"a".repeat(32),
            )
            .expect("reserve");
            let directory =
                MacosProfile::create_private_directory(owned.stage_path()).expect("stage");
            owned.adopt_directory(&directory).expect("directory");
            let payload = MacosProfile::create_private_file(&directory, OsStr::new("payload"))
                .expect("payload");
            owned.adopt_empty(&directory, &payload).expect("empty");
            let record = Record {
                version: RecordVersion::V2,
                pid: std::process::id(),
                nonce: owned.nonce.clone(),
                owner: MacosProfile::owner_identity().expect("owner"),
                stage: owned.path.clone(),
                parent: owned.parent_id,
                directory: MacosProfile::identity(&directory).expect("directory identity"),
                payload: MacosProfile::identity(&payload).expect("payload identity"),
            };
            let prepare = owned.index.path.join(format!("{}.prepare", owned.nonce));
            let mut marker = MacosProfile::create_private_file(
                &owned.index.directory,
                OsStr::new(&format!("{}.prepare", owned.nonce)),
            )
            .expect("prepare");
            let encoded = if renamed {
                record.encode().expect("encoding")
            } else {
                b"partial".to_vec()
            };
            marker.write_all(&encoded).expect("marker bytes");
            owned.pending_record = Some(record);
            owned.pending_file = Some(EphemeralArtifact {
                identity: MacosProfile::identity(&marker).expect("marker identity"),
                file: marker.try_clone().expect("duplicate marker"),
            });
            owned.pending_claim = Some(MarkerClaim::acquire(marker).expect("marker claim"));
            if renamed {
                fs::rename(
                    prepare,
                    owned.index.path.join(format!("{}.record", owned.nonce)),
                )
                .expect("rename before simulated flush failure");
            }
            owned
                .cleanup()
                .expect("cleanup only owned marker/artifacts");
            assert!(!owned.path.exists());
            assert_eq!(fs::read_dir(&owned.index.path).expect("index").count(), 1);
        }
    }
    #[test]
    #[ignore = "subprocess fixture for killed_native_producer_is_recovered"]
    fn crash_child() {
        let home =
            PathBuf::from(std::env::var_os("RELAVIUM_STAGE_TEST_HOME").expect("child fixture"));
        let pinned = std::env::var_os("RELAVIUM_STAGE_TEST_PINNED").is_some();
        let parent = MacosProfile::open_parent(&home).expect("parent");
        let mut owned = OwnedStage::<MacosProfile>::reserve(&home, &parent, &home, &"c".repeat(32))
            .expect("reserve");
        let stage = MacosProfile::create_private_directory(owned.stage_path()).expect("stage");
        let mut payload =
            MacosProfile::create_private_file(&stage, OsStr::new("payload")).expect("payload");
        owned.adopt_directory(&stage).expect("ephemeral directory");
        owned
            .adopt_empty(&stage, &payload)
            .expect("ephemeral payload");
        if pinned {
            let path = owned.path.clone();
            owned.pin_empty(&stage, &payload, &path).expect("pin");
            payload.write_all(b"synthetic orphan").expect("payload");
            payload.sync_all().expect("flush");
        }
        fs::write(home.join("ready"), b"ready").expect("ready");
        loop {
            std::thread::park();
        }
    }
    #[test]
    fn killed_native_producer_is_recovered_only_after_pinning() {
        for (pinned, legacy) in [(false, false), (true, false), (true, true)] {
            let fixture = Fixture::new();
            let mut command = Command::new(std::env::current_exe().expect("test executable"));
            command
                .args([
                    "--exact",
                    "stage_index::tests::crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("RELAVIUM_STAGE_TEST_HOME", &fixture.0)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if pinned {
                command.env("RELAVIUM_STAGE_TEST_PINNED", "1");
            }
            let mut child = command.spawn().expect("child");
            let deadline = Instant::now();
            while !fixture.0.join("ready").exists() {
                assert!(
                    deadline.elapsed() < Duration::from_secs(5),
                    "child ready deadline"
                );
                assert!(
                    child.try_wait().expect("child state").is_none(),
                    "child exited"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            let live = recover::<MacosProfile>(&fixture.0).expect("live scan");
            assert_eq!(live.removed, 0);
            child.kill().expect("kill");
            child.wait().expect("join killed producer");
            if legacy {
                let marker = fixture
                    .0
                    .join(".relavium-fs-private-v1/fs-staging-v1")
                    .join(format!("{}.record", "c".repeat(32)));
                let mut bytes = fs::read(&marker).expect("native v2 record");
                bytes[..8].copy_from_slice(MAGIC_V1);
                bytes[8] = 1;
                fs::write(&marker, bytes).expect("legacy fixture");
            }
            let recovered = recover::<MacosProfile>(&fixture.0).expect("orphan scan");
            assert_eq!(recovered.removed, usize::from(pinned && !legacy));
            assert_eq!(recovered.retained, usize::from(!pinned || legacy));
            let count = fs::read_dir(&fixture.0)
                .expect("fixture")
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(PREFIX))
                .count();
            assert_eq!(count, usize::from(!pinned || legacy));
        }
    }
}

// Portable OS-lock tests deliberately use independent handles and processes.
#[cfg(test)]
mod custody_tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    #[test]
    #[ignore = "subprocess fixture for claim_survives_duplicates_but_not_child_exec"]
    fn claim_exec_child() {
        let ready = std::env::var_os("RELAVIUM_CUSTODY_CHILD_READY").expect("ready path");
        let path = std::env::var_os("RELAVIUM_CUSTODY_CHILD_RECORD").expect("record path");
        let mut reader = open_nofollow(Path::new(&path)).expect("child reader");
        let mut bytes = Vec::new();
        (&mut reader)
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .expect("child read");
        if std::env::var_os("RELAVIUM_CUSTODY_NATIVE_RECORD").is_some() {
            assert!(bytes.starts_with(b"RVSTG002\x02"));
        } else {
            assert_eq!(bytes, b"bounded record");
        }
        assert!(lock(&reader).is_err(), "child must contend with producer");
        drop(reader);
        fs::write(ready, b"ready").expect("signal readiness");
        loop {
            std::thread::park();
        }
    }

    #[cfg(target_os = "macos")]
    type TestProfile = crate::macos::MacosProfile;
    #[cfg(target_os = "linux")]
    type TestProfile = crate::linux::LinuxProfile;
    #[cfg(windows)]
    type TestProfile = crate::windows::WindowsProfile;

    #[test]
    fn native_producer_claim_noninheritance_and_independent_reader() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "relavium-native-claim-{}-{stamp}",
            std::process::id()
        ));
        let home = TestProfile::create_private_directory(&root).expect("private home");
        let root = fs::canonicalize(root).expect("home path");
        let mut owned = OwnedStage::<TestProfile>::reserve(&root, &home, &root, &"7".repeat(32))
            .expect("reserve");
        let stage = TestProfile::create_private_directory(owned.stage_path()).expect("stage");
        let payload =
            TestProfile::create_private_file(&stage, OsStr::new("payload")).expect("payload");
        let stage_path = owned.stage_path().to_owned();
        owned.pin_empty(&stage, &payload, &stage_path).expect("pin");
        let path = owned.index.path.join(format!("{}.record", owned.nonce));
        let ready = root.join("child-ready");
        let claim = &owned.pinned_file.as_ref().expect("claim").0;
        let duplicate = claim.try_clone().expect("duplicate");
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            for file in [claim, &duplicate] {
                let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
                assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
            for file in [claim, &duplicate] {
                let mut flags = 0;
                assert_ne!(
                    unsafe { GetHandleInformation(file.as_raw_handle().cast(), &mut flags) },
                    0
                );
                assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
            }
        }
        let reader = open_nofollow(&path).expect("separate reader");
        assert!(lock(&reader).is_err());
        let mut child = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--ignored",
                "--exact",
                "stage_index::custody_tests::claim_exec_child",
            ])
            .env("RELAVIUM_CUSTODY_CHILD_READY", &ready)
            .env("RELAVIUM_CUSTODY_CHILD_RECORD", &path)
            .env("RELAVIUM_CUSTODY_NATIVE_RECORD", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("child");
        let start = Instant::now();
        while !ready.exists() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child did not read record while locked");
        drop(owned);
        drop(duplicate);
        assert!(lock(&reader).is_ok(), "child inherited native marker claim");
        child.kill().expect("stop child");
        child.wait().expect("join child");
        drop(reader);
        drop(payload);
        drop(stage);
        drop(home);
        fs::remove_dir_all(root).expect("remove owned fixture");
    }

    #[test]
    fn claim_survives_duplicates_but_not_child_exec() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("relavium-claim-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).expect("fixture");
        let path = root.join("record");
        let ready = root.join("ready");
        let mut original = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .expect("record");
        original.write_all(b"bounded record").expect("bytes");
        let claim = MarkerClaim::acquire(original).expect("claim");
        let duplicate = claim.0.try_clone().expect("duplicate");
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            for file in [&claim.0, &duplicate] {
                let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
                assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};
            for file in [&claim.0, &duplicate] {
                let mut flags = 0;
                assert_ne!(
                    unsafe { GetHandleInformation(file.as_raw_handle().cast(), &mut flags) },
                    0
                );
                assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
            }
        }
        let mut reader = open_nofollow(&path).expect("independent reader");
        assert!(lock(&reader).is_err());
        let mut bytes = Vec::new();
        (&mut reader)
            .take((MAX_RECORD_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .expect("reader does not overlap lock byte");
        assert_eq!(bytes, b"bounded record");
        let mut child = Command::new(std::env::current_exe().expect("test binary"))
            .args([
                "--ignored",
                "--exact",
                "stage_index::custody_tests::claim_exec_child",
            ])
            .env("RELAVIUM_CUSTODY_CHILD_READY", &ready)
            .env("RELAVIUM_CUSTODY_CHILD_RECORD", &path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("child");
        let start = Instant::now();
        while !ready.exists() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child exec did not become ready");
        drop(claim);
        // On POSIX the duplicate shares the open description; on Windows the
        // original handle owns the byte lock and its duplicate must not relock.
        #[cfg(unix)]
        assert!(lock(&reader).is_err());
        drop(duplicate);
        assert!(lock(&reader).is_ok(), "exec child inherited a claim");
        child.kill().expect("stop child");
        child.wait().expect("join child");
        drop(reader);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    fn fixture_home(label: &str) -> (PathBuf, File) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("relavium-{label}-{}-{stamp}", std::process::id()));
        let home = TestProfile::create_private_directory(&root).expect("private home");
        (fs::canonicalize(root).expect("home path"), home)
    }

    /// The waiter count is process-wide and the hooks are per thread, so the tests that contend for a
    /// claim run one at a time.
    static CLAIM_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn claim_tests_serial() -> std::sync::MutexGuard<'static, ()> {
        CLAIM_TESTS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Run `hook` on this thread after every contended attempt. A wait that should have ended at its
    /// deadline or its cancellation fails the test here instead of hanging it.
    fn on_contended(mut hook: impl FnMut() + 'static) {
        let mut attempts = 0_u32;
        ON_CONTENDED.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                attempts += 1;
                assert!(attempts < 2000, "the wait did not end at its deadline");
                hook();
            }));
        });
    }
    fn clear_hooks() {
        ON_CONTENDED.with(|slot| *slot.borrow_mut() = None);
        ON_ENTRY.with(|slot| *slot.borrow_mut() = None);
        ON_OPENED.with(|slot| *slot.borrow_mut() = None);
        ON_CLAIMED.with(|slot| *slot.borrow_mut() = None);
        OPERATION_BUDGET.with(|budget| budget.set(Duration::from_secs(2)));
    }

    /// A second handle on `inventory.lock` that holds the allocation claim, as another process would.
    fn hold_allocation_claim(index: &Index<TestProfile>) -> File {
        let holder = open_nofollow(&index.path.join("inventory.lock")).expect("holder handle");
        lock(&holder).expect("holder claim");
        holder
    }

    /// A home with its index hierarchy and `inventory.lock` created.
    fn fixture_index(label: &str) -> (PathBuf, File, Index<TestProfile>) {
        let (root, home) = fixture_home(label);
        let index = Index::<TestProfile>::open(&root, true).expect("index");
        drop(
            index
                .allocation_lock()
                .expect("the first claim creates the lock file"),
        );
        (root, home, index)
    }

    #[test]
    fn allocation_claim_waits_for_a_holder_and_fails_closed_after_the_budget() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("claim-wait");

        // The holder lets go after a long enough wait to tell when the claim's own budget starts: the
        // writer queues behind it instead of failing the write, met the holder exactly once, and the
        // claim reports the instant it was ACQUIRED, not the one the wait began at (pre-pin cleanup
        // and recovery measure their destructive work from it).
        let holder = std::cell::Cell::new(Some(hold_allocation_claim(&index)));
        let met = std::rc::Rc::new(std::cell::Cell::new(0_u32));
        {
            let met = std::rc::Rc::clone(&met);
            on_contended(move || {
                met.set(met.get() + 1);
                std::thread::sleep(Duration::from_millis(400));
                drop(holder.take());
            });
        }
        let claim = index
            .allocation_lock()
            .expect("waits for the holder instead of failing the write");
        assert_eq!(met.get(), 1);
        assert!(
            claim.held_since.elapsed() < Duration::from_millis(200),
            "the claim's budget must start when it was acquired, after the 400 ms wait"
        );
        drop(claim);
        clear_hooks();

        // A holder that outlasts the operation's deadline: fail closed at the deadline, not at the
        // holder. The operation started 1.9 s ago, so about 100 ms of its two seconds remain; a wait
        // that ignored its deadline would trip the hook's attempt limit instead of hanging the test.
        let holder = hold_allocation_claim(&index);
        on_contended(|| {});
        let started = Instant::now()
            .checked_sub(Duration::from_millis(1900))
            .expect("monotonic clock is more than two seconds past its origin");
        let began = Instant::now();
        assert!(matches!(
            index.allocation_lock_checked(started, None),
            Err(NativeFailure::Changed)
        ));
        assert!(
            began.elapsed() < Duration::from_secs(1),
            "gave up late: it waited for the holder instead of the deadline"
        );
        clear_hooks();
        drop(holder);
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn allocation_claim_wait_honours_cancellation() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("claim-cancel");
        let holder = hold_allocation_claim(&index);
        let flag = std::rc::Rc::new(AtomicBool::new(false));
        {
            let raise = std::rc::Rc::clone(&flag);
            // Raised at the first moment the writer is proven to be waiting.
            on_contended(move || raise.store(true, Ordering::Release));
        }
        assert!(matches!(
            index.allocation_lock_checked(Instant::now(), Some(flag.as_ref())),
            Err(NativeFailure::Cancelled)
        ));
        clear_hooks();
        drop(holder);
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn recovery_waits_for_an_allocation_holder() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("recover-wait");
        let holder = std::cell::Cell::new(Some(hold_allocation_claim(&index)));
        on_contended(move || drop(holder.take()));
        let summary = recover::<TestProfile>(&root)
            .expect("recovery queues behind a writer's allocation instead of failing the pass");
        assert_eq!((summary.removed, summary.retained), (0, 0));
        clear_hooks();
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    /// Puts the process-wide waiter count back to zero even if a test panics while it is raised.
    struct WaitersReset;
    impl Drop for WaitersReset {
        fn drop(&mut self) {
            CLAIM_WAITERS.store(0, Ordering::Release);
        }
    }

    #[test]
    fn waiters_park_up_to_the_limit_and_the_next_one_gets_only_a_short_grace() {
        // Every native call runs on Node's worker pool, which also serves fs, dns and crypto: a stuck
        // holder must never be able to park all of it. All but one thread may wait.
        let limit = max_claim_waiters();
        if std::env::var_os("UV_THREADPOOL_SIZE").is_none() {
            assert_eq!(limit, 3, "the default pool of four, minus one thread");
        }
        if limit == 0 {
            return;
        }
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("claim-cap");
        let holder = hold_allocation_claim(&index);
        let lock_path = index.path.join("inventory.lock");
        let mut handles: Vec<File> = (0..=limit)
            .map(|_| open_nofollow(&lock_path).expect("waiter handle"))
            .collect();
        let extra = handles.pop().expect("one handle beyond the limit");
        std::thread::scope(|scope| {
            let waiters: Vec<_> = handles
                .into_iter()
                .map(|file| {
                    scope.spawn(move || {
                        let outcome = lock_within(&file, Instant::now(), None, true);
                        drop(file);
                        outcome
                    })
                })
                .collect();
            let began = Instant::now();
            while CLAIM_WAITERS.load(Ordering::Acquire) < limit {
                assert!(
                    began.elapsed() < Duration::from_secs(10),
                    "the waiters never parked"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            // The next caller polls for the grace and no longer: it neither parks like the waiters
            // (that would take the whole two seconds) nor is refused before the grace is over.
            let refused_at = Instant::now();
            assert!(matches!(
                lock_within(&extra, Instant::now(), None, true),
                Err(NativeFailure::Changed)
            ));
            let refused_after = refused_at.elapsed();
            assert!(
                refused_after >= OVER_LIMIT_GRACE && refused_after < Duration::from_secs(1),
                "the extra caller waited {refused_after:?}"
            );
            drop(holder);
            for waiter in waiters {
                assert!(
                    waiter.join().expect("waiter thread").is_ok(),
                    "a parked waiter must get its turn once the holder lets go"
                );
            }
        });
        assert_eq!(CLAIM_WAITERS.load(Ordering::Acquire), 0);
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_caller_beyond_the_limit_still_gets_through_a_busy_holder() {
        // Four concurrent callers behind a holder in ANOTHER process are the supported case, and the
        // holder is usually just busy: the caller beyond the limit must be able to wait out a short hold.
        let limit = max_claim_waiters();
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("claim-grace");
        let _reset = WaitersReset;
        CLAIM_WAITERS.store(limit, Ordering::Release);
        let holder = std::cell::Cell::new(Some(hold_allocation_claim(&index)));
        on_contended(move || drop(holder.take()));
        drop(
            index
                .allocation_lock_checked(Instant::now(), None)
                .expect("a caller beyond the limit waits out a holder that is merely busy"),
        );
        clear_hooks();
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_cancelled_caller_beyond_the_limit_is_cancelled_not_changed() {
        // Cancellation comes before the waiter limit and its grace: when the grace is over in the very
        // same attempt in which the flag is seen, the answer is `cancelled`.
        let limit = max_claim_waiters();
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("claim-cancel-over");
        let _reset = WaitersReset;
        CLAIM_WAITERS.store(limit, Ordering::Release);
        let holder = hold_allocation_claim(&index);
        let flag = std::rc::Rc::new(AtomicBool::new(false));
        {
            let raise = std::rc::Rc::clone(&flag);
            on_contended(move || {
                // The grace is over by the time this returns, and only then is the flag raised.
                std::thread::sleep(OVER_LIMIT_GRACE + Duration::from_millis(50));
                raise.store(true, Ordering::Release);
            });
        }
        assert!(matches!(
            index.allocation_lock_checked(Instant::now(), Some(flag.as_ref())),
            Err(NativeFailure::Cancelled)
        ));
        clear_hooks();
        drop(holder);
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    /// A one-second budget, a wait of 400 ms for the claim and 700 ms of slow work under it: 1.1 s in all,
    /// over the budget, so only work that measures its budget from the claim's acquisition (700 ms)
    /// completes. The hooks put the numbers in place; the caller runs the operation.
    fn slow_claim_scenario(holder: File) {
        OPERATION_BUDGET.with(|budget| budget.set(Duration::from_millis(1000)));
        let holder = std::cell::Cell::new(Some(holder));
        on_contended(move || {
            std::thread::sleep(Duration::from_millis(400));
            drop(holder.take());
        });
        ON_CLAIMED.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(|| std::thread::sleep(Duration::from_millis(700))));
        });
    }

    #[test]
    fn reserve_measures_its_work_under_the_claim_from_the_claim() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("budget-reserve");
        slow_claim_scenario(hold_allocation_claim(&index));
        let owned = OwnedStage::<TestProfile>::reserve(&root, &home, &root, &"1".repeat(32))
            .expect(
                "a wait that used up the budget must not fail work under a claim just obtained",
            );
        clear_hooks();
        drop(owned);
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    // POSIX only: the cleanup removes files that this process still holds open by name; what Windows does
    // with a delete-pending file is only observable in the eight-target CI.
    #[cfg(unix)]
    #[test]
    fn pre_pin_cleanup_measures_its_destructive_work_from_the_claim() {
        let _serial = claim_tests_serial();
        let (root, home) = fixture_home("budget-cleanup");
        let mut owned = OwnedStage::<TestProfile>::reserve(&root, &home, &root, &"2".repeat(32))
            .expect("reserve");
        let reserved = owned.index.path.join(format!("{}.reserved", owned.nonce));
        assert!(reserved.exists());
        slow_claim_scenario(hold_allocation_claim(&owned.index));
        owned
            .cleanup()
            .expect("the destructive steps are checked against a budget that starts at the claim");
        clear_hooks();
        assert!(!reserved.exists(), "the reservation must be gone");
        drop(owned);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn recovery_measures_its_pass_from_the_claim() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("budget-recover");
        slow_claim_scenario(hold_allocation_claim(&index));
        recover::<TestProfile>(&root)
            .expect("a wait that used up the budget must not fail the pass under the claim");
        clear_hooks();
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_cleanup_beyond_the_waiter_limit_still_waits_for_the_claim() {
        // Cleanup cannot be retried (a refused cleanup after a publication is an uncertain write), so it
        // is never refused for being beyond the waiter limit, however long the grace is over.
        let limit = max_claim_waiters();
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("cleanup-limit");
        let _reset = WaitersReset;
        CLAIM_WAITERS.store(limit, Ordering::Release);
        let holder = std::cell::Cell::new(Some(hold_allocation_claim(&index)));
        let attempts = std::cell::Cell::new(0_u32);
        on_contended(move || {
            // The holder lets go only at the SECOND contended attempt, which comes after the grace a
            // reservation beyond the limit would get: a cleanup subject to the grace would be refused
            // before reaching it.
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                std::thread::sleep(OVER_LIMIT_GRACE + Duration::from_millis(150));
            } else {
                drop(holder.take());
            }
        });
        drop(
            index
                .allocation_lock()
                .expect("a cleanup waits for the claim however many are waiting"),
        );
        clear_hooks();
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn the_pool_size_is_read_the_way_libuv_reads_it() {
        for (value, size) in [
            (None, 4),
            (Some("8"), 8),
            (Some("  8"), 8),
            (Some("+6"), 6),
            (Some("2x"), 2),
            (Some("x2"), 1),
            (Some(""), 1),
            (Some("0"), 1),
            (Some("-0"), 1),
            (Some("-5"), 1024),
            (Some("5000"), 1024),
            (Some("99999999999999999999999"), 1024),
            (Some("1"), 1),
        ] {
            assert_eq!(pool_size_from(value), size, "{value:?}");
        }
    }

    #[test]
    fn only_contention_is_waited_out_as_a_claim_failure() {
        #[cfg(unix)]
        {
            for code in [libc::EWOULDBLOCK, libc::EAGAIN, libc::EINTR] {
                assert!(matches!(claim_outcome(Some(code)), Ok(Claim::Contended)));
            }
            // A bad descriptor, an exhausted lock table or an invalid request will not go away.
            for code in [libc::EBADF, libc::EINVAL, libc::ENOLCK] {
                assert!(matches!(
                    claim_outcome(Some(code)),
                    Err(NativeFailure::Changed)
                ));
            }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{
                ERROR_ACCESS_DENIED, ERROR_INVALID_HANDLE, ERROR_LOCK_VIOLATION,
            };
            assert!(matches!(
                claim_outcome(Some(ERROR_LOCK_VIOLATION as i32)),
                Ok(Claim::Contended)
            ));
            for code in [ERROR_ACCESS_DENIED, ERROR_INVALID_HANDLE] {
                assert!(matches!(
                    claim_outcome(Some(code as i32)),
                    Err(NativeFailure::Changed)
                ));
            }
        }
        assert!(matches!(claim_outcome(None), Err(NativeFailure::Changed)));
    }

    #[test]
    fn scan_skips_a_vanished_uncommitted_entry_but_not_a_committed_one() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("relavium-scan-open-{}-{stamp}", std::process::id()));
        fs::create_dir(&dir).expect("fixture");
        let nonce = "c".repeat(32);
        let reserved = format!("{nonce}.reserved");
        let prepare = format!("{nonce}.prepare");
        let record = format!("{nonce}.record");
        // A producer's `.reserved` and `.prepare` can be gone between the listing and the open.
        assert!(matches!(
            open_scanned(&reserved, &dir.join(&reserved)),
            Ok(None)
        ));
        assert!(matches!(
            open_scanned(&prepare, &dir.join(&prepare)),
            Ok(None)
        ));
        // A committed record, the lock and a malformed name are never removed under the scan's own
        // claim, so their absence is a changed index.
        for name in [record.as_str(), "inventory.lock", "not-a-nonce.reserved"] {
            assert!(
                matches!(
                    open_scanned(name, &dir.join(name)),
                    Err(NativeFailure::Changed)
                ),
                "{name}"
            );
        }
        // Anything that is there is opened as before.
        fs::write(dir.join(&reserved), b"").expect("entry");
        assert!(matches!(
            open_scanned(&reserved, &dir.join(&reserved)),
            Ok(Some(_))
        ));
        fs::remove_dir_all(dir).expect("remove fixture");
    }

    // POSIX only: the producer's unlink leaves the scan holding a file whose link count is zero, which
    // the private-file check refuses. Windows keeps a deleted-but-open file in a delete-pending state
    // that only the eight-target CI can observe.
    #[cfg(unix)]
    #[test]
    fn scan_skips_an_uncommitted_entry_unlinked_after_it_was_opened() {
        {
            let (root, home) = fixture_home("scan-unlinked");
            let index = Index::<TestProfile>::open(&root, true).expect("index");
            let nonce = "d".repeat(32);
            for (suffix, skipped) in [("reserved", true), ("prepare", true), ("record", false)] {
                let name = format!("{nonce}.{suffix}");
                let path = index.path.join(&name);
                drop(
                    TestProfile::create_private_file(&index.directory, OsStr::new(&name))
                        .expect("entry"),
                );
                let file = open_scanned(&name, &path)
                    .expect("open")
                    .expect("the entry is there");
                fs::remove_file(&path).expect("unlinked under the scan");
                let outcome = verified_entry_size::<TestProfile>(&name, &path, &file);
                if skipped {
                    assert!(matches!(outcome, Ok(None)), "{suffix} is skipped");
                } else {
                    assert!(outcome.is_err(), "a committed record stays fatal");
                }
            }
            // A file that is still there and fails the private-file check is not a vanished entry.
            let name = format!("{nonce}.reserved");
            let path = index.path.join(&name);
            drop(
                TestProfile::create_private_file(&index.directory, OsStr::new(&name))
                    .expect("entry"),
            );
            let file = open_scanned(&name, &path)
                .expect("open")
                .expect("the entry is there");
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("widen mode");
            }
            assert!(matches!(
                verified_entry_size::<TestProfile>(&name, &path, &file),
                Err(_)
            ));
            drop(file);
            drop(index);
            drop(home);
            fs::remove_dir_all(root).expect("remove fixture");
        }
    }

    // POSIX only: a Windows scan can meet a delete-pending entry (access denied or a sharing
    // violation instead of not-found), which only the eight-target CI can observe.
    #[cfg(unix)]
    #[test]
    fn scan_survives_concurrent_promotion_churn() {
        // A producer pins WITHOUT the allocation claim: it renames `.prepare` to `.record` and removes
        // `.reserved`. This stress test only creates and removes `.reserved` entries (the removal half
        // of a pin; the rename half has its own deterministic tests): a scan that lists such an entry and
        // then finds it gone must skip it, not call the whole index changed (78 and 102 of 200 recovery
        // passes failed under this churn before the fix, in two runs).
        let (root, home) = fixture_home("scan-churn");
        let index = Index::<TestProfile>::open(&root, true).expect("index");
        drop(
            index
                .allocation_lock()
                .expect("the first claim creates the lock file"),
        );
        let directory = index.directory.try_clone().expect("directory handle");
        let path = index.path.clone();
        let stop = AtomicBool::new(false);
        // A failing scan must end the test, never hang it: record the first failure and let the
        // churner stop before the scope joins it.
        let mut failure = None;
        std::thread::scope(|scope| {
            let churn = scope.spawn(|| {
                let mut counter = 0_u128;
                while !stop.load(Ordering::Acquire) {
                    counter += 1;
                    let name = format!("{counter:032x}.reserved");
                    let file = TestProfile::create_private_file(&directory, OsStr::new(&name))
                        .expect("churn create");
                    drop(file);
                    fs::remove_file(path.join(&name)).expect("churn remove");
                }
                counter
            });
            for round in 0..300 {
                if let Err(error) = index.entries(Instant::now(), None) {
                    failure = Some(format!("scan {round}: {error:?}"));
                    break;
                }
            }
            stop.store(true, Ordering::Release);
            assert!(churn.join().expect("churn thread") > 0);
        });
        assert_eq!(failure, None, "a scan failed while entries churned");
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn pin_removes_only_the_reservation_it_created() {
        let (root, home) = fixture_home("pin-reservation");
        let mut owned = OwnedStage::<TestProfile>::reserve(&root, &home, &root, &"8".repeat(32))
            .expect("reserve");
        let reserved = owned.index.path.join(format!("{}.reserved", owned.nonce));
        // The name now belongs to a file this producer did not create: its held handle is another file.
        let other = TestProfile::create_private_file(&owned.index.directory, OsStr::new("other"))
            .expect("another empty private file");
        let original = std::mem::replace(&mut owned.reservation, other);
        assert!(matches!(
            owned.remove_own_reservation(),
            Err(NativeFailure::Changed)
        ));
        assert!(reserved.exists(), "the file under the name must stay");
        // With its own handle back, the same call removes exactly that file.
        owned.reservation = original;
        // The file under the name is the producer's own, but not empty: it is not the reservation it made.
        {
            let mut writer = OpenOptions::new()
                .write(true)
                .open(&reserved)
                .expect("a second handle");
            writer.write_all(b"x").expect("bytes");
        }
        assert!(matches!(
            owned.remove_own_reservation(),
            Err(NativeFailure::Changed)
        ));
        assert!(reserved.exists(), "a nonempty reservation stays");
        OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&reserved)
            .expect("truncate");
        // POSIX only: a mode wider than private is refused as well.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&reserved, fs::Permissions::from_mode(0o644)).expect("widen");
            assert!(owned.remove_own_reservation().is_err());
            assert!(reserved.exists(), "a widened reservation stays");
            fs::set_permissions(&reserved, fs::Permissions::from_mode(0o600)).expect("restore");
        }
        owned.remove_own_reservation().expect("own reservation");
        assert!(!reserved.exists());
        drop(owned);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn pin_refuses_a_reservation_it_did_not_create() {
        // The pin itself, not only its helper: with the name held by a file other than the producer's own
        // handle, the pin fails, the file under the name stays, and the already committed record keeps
        // the artifact protected.
        let (root, home) = fixture_home("pin-foreign");
        let mut owned = OwnedStage::<TestProfile>::reserve(&root, &home, &root, &"9".repeat(32))
            .expect("reserve");
        let stage = TestProfile::create_private_directory(owned.stage_path()).expect("stage");
        let payload =
            TestProfile::create_private_file(&stage, OsStr::new("payload")).expect("payload");
        let stage_path = owned.stage_path().to_owned();
        let reserved = owned.index.path.join(format!("{}.reserved", owned.nonce));
        let other = TestProfile::create_private_file(&owned.index.directory, OsStr::new("other"))
            .expect("another empty private file");
        let original = std::mem::replace(&mut owned.reservation, other);
        assert!(owned.pin_empty(&stage, &payload, &stage_path).is_err());
        assert!(reserved.exists(), "the file under the name must stay");
        assert!(
            owned
                .index
                .path
                .join(format!("{}.record", owned.nonce))
                .exists(),
            "the record was committed before the removal and keeps protecting the artifact"
        );
        owned.reservation = original;
        drop(payload);
        drop(stage);
        drop(owned);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_vanished_entry_still_counts_toward_the_bound_and_the_scan_has_slack() {
        let (root, home) = fixture_home("scan-bound");
        let index = Index::<TestProfile>::open(&root, true).expect("index");
        let name = |n: usize| format!("{n:032x}.reserved");
        let create = |n: usize| {
            drop(
                TestProfile::create_private_file(&index.directory, OsStr::new(&name(n)))
                    .expect("reservation"),
            );
        };
        // At the bound, with the last entry finished by its producer exactly while the scan lists it:
        // it must still be counted, or `reserve` would allocate one past the bound.
        (0..MAX_RECORDS).for_each(&create);
        let ghost = name(MAX_RECORDS - 1);
        let ghost_path = index.path.join(&ghost);
        ON_ENTRY.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |entry: &str| {
                if entry == ghost {
                    fs::remove_file(&ghost_path).expect("the producer finished");
                }
            }));
        });
        let listed = index.entries(Instant::now(), None).expect("scan");
        clear_hooks();
        assert_eq!(listed.len(), MAX_RECORDS);
        // Past the bound `reserve` refuses, but a scan (and so a recovery pass) tolerates a small
        // overshoot instead of failing closed with nothing supported to clear it.
        (MAX_RECORDS..MAX_RECORDS + 2).for_each(&create);
        assert!(OwnedStage::<TestProfile>::reserve(&root, &home, &root, &"e".repeat(32)).is_err());
        assert!(index.entries(Instant::now(), None).is_ok());
        // The vanished entry is gone from disk, so 127 + 2 are there now; fill up to exactly the slack.
        (MAX_RECORDS + 2..MAX_RECORDS + SCAN_SLACK + 1).for_each(&create);
        assert_eq!(
            index
                .entries(Instant::now(), None)
                .expect("at the slack")
                .len(),
            MAX_RECORDS + SCAN_SLACK
        );
        create(MAX_RECORDS + SCAN_SLACK + 1);
        assert!(index.entries(Instant::now(), None).is_err());
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn a_vanished_entry_is_counted_against_the_scan_bound() {
        let name = |n: usize| format!("{n:032x}.reserved");
        let mut nonces = BTreeSet::new();
        let mut entries = Vec::new();
        for n in 0..MAX_RECORDS + SCAN_SLACK {
            note_vanished(&name(n), &mut nonces, &mut entries).expect("within the scan bound");
        }
        assert_eq!(entries.len(), MAX_RECORDS + SCAN_SLACK);
        assert!(matches!(
            note_vanished(&name(MAX_RECORDS + SCAN_SLACK), &mut nonces, &mut entries),
            Err(NativeFailure::Changed)
        ));
        // Only an uncommitted entry can be a vanished one.
        assert!(matches!(
            note_vanished(
                &format!("{:032x}.record", 1_u8),
                &mut BTreeSet::new(),
                &mut Vec::new()
            ),
            Err(NativeFailure::Changed)
        ));
    }

    // POSIX only: an unlinked-but-open file has a link count of zero there.
    #[cfg(unix)]
    #[test]
    fn an_entry_unlinked_after_it_was_opened_still_counts_toward_the_bound() {
        let (root, home) = fixture_home("scan-opened");
        let index = Index::<TestProfile>::open(&root, true).expect("index");
        let name = |n: usize| format!("{n:032x}.reserved");
        for n in 0..MAX_RECORDS {
            drop(
                TestProfile::create_private_file(&index.directory, OsStr::new(&name(n)))
                    .expect("reservation"),
            );
        }
        let ghost = name(MAX_RECORDS - 1);
        let ghost_path = index.path.join(&ghost);
        ON_OPENED.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |entry: &str| {
                if entry == ghost {
                    fs::remove_file(&ghost_path).expect("the producer finished");
                }
            }));
        });
        let listed = index.entries(Instant::now(), None).expect("scan");
        clear_hooks();
        assert_eq!(
            listed.len(),
            MAX_RECORDS,
            "the unlinked entry must stay counted"
        );
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    // POSIX only: replacing a lock file that another process holds open is done with unlink and create.
    #[cfg(unix)]
    #[test]
    fn a_claim_on_a_replaced_lock_file_is_refused() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("claim-replaced");
        let lock_path = index.path.join("inventory.lock");
        let holder = std::cell::Cell::new(Some(hold_allocation_claim(&index)));
        let directory = index.directory.try_clone().expect("directory handle");
        {
            let lock_path = lock_path.clone();
            // While the writer waits on the old file, it is unlinked and a new one takes the name.
            on_contended(move || {
                fs::remove_file(&lock_path).expect("unlink");
                drop(
                    TestProfile::create_private_file(&directory, OsStr::new("inventory.lock"))
                        .expect("a new lock file"),
                );
                drop(holder.take());
            });
        }
        assert!(
            matches!(index.allocation_lock(), Err(NativeFailure::Changed)),
            "a claim on an orphaned inode would split the exclusion domain"
        );
        clear_hooks();
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    // POSIX only: see `a_claim_on_a_replaced_lock_file_is_refused`.
    #[cfg(unix)]
    #[test]
    fn recovery_refuses_a_claim_on_a_replaced_lock_file() {
        let _serial = claim_tests_serial();
        let (root, home, index) = fixture_index("recover-replaced");
        let lock_path = index.path.join("inventory.lock");
        let holder = std::cell::Cell::new(Some(hold_allocation_claim(&index)));
        let directory = index.directory.try_clone().expect("directory handle");
        on_contended(move || {
            fs::remove_file(&lock_path).expect("unlink");
            drop(
                TestProfile::create_private_file(&directory, OsStr::new("inventory.lock"))
                    .expect("a new lock file"),
            );
            drop(holder.take());
        });
        assert!(
            matches!(recover::<TestProfile>(&root), Err(NativeFailure::Changed)),
            "recovery must not run on an orphaned lock inode"
        );
        clear_hooks();
        drop(index);
        drop(home);
        fs::remove_dir_all(root).expect("remove fixture");
    }

    // POSIX only: a descriptor that is not open stands for an error that is not contention.
    #[cfg(unix)]
    #[test]
    fn a_claim_error_that_is_not_contention_fails_at_once() {
        use std::os::fd::FromRawFd;
        let _serial = claim_tests_serial();
        let bogus = unsafe { File::from_raw_fd(1_000_000) };
        let began = Instant::now();
        assert!(matches!(
            lock_within(&bogus, Instant::now(), None, true),
            Err(NativeFailure::Changed)
        ));
        assert!(
            began.elapsed() < Duration::from_millis(500),
            "a non-contention error must not be waited out"
        );
        assert_eq!(CLAIM_WAITERS.load(Ordering::Acquire), 0);
        // It was never a valid descriptor: closing it again would be the only thing that could go wrong.
        std::mem::forget(bogus);
    }

    #[test]
    fn record_encode_enforces_the_decode_invariants() {
        let id = NativeIdentity {
            volume: 1,
            object: 2,
            node_dev: 3,
            node_ino: 4,
        };
        let nonce = "b".repeat(32);
        let base = if cfg!(windows) {
            "C:\\relavium"
        } else {
            "/relavium"
        };
        let locator = |pid: u32| PathBuf::from(base).join(format!("{PREFIX}{pid}.{nonce}"));
        let record = |pid: u32, stage: PathBuf| Record {
            version: RecordVersion::V2,
            pid,
            nonce: nonce.clone(),
            owner: "owner".to_owned(),
            stage,
            parent: id,
            directory: id,
            payload: id,
        };
        let good = record(7, locator(7));
        let decoded = Record::decode(&good.encode().expect("a well-formed record encodes"))
            .expect("and decodes");
        assert_eq!((decoded.pid, &decoded.stage), (7, &good.stage));
        // Everything `decode` refuses must already be refused by `encode`: a record that could be
        // written but not read back would make every later scan of the index fail closed.
        let too_big = i32::MAX as u32 + 1;
        assert!(record(0, locator(0)).encode().is_err(), "pid 0");
        assert!(
            record(too_big, locator(too_big)).encode().is_err(),
            "pid beyond i32"
        );
        assert!(
            record(7, PathBuf::from(format!("relavium/{PREFIX}7.{nonce}")))
                .encode()
                .is_err(),
            "relative locator"
        );
        assert!(
            record(7, locator(8)).encode().is_err(),
            "locator names another pid"
        );
        let climbing = PathBuf::from(base)
            .join("..")
            .join("relavium")
            .join(format!("{PREFIX}7.{nonce}"));
        assert!(record(7, climbing).encode().is_err(), "`..` component");
        // The TypeScript reader requires `resolve(stage) === stage`: a locator that is not in normalized
        // form (a `.` in the middle, a repeated or a trailing separator) must be refused here as well.
        // `Path::components` drops those silently, so only the string comparison can see them.
        let sep = std::path::MAIN_SEPARATOR;
        let name = format!("{PREFIX}7.{nonce}");
        for (what, text) in [
            ("a `.` in the middle", format!("{base}{sep}.{sep}{name}")),
            ("a repeated separator", format!("{base}{sep}{sep}{name}")),
            ("a trailing separator", format!("{base}{sep}{name}{sep}")),
        ] {
            let locator = PathBuf::from(text);
            assert!(record(7, locator).encode().is_err(), "{what}");
        }
        // The other fields the decoder bounds.
        let mut long_owner = record(7, locator(7));
        long_owner.owner = "o".repeat(185);
        assert!(long_owner.encode().is_err(), "owner longer than 184 bytes");
        let mut empty_owner = record(7, locator(7));
        empty_owner.owner = String::new();
        assert!(empty_owner.encode().is_err(), "empty owner");
        // Self-consistent locators, so that only the length check and only the nonce check can refuse them.
        let short_nonce = "b".repeat(31);
        let mut bad_nonce = record(
            7,
            PathBuf::from(base).join(format!("{PREFIX}7.{short_nonce}")),
        );
        bad_nonce.nonce = short_nonce;
        assert!(
            bad_nonce.encode().is_err(),
            "nonce that is not 32 hex digits"
        );
        let too_long = PathBuf::from(base)
            .join("a".repeat(4100))
            .join(format!("{PREFIX}7.{nonce}"));
        assert!(
            valid_locator(&too_long, 7, &nonce),
            "only the length can refuse it"
        );
        assert!(
            record(7, too_long).encode().is_err(),
            "locator longer than 4096 bytes"
        );
    }
}
