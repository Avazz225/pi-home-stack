import { useState } from "react"
import { setLight, setRoomLights, updateRoom, createSchedule, updateSchedule, deleteSchedule, cleanRooms } from "../api"
import "./room.css"

const WEEKDAYS = [["1", "Mo"], ["2", "Di"], ["3", "Mi"], ["4", "Do"], ["5", "Fr"], ["6", "Sa"], ["7", "So"]]

function fmtTemp(value) {
    if (value === null || value === undefined || value === "") return "–"
    return `${Number(value).toFixed(1).replace(".", ",")} °C`
}

function weekdayLabel(weekdays) {
    if (weekdays === "1234567") return "täglich"
    if (weekdays === "12345") return "Mo–Fr"
    if (weekdays === "67") return "Sa + So"
    return WEEKDAYS.filter(([d]) => weekdays.includes(d)).map(([, l]) => l).join(", ")
}

export default function RoomPanel({ room, hue, vacuum, onChanged }) {
    const [error, setError] = useState("")

    if (!room) {
        return (
            <div className="home-card">
                <p className="home-empty">Einen Raum im Grundriss antippen.</p>
            </div>
        )
    }

    async function run(action) {
        try {
            await action()
            setError("")
            onChanged()
        } catch (e) {
            setError(e.message)
        }
    }

    return (
        <div className="home-card room-panel">
            <div className="home-card-header">
                <h4>{room.name}</h4>
                <span className="home-meta home-num">{room.area_m2} m²</span>
            </div>

            <LightSection room={room} hue={hue} run={run} />
            <ClimateSection room={room} run={run} />
            <ScheduleSection room={room} run={run} />
            <VacuumSection room={room} vacuum={vacuum} run={run} />

            {error && <p className="home-error">{error}</p>}
        </div>
    )
}

/* ── Light ───────────────────────────────────────────────────────────────── */

function LightSection({ room, hue, run }) {
    const lights = room.lights || { bound: 0, items: [] }

    if (!hue.configured) {
        return (
            <div className="home-section">
                <h5 className="home-h4">Licht</h5>
                <p className="home-empty">Hue ist noch nicht eingerichtet — siehe Tab „Einstellungen“.</p>
            </div>
        )
    }
    if (lights.bound === 0) {
        return (
            <div className="home-section">
                <h5 className="home-h4">Licht</h5>
                <p className="home-empty">Diesem Raum ist keine Lampe zugeordnet.</p>
            </div>
        )
    }

    return (
        <div className="home-section">
            <div className="home-card-header">
                <h5 className="home-h4">Licht</h5>
                <span className="home-meta home-num">{lights.on} von {lights.bound} an</span>
            </div>
            {!hue.reachable && <p className="home-error">Bridge nicht erreichbar — Schalten geht gerade nicht.</p>}

            <div className="home-actions">
                <button className="home-btn primary" disabled={!hue.reachable}
                        onClick={() => run(() => setRoomLights(room.id, { on: true }))}>Alle an</button>
                <button className="home-btn" disabled={!hue.reachable}
                        onClick={() => run(() => setRoomLights(room.id, { on: false }))}>Alle aus</button>
            </div>

            {lights.items.map(light => (
                <LightRow key={light.id} light={light} disabled={!hue.reachable} run={run} />
            ))}
            {lights.known < lights.bound && (
                <p className="home-empty">
                    {lights.bound - lights.known} zugeordnete Lampe(n) meldet die Bridge nicht mehr.
                </p>
            )}
        </div>
    )
}

function LightRow({ light, disabled, run }) {
    /* The slider keeps its own value while it is being dragged and only sends on
       release — React fires onChange for every pixel, and the bridge would get a
       burst of writes for a single gesture. */
    const [brightness, setBrightness] = useState(light.brightness ?? 100)

    return (
        <div className="room-light">
            <div className="home-row">
                <span className="home-row-title">{light.name}</span>
                <span className={`home-chip ${light.on ? "home-chip-warn" : ""}`}>{light.on ? "an" : "aus"}</span>
                <button className="home-btn" disabled={disabled}
                        onClick={() => run(() => setLight(light.id, { on: !light.on }))}>
                    {light.on ? "Aus" : "An"}
                </button>
            </div>
            {light.brightness !== null && light.brightness !== undefined && (
                <label className="room-slider-row">
                    <span className="home-meta home-num">{Math.round(brightness)} %</span>
                    <input
                        className="home-slider"
                        type="range" min="1" max="100" step="1"
                        value={brightness}
                        disabled={disabled}
                        aria-label={`Helligkeit ${light.name}`}
                        onChange={e => setBrightness(Number(e.target.value))}
                        onPointerUp={() => run(() => setLight(light.id, { brightness }))}
                        onKeyUp={() => run(() => setLight(light.id, { brightness }))}
                    />
                </label>
            )}
        </div>
    )
}

/* ── Climate ─────────────────────────────────────────────────────────────── */

function ClimateSection({ room, run }) {
    const [target, setTarget] = useState(room.target_temp ?? "")
    const climate = room.climate || {}
    const scheduled = room.scheduled

    return (
        <div className="home-section">
            <h5 className="home-h4">Klima</h5>
            <div className="room-readings">
                <Reading label="Temperatur" value={fmtTemp(climate.temperature)} />
                <Reading label="Luftfeuchte" value={climate.humidity == null ? "–" : `${climate.humidity} %`} />
                <Reading label="Fenster"
                         value={climate.window_open == null ? "–" : (climate.window_open ? "offen" : "zu")} />
            </div>
            {!climate.available && (
                <p className="home-empty">
                    Noch kein Shelly-Gerät in diesem Raum — Messwerte kommen, sobald eines zugeordnet ist.
                </p>
            )}

            <div className="home-form">
                <label className="home-field room-target">Soll-Temperatur
                    <input type="number" min="5" max="30" step="0.5" inputMode="decimal"
                           value={target} onChange={e => setTarget(e.target.value)} />
                </label>
                <div className="home-form-actions">
                    <button className="home-btn primary"
                            disabled={String(target) === String(room.target_temp ?? "")}
                            onClick={() => run(() => updateRoom(room.id, {
                                target_temp: target === "" ? null : Number(target),
                            }))}>Übernehmen</button>
                </div>
            </div>
            {scheduled && (
                <p className="home-empty">
                    Laut Heizplan gerade {fmtTemp(scheduled.target_temp)} (seit {scheduled.since}
                    {scheduled.days_back > 0 ? " am Vortag" : ""}).
                </p>
            )}
        </div>
    )
}

function Reading({ label, value }) {
    return (
        <div className="room-reading">
            <span className="home-meta">{label}</span>
            <span className="room-reading-value">{value}</span>
        </div>
    )
}

/* ── Heating schedule ────────────────────────────────────────────────────── */

function ScheduleSection({ room, run }) {
    const [adding, setAdding] = useState(false)
    const schedules = room.schedules || []
    const activeId = room.scheduled ? room.scheduled.schedule_id : null

    return (
        <div className="home-section">
            <div className="home-card-header">
                <h5 className="home-h4">Heizplan</h5>
                <span className="home-meta">„um X Uhr will ich Y Grad“</span>
            </div>
            {schedules.length === 0 && <p className="home-empty">Noch kein Eintrag.</p>}
            {schedules.map(schedule => (
                <div key={schedule.id} className="home-row">
                    <span className="home-num room-sched-time">{schedule.time}</span>
                    <span className="home-row-title">{fmtTemp(schedule.target_temp)}</span>
                    <span className="home-meta">{weekdayLabel(schedule.weekdays)}</span>
                    {schedule.id === activeId && <span className="home-chip home-chip-accent">aktiv</span>}
                    <button className="home-icon-btn" title={schedule.enabled ? "Pausieren" : "Aktivieren"}
                            onClick={() => run(() => updateSchedule(schedule.id, { enabled: !schedule.enabled }))}>
                        {schedule.enabled ? "⏸" : "▶"}
                    </button>
                    <button className="home-icon-btn delete" title="Löschen"
                            onClick={() => run(() => deleteSchedule(schedule.id))}>✕</button>
                </div>
            ))}

            {adding ? (
                <ScheduleForm
                    onSave={values => run(async () => { await createSchedule(room.id, values); setAdding(false) })}
                    onCancel={() => setAdding(false)} />
            ) : (
                <button className="home-add-btn" onClick={() => setAdding(true)}>+ Zeitpunkt</button>
            )}
        </div>
    )
}

function ScheduleForm({ onSave, onCancel }) {
    const [time, setTime] = useState("18:00")
    const [temp, setTemp] = useState("21")
    const [days, setDays] = useState(new Set(WEEKDAYS.map(([d]) => d)))

    function toggleDay(day) {
        const next = new Set(days)
        if (next.has(day)) next.delete(day); else next.add(day)
        setDays(next)
    }

    return (
        <div className="home-form">
            <label className="home-field narrow">Uhrzeit
                <input type="time" value={time} onChange={e => setTime(e.target.value)} />
            </label>
            <label className="home-field narrow">Grad
                <input type="number" min="5" max="30" step="0.5" inputMode="decimal"
                       value={temp} onChange={e => setTemp(e.target.value)} />
            </label>
            <div className="home-field wide">Wochentage
                <div className="room-weekdays">
                    {WEEKDAYS.map(([day, label]) => (
                        <button key={day} type="button"
                                className={`home-chip room-day${days.has(day) ? " active" : ""}`}
                                aria-pressed={days.has(day)}
                                onClick={() => toggleDay(day)}>{label}</button>
                    ))}
                </div>
            </div>
            <div className="home-form-actions">
                <button className="home-btn primary" disabled={days.size === 0 || !time}
                        onClick={() => onSave({
                            time,
                            target_temp: Number(temp),
                            weekdays: WEEKDAYS.map(([d]) => d).filter(d => days.has(d)).join(""),
                        })}>Speichern</button>
                <button className="home-btn" onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}

/* ── Vacuum ──────────────────────────────────────────────────────────────── */

function VacuumSection({ room, vacuum, run }) {
    const bound = room.vacuum_rooms || []
    if (bound.length === 0) return null
    return (
        <div className="home-section">
            <h5 className="home-h4">Staubsauger</h5>
            <p className="home-empty">
                Zugeordnet: {bound.map(r => r.name || `#${r.id}`).join(", ")}
            </p>
            <div className="home-actions">
                <button className="home-btn" disabled={!vacuum.connected}
                        onClick={() => run(() => cleanRooms([room.id]))}>
                    Nur diesen Raum saugen
                </button>
            </div>
        </div>
    )
}
