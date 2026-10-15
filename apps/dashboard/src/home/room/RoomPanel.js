import { useState } from "react"
import { setLight, setRoomLights, updateRoom, setRoomTarget, createSchedule, updateSchedule, deleteSchedule, cleanRooms } from "../api"
import Hint from "../../common/Hint"
import Collapsible from "../../common/Collapsible"
import { readLayout, orderedSections, orderedTiles } from "../layout"
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

/* A section of the panel: the shared Collapsible with the panel's own frame.
   Its id is also the key its open state is remembered under, so folding the
   heating plan away stays folded on the next room as well - which is the point,
   the decision is about the kind of block, not about one room. */
function Section({ id, title, chips, summary, startOpen, children }) {
    return (
        <Collapsible id={id} store="home.room.open." className="as-section"
                     title={<h5 className="home-h4">{title}</h5>}
                     chips={chips} summary={summary} defaultOpen={startOpen}>
            {children}
        </Collapsible>
    )
}

export default function RoomPanel({ room, hue, shelly, vacuum, layout: rawLayout, onChanged }) {
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

    const layout = readLayout(rawLayout)
    const sections = orderedSections(layout, { room, hue, shelly, vacuum })

    return (
        <div className="home-card room-panel">
            <div className="home-card-header">
                <h4>{room.name}</h4>
                <span className="home-meta home-num">{room.area_m2} m²</span>
            </div>

            {/* Order and visibility come from the layout, availability from the
                data. A room with no valve shows no climate block at all rather
                than a block full of dashes. */}
            {sections.map(section => {
                const startOpen = section.openByDefault
                if (section.id === "climate")
                    return <ClimateSection key="climate" room={room} shelly={shelly}
                                           layout={layout} startOpen={startOpen} run={run} />
                if (section.id === "lights")
                    return <LightSection key="lights" room={room} hue={hue} startOpen={startOpen} run={run} />
                if (section.id === "schedule")
                    return <ScheduleSection key="schedule" room={room} shelly={shelly}
                                            startOpen={startOpen} run={run} />
                if (section.id === "vacuum")
                    return <VacuumSection key="vacuum" room={room} vacuum={vacuum}
                                          startOpen={startOpen} run={run} />
                return null
            })}
            {sections.length === 0 && (
                <p className="home-empty">
                    Für diesen Raum ist noch nichts eingerichtet — unter „Einstellungen“
                    Geräte zuordnen.
                </p>
            )}

            {error && <p className="home-error">{error}</p>}
        </div>
    )
}

/* ── Light ───────────────────────────────────────────────────────────────── */

function LightSection({ room, hue, startOpen, run }) {
    const lights = room.lights || { bound: 0, items: [] }

    if (!hue.configured) {
        return (
            <Section id="lights" title="Licht" startOpen={startOpen}>
                <p className="home-empty">Hue ist noch nicht eingerichtet — siehe Tab „Einstellungen“.</p>
            </Section>
        )
    }
    if (lights.bound === 0) {
        return (
            <Section id="lights" title="Licht" startOpen={startOpen}>
                <p className="home-empty">Diesem Raum ist keine Lampe zugeordnet.</p>
            </Section>
        )
    }

    return (
        <Section id="lights" title="Licht" startOpen={startOpen}
                 chips={<span className="home-meta home-num">{lights.on} von {lights.bound} an</span>}
                 summary={`${lights.on} von ${lights.bound} an`}>
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
        </Section>
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

/* How old a reading may be before it is worth mentioning.
 *
 * A BLU TRV broadcasts every few minutes while nothing changes, so a value that
 * is two minutes old is the normal case and not worth a word. Ten minutes of
 * silence means something: the valve is out of range, or its batteries went. */
const READING_STALE_S = 600

function fmtAge(seconds) {
    if (seconds == null) return null
    if (seconds < 90) return "gerade"
    const minutes = Math.round(seconds / 60)
    return minutes < 60 ? `vor ${minutes} min` : `vor ${Math.round(minutes / 60)} h`
}

/* One tile each, keyed by the ids in layout.js. Only the ones with a value
   are rendered, and in the order the operator put them in. */
function climateTile(id, climate) {
    switch (id) {
        case "temperature":
            return {
                label: "Temperatur",
                value: fmtTemp(climate.temperature),
                hint: fmtAge(climate.age_s),
                note: climate.temperature_source === "sensor" ? "Wandfühler" : "Ventilkopf",
            }
        case "humidity":
            return { label: "Luftfeuchte", value: `${climate.humidity} %` }
        case "trv_target":
            return { label: "Ventil-Soll", value: fmtTemp(climate.trv_target) }
        case "valve":
            return { label: "Ventilstellung", value: `${climate.valve_position} %` }
        case "head":
            return { label: "Kopftemperatur", value: fmtTemp(climate.head_temperature),
                     note: "im Ventil" }
        case "battery":
            return { label: "Batterie", value: `${climate.battery} %` }
        case "window":
            return { label: "Fenster", value: climate.window_open ? "offen" : "zu" }
        default:
            return null
    }
}

function ClimateSection({ room, shelly, layout, startOpen, run }) {
    const [target, setTarget] = useState(room.target_temp ?? "")
    const climate = room.climate || {}
    const scheduled = room.scheduled
    const tiles = orderedTiles(layout, climate)
    const stale = climate.age_s != null && climate.age_s > READING_STALE_S

    /* The setpoint on the valve and the wish on the room are two values, and
       they drift apart: somebody turns the knob on the radiator, or a valve was
       out of reach when the last change went out. Saying so is the whole point
       - otherwise the panel shows a number that is not what is heating. */
    const drifted = climate.trv_target != null && room.target_temp != null
        && Math.abs(climate.trv_target - room.target_temp) >= 0.5

    return (
        <Section id="climate" title="Klima" startOpen={startOpen}
                 summary={[climate.temperature != null && fmtTemp(climate.temperature),
                           climate.humidity != null && `${climate.humidity} %`]
                          .filter(Boolean).join(" · ")}
                 chips={climate.temperature_source === "sensor" && climate.head_temperature != null && (
                    <Hint>
                        Die Temperatur kommt vom Wandfühler. Der Fühler im Ventilkopf sitzt in
                        der Fensternische auf einem meist kalten Heizkörper und liest
                        systematisch zu niedrig — hier gerade
                        {" "}{fmtTemp(climate.head_temperature)}.
                    </Hint>
                 )}>
            <div className="room-readings">
                {tiles.map(tile => {
                    const data = climateTile(tile.id, climate)
                    return data && <Reading key={tile.id} {...data} />
                })}
            </div>

            {climate.bound === 0 && (
                <p className="home-empty">
                    {shelly && !shelly.configured
                        ? "Kein BLU-Gateway eingerichtet — unter „Einstellungen“ verbinden."
                        : "Kein Gerät in diesem Raum — unter „Einstellungen“ zuordnen."}
                </p>
            )}
            {climate.bound > 0 && !climate.available && (
                <p className="home-empty">
                    {shelly && shelly.error
                        ? `Gateway meldet: ${shelly.error}`
                        : "Noch kein Messwert gemeldet."}
                </p>
            )}
            {/* Stays a visible line, not a tooltip: it reports a state, and a
                warning that has to be opened is a warning nobody reads. */}
            {stale && (
                <p className="home-error">
                    Letzter Messwert {fmtAge(climate.age_s)} — Reichweite oder Batterie prüfen.
                </p>
            )}
            {drifted && (
                <p className="home-error">
                    Am Ventil stehen {fmtTemp(climate.trv_target)}, gewünscht
                    sind {fmtTemp(room.target_temp)}. „Übernehmen“ schickt den Wunsch erneut.
                </p>
            )}

            <div className="home-form">
                <label className="home-field room-target">
                    <span className="room-field-label">
                        Soll-Temperatur
                        {climate.bound > 0 && (
                            <Hint>
                                Setzen baut eine Bluetooth-Verbindung zum Ventil auf und dauert
                                ein paar Sekunden. Gelesen wird dagegen aus dem Zwischenspeicher
                                des Gateways, das kostet keine Batterie.
                            </Hint>
                        )}
                    </span>
                    <input type="number" min="4" max="30" step="0.5" inputMode="decimal"
                           value={target} onChange={e => setTarget(e.target.value)} />
                </label>
                <div className="home-form-actions">
                    {/* Not disabled on an unchanged value when the valve disagrees: resending
                        the same wish is exactly what one wants after a valve missed it. */}
                    <button className="home-btn primary"
                            disabled={!drifted && String(target) === String(room.target_temp ?? "")}
                            onClick={() => run(async () => {
                                if (target === "") return updateRoom(room.id, { target_temp: null })
                                const result = await setRoomTarget(room.id, Number(target))
                                const failed = (result.valves || []).filter(v => !v.ok)
                                if (failed.length) {
                                    throw new Error(`Ventil ${failed.map(v => v.id).join(", ")}: ${failed[0].error}`)
                                }
                            })}>Übernehmen</button>
                </div>
            </div>
            {scheduled && (
                <p className="home-empty">
                    Laut Heizplan gerade {fmtTemp(scheduled.target_temp)} (seit {scheduled.since}
                    {scheduled.days_back > 0 ? " am Vortag" : ""}).
                </p>
            )}
        </Section>
    )
}

function Reading({ label, value, hint, note }) {
    return (
        <div className="room-reading">
            <span className="home-meta">{label}</span>
            <span className="room-reading-value">{value}</span>
            {(hint || note) && (
                <span className="home-meta room-reading-hint">
                    {[note, hint].filter(Boolean).join(" · ")}
                </span>
            )}
        </div>
    )
}

/* ── Heating schedule ────────────────────────────────────────────────────── */

function ScheduleSection({ room, shelly, startOpen, run }) {
    const [adding, setAdding] = useState(false)
    const schedules = room.schedules || []
    const activeId = room.scheduled ? room.scheduled.schedule_id : null
    const bound = (room.climate || {}).bound || 0

    return (
        <Section id="schedule" title="Heizplan" startOpen={startOpen}
                 summary={schedules.length === 0
                     ? "kein Eintrag"
                     : `${schedules.length} Eintrag${schedules.length === 1 ? "" : "e"}`
                       + (room.scheduled ? `, gerade ${fmtTemp(room.scheduled.target_temp)}` : "")}
                 chips={<>
                    <span className="home-meta">„um X Uhr will ich Y Grad“</span>
                    <Hint>
                        Die Zeiten liegen als Aufträge im BLU-Gateway, nicht auf dem Pi — sie
                        greifen also auch, wenn der Pi aus ist. Gespiegelt wird bei jeder Änderung.
                    </Hint>
                 </>}>
            {schedules.length === 0 && <p className="home-empty">Noch kein Eintrag.</p>}
            {/* A plan without a valve goes nowhere - that is a state and stays
                visible. That the plan runs on the gateway is background, and
                background belongs in the tooltip at the heading. */}
            {schedules.length > 0 && bound === 0 && (
                <p className="home-error">
                    Keine Ventile in diesem Raum — der Plan wird nicht ans Gateway geschickt.
                </p>
            )}
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
        </Section>
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

function VacuumSection({ room, vacuum, startOpen, run }) {
    const bound = room.vacuum_rooms || []
    if (bound.length === 0) return null
    return (
        <Section id="vacuum" title="Staubsauger" startOpen={startOpen}>
            <p className="home-empty">
                Zugeordnet: {bound.map(r => r.name || `#${r.id}`).join(", ")}
            </p>
            <div className="home-actions">
                <button className="home-btn" disabled={!vacuum.connected}
                        onClick={() => run(() => cleanRooms([room.id]))}>
                    Nur diesen Raum saugen
                </button>
            </div>
        </Section>
    )
}
