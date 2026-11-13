//! Private, bounded artifact ownership inventory. This is never an effect journal.
use crate::profile_api::{NativeFailure, NativeIdentity, Profile};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const MAX_RECORDS: usize = 128;
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
    if start.elapsed() > Duration::from_secs(2) {
        refused()
    } else {
        Ok(())
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
        if pid == 0
            || pid > i32::MAX as u32
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
        if !valid_nonce(&nonce)
            || !stage.is_absolute()
            || stage.file_name() != Some(OsStr::new(&format!("{PREFIX}{pid}.{nonce}")))
            || stage.components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
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
            let file = open_nofollow(&entry.path())?;
            tick(start, cancelled)?;
            P::verify_private_file(&file)?;
            let size = io(file.metadata())?.len();
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
            if nonces.len() > MAX_RECORDS {
                return refused();
            }
        }
        self.recheck_checked(start, cancelled)?;
        Ok(entries)
    }
    fn allocation_lock(&self) -> Result<File, NativeFailure> {
        self.allocation_lock_checked(Instant::now(), None)
    }
    fn allocation_lock_checked(
        &self,
        start: Instant,
        cancelled: Option<&AtomicBool>,
    ) -> Result<File, NativeFailure> {
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
        trace_failure!("first-lock-acquire", lock(&file))?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("lock-recheck");
        trace_failure!("first-lock-recheck", self.recheck_checked(start, cancelled))?;
        Ok(file)
    }
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
        let _claim = trace_failure!(
            "first-reserve-lock",
            index.allocation_lock_checked(start, cancelled)
        )?;
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
            io(fs::remove_file(
                self.index.path.join(format!("{}.reserved", self.nonce)),
            ))
        )?;
        trace_failure!(
            "first-pin-context-after-remove",
            self.index.ensure_context()
        )?;
        tick(start, cancelled)?;
        trace_failure!("first-pin-final-flush", io(self.index.directory.sync_all()))?;
        Ok(())
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
        let _allocation = self.index.allocation_lock()?;
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
        cleanup_record::<P>(&self.index, record, file, Instant::now(), false, None)?;
        self.record = None;
        self.pinned_file = None;
        Ok(())
    }
    fn cleanup_ephemeral(&mut self) -> Result<(), NativeFailure> {
        let start = Instant::now();
        let _allocation = self.index.allocation_lock()?;
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
    lock(&allocation)?;
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
fn open_nofollow(path: &Path) -> Result<File, NativeFailure> {
    use std::os::unix::fs::OpenOptionsExt;
    io(OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path))
}
#[cfg(windows)]
fn open_nofollow(path: &Path) -> Result<File, NativeFailure> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    io(OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path))
}
#[cfg(unix)]
fn lock(file: &File) -> Result<(), NativeFailure> {
    use std::os::fd::AsRawFd;
    // Nonblocking, descriptor-bound kernel claim; process death releases it.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        refused()
    }
}
#[cfg(windows)]
fn lock(file: &File) -> Result<(), NativeFailure> {
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
        Ok(())
    } else {
        refused()
    }
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
}
