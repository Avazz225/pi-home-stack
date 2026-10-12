import { useState } from "react"
import Floorplan from "../floorplan/Floorplan"
import { cleanAll, cleanRooms, controlVacuum, setFanSpeed, connectVacuum, disconnectVacuum } from "../api"
import "./vacuum.css"

const FAN_LABELS = { quiet: "Leise", normal: "Normal", max: "Stark", max_plus: "Maximal" }

export default function VacuumView({ rooms, vacuum, onChanged }) {
    const [selected, setSelected] = useState([])
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    const mappable = rooms.filter(r => (r.vacuum_rooms || []).length > 0)
    const selectable = new Set(mappable.map(r => r.id))

    async function run(action) {
        setBusy(true)
        try {
            await action()
            setError("")
            onChanged()
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    function toggleRoom(room) {
        if (!selectable.has(room.id)) return
        setSelected(current => current.includes(room.id)
            ? current.filter(id => id !== room.id)
            : [...current, room.id])
    }

    return (
        <div className="home-view">
            <StatusCard vacuum={vacuum} busy={busy} run={run} />

            {vacuum.connected && (
                <>
                    <div className="home-card">
                        <div className="home-card-header">
                            <h4>Wo soll gesaugt werden?</h4>
                            <span className="home-meta">
                                {selected.length === 0 ? "nichts ausgewählt" : `${selected.length} Raum/Räume`}
                            </span>
                        </div>
                        {mappable.length === 0 ? (
                            <p className="home-empty">
                                Noch kein Raum mit einem Raum der Roboterkarte verknüpft — das geht im Tab
                                „Einstellungen“, sobald der Roboter seine Karte gemeldet hat.
                            </p>
                        ) : (
                            <Floorplan rooms={mappable} selected={selected} onSelect={toggleRoom} mode="multi" />
                        )}
                        <div className="home-actions">
                            <button className="home-btn primary" disabled={busy || selected.length === 0}
                                    onClick={() => run(async () => { await cleanRooms(selected); setSelected([]) })}>
                                Ausgewählte saugen
                            </button>
                            <button className="home-btn" disabled={busy}
                                    onClick={() => run(cleanAll)}>Ganze Wohnung</button>
                            {selected.length > 0 && (
                                <button className="home-btn" onClick={() => setSelected([])}>Auswahl leeren</button>
                            )}
                        </div>
                    </div>

                    <div className="home-card">
                        <h4 className="home-h4">Steuerung</h4>
                        <div className="home-actions">
                            <button className="home-btn" disabled={busy} onClick={() => run(() => controlVacuum("pause"))}>Pause</button>
                            <button className="home-btn" disabled={busy} onClick={() => run(() => controlVacuum("resume"))}>Weiter</button>
                            <button className="home-btn" disabled={busy} onClick={() => run(() => controlVacuum("stop"))}>Stopp</button>
                            <button className="home-btn" disabled={busy} onClick={() => run(() => controlVacuum("home"))}>Zur Station</button>
                        </div>
                        {vacuum.fan_speed_levels && vacuum.fan_speed_levels.length > 0 && (
                            <div className="home-section">
                                <h5 className="home-h4">Saugstufe</h5>
                                <div className="home-actions">
                                    {vacuum.fan_speed_levels.map(level => (
                                        <button key={level}
                                                className={`home-btn${vacuum.fan_speed === level ? " primary" : ""}`}
                                                disabled={busy}
                                                onClick={() => run(() => setFanSpeed(level))}>
                                            {FAN_LABELS[level] || level}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}

            {error && <p className="home-error">{error}</p>}
        </div>
    )
}

function StatusCard({ vacuum, busy, run }) {
    const connected = vacuum.connected
    return (
        <div className="home-card">
            <div className="home-card-header">
                <h4>{vacuum.device_name || "Saugroboter"}</h4>
                {vacuum.connecting && <span className="home-chip">verbindet…</span>}
                {connected
                    ? <span className="home-chip home-chip-ok">verbunden</span>
                    : !vacuum.connecting && <span className="home-chip">getrennt</span>}
                {vacuum.available === false && <span className="home-chip home-chip-warn">offline</span>}
            </div>

            {connected && (
                <div className="vac-readings">
                    <Reading label="Status" value={vacuum.state_label || vacuum.state || "–"} />
                    <Reading label="Akku" value={vacuum.battery == null ? "–" : `${vacuum.battery} %`} />
                    <Reading label="Saugstufe" value={FAN_LABELS[vacuum.fan_speed] || vacuum.fan_speed || "–"} />
                    <Reading label="Räume" value={(vacuum.rooms || []).length || "–"} />
                </div>
            )}

            {vacuum.error && <p className="home-error">{vacuum.error}</p>}
            {vacuum.error_text && <p className="home-error">Gerätefehler: {vacuum.error_text}</p>}

            {vacuum.used_fallback && (
                <p className="home-empty">
                    Das Gerät ist der Bibliothek unbekannt und läuft über das Ersatzprofil
                    „{vacuum.used_fallback}“. Nicht jeder Befehl muss damit funktionieren.
                </p>
            )}
            {!connected && vacuum.unsupported && vacuum.unsupported.length > 0 && (
                <p className="home-empty">
                    Im Konto gefunden, aber ohne Profil: {vacuum.unsupported.filter(Boolean).join(", ")}.
                    In den Einstellungen lässt sich ein Ersatzprofil auswählen.
                </p>
            )}

            <div className="home-actions">
                {connected
                    ? <button className="home-btn" disabled={busy} onClick={() => run(disconnectVacuum)}>Trennen</button>
                    : <button className="home-btn primary" disabled={busy || vacuum.connecting}
                              onClick={() => run(connectVacuum)}>Verbinden</button>}
            </div>

            <p className="home-empty vac-disclaimer">
                yeedi bietet keine offizielle Schnittstelle. Die Anbindung läuft über die
                Ecovacs-Cloud und eine nachgebaute Protokollbibliothek — sie kann mit einem
                Firmware- oder Server-Update jederzeit ausfallen.
            </p>
        </div>
    )
}

function Reading({ label, value }) {
    return (
        <div className="vac-reading">
            <span className="home-meta">{label}</span>
            <span className="vac-reading-value">{value}</span>
        </div>
    )
}
