import { useCallback, useEffect, useState } from "react"
import { fetchSystemStatus } from "./api"
import "./system.css"

/* What this machine is doing right now.
 *
 * The one pane that has to work when everything else does not - it is the view
 * you open after a reboot that went wrong. So it makes no demands: no backend,
 * no database, one static file. Every section renders only if the collector
 * found something, because a Pi without a RAID should not show an empty RAID
 * box, and a missing probe is not an error.
 *
 * The age of the file is a finding in itself. A timer that stopped leaves
 * numbers that look perfectly healthy and are simply old, which is worse than
 * no numbers at all - hence the warning above everything else.
 */

const STALE_AFTER = 5 * 60 * 1000
const POLL_MS = 60_000

/* Deliberately 1024: these are disk and memory sizes as df and free report
   them, and a tile that disagrees with the shell is a tile nobody trusts. */
function bytes(value) {
    if (value === null || value === undefined) return "–"
    if (value === 0) return "0 B"
    const units = ["B", "kB", "MB", "GB", "TB"]
    const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
    return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function duration(seconds) {
    if (!seconds && seconds !== 0) return "–"
    const d = Math.floor(seconds / 86400)
    const h = Math.floor((seconds % 86400) / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (d > 0) return `${d} T ${h} h`
    if (h > 0) return `${h} h ${m} min`
    return `${m} min`
}

function moment(value) {
    if (!value) return "–"
    /* The collector hands out ISO strings for its own timestamps and epoch
       seconds for the next timer elapse. Both land here. */
    const d = typeof value === "number" ? new Date(value * 1000) : new Date(value)
    return isNaN(d) ? String(value) : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
}

/* Unit names are the honest identifier - they are what you type into systemctl
   when something is wrong, so they stay visible. The label is only there to
   save the reader a translation step. */
const UNIT_LABELS = {
    "pi-home-status": "Systemzahlen",
    "pi-home-backup": "Backup-API",
    "pi-home-backup-job": "Sicherungslauf",
    "pi-home-netmonitor": "Netzmessung (API)",
    "pi-home-netmonitor-measure": "Netzmessung",
    "pi-home-speedtest": "Speedtest-API",
    "pi-home-speedtest-measure": "Speedtest-Messung",
    "pi-home-grafana": "Grafana",
    "pi-home-duckdns": "DuckDNS",
    "pi-home-pihole-update": "Pi-hole-Update",
    "pi-home-api-quickaction": "Profile & Quicklinks",
    "pi-home-api-tracking": "Feature-Tracking",
    "pi-home-api-study": "Modulplanung",
    "pi-home-api-home": "Wohnung",
}

function unitLabel(name) {
    const base = name.replace(/\.(service|timer)$/, "")
    return UNIT_LABELS[base] || base.replace(/^pi-home-/, "")
}

const STATE_WORDS = {
    active: "läuft",
    inactive: "gestoppt",
    failed: "fehlgeschlagen",
    activating: "startet",
    missing: "nicht installiert",
    unknown: "unbekannt",
}

/* ok / warn / bad, and nothing else - the pane is read in a hurry. A stopped
   timer is a warning, not a failure: it may have been switched off on purpose. */
function stateKind(state, isTimer) {
    if (state === "active") return "ok"
    if (state === "failed") return "bad"
    if (state === "inactive") return isTimer ? "warn" : "bad"
    return "warn"
}

export function System() {
    const [status, setStatus] = useState(null)
    const [error, setError] = useState("")
    const [loading, setLoading] = useState(true)

    const refresh = useCallback(async () => {
        try {
            setStatus(await fetchSystemStatus())
            setError("")
        } catch (e) {
            setError(e.message)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])
    useEffect(() => {
        const id = setInterval(refresh, POLL_MS)
        return () => clearInterval(id)
    }, [refresh])

    if (loading) return <div className="sys-note">Lädt…</div>
    if (!status) {
        return (
            <div className="sys-note bad">
                Keine Systemzahlen: {error}
                <p>
                    Sie werden von <code>pi-home-status.timer</code> geschrieben.
                    Prüfen mit <code>systemctl status pi-home-status.timer</code>.
                </p>
            </div>
        )
    }

    const { system = {}, storage, raid, pihole, backup, netmonitor, units } = status
    const age = status.generatedAt ? Date.now() - new Date(status.generatedAt).getTime() : null
    const stale = age !== null && !isNaN(age) && age > STALE_AFTER
    const memUsed = system.memoryTotal && system.memoryAvailable
        ? system.memoryTotal - system.memoryAvailable : null

    return (
        <div className="sys-view">
            {stale && (
                <div className="sys-note warn">
                    Diese Zahlen sind von {moment(status.generatedAt)} — der Sammler läuft
                    offenbar nicht mehr. Alles darunter beschreibt also einen älteren Zustand.
                </div>
            )}
            {error && <div className="sys-note warn">Letzte Aktualisierung fehlgeschlagen: {error}</div>}

            <div className="sys-head">
                <div>
                    <strong>{system.hostname || "unbekannt"}</strong>
                    {system.model && <span className="sys-meta"> · {system.model}</span>}
                </div>
                <span className="sys-meta">Stand {moment(status.generatedAt)}</span>
                <button onClick={refresh}>Aktualisieren</button>
            </div>

            <div className="sys-tiles">
                <Tile label="Laufzeit" value={duration(system.uptimeSeconds)} />
                <Tile label="Last" value={system.load ? system.load.map(l => l.toFixed(2)).join(" ") : "–"}
                      hint={system.cpuCount ? `${system.cpuCount} Kerne` : null} />
                <Tile label="CPU-Temperatur"
                      value={system.cpuTemperature !== null && system.cpuTemperature !== undefined
                          ? `${system.cpuTemperature} °C` : "–"}
                      kind={system.cpuTemperature >= 80 ? "bad" : system.cpuTemperature >= 70 ? "warn" : null} />
                <Tile label="Arbeitsspeicher" value={memUsed !== null ? bytes(memUsed) : "–"}
                      hint={system.memoryTotal ? `von ${bytes(system.memoryTotal)}` : null} />
            </div>

            {storage && (
                <section>
                    <h4>Datenspeicher</h4>
                    <div className="sys-bar-row">
                        <span className="sys-path">{storage.path}</span>
                        <Bar used={storage.used} total={storage.total} />
                        <span className="sys-meta">
                            {bytes(storage.used)} von {bytes(storage.total)} · {bytes(storage.free)} frei
                        </span>
                    </div>
                    {!storage.mounted && (
                        <div className="sys-note bad">
                            Das Verzeichnis ist kein Mountpoint — liegt der Speicher wirklich dort?
                        </div>
                    )}
                </section>
            )}

            {raid?.length > 0 && (
                <section>
                    <h4>RAID</h4>
                    {raid.map(array => (
                        <div key={array.name} className="sys-row" data-kind={array.healthy === false ? "bad" : "ok"}>
                            <span className={`sys-dot ${array.healthy === false ? "bad" : "ok"}`} />
                            <span className="sys-row-name">{array.name}</span>
                            <span className="sys-meta">{array.level} · {array.state}</span>
                            {array.disks && <span className="sys-meta">{array.disks} Platten</span>}
                            <span className="sys-row-state">
                                {array.healthy === false ? "Platte ausgefallen"
                                    : array.resync ? `${array.resync.kind} ${array.resync.percent} %`
                                    : "intakt"}
                            </span>
                        </div>
                    ))}
                </section>
            )}

            {units?.length > 0 && (
                <section>
                    <h4>Dienste</h4>
                    <div className="sys-units">
                        {units.map(unit => {
                            const isTimer = unit.name.endsWith(".timer")
                            const kind = stateKind(unit.state, isTimer)
                            return (
                                <div key={unit.name} className="sys-row" data-kind={kind}>
                                    <span className={`sys-dot ${kind}`} />
                                    <span className="sys-row-name">{unitLabel(unit.name)}</span>
                                    <span className="sys-unit-name">{unit.name}</span>
                                    <span className="sys-row-state">
                                        {STATE_WORDS[unit.state] || unit.state}
                                        {unit.next && ` · nächster Lauf ${moment(unit.next)}`}
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                </section>
            )}

            {backup && (
                <section>
                    <h4>Sicherung</h4>
                    <div className="sys-tiles">
                        <Tile label="Letzter Lauf" value={moment(backup.lastRun?.started_at)}
                              hint={backup.lastRun?.status === "error" ? "fehlgeschlagen" : null}
                              kind={backup.lastRun?.status === "error" ? "bad" : null} />
                        <Tile label="Gesicherte Dateien" value={backup.objects ?? "–"} />
                        <Tile label="Datenmenge" value={bytes(backup.bytes)} />
                    </div>
                </section>
            )}

            {netmonitor && (
                <section>
                    <h4>Letzte Netzmessung</h4>
                    <div className="sys-tiles">
                        <Tile label="Download" value={netmonitor.download_mbps != null
                            ? `${netmonitor.download_mbps} Mbit/s` : "–"} />
                        <Tile label="Upload" value={netmonitor.upload_mbps != null
                            ? `${netmonitor.upload_mbps} Mbit/s` : "–"} />
                        <Tile label="Ping" value={netmonitor.ping_ms != null
                            ? `${netmonitor.ping_ms} ms` : "–"} />
                        <Tile label="Gemessen" value={moment(netmonitor.measured_at)} />
                    </div>
                </section>
            )}

            {pihole && (
                <section>
                    <h4>Pi-hole</h4>
                    <div className="sys-tiles">
                        <Tile label="Anfragen heute" value={pihole.queriesToday ?? "–"} />
                        <Tile label="Blockiert" value={pihole.blockedToday ?? "–"}
                              hint={pihole.blockedPercent != null
                                  ? `${Number(pihole.blockedPercent).toFixed(1)} %` : null} />
                        <Tile label="Domains auf der Liste" value={pihole.domainsOnList ?? "–"} />
                    </div>
                </section>
            )}
        </div>
    )
}

function Tile({ label, value, hint, kind }) {
    return (
        <div className="sys-tile" data-kind={kind || ""}>
            <span className="sys-tile-value">{value}</span>
            <span className="sys-tile-label">{label}</span>
            {hint && <span className="sys-tile-hint">{hint}</span>}
        </div>
    )
}

/* Red from 90 % on, because that is where a full data store stops being a
   number and starts being a failed backup. */
function Bar({ used, total }) {
    if (!total) return null
    const percent = Math.min(100, Math.round((used / total) * 100))
    const kind = percent >= 90 ? "bad" : percent >= 75 ? "warn" : "ok"
    return (
        <span className="sys-bar" title={`${percent} %`}>
            <span className={`sys-bar-fill ${kind}`} style={{ width: `${percent}%` }} />
        </span>
    )
}
