import { useState, useEffect, useCallback, useRef } from "react"
import { fetchStatus, fetchRuns, fetchRun, startRun, fetchObjects } from "../api"
import "./status.css"

const RUN_STATUS = { ok: "Erfolgreich", error: "Fehler", running: "Läuft" }

function formatBytes(bytes) {
    if (!bytes) return "0 B"
    const units = ["B", "kB", "MB", "GB", "TB"]
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatTime(iso) {
    if (!iso) return "–"
    const d = new Date(iso)
    return isNaN(d) ? iso : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
}

export default function BackupStatus() {
    const [status, setStatus] = useState(null)
    const [runs, setRuns] = useState([])
    const [openRun, setOpenRun] = useState(null)
    const [marked, setMarked] = useState([])
    const [error, setError] = useState("")
    const [starting, setStarting] = useState(false)
    const pollRef = useRef(null)

    const refresh = useCallback(async () => {
        try {
            const [s, r] = await Promise.all([fetchStatus(), fetchRuns(15)])
            setStatus(s)
            setRuns(r)
            setError("")
            return s
        } catch (e) {
            setError(e.message)
            return null
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    // While a run is active, poll so the user sees it finish without reloading.
    useEffect(() => {
        if (!status?.runningRun) {
            clearInterval(pollRef.current)
            return
        }
        pollRef.current = setInterval(refresh, 4000)
        return () => clearInterval(pollRef.current)
    }, [status?.runningRun, refresh])

    async function trigger(dryRun) {
        setStarting(true)
        try {
            await startRun(dryRun)
            setTimeout(refresh, 800)
        } catch (e) {
            setError(e.message)
        } finally {
            setStarting(false)
        }
    }

    async function toggleRun(id) {
        if (openRun?.id === id) return setOpenRun(null)
        try {
            setOpenRun(await fetchRun(id))
        } catch (e) {
            setError(e.message)
        }
    }

    async function loadMarked() {
        try {
            setMarked(await fetchObjects({ state: "deleted", limit: 200 }))
        } catch (e) {
            setError(e.message)
        }
    }

    if (!status && !error) return <div className="backup-status">Lädt…</div>
    if (!status) return <div className="backup-status error">Backup-Service nicht erreichbar: {error}</div>

    return (
        <div className="backup-statusview">
            {error && <div className="backup-status error">{error}</div>}

            {!status.enabled && (
                <div className="backup-status warn">
                    Die Sicherung ist deaktiviert — der Cronjob läuft, bricht aber sofort ab.
                    Unter „Einstellungen“ aktivieren.
                </div>
            )}
            {status.problems?.length > 0 && (
                <div className="backup-status warn">
                    <strong>Konfiguration unvollständig:</strong>
                    <ul>{status.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                </div>
            )}

            <div className="stat-row">
                <Stat label="Ausgewählte Ordner" value={status.includedFolders} />
                <Stat label="Dateien in Auswahl" value={status.liveObjects} />
                <Stat label="Datenmenge" value={formatBytes(status.liveBytes)} />
                <Stat label="Auf allen Zielen" value={status.fullyReplicated}
                      hint={`${status.activeTargets} aktive${status.activeTargets === 1 ? "s Ziel" : " Ziele"}`} />
                <Stat label="Löschmarker offen" value={status.markedObjects}
                      hint={`werden nach ${status.retentionDays} Tagen gelöscht`} />
                <Stat label="Letzter Lauf" value={formatTime(status.lastRun?.started_at)} />
            </div>

            <div className="target-summary">
                {status.targets?.length
                    ? status.targets.map(t => <TargetRow key={t.id} target={t} />)
                    : <div className="backup-status warn">
                          Kein Backup-Ziel angelegt — unter „Ziele“ einen Bucket hinzufügen.
                      </div>}
            </div>

            <div className="status-actions">
                <button className="primary" onClick={() => trigger(false)}
                        disabled={starting || !!status.runningRun}>
                    {status.runningRun ? "Sicherung läuft…" : "Jetzt sichern"}
                </button>
                <button onClick={() => trigger(true)} disabled={starting || !!status.runningRun}
                        title="Zeigt an, was passieren würde, ohne etwas hochzuladen oder zu löschen">
                    Probelauf
                </button>
                <button onClick={refresh}>Aktualisieren</button>
            </div>

            <h4>Läufe</h4>
            {!runs.length && <div className="backup-status">Noch kein Lauf aufgezeichnet.</div>}
            <div className="run-list">
                {runs.map(run => (
                    <div key={run.id} className={`run-item ${run.status}`}>
                        <div className="run-head" onClick={() => toggleRun(run.id)}>
                            <span className={`run-dot ${run.status}`} />
                            <span className="run-time">{formatTime(run.started_at)}</span>
                            <span className="run-meta">{RUN_STATUS[run.status] || run.status}</span>
                            <span className="run-meta">{run.trigger === "manual" ? "manuell" : "Cron"}</span>
                            <span className="run-numbers">
                                {run.files_uploaded} gesichert · {formatBytes(run.bytes_uploaded)}
                                {run.files_marked > 0 && ` · ${run.files_marked} Marker`}
                                {run.files_purged > 0 && ` · ${run.files_purged} gelöscht`}
                            </span>
                        </div>
                        {run.error && <div className="run-error">{run.error}</div>}
                        {openRun?.id === run.id && (
                            <pre className="run-log">{openRun.log || "Kein Log vorhanden."}</pre>
                        )}
                    </div>
                ))}
            </div>

            <h4>Offene Löschmarker</h4>
            <p className="backup-hint">
                Dateien, die auf dem NAS gelöscht oder abgewählt wurden. Sie bleiben noch
                {" "}{status.retentionDays} Tage ab dem Markierungsdatum im Bucket.
            </p>
            <button onClick={loadMarked}>Liste laden ({status.markedObjects})</button>
            {marked.length > 0 && (
                <div className="marked-list">
                    {marked.map(o => (
                        <div key={o.rel_path} className="marked-item">
                            <span className="marked-path">/{o.rel_path}</span>
                            <span className="run-meta">markiert {formatTime(o.deleted_at)}</span>
                            <span className="run-meta">{formatBytes(o.size)}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

function TargetRow({ target }) {
    const { current, outdated, missing, liveObjects, bytes } = target.coverage
    const pending = outdated + missing
    return (
        <div className={`target-summary-row ${target.enabled ? "" : "disabled"}`}>
            <span className={`run-dot ${target.enabled ? (pending ? "running" : "ok") : ""}`} />
            <span className="target-summary-name">{target.name}</span>
            <span className="run-meta">{target.region}</span>
            <span className="run-meta">{formatBytes(bytes)}</span>
            <span className="target-summary-state">
                {!target.enabled
                    ? "inaktiv"
                    : pending
                        ? `${pending} von ${liveObjects} offen`
                        : `vollständig (${current})`}
            </span>
        </div>
    )
}

function Stat({ label, value, hint }) {
    return (
        <div className="stat-tile">
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
            {hint && <span className="stat-hint">{hint}</span>}
        </div>
    )
}
