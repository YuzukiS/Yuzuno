//! Local NVIDIA GPUs as admission resources. A device is known by its UUID;
//! a job declares the GPU memory it needs, and admission reserves devices in
//! the same transaction as CPU and RAM, for the same candidate job. Samples
//! come from NVML or nvidia-smi through the host helper. Only memory figures
//! are used: on WSL the process list can be empty while the card is in use,
//! so an empty list never means an idle card, and a missing or stale sample
//! makes GPU jobs wait. Managed jobs share a device only after the user opens
//! it for sharing. None of this isolates memory or divides compute: it is
//! admission among this Core's managed jobs, not control of the card.
use crate::{model::now, store::Store};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};

/// A sample older than this is not used for admission.
pub(super) const STALE_SECS: i64 = 60;
/// Memory kept free on a device by default when checking a request.
pub(super) const DEFAULT_HEADROOM_MIB: u64 = 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GpuRequest {
    #[serde(default = "one")]
    pub count: u32,
    /// Specific devices by UUID; any known device when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<String>,
    pub memory_mi_b: u64,
    #[serde(default, skip_serializing_if = "GpuMode::is_default")]
    pub mode: GpuMode,
}
fn one() -> u32 {
    1
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GpuMode {
    /// The only managed GPU job on its device (the default).
    #[default]
    Exclusive,
    /// May share a device the user opened for sharing, by declared memory.
    Shared,
}
impl GpuMode {
    fn is_default(&self) -> bool {
        *self == GpuMode::Exclusive
    }
}

impl GpuRequest {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!((1..=8).contains(&self.count), "gpu.count must be 1–8");
        ensure!(
            self.devices.len() <= 8
                && self
                    .devices
                    .iter()
                    .all(|d| d.starts_with("GPU-") && d.len() <= 64)
                && self.devices.iter().collect::<BTreeSet<_>>().len() == self.devices.len()
                && (self.devices.is_empty() || self.count as usize <= self.devices.len()),
            "gpu.devices lists distinct device UUIDs (GPU-…), at least gpu.count of them"
        );
        ensure!(
            (64..=1_048_576).contains(&self.memory_mi_b),
            "gpu.memoryMiB must be 64–1048576"
        );
        Ok(())
    }
}

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_job_gpus(uuid TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_job_gpu_sample(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS local_job_gpu_settings(uuid TEXT PRIMARY KEY, data TEXT NOT NULL);",
    )?;
    Ok(())
}

/// A device as admission sees it now.
pub(super) struct Device {
    pub uuid: String,
    pub index: Option<u64>,
    pub name: String,
    pub total: u64,
    /// Free memory in the current sample; None if the device is not in it.
    pub free: Option<u64>,
    pub open: bool,
    pub closed_reason: Option<String>,
    /// "user" or "agent": who closed it to new jobs.
    pub closed_by: Option<String>,
    pub sharing: bool,
    pub headroom: u64,
    /// (job id, job name, memory MiB, shared)
    pub reservations: Vec<(String, String, u64, bool)>,
}

impl Device {
    /// The most this device can give one job: its total less the memory kept free.
    pub fn limit(&self) -> u64 {
        self.total.saturating_sub(self.headroom)
    }
}

/// The devices, their latest sample and settings, and what managed jobs hold.
pub(super) struct View {
    pub problem: Option<String>,
    pub observed_at: Option<String>,
    pub devices: Vec<Device>,
}

fn settings(db: &Connection, uuid: &str) -> Result<Value> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM local_job_gpu_settings WHERE uuid=?1",
            [uuid],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .map(|r| serde_json::from_str(&r))
        .transpose()?
        .unwrap_or_else(|| json!({})))
}

pub(super) fn view(db: &Connection) -> Result<View> {
    let sample: Option<String> = db
        .query_row(
            "SELECT data FROM local_job_gpu_sample WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let sample: Value = sample
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(Value::Null);
    let observed_at = sample["observedAt"].as_str().map(str::to_owned);
    let fresh = observed_at
        .as_deref()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| {
            (chrono::Utc::now() - at.with_timezone(&chrono::Utc)).num_seconds() <= STALE_SECS
        });
    let problem = if sample.is_null() {
        Some("no GPU sample has been taken yet".to_owned())
    } else if let Some(error) = sample["error"].as_str() {
        Some(format!("GPU sampling failed: {error}"))
    } else if !fresh {
        Some(format!("the last GPU sample is older than {STALE_SECS} s"))
    } else {
        None
    };
    let mut reservations: Vec<(String, String, String, u64, bool)> = Vec::new();
    let mut q = db.prepare("SELECT id,data FROM local_jobs WHERE reserved=1")?;
    for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (id, raw) = row?;
        let job: Value = serde_json::from_str(&raw)?;
        for held in job["gpuReservation"].as_array().into_iter().flatten() {
            reservations.push((
                held["uuid"].as_str().unwrap_or("").to_owned(),
                id.clone(),
                job["name"].as_str().unwrap_or("").to_owned(),
                held["memoryMiB"].as_u64().unwrap_or(0),
                held["mode"] == "shared",
            ));
        }
    }
    let mut known = db.prepare("SELECT uuid,data FROM local_job_gpus ORDER BY uuid")?;
    let rows = known
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut devices = Vec::new();
    for (uuid, raw) in rows {
        let identity: Value = serde_json::from_str(&raw)?;
        let now = sample["devices"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|d| d["uuid"] == uuid.as_str());
        let setting = settings(db, &uuid)?;
        devices.push(Device {
            index: now.and_then(|d| d["index"].as_u64()),
            name: identity["name"].as_str().unwrap_or("GPU").to_owned(),
            total: identity["memoryTotalMiB"].as_u64().unwrap_or(0),
            free: if problem.is_none() {
                now.and_then(|d| d["memoryFreeMiB"].as_u64())
            } else {
                None
            },
            open: setting["admission"] != "closed",
            closed_reason: setting["reason"].as_str().map(str::to_owned),
            closed_by: setting["closedBy"].as_str().map(str::to_owned),
            sharing: setting["sharing"] == true,
            headroom: setting["headroomMiB"]
                .as_u64()
                .unwrap_or(DEFAULT_HEADROOM_MIB),
            reservations: reservations
                .iter()
                .filter(|r| r.0 == uuid)
                .map(|r| (r.1.clone(), r.2.clone(), r.3, r.4))
                .collect(),
            uuid,
        });
    }
    devices.sort_by_key(|d| (d.index.unwrap_or(u64::MAX), d.uuid.clone()));
    Ok(View {
        problem,
        observed_at,
        devices,
    })
}

/// Devices for one request, or why not and which devices it waits for.
pub(super) fn fit(
    request: &GpuRequest,
    view: &View,
    held: &HashSet<String>,
) -> Result<Vec<Value>, (String, Vec<String>)> {
    let wanted: Vec<&Device> = view
        .devices
        .iter()
        .filter(|d| request.devices.is_empty() || request.devices.contains(&d.uuid))
        .collect();
    // The devices this request could ever be given: those whose total, less
    // the memory kept free, holds it (the setting may have been raised after
    // submission). A named device not seen yet counts until it is.
    let feasible: Vec<String> = if request.devices.is_empty() {
        wanted
            .iter()
            .filter(|d| request.memory_mi_b <= d.limit())
            .map(|d| d.uuid.clone())
            .collect()
    } else {
        request
            .devices
            .iter()
            .filter(|u| {
                view.devices
                    .iter()
                    .find(|d| &d.uuid == *u)
                    .is_none_or(|d| request.memory_mi_b <= d.limit())
            })
            .cloned()
            .collect()
    };
    // Too few of them for the whole request: it can never start, so it keeps
    // no device from other jobs, and says why. Checked before any device is
    // held and before the sample, which does not change it. A host with no
    // device known yet is not judged here: the job waits for a sample.
    if !view.devices.is_empty() && feasible.len() < request.count as usize {
        let too_small: Vec<String> = wanted
            .iter()
            .filter(|d| request.memory_mi_b > d.limit())
            .map(|d| {
                format!(
                    "{} ({}) can never hold {} MiB: {} MiB in all, {} MiB kept free",
                    d.name,
                    short(&d.uuid),
                    request.memory_mi_b,
                    d.total,
                    d.headroom
                )
            })
            .collect();
        let detail = if too_small.is_empty() {
            format!("only {} known device(s) can hold it", feasible.len())
        } else {
            too_small.join("; ")
        };
        return Err((
            format!(
                "Waiting for a GPU: this job can never get {} GPU(s) with {} MiB each; {detail}",
                request.count, request.memory_mi_b
            ),
            Vec::new(),
        ));
    }
    let wanted_ids = feasible;
    if let Some(problem) = &view.problem {
        return Err((
            format!(
                "Waiting for a current GPU sample: {problem}. GPU jobs start only on a current sample; CPU jobs are not held"
            ),
            wanted_ids,
        ));
    }
    if let Some(missing) = request.devices.iter().find(|u| {
        !view
            .devices
            .iter()
            .any(|d| &d.uuid == *u && d.free.is_some())
    }) {
        return Err((
            format!("Waiting for GPU {missing}, which is not present in the current sample"),
            wanted_ids,
        ));
    }
    if wanted.is_empty() {
        return Err((
            "Waiting for a GPU: no NVIDIA device is present in the current sample".to_owned(),
            wanted_ids,
        ));
    }
    let shared = request.mode == GpuMode::Shared;
    let mut chosen = Vec::new();
    let mut reasons = Vec::new();
    for device in wanted {
        let name = format!("{} ({})", device.name, short(&device.uuid));
        if request.memory_mi_b > device.limit() {
            reasons.push(format!(
                "{name} can never hold {} MiB: {} MiB in all, {} MiB kept free",
                request.memory_mi_b, device.total, device.headroom
            ));
            continue;
        }
        // Known from an earlier sample but not in this one: not usable now.
        let Some(free) = device.free else {
            reasons.push(format!("{name} is not present in the current sample"));
            continue;
        };
        if held.contains(&device.uuid) {
            reasons.push(format!("{name} is held for an earlier job waiting for it"));
            continue;
        }
        if !device.open {
            reasons.push(format!(
                "{name} is closed to new jobs{}",
                device
                    .closed_reason
                    .as_deref()
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default()
            ));
            continue;
        }
        let holders: Vec<&str> = device.reservations.iter().map(|r| r.1.as_str()).collect();
        if !shared && !holders.is_empty() {
            reasons.push(format!(
                "{name} is in use by managed job {}",
                holders.join(", ")
            ));
            continue;
        }
        if shared && !device.sharing {
            reasons.push(format!(
                "{name} is not open for sharing; by default one managed GPU job uses it at a time"
            ));
            continue;
        }
        if shared && device.reservations.iter().any(|r| !r.3) {
            reasons.push(format!(
                "{name} is used exclusively by managed job {}",
                holders.join(", ")
            ));
            continue;
        }
        // Conservative: the sample may predate reservations made since, so
        // every managed reservation is taken from the free memory sampled,
        // even one whose use the sample already shows.
        // The reason names only what changes with reservations and settings:
        // the free memory itself moves with every sample and is shown with
        // the GPUs, so a waiting job is not rewritten on each resample.
        let reserved: u64 = device.reservations.iter().map(|r| r.2).sum();
        let available = free
            .saturating_sub(reserved)
            .saturating_sub(device.headroom);
        if request.memory_mi_b > available {
            reasons.push(format!(
                "{name} has too little free memory for {} MiB once {reserved} MiB reserved by managed jobs and {} MiB kept free are set aside (its latest free memory is shown with the GPUs)",
                request.memory_mi_b, device.headroom
            ));
            continue;
        }
        chosen.push(
            json!({"uuid":device.uuid,"index":device.index,"name":device.name,
            "memoryMiB":request.memory_mi_b,"mode":if shared { "shared" } else { "exclusive" }}),
        );
        if chosen.len() == request.count as usize {
            return Ok(chosen);
        }
    }
    if reasons.is_empty() {
        reasons.push(format!(
            "{} of {} requested GPUs are available",
            chosen.len(),
            request.count
        ));
    }
    Err((
        format!("Waiting for a GPU: {}", reasons.join("; ")),
        wanted_ids,
    ))
}

fn short(uuid: &str) -> &str {
    uuid.get(..12).unwrap_or(uuid)
}

/// A request no known device can ever hold, or None. Unknown hosts (no
/// sample yet) accept the request; it waits with its reason.
pub(super) fn never_fits(db: &Connection, request: &GpuRequest) -> Result<Option<String>> {
    let mut q = db.prepare("SELECT uuid,data FROM local_job_gpus")?;
    let known = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if known.is_empty() {
        return Ok(None);
    }
    // The most each device can give one job: its total less the memory kept
    // free, the same limit admission applies.
    let mut totals: Vec<(String, u64)> = Vec::new();
    for (uuid, raw) in known {
        let data: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let headroom = settings(db, &uuid)?["headroomMiB"]
            .as_u64()
            .unwrap_or(DEFAULT_HEADROOM_MIB);
        let total = data["memoryTotalMiB"].as_u64().unwrap_or(0);
        totals.push((uuid, total.saturating_sub(headroom)));
    }
    if let Some(missing) = request
        .devices
        .iter()
        .find(|u| !totals.iter().any(|t| &t.0 == *u))
    {
        return Ok(Some(format!("GPU {missing} is not known on this machine")));
    }
    let candidates: Vec<u64> = totals
        .iter()
        .filter(|t| request.devices.is_empty() || request.devices.contains(&t.0))
        .map(|t| t.1)
        .collect();
    let fitting = candidates
        .iter()
        .filter(|total| request.memory_mi_b <= **total)
        .count();
    Ok((fitting < request.count as usize).then(|| {
        format!(
            "This job can never fit: it needs {} MiB on {} GPU(s), and the most a known device can give one job is {} MiB (its total less the memory kept free)",
            request.memory_mi_b,
            request.count,
            candidates.iter().max().copied().unwrap_or(0)
        )
    }))
}

impl Store {
    /// Keep the latest sample and every device seen, by UUID.
    pub(super) fn record_gpu_sample(&self, sample: Value) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut stored = sample.clone();
        stored["observedAt"] = json!(now());
        for device in sample["devices"].as_array().into_iter().flatten() {
            let Some(uuid) = device["uuid"].as_str().filter(|u| u.starts_with("GPU-")) else {
                continue;
            };
            let identity = json!({"uuid":uuid,"name":device["name"],"memoryTotalMiB":device["memoryTotalMiB"],
                "pciBusId":device["pciBusId"],"lastIndex":device["index"],"lastSeenAt":stored["observedAt"]});
            tx.execute(
                "INSERT INTO local_job_gpus(uuid,data) VALUES(?1,?2) ON CONFLICT(uuid) DO UPDATE SET data=excluded.data",
                params![uuid, identity.to_string()],
            )?;
        }
        tx.execute(
            "INSERT INTO local_job_gpu_sample(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            [stored.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Open or close one device to new jobs. Running and paused jobs keep it.
    /// `actor` is the Agent asking, or None for the user. A close the user
    /// made is the user's to undo: an Agent neither reopens it nor replaces
    /// it with its own.
    pub(super) fn set_gpu_admission(
        &self,
        uuid: &str,
        open: bool,
        reason: Option<String>,
        actor: Option<&str>,
    ) -> Result<Value> {
        ensure!(
            reason.as_ref().is_none_or(|r| r.len() <= 200),
            "reason must be at most 200 bytes"
        );
        self.update_gpu_settings(uuid, |s| {
            if actor.is_some() && s["admission"] == "closed" && s["closedBy"] == "user" {
                ensure!(
                    !open,
                    "The user closed this GPU to new jobs; only the user can open it again"
                );
                return Ok(());
            }
            s["admission"] = json!(if open { "open" } else { "closed" });
            s["reason"] = if open { Value::Null } else { json!(reason) };
            s["closedBy"] = match (open, actor) {
                (true, _) => Value::Null,
                (false, None) => json!("user"),
                (false, Some(_)) => json!("agent"),
            };
            s["closedByAgentId"] = if open { Value::Null } else { json!(actor) };
            Ok(())
        })
    }
    /// The user's sharing choice and kept-free memory for one device.
    pub(super) fn set_gpu_sharing(
        &self,
        uuid: &str,
        sharing: Option<bool>,
        headroom: Option<u64>,
    ) -> Result<Value> {
        ensure!(
            headroom.is_none_or(|h| h <= 65536),
            "headroomMiB must be at most 65536"
        );
        self.update_gpu_settings(uuid, |s| {
            if let Some(sharing) = sharing {
                s["sharing"] = json!(sharing);
            }
            if let Some(headroom) = headroom {
                s["headroomMiB"] = json!(headroom);
            }
            Ok(())
        })
    }
    fn update_gpu_settings(
        &self,
        uuid: &str,
        edit: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let known: Option<String> = tx
            .query_row(
                "SELECT uuid FROM local_job_gpus WHERE uuid=?1",
                [uuid],
                |r| r.get(0),
            )
            .optional()?;
        known.context("GPU not known on this machine")?;
        let mut setting = settings(&tx, uuid)?;
        edit(&mut setting)?;
        setting["updatedAt"] = json!(now());
        tx.execute(
            "INSERT INTO local_job_gpu_settings(uuid,data) VALUES(?1,?2) ON CONFLICT(uuid) DO UPDATE SET data=excluded.data",
            params![uuid, setting.to_string()],
        )?;
        let view = devices_value(&tx)?;
        tx.commit()?;
        Ok(view)
    }
    pub(super) fn gpu_devices(&self) -> Result<Value> {
        devices_value(&*self.db.read()?)
    }
}

/// What the Jobs panel, job_budget and the GPU API show.
pub(super) fn devices_value(db: &Connection) -> Result<Value> {
    let view = view(db)?;
    let devices: Vec<Value> = view
        .devices
        .iter()
        .map(|d| {
            json!({"uuid":d.uuid,"index":d.index,"name":d.name,"memoryTotalMiB":d.total,
                "memoryFreeMiB":d.free,"admission":if d.open { "open" } else { "closed" },
                "closedReason":d.closed_reason,"closedBy":d.closed_by,"sharing":d.sharing,"headroomMiB":d.headroom,
                "reservations":d.reservations.iter().map(|r| json!({"jobId":r.0,"name":r.1,"memoryMiB":r.2,"mode":if r.3 { "shared" } else { "exclusive" }})).collect::<Vec<_>>()})
        })
        .collect();
    let sample: Option<String> = db
        .query_row(
            "SELECT data FROM local_job_gpu_sample WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let sample: Value = sample
        .map(|s| serde_json::from_str(&s))
        .transpose()?
        .unwrap_or(Value::Null);
    Ok(
        json!({"devices":devices,"observedAt":view.observed_at,"problem":view.problem,
        "source":sample["source"],"samples":sample["devices"],
        "scope":"Admission among this Core's managed jobs by declared GPU memory. Free memory is the whole card's, other programs included; on WSL the process list can be empty while the card is in use. No memory isolation, hard limit or compute share."}),
    )
}
