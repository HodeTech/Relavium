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
const MAGIC: &[u8; 8] = b"RVSTG001";

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

#[derive(Clone)]
struct Record {
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
        out.extend_from_slice(MAGIC);
        out.push(1);
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
        if bytes.len() < 176 || &bytes[..8] != MAGIC || bytes[8] != 1 || bytes[9..16] != [0; 7] {
            return refused();
        }
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
        let parent_path = home_path.join(".relavium");
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
        self.ensure_context()?;
        tick(start, cancelled)?;
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
            tick(start, cancelled)?;
            if P::identity(file)? != expected {
                return refused();
            }
        }
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-home-reopen");
        let current_home = P::open_parent(&self.home_path)?;
        tick(start, cancelled)?;
        if P::identity(&current_home)? != self.home_id {
            return refused();
        }
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("recheck-parent-private");
        P::verify_private_directory(&self.parent_path, &self.parent)?;
        tick(start, cancelled)?;
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
    pinned_file: Option<File>,
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
        let mut file = trace_failure!(
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
        let rename_result = fs::rename(
            self.index.path.join(format!("{}.prepare", self.nonce)),
            self.index.path.join(format!("{}.record", self.nonce)),
        );
        #[cfg(all(test, windows))]
        if let Err(error) = &rename_result {
            crate::test_hooks::remember_failure(
                rename_error_category(error),
                NativeFailure::Changed,
            );
        }
        trace_failure!("first-pin-rename", io(rename_result))?;
        tick(start, cancelled)?;
        #[cfg(test)]
        crate::test_hooks::checkpoint("pin-index-flush");
        trace_failure!("first-pin-index-flush", io(self.index.directory.sync_all()))?;
        // A failed pin never grants permission to write payload. Preserve its evidence.
        self.record = Some(record);
        self.pinned_file = Some(file);
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
        let file = self.pinned_file.as_ref().ok_or(NativeFailure::Changed)?;
        let _allocation = self.index.allocation_lock()?;
        lock(file)?;
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
        let mut marker_paths = Vec::new();
        if let Some(pending) = &self.pending_file {
            P::verify_private_file(&pending.file)?;
            lock(&pending.file)?;
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
        if let Some(directory) = &self.adopted_directory {
            tick(start, None)?;
            P::verify_private_directory(&self.path, &directory.file)?;
            if P::identity(&directory.file)? != directory.identity {
                return refused();
            }
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
        self.adopted_directory = None;
        self.adopted_payload = None;
        self.pending_record = None;
        self.pending_file = None;
        Ok(())
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
        let _cleanup = cleanup_empty_reservation::<P>(index, reservation, nonce);
        return Err(failure);
    }
    Ok(())
}

fn cleanup_empty_reservation<P: Profile>(
    index: &Index<P>,
    reservation: &File,
    nonce: &str,
) -> Result<(), NativeFailure> {
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
        if record.nonce != nonce
            || record.owner != P::owner_identity()?
            || !producer_dead(record.pid)
        {
            summary.retained += 1;
            continue;
        }
        tick(start, cancelled)?;
        match cleanup_record::<P>(&index, &record, &file, start, true, cancelled) {
            Ok(()) => summary.removed += 1,
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
    let parent_path = canonical.join(".relavium");
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
    index.ensure_context()?;
    tick(start, cancelled)?;
    io(parent.sync_all())?;
    index.recheck_checked(start, cancelled)?;
    if P::identity(marker)? != P::identity(&open_nofollow(&marker_path)?)? {
        return refused();
    }
    tick(start, cancelled)?;
    index.ensure_context()?;
    io(fs::remove_file(marker_path))?;
    index.ensure_context()?;
    tick(start, cancelled)?;
    io(index.directory.sync_all())?;
    Ok(())
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
        let parent_path = fixture.0.join(".relavium");
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
        lock(&first).expect("exclusive first claim");
        let second = open_nofollow(&marker).expect("second descriptor");
        assert!(lock(&second).is_err());
        drop(first);
        lock(&second).expect("kernel releases closed claimant");
        assert!(owned.path.join("payload").is_file());
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
                file: marker,
            });
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
        for pinned in [false, true] {
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
            let recovered = recover::<MacosProfile>(&fixture.0).expect("orphan scan");
            assert_eq!(recovered.removed, usize::from(pinned));
            let count = fs::read_dir(&fixture.0)
                .expect("fixture")
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(PREFIX))
                .count();
            assert_eq!(count, usize::from(!pinned));
        }
    }
}
