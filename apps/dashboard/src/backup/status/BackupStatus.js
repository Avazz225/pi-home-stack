import { useState, useEffect, useCallback, useRef } from "react"
import { Tile, Pill, Btn, Note, Empty, Actions } from "../../common/ui"
import { fetchStatus, fetchRuns, fetchRun, startRun, fetchObjects } from "../api"
import { formatStamp } from "../../common/time"
import "./status.css"

const RUN_STATUS = { ok: "Erfolgreich", error: "Fehler", running: "Läuft" }

function formatBytes(bytes) {
    if (!bytes) return "0 B"
    const units = ["B", "kB", "MB", "GB", "TB"]
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// Shared, because a timestamp without a zone marker is read as local time and
// lands hours out - see common/time.js.
const formatTime = (iso) => formatStamp(iso)

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
            {error && <Note tone="danger">{error}</Note>}

            {/* One line, then the particulars as pills - the same shape the
                system pane uses, for the same reason. Three stacked amber
                boxes said "deaktiviert", "Konfiguration unvollständig" with
                three bullets, and further down "Kein Backup-Ziel angelegt"
                again word for word, so the screen looked like four problems
                where there were two. */}
            {(!status.enabled || status.problems?.length > 0) && (
                <div className="backup-head">
                    <Pill tone={status.enabled ? "warn" : "danger"} dot>
                        {status.enabled ? "Noch nicht einsatzbereit" : "Sicherung ist aus"}
                    </Pill>
                    {!status.enabled && (
                        <span className="backup-head__hint">
                            Der Cronjob läuft, bricht aber sofort ab — unter „Einstellungen“
                            aktivieren.
                        </span>
                    )}
                </div>
            )}
            {status.problems?.length > 0 && (
                <div className="backup-problems">
                    {status.problems.map((problem, i) => (
                        <Pill key={i} tone="warn" dot>{problem}</Pill>
                    ))}
                </div>
            )}

            <div className="ui-tiles">
                <Stat label="Ausgewählte Ordner" value={status.includedFolders} />
                <Stat label="Dateien in Auswahl" value={status.liveObjects} />
                <Stat label="Datenmenge" value={formatBytes(status.liveBytes)} />
                <Stat label="Auf allen Zielen" value={status.fullyReplicated}
                      hint={`${status.activeTargets} aktive${status.activeTargets === 1 ? "s Ziel" : " Ziele"}`} />
                <Stat label="Löschmarker offen" value={status.markedObjects}
                      hint={`werden nach ${status.retentionDays} Tagen gelöscht`} />
                <Stat label="Letzter Lauf" value={formatTime(status.lastRun?.started_at)} />
            </div>

            {/* No empty-state warning here: "Kein Backup-Ziel angelegt" is
                already one of the problems listed above, and saying it twice
                on one screen made it read as two separate faults. */}
            {status.targets?.length > 0 && (
                <div className="target-summary">
                    {status.targets.map(t => <TargetRow key={t.id} target={t} />)}
                </div>
            )}

            <Actions>
                <Btn variant="primary" onClick={() => trigger(false)}
                     disabled={starting || !!status.runningRun}>
                    {status.runningRun ? "Sicherung läuft…" : "Jetzt sichern"}
                </Btn>
                <Btn onClick={() => trigger(true)} disabled={starting || !!status.runningRun}
                     title="Zeigt an, was passieren würde, ohne etwas hochzuladen oder zu löschen">
                    Probelauf
                </Btn>
                <Btn variant="ghost" onClick={refresh}>Aktualisieren</Btn>
            </Actions>

            <h4>Läufe</h4>
            {!runs.length && <Empty>Noch kein Lauf aufgezeichnet.</Empty>}
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
            <Actions>
                <Btn onClick={loadMarked}>Liste laden ({status.markedObjects})</Btn>
            </Actions>
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

/* The shared tile under its old name, so the call sites below read as they
   did. The system page shows the same object and now shows it identically. */
const Stat = Tile
