import { useState, useEffect } from "react"
import { fetchTargets, createTarget, updateTarget, deleteTarget } from "../api"
import "./targets.css"

// Regions with an eye on geo-redundancy inside the EU; the field stays free text.
const REGIONS = {
    "eu-north-1": "Stockholm (Schweden)",
    "eu-south-2": "Zaragoza (Spanien)",
    "eu-central-1": "Frankfurt",
    "eu-west-1": "Irland",
    "eu-west-3": "Paris",
    "eu-south-1": "Mailand",
    "us-east-1": "N. Virginia",
}

const STORAGE_CLASSES = {
    STANDARD: "Standard",
    STANDARD_IA: "Standard-IA (selten benötigt)",
    ONEZONE_IA: "One Zone-IA",
    INTELLIGENT_TIERING: "Intelligent-Tiering",
    GLACIER_IR: "Glacier Instant Retrieval",
    DEEP_ARCHIVE: "Glacier Deep Archive",
}

// Presets for the S3-compatible stores people actually reach for. "auto" lets
// boto3 decide the addressing style; several self-hosted stores need "path".
const S3_PRESETS = {
    aws: { label: "Amazon S3", endpoint_url: "", addressing: "auto" },
    minio: { label: "MinIO / Garage / Ceph", endpoint_url: "https://minio.lan:9000", addressing: "path" },
    backblaze: { label: "Backblaze B2", endpoint_url: "https://s3.eu-central-003.backblazeb2.com", addressing: "auto" },
    wasabi: { label: "Wasabi", endpoint_url: "https://s3.eu-central-1.wasabisys.com", addressing: "auto" },
    hetzner: { label: "Hetzner Object Storage", endpoint_url: "https://fsn1.your-objectstorage.com", addressing: "auto" },
    custom: { label: "Anderer S3-kompatibler Dienst", endpoint_url: "", addressing: "auto" },
}

const EMPTY = {
    name: "", kind: "s3", region: "eu-north-1", bucket: "", prefix: "nas-backup",
    storage_class: "STANDARD_IA", endpoint_url: "", addressing: "auto", require_mount: false,
}

export default function TargetList() {
    const [targets, setTargets] = useState(null)
    const [error, setError] = useState("")
    const [adding, setAdding] = useState(false)
    const [editingId, setEditingId] = useState(null)

    async function refresh() {
        try {
            setTargets(await fetchTargets())
            setError("")
        } catch (e) {
            setError(e.message)
        }
    }

    useEffect(() => { refresh() }, [])

    async function run(action) {
        try {
            setTargets(await action())
            setError("")
            return true
        } catch (e) {
            setError(e.message)
            return false
        }
    }

    if (!targets && !error) return <div className="backup-status">Lädt…</div>
    if (!targets) return <div className="backup-status error">Backup-Service nicht erreichbar: {error}</div>

    const active = targets.filter(t => t.enabled).length

    return (
        <div className="backup-targets">
            <p className="backup-hint">
                Ein Ziel ist entweder ein Bucket (Amazon S3 oder ein S3-kompatibler Dienst)
                oder ein Verzeichnis — etwa eine eingebundene NFS- oder SMB-Freigabe oder
                eine USB-Platte. Der Job schreibt jede Datei in jedes aktive Ziel;
                verschlüsselt wird nur einmal, geschrieben mehrfach. Fällt ein Ziel aus,
                wird nur dort beim nächsten Lauf nachgeholt.
            </p>
            {active < 2 && (
                <div className="backup-status warn">
                    {active === 0
                        ? "Kein aktives Ziel — es wird nichts gesichert."
                        : "Nur ein aktives Ziel. Für Georedundanz ein zweites in einer anderen Region anlegen."}
                </div>
            )}
            {error && <div className="backup-status error">{error}</div>}

            {targets.map(target => (
                editingId === target.id ? (
                    <TargetForm
                        key={target.id}
                        initial={target}
                        onCancel={() => setEditingId(null)}
                        onSubmit={async (values) => {
                            if (await run(() => updateTarget(target.id, values))) setEditingId(null)
                        }}
                    />
                ) : (
                    <TargetCard
                        key={target.id}
                        target={target}
                        onEdit={() => setEditingId(target.id)}
                        onToggle={() => run(() => updateTarget(target.id, { enabled: !target.enabled }))}
                        onDelete={() => run(() => deleteTarget(target.id))}
                    />
                )
            ))}

            {adding ? (
                <TargetForm
                    initial={EMPTY}
                    onCancel={() => setAdding(false)}
                    onSubmit={async (values) => {
                        if (await run(() => createTarget(values))) setAdding(false)
                    }}
                />
            ) : (
                <button className="primary add-target" onClick={() => setAdding(true)}>
                    Ziel hinzufügen
                </button>
            )}
        </div>
    )
}

function TargetCard({ target, onEdit, onToggle, onDelete }) {
    const isFs = target.kind === "fs"
    const { current, outdated, missing, liveObjects } = target.coverage
    const total = Math.max(liveObjects, current + outdated + missing, 1)
    const pending = outdated + missing
    const [confirming, setConfirming] = useState(false)

    return (
        <div className={`target-card ${target.enabled ? "" : "disabled"}`}>
            <div className="target-head">
                <span className={`target-dot ${target.enabled ? (pending ? "pending" : "ok") : "off"}`} />
                <h4>{target.name}</h4>
                <span className="target-badge kind">{isFs ? "Verzeichnis" : "S3"}</span>
                {!isFs && <span className="target-meta">{REGIONS[target.region] || target.region}</span>}
                {!isFs && <span className="target-meta">{STORAGE_CLASSES[target.storage_class] || target.storage_class}</span>}
                {isFs && target.require_mount === 1 && <span className="target-meta">nur wenn eingehängt</span>}
                {!target.enabled && <span className="target-badge off">inaktiv</span>}
            </div>

            <div className="target-path">
                {isFs
                    ? `${target.bucket}${target.prefix ? `/${target.prefix}` : ""}`
                    : `s3://${target.bucket}${target.prefix ? `/${target.prefix}` : ""}`}
            </div>
            {!isFs && target.endpoint_url && (
                <div className="target-path">{target.endpoint_url}</div>
            )}

            <div className="target-bar" title={`${current} aktuell, ${outdated} veraltet, ${missing} fehlend`}>
                <span className="seg current" style={{ width: `${(current / total) * 100}%` }} />
                <span className="seg outdated" style={{ width: `${(outdated / total) * 100}%` }} />
                <span className="seg missing" style={{ width: `${(missing / total) * 100}%` }} />
            </div>
            <div className="target-numbers">
                <span className="ok">{current} aktuell</span>
                {outdated > 0 && <span className="warn">{outdated} veraltet</span>}
                {missing > 0 && <span className="bad">{missing} fehlen</span>}
                {pending === 0 && liveObjects > 0 && <span className="ok">vollständig</span>}
                <span className="target-meta">von {liveObjects} Dateien</span>
            </div>

            <div className="target-actions">
                <button onClick={onEdit}>Bearbeiten</button>
                <button onClick={onToggle}>{target.enabled ? "Deaktivieren" : "Aktivieren"}</button>
                {confirming ? (
                    <>
                        <button className="danger" onClick={onDelete}>Wirklich entfernen</button>
                        <button onClick={() => setConfirming(false)}>Abbrechen</button>
                    </>
                ) : (
                    <button onClick={() => setConfirming(true)}>Entfernen</button>
                )}
            </div>
            {confirming && (
                <p className="target-warning">
                    Entfernt nur die Verwaltung dieses Ziels. Die Objekte bleiben im Bucket
                    liegen und werden danach von keinem Lauf mehr aufgeräumt.
                </p>
            )}
        </div>
    )
}

function TargetForm({ initial, onSubmit, onCancel }) {
    const [values, setValues] = useState({
        name: initial.name || "",
        kind: initial.kind || "s3",
        region: initial.region || "",
        bucket: initial.bucket || "",
        prefix: initial.prefix || "",
        storage_class: initial.storage_class || "STANDARD_IA",
        endpoint_url: initial.endpoint_url || "",
        addressing: initial.addressing || "auto",
        require_mount: initial.require_mount === 1 || initial.require_mount === true,
    })
    const [preset, setPreset] = useState(() => (initial.endpoint_url ? "custom" : "aws"))
    const [busy, setBusy] = useState(false)
    const isFs = values.kind === "fs"

    function set(key, value) {
        setValues(prev => ({ ...prev, [key]: value }))
    }

    function applyPreset(key) {
        setPreset(key)
        const chosen = S3_PRESETS[key]
        if (chosen) setValues(prev => ({ ...prev, endpoint_url: chosen.endpoint_url, addressing: chosen.addressing }))
    }

    const incomplete = !values.name.trim() || !values.bucket.trim()
        || (!isFs && !values.region.trim())
        || (isFs && !values.bucket.trim().startsWith("/"))

    async function submit() {
        if (incomplete) return
        setBusy(true)
        await onSubmit(values)
        setBusy(false)
    }

    return (
        <div className="target-card editing">
            <div className="target-form">
                <label>Name</label>
                <input value={values.name} onChange={e => set("name", e.target.value)}
                       placeholder="z. B. Spanien" />

                <label>Art</label>
                <select value={values.kind} onChange={e => set("kind", e.target.value)}>
                    <option value="s3">Objektspeicher (S3 oder S3-kompatibel)</option>
                    <option value="fs">Verzeichnis (NFS, SMB, USB, zweite Platte)</option>
                </select>

                {isFs ? (
                    <>
                        <label>Zielverzeichnis</label>
                        <input value={values.bucket} onChange={e => set("bucket", e.target.value)}
                               placeholder="/mnt/backup" />

                        <label>Nur wenn eingehängt</label>
                        <label className="target-check">
                            <input type="checkbox" checked={values.require_mount}
                                   onChange={e => set("require_mount", e.target.checked)} />
                            <span>Abbrechen, wenn das Verzeichnis kein Einhängepunkt ist</span>
                        </label>
                    </>
                ) : (
                    <>
                        <label>Dienst</label>
                        <select value={preset} onChange={e => applyPreset(e.target.value)}>
                            {Object.entries(S3_PRESETS).map(([k, p]) =>
                                <option key={k} value={k}>{p.label}</option>)}
                        </select>

                        {preset !== "aws" && (
                            <>
                                <label>Endpunkt</label>
                                <input value={values.endpoint_url}
                                       onChange={e => set("endpoint_url", e.target.value)}
                                       placeholder="https://…" />

                                <label>Adressierung</label>
                                <select value={values.addressing} onChange={e => set("addressing", e.target.value)}>
                                    <option value="auto">Automatisch</option>
                                    <option value="path">Pfad-Stil (viele selbst gehostete Dienste)</option>
                                    <option value="virtual">Virtual-Host-Stil</option>
                                </select>
                            </>
                        )}

                        <label>Region</label>
                        <input list="target-regions" value={values.region}
                               onChange={e => set("region", e.target.value)} />
                        <datalist id="target-regions">
                            {Object.entries(REGIONS).map(([code, label]) =>
                                <option key={code} value={code}>{label}</option>)}
                        </datalist>

                        <label>Bucket</label>
                        <input value={values.bucket} onChange={e => set("bucket", e.target.value)} />

                        <label>Speicherklasse</label>
                        <select value={values.storage_class} onChange={e => set("storage_class", e.target.value)}>
                            {Object.entries(STORAGE_CLASSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                    </>
                )}

                <label>Präfix</label>
                <input value={values.prefix} onChange={e => set("prefix", e.target.value)}
                       placeholder="nas-backup" />
            </div>
            <p className="target-warning">
                {isFs
                    ? "Das Verzeichnis muss existieren und für den Backup-Dienst beschreibbar sein. Bei Netzwerkfreigaben lohnt sich „nur wenn eingehängt“: sonst schreibt der Lauf ins leere Mount-Verzeichnis der lokalen Platte."
                    : "Der Bucket muss existieren und den konfigurierten Zugangsdaten Schreib-, Lese- und Löschrechte geben."}
                {" "}Beim nächsten Lauf holt ein neues Ziel alle bereits gesicherten Dateien nach.
            </p>
            <div className="target-actions">
                <button className="primary" onClick={submit} disabled={busy || incomplete}>
                    {busy ? "Speichert…" : "Speichern"}
                </button>
                <button onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}
