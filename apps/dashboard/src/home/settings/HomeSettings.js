import { useState, useEffect, useCallback } from "react"
import {
    discoverHue, pairHue, forgetHue, fetchHueLights, automapHue,
    bindDevice, unbindDevice, fetchSettings, saveSettings, connectVacuum,
    connectShelly, forgetShelly, fetchShellyDevices, fetchShellySchedules, syncShellySchedules,
    fetchHueLights as loadHueLights, createScene, updateScene, deleteScene,
} from "../api"
import Hint from "../../common/Hint"
import { useUser } from "../../common/user"
import { SECTIONS, CLIMATE_TILES, readLayout, moveWithin, isHidden } from "../layout"
import FloorplanSettings from "./FloorplanSettings"
import SettingsSection from "./Section"
import "./settings.css"

export default function HomeSettings({ rooms, hue, shelly, vacuum, scenes, onChanged }) {
    const [settings, setSettings] = useState(null)
    const [error, setError] = useState("")

    const refresh = useCallback(async () => {
        try {
            setSettings(await fetchSettings())
            setError("")
        } catch (e) {
            setError(e.message)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    if (!settings) return <div className="home-status">Lädt…</div>

    return (
        <div className="home-view">
            <FloorplanSettings rooms={rooms} settings={settings}
                               onSaved={async () => { await refresh(); onChanged() }}
                               onChanged={onChanged} />
            <HueSettings rooms={rooms} hue={hue} onChanged={onChanged} />
            <SceneSettings scenes={scenes} hue={hue} onChanged={onChanged} />
            <ShellySettings rooms={rooms} shelly={shelly || {}} settings={settings}
                            onChanged={onChanged} />
            <VacuumSettings rooms={rooms} vacuum={vacuum} settings={settings}
                            onSaved={async () => { await refresh(); onChanged() }} onChanged={onChanged} />
            <LayoutSettings settings={settings}
                            onSaved={async () => { await refresh(); onChanged() }} />
            {error && <p className="home-error">{error}</p>}
        </div>
    )
}

/* ── Hue ─────────────────────────────────────────────────────────────────── */

function HueSettings({ rooms, hue, onChanged }) {
    const [bridges, setBridges] = useState(null)
    const [ip, setIp] = useState(hue.bridge_ip || "")
    const [lights, setLights] = useState([])
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    const loadLights = useCallback(async () => {
        if (!hue.configured) return
        try {
            const payload = await fetchHueLights()
            setLights(payload.lights || [])
            setError(payload.error || "")
        } catch (e) {
            setError(e.message)
        }
    }, [hue.configured])

    useEffect(() => { loadLights() }, [loadLights])

    async function run(action, successMessage) {
        setBusy(true)
        try {
            const result = await action()
            setError("")
            setMessage(typeof successMessage === "function" ? successMessage(result) : successMessage || "")
            await loadLights()
            onChanged()
        } catch (e) {
            setError(e.message)
            setMessage("")
        } finally {
            setBusy(false)
        }
    }

    // Which room each Hue lamp is currently bound to, so a select can show it
    const bindingByLight = {}
    for (const room of rooms) {
        for (const device of room.devices || []) {
            if (device.kind === "hue_light") bindingByLight[device.external_id] = { deviceId: device.id, roomId: room.id }
        }
    }

    async function rebind(lightId, lightName, roomId) {
        const current = bindingByLight[lightId]
        await run(async () => {
            if (current) await unbindDevice(current.deviceId)
            if (roomId) await bindDevice(Number(roomId), { kind: "hue_light", external_id: lightId, name: lightName })
        })
    }

    const bound = Object.keys(bindingByLight).length

    return (
        <SettingsSection
            id="hue"
            title="Philips Hue"
            chips={<>
                {hue.configured
                    ? <span className={`home-chip ${hue.reachable ? "home-chip-ok" : "home-chip-danger"}`}>
                          {hue.reachable ? "verbunden" : "nicht erreichbar"}
                      </span>
                    : <span className="home-chip">nicht eingerichtet</span>}
                {hue.bridge_ip && <span className="home-meta home-num">{hue.bridge_ip}</span>}
            </>}
            summary={hue.configured
                ? `${lights.length} Lampe${lights.length === 1 ? "" : "n"}, ${bound} zugeordnet`
                : "Bridge koppeln"}
        >

            {!hue.configured && (
                <>
                    <p className="home-empty">
                        Zum Koppeln den runden Knopf auf der Bridge drücken und <em>danach</em> innerhalb
                        von etwa 30 Sekunden auf „Koppeln“ tippen.
                    </p>
                    <div className="home-form">
                        <label className="home-field">Bridge-IP
                            <input value={ip} onChange={e => setIp(e.target.value)} placeholder="192.168.2.x" />
                        </label>
                        <div className="home-form-actions">
                            <button className="home-btn" disabled={busy}
                                    onClick={() => run(async () => {
                                        const found = await discoverHue()
                                        setBridges(found)
                                        if (found.length === 1) setIp(found[0].ip)
                                    }, "Suche abgeschlossen.")}>Bridges suchen</button>
                            <button className="home-btn primary" disabled={busy || !ip}
                                    onClick={() => run(() => pairHue(ip), "Bridge gekoppelt.")}>Koppeln</button>
                        </div>
                    </div>
                    {bridges && bridges.length === 0 && (
                        <p className="home-empty">Keine Bridge gefunden — IP von Hand eintragen.</p>
                    )}
                    {bridges && bridges.length > 0 && (
                        <p className="home-empty">
                            Gefunden: {bridges.map(b => b.ip).join(", ")}
                        </p>
                    )}
                </>
            )}

            {hue.configured && (
                <>
                    <div className="home-actions">
                        <button className="home-btn" disabled={busy}
                                onClick={() => run(automapHue, r => r.bound === 0
                                    ? "Nichts Neues zuzuordnen."
                                    : `${r.bound} Lampe(n) übernommen.`
                                      + (r.unmatched.length ? ` Ohne Entsprechung: ${r.unmatched.join(", ")}.` : ""))}>
                            Aus Hue-Räumen übernehmen
                        </button>
                        <button className="home-btn danger" disabled={busy}
                                onClick={() => run(forgetHue, "Hue entkoppelt.")}>Hue vergessen</button>
                    </div>

                    <div className="home-section">
                        <h5 className="home-h4">Lampen zuordnen</h5>
                        {lights.length === 0 && <p className="home-empty">Die Bridge meldet keine Lampen.</p>}
                        {lights.map(light => (
                            <div key={light.id} className="home-row">
                                <span className="home-row-title">{light.name}</span>
                                <span className={`home-chip ${light.on ? "home-chip-warn" : ""}`}>
                                    {light.on ? "an" : "aus"}
                                </span>
                                <select
                                    className="set-room-select"
                                    aria-label={`Raum für ${light.name}`}
                                    value={(bindingByLight[light.id] || {}).roomId || ""}
                                    disabled={busy}
                                    onChange={e => rebind(light.id, light.name, e.target.value)}
                                >
                                    <option value="">nicht zugeordnet</option>
                                    {rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
                                </select>
                            </div>
                        ))}
                    </div>
                </>
            )}

            {message && <p className="home-empty">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </SettingsSection>
    )
}

/* ── Appearance ───────────────────────────────────────────────────────────── */

/* The order of the room panel's blocks and of the climate tiles.
 *
 * Saved on the server rather than in this browser, and against the person
 * rather than the flat: it should hold on the hallway tablet as well as on the
 * phone, and two people may want different things in front of them. The
 * floorplan, the valves and the lamps stay shared - a flat has one layout of
 * rooms and one set of radiators. What stays in this browser is which block is
 * folded away, which genuinely is per device.
 *
 * Without a user there is nothing to save against, so the list reads and does
 * not write. The arrangement shown is then the flat's, which is also what a
 * tablet on the wall gets.
 *
 * Availability is not configured here. A block for a device that does not exist
 * never appears, however it is ordered, and the list says so rather than
 * offering a switch that changes nothing.
 */
function LayoutSettings({ settings, onSaved }) {
    const { user } = useUser()
    const [layout, setLayout] = useState(() => readLayout(settings.home_layout))
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")

    async function save(next) {
        if (!user) return
        setLayout(next)
        setBusy(true)
        try {
            await saveSettings({ home_layout: JSON.stringify(next) })
            setError("")
            setMessage("Darstellung gespeichert.")
            onSaved()
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    const move = (field, id, delta) =>
        save({ ...layout, [field]: moveWithin(layout[field], id, delta) })

    const toggle = (id) => save({
        ...layout,
        hidden: isHidden(layout, id)
            ? layout.hidden.filter(h => h !== id)
            : [...layout.hidden, id],
    })

    const sectionLabels = Object.fromEntries(SECTIONS.map(s => [s.id, s.label]))
    const tileLabels = Object.fromEntries(CLIMATE_TILES.map(t => [t.id, t.label]))

    return (
        <SettingsSection
            id="layout"
            title="Darstellung"
            chips={<Hint>
                Gilt für das Raumpanel im Grundriss. Was es nicht gibt, wird ohnehin nicht
                gezeigt — ein Raum ohne Ventil hat keinen Klima-Block, gleich an welcher
                Stelle er steht.
            </Hint>}
            summary={user ? `für ${user.name}` : `${layout.sections.length} Blöcke`}
        >
            {!user && (
                <p className="home-empty">
                    Die Anordnung gehört zu einem Benutzer — oben rechts einen auswählen,
                    um eine eigene zu speichern. Gezeigt wird solange die der Wohnung.
                </p>
            )}
            <div className="home-section">
                <h5 className="home-h4">Blöcke im Raumpanel</h5>
                <OrderList order={layout.sections} labels={sectionLabels} layout={layout}
                           busy={busy} locked={!user} onMove={(id, d) => move("sections", id, d)}
                           onToggle={toggle} />
            </div>
            <div className="home-section">
                <h5 className="home-h4">Kacheln im Klima-Block</h5>
                <OrderList order={layout.climate_tiles} labels={tileLabels} layout={layout}
                           busy={busy} locked={!user} onMove={(id, d) => move("climate_tiles", id, d)}
                           onToggle={toggle} />
            </div>
            {message && <p className="home-empty">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </SettingsSection>
    )
}


/* Outside the component on purpose: a component declared inside a render is a
   different component on every render, and React throws its state away. This
   one has none, but the habit is what costs an afternoon later. */
function OrderList({ order, labels, layout, busy, locked, onMove, onToggle }) {
    return (
        <div className="set-order">
            {order.map((id, index) => labels[id] && (
                <div key={id} className="home-row" data-off={isHidden(layout, id)}>
                    <span className="home-meta home-num">{index + 1}</span>
                    <span className="home-row-title">{labels[id]}</span>
                    <span className="fps-spacer" />
                    <label className="fps-inline">
                        <input type="checkbox" checked={!isHidden(layout, id)}
                               disabled={busy || locked} onChange={() => onToggle(id)} />
                        zeigen
                    </label>
                    <button className="home-icon-btn" title="nach oben" disabled={busy || locked || index === 0}
                            onClick={() => onMove(id, -1)}>↑</button>
                    <button className="home-icon-btn" title="nach unten"
                            disabled={busy || locked || index === order.length - 1}
                            onClick={() => onMove(id, 1)}>↓</button>
                </div>
            ))}
        </div>
    )
}


/* ── Scenes ───────────────────────────────────────────────────────────────── */

const EMPTY_SCENE = { name: "", duration_s: 1800, fade_s: 300, turn_off: true, lights: [] }

/* Minutes in the form, seconds in the database. The form speaks the unit people
   think in; the service speaks the one it counts in, and 0 means "no end". */
const toMinutes = (seconds) => (seconds ? Math.round(seconds / 60) : 0)
const toSeconds = (minutes) => Math.max(0, Math.round(Number(minutes) || 0) * 60)

/* xy back to something a colour input accepts. Only an approximation of the
   inverse - the bridge's gamut is not sRGB - but it has one job: show roughly
   the colour that was chosen, so the swatch is recognisable. */
function xyToHex(xy, brightness = 100) {
    if (!Array.isArray(xy) || xy.length !== 2) return "#ffffff"
    const [x, y] = xy
    if (!y) return "#ffffff"
    const Y = Math.max(0.05, (brightness || 100) / 100)
    const X = (Y / y) * x
    const Z = (Y / y) * (1 - x - y)
    const clamp = (v) => Math.max(0, Math.min(1, v))
    const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
    const r = gamma(clamp(X * 1.656492 - Y * 0.354851 - Z * 0.255038))
    const g = gamma(clamp(-X * 0.707196 + Y * 1.655397 + Z * 0.036152))
    const b = gamma(clamp(X * 0.051713 - Y * 0.121364 + Z * 1.011530))
    const hex = (v) => Math.round(clamp(v) * 255).toString(16).padStart(2, "0")
    return `#${hex(r)}${hex(g)}${hex(b)}`
}

function SceneSettings({ scenes, hue, onChanged }) {
    const [lights, setLights] = useState([])
    const [draft, setDraft] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [message, setMessage] = useState("")

    useEffect(() => {
        if (!hue || !hue.configured) return
        loadHueLights().then(p => setLights(p.lights || [])).catch(() => setLights([]))
    }, [hue])

    async function run(action, note) {
        setBusy(true)
        try {
            await action()
            setError("")
            setMessage(note || "")
            setDraft(null)
            onChanged()
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    function edit(scene) {
        setDraft({
            ...scene,
            lights: (scene.lights || []).map(l => ({ ...l, color: xyToHex(l.xy, l.brightness) })),
        })
        setMessage("")
    }

    function patch(change) {
        setDraft(current => ({ ...current, ...change }))
    }

    function toggleLight(light) {
        const chosen = draft.lights.some(l => l.light_id === light.id)
        patch({
            lights: chosen
                ? draft.lights.filter(l => l.light_id !== light.id)
                : [...draft.lights, { light_id: light.id, brightness: 70, color: "#ffd9a0" }],
        })
    }

    function patchLight(lightId, change) {
        patch({ lights: draft.lights.map(l => l.light_id === lightId ? { ...l, ...change } : l) })
    }

    const list = scenes || []

    return (
        <SettingsSection
            id="scenes"
            title="Szenen"
            chips={<Hint>
                Eine Szene schaltet bestimmte Lampen in einen Zustand und beendet ihn nach
                einer Zeit. Der Ablauf liegt im Dienst, nicht im Browser — das Ende kommt
                auch, wenn das Tablet aus ist. Das Ausdimmen übernimmt die Bridge selbst.
            </Hint>}
            summary={list.length ? `${list.length} angelegt` : "keine"}
        >
            {(!hue || !hue.configured) && (
                <p className="home-empty">
                    Ohne Hue gibt es keine Lampen zu schalten — oben unter „Philips Hue"
                    koppeln.
                </p>
            )}

            {list.map(scene => (
                <div key={scene.id} className="home-row">
                    <span className="home-row-title">{scene.name}</span>
                    <span className="home-meta">
                        {scene.duration_s ? `${toMinutes(scene.duration_s)} min` : "ohne Ende"}
                        {scene.fade_s > 0 && ` · ${toMinutes(scene.fade_s)} min ausdimmen`}
                        {` · ${scene.lights.length} Lampen`}
                    </span>
                    <span className="fps-spacer" />
                    <button className="home-btn" disabled={busy}
                            onClick={() => edit(scene)}>Bearbeiten</button>
                    <button className="home-btn danger" disabled={busy}
                            onClick={() => run(() => deleteScene(scene.id), "Szene gelöscht.")}>
                        ✕
                    </button>
                </div>
            ))}

            {!draft && (
                <div className="home-form-actions">
                    <button className="home-btn primary" disabled={busy}
                            onClick={() => setDraft({ ...EMPTY_SCENE })}>+ Szene</button>
                </div>
            )}

            {draft && (
                <div className="home-section">
                    <h5 className="home-h4">{draft.id ? "Szene bearbeiten" : "Neue Szene"}</h5>
                    <div className="fps-grid">
                        <label className="home-field">Name
                            <input value={draft.name} autoFocus
                                   onChange={e => patch({ name: e.target.value })} />
                        </label>
                        <label className="home-field">Dauer (min, 0 = ohne Ende)
                            <input type="number" min="0" step="1" value={toMinutes(draft.duration_s)}
                                   onChange={e => patch({ duration_s: toSeconds(e.target.value) })} />
                        </label>
                        <label className="home-field">Ausdimmen (min)
                            <input type="number" min="0" step="1" value={toMinutes(draft.fade_s)}
                                   onChange={e => patch({ fade_s: toSeconds(e.target.value) })} />
                        </label>
                        <label className="fps-inline">
                            <input type="checkbox" checked={!!draft.turn_off}
                                   onChange={e => patch({ turn_off: e.target.checked })} />
                            am Ende ausschalten
                        </label>
                    </div>

                    <p className="home-empty">
                        Ausdimmen zählt in die Dauer hinein: 30 Minuten mit 5 Minuten Ausdimmen
                        heißt 25 Minuten hell, dann 5 Minuten langsam dunkler.
                    </p>

                    {lights.length === 0 && (
                        <p className="home-empty">Die Bridge meldet keine Lampen.</p>
                    )}
                    {lights.map(light => {
                        const chosen = draft.lights.find(l => l.light_id === light.id)
                        return (
                            <div key={light.id} className="home-row">
                                <label className="fps-inline">
                                    <input type="checkbox" checked={!!chosen}
                                           onChange={() => toggleLight(light)} />
                                    {light.name}
                                </label>
                                {chosen && (
                                    <>
                                        <input type="range" min="1" max="100" step="1"
                                               aria-label={`Helligkeit ${light.name}`}
                                               value={chosen.brightness ?? 70}
                                               onChange={e => patchLight(light.id,
                                                   { brightness: Number(e.target.value) })} />
                                        <span className="home-meta home-num">
                                            {chosen.brightness ?? 70} %
                                        </span>
                                        {light.supports_color && (
                                            <input type="color" value={chosen.color || "#ffd9a0"}
                                                   aria-label={`Farbe ${light.name}`}
                                                   onChange={e => patchLight(light.id,
                                                       { color: e.target.value })} />
                                        )}
                                    </>
                                )}
                            </div>
                        )
                    })}

                    <div className="home-form-actions">
                        <button className="home-btn primary"
                                disabled={busy || !draft.name.trim() || draft.lights.length === 0}
                                onClick={() => run(() => draft.id
                                    ? updateScene(draft.id, draft)
                                    : createScene(draft), "Szene gespeichert.")}>
                            Speichern
                        </button>
                        <button className="home-btn" disabled={busy}
                                onClick={() => setDraft(null)}>Abbrechen</button>
                    </div>
                </div>
            )}

            {message && <p className="home-empty">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </SettingsSection>
    )
}


/* ── Shelly BLU ───────────────────────────────────────────────────────────── */

function fmtTemp(value) {
    return value == null ? "–" : `${Number(value).toFixed(1).replace(".", ",")} °C`
}

function ShellySettings({ rooms, shelly, settings, onChanged }) {
    const [ip, setIp] = useState(shelly.gateway_ip || "")
    const [password, setPassword] = useState("")
    const [trvs, setTrvs] = useState([])
    const [hts, setHts] = useState([])
    const [jobs, setJobs] = useState(null)
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)

    const loadTrvs = useCallback(async () => {
        if (!shelly.configured) return
        try {
            const payload = await fetchShellyDevices()
            setTrvs(payload.trvs || [])
            setHts(payload.sensors || [])
            setError(payload.error || "")
        } catch (e) {
            setError(e.message)
        }
        try {
            setJobs(await fetchShellySchedules())
        } catch {
            // The valves are the point of this block; the job count is extra.
            setJobs(null)
        }
    }, [shelly.configured])

    useEffect(() => { loadTrvs() }, [loadTrvs])

    async function run(action, successMessage) {
        setBusy(true)
        try {
            const result = await action()
            setError("")
            setMessage(typeof successMessage === "function" ? successMessage(result) : successMessage || "")
            await loadTrvs()
            onChanged()
        } catch (e) {
            setError(e.message)
            setMessage("")
        } finally {
            setBusy(false)
        }
    }

    // Which room each device is bound to, per kind, so a select can show it
    const binding = { shelly_climate: {}, shelly_ht: {} }
    for (const room of rooms) {
        for (const device of room.devices || []) {
            if (binding[device.kind]) {
                binding[device.kind][device.external_id] = { deviceId: device.id, roomId: room.id }
            }
        }
    }

    async function rebind(kind, externalId, name, roomId) {
        const current = binding[kind][String(externalId)]
        await run(async () => {
            if (current) await unbindDevice(current.deviceId)
            if (roomId) {
                await bindDevice(Number(roomId), {
                    kind, external_id: String(externalId), name,
                })
            }
        })
    }

    const unbound = trvs.filter(t => !binding.shelly_climate[String(t.id)]).length
                  + hts.filter(h => !binding.shelly_ht[String(h.addr)]).length
    const chips = shelly.configured
        ? <>
              <span className={`home-chip ${shelly.reachable ? "home-chip-ok" : "home-chip-danger"}`}>
                  {shelly.reachable ? "verbunden" : "nicht erreichbar"}
              </span>
              {shelly.gateway_ip && <span className="home-meta home-num">{shelly.gateway_ip}</span>}
          </>
        : <span className="home-chip">nicht eingerichtet</span>

    return (
        <SettingsSection
            id="shelly"
            title="Shelly BLU — Heizung"
            chips={chips}
            summary={shelly.configured
                ? `${trvs.length} Ventil${trvs.length === 1 ? "" : "e"}, `
                  + `${hts.length} Fühler`
                  + (unbound ? `, ${unbound} ohne Raum` : "")
                  + (jobs && jobs.desired ? `, ${(jobs.ours || []).length} Aufträge` : "")
                : "Gateway verbinden"}
        >
            {!shelly.configured && (
                <>
                    <p className="home-empty">
                        Das BLU-Gateway überträgt die Heizkörperventile per Bluetooth. Es braucht eine
                        feste Adresse im Netz — im Router reservieren, sonst zeigt die Zuordnung
                        irgendwann ins Leere.
                    </p>
                    <div className="home-form">
                        <label className="home-field">Gateway-IP
                            <input value={ip} onChange={e => setIp(e.target.value)} placeholder="192.168.2.x" />
                        </label>
                        <label className="home-field">Passwort (falls gesetzt)
                            <input type="password" value={password} autoComplete="new-password"
                                   onChange={e => setPassword(e.target.value)} placeholder="leer = keines" />
                        </label>
                        <div className="home-form-actions">
                            <button className="home-btn primary" disabled={busy || !ip}
                                    onClick={() => run(() => connectShelly(ip, password || null),
                                                       r => `Gateway ${r.gateway.model}, Firmware ${r.gateway.version}.`)}>
                                Verbinden
                            </button>
                        </div>
                    </div>
                </>
            )}

            {shelly.configured && (
                <>
                    <div className="home-actions">
                        <button className="home-btn" disabled={busy}
                                onClick={() => run(loadTrvs, "Ventile neu gelesen.")}>Aktualisieren</button>
                        <button className="home-btn" disabled={busy || !ip}
                                onClick={() => run(() => connectShelly(ip, password || null), "Zugang gespeichert.")}>
                            Zugang ändern
                        </button>
                        <button className="home-btn danger" disabled={busy}
                                onClick={() => run(forgetShelly, "Gateway vergessen.")}>Gateway vergessen</button>
                    </div>
                    <div className="home-form">
                        <label className="home-field">Gateway-IP
                            <input value={ip} onChange={e => setIp(e.target.value)} />
                        </label>
                        <label className="home-field">Passwort
                            <input type="password" value={password} autoComplete="new-password"
                                   onChange={e => setPassword(e.target.value)}
                                   placeholder={settings.shelly_gateway_password_set ? "hinterlegt" : "keines"} />
                        </label>
                    </div>

                    <div className="home-section">
                        <div className="home-card-header">
                            <h5 className="home-h4">Ventile zuordnen</h5>
                            <Hint>
                                Mehrere Ventile dürfen in denselben Raum — zwei Heizkörper unter
                                einem Fenster sind ein Raum mit einem Wunsch. Die Temperatur ist
                                dann das Mittel, der Sollwert der niedrigste.
                            </Hint>
                        </div>
                        {trvs.length === 0 && (
                            <p className="home-empty">
                                Das Gateway meldet kein Ventil. Gekoppelt wird in der Shelly-App,
                                nicht hier.
                            </p>
                        )}
                        {trvs.map(trv => (
                            <div key={trv.id} className="home-row">
                                <span className="home-row-title">{trv.name || `Ventil ${trv.id}`}</span>
                                <span className="home-meta home-num">{trv.addr}</span>
                                <span className="home-meta">
                                    {fmtTemp(trv.current_C)} · Soll {fmtTemp(trv.target_C)}
                                    {trv.battery != null && ` · Batterie ${trv.battery} %`}
                                </span>
                                <select
                                    className="set-room-select"
                                    aria-label={`Raum für Ventil ${trv.id}`}
                                    value={(binding.shelly_climate[String(trv.id)] || {}).roomId || ""}
                                    disabled={busy}
                                    onChange={e => rebind("shelly_climate", trv.id,
                                                          trv.name || `Ventil ${trv.id}`, e.target.value)}
                                >
                                    <option value="">nicht zugeordnet</option>
                                    {rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
                                </select>
                            </div>
                        ))}
                    </div>

                    <div className="home-section">
                        <div className="home-card-header">
                            <h5 className="home-h4">Fühler zuordnen</h5>
                            <Hint>
                                Ein Wandfühler misst die Raumluft, der Fühler im Ventilkopf sitzt
                                auf einem meist kalten Heizkörper und liest zu niedrig. Wo ein
                                Fühler zugeordnet ist, zeigt der Plan dessen Temperatur und seine
                                Luftfeuchte. Dass das Ventil selbst darauf regelt, ist eine zweite
                                Sache — die wird in der Shelly-App am Ventil hinterlegt.
                            </Hint>
                        </div>
                        {hts.length === 0 && (
                            <p className="home-empty">
                                Das Gateway meldet keinen Fühler.
                            </p>
                        )}
                        {hts.map(ht => (
                            <div key={ht.addr} className="home-row">
                                <span className="home-row-title">{ht.name || "ohne Namen"}</span>
                                <span className="home-meta home-num">{ht.addr}</span>
                                <span className="home-meta">
                                    {fmtTemp(ht.temperature)}
                                    {ht.humidity != null && ` · ${ht.humidity} % rF`}
                                    {ht.battery != null && ` · Batterie ${ht.battery} %`}
                                </span>
                                <select
                                    className="set-room-select"
                                    aria-label={`Raum für Fühler ${ht.name || ht.addr}`}
                                    value={(binding.shelly_ht[String(ht.addr)] || {}).roomId || ""}
                                    disabled={busy}
                                    onChange={e => rebind("shelly_ht", ht.addr,
                                                          ht.name || ht.addr, e.target.value)}
                                >
                                    <option value="">nicht zugeordnet</option>
                                    {rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
                                </select>
                            </div>
                        ))}
                        {hts.some(h => !h.name) && (
                            <p className="home-empty">
                                Ein Fühler hat am Gateway keinen Namen. Dort vergeben, dann steht er
                                auch hier.
                            </p>
                        )}
                    </div>

                    <div className="home-section">
                        <h5 className="home-h4">Heizpläne im Gateway</h5>
                        <p className="home-empty">
                            Die Zeiten aus den Raumplänen liegen als Aufträge im Gateway, nicht auf
                            dem Pi — sie greifen also auch, wenn der Pi aus ist. Gespiegelt wird bei
                            jeder Änderung; diese Datenbank ist die Quelle, das Gateway ihr Abbild.
                            Aufträge, die hier nicht angelegt wurden, bleiben unangetastet.
                        </p>
                        {jobs && (
                            <div className="home-row">
                                <span className="home-row-title">
                                    {(jobs.ours || []).length} von {jobs.limit || 20} Aufträgen
                                </span>
                                {jobs.foreign > 0 &&
                                    <span className="home-meta">
                                        {jobs.foreign} fremde{jobs.foreign === 1 ? "r" : ""} Auftrag
                                        {jobs.foreign === 1 ? "" : "e"} — bleibt unberührt
                                    </span>}
                                {(jobs.ours || []).length !== jobs.desired &&
                                    <span className="home-chip home-chip-warn">nicht abgeglichen</span>}
                                <button className="home-btn" disabled={busy}
                                        onClick={() => run(syncShellySchedules, r => r.synced
                                            ? (r.changed ? `${r.jobs} Auftrag/Aufträge geschrieben.`
                                                         : "War schon aktuell.")
                                            : `Nicht gespiegelt: ${r.reason}`)}>
                                    Jetzt abgleichen
                                </button>
                            </div>
                        )}
                        {jobs && (jobs.problems || []).map((problem, i) => (
                            <p key={i} className="home-error">{problem}</p>
                        ))}
                        {jobs && jobs.desired === 0 && (
                            <p className="home-empty">
                                Noch keine Zeiten zu spiegeln — Heizpläne entstehen je Raum im
                                Grundriss.
                            </p>
                        )}
                    </div>
                </>
            )}

            {message && <p className="home-empty">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </SettingsSection>
    )
}


/* ── yeedi ───────────────────────────────────────────────────────────────── */

function VacuumSettings({ rooms, vacuum, settings, onSaved, onChanged }) {
    const [account, setAccount] = useState(settings.yeedi_account || "")
    const [password, setPassword] = useState("")
    const [country, setCountry] = useState(settings.yeedi_country || "DE")
    const [fallback, setFallback] = useState(settings.yeedi_fallback_class || "")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [message, setMessage] = useState("")

    async function run(action, successMessage) {
        setBusy(true)
        try {
            await action()
            setError("")
            setMessage(successMessage || "")
        } catch (e) {
            setError(e.message)
            setMessage("")
        } finally {
            setBusy(false)
        }
    }

    const bindingByVacuumRoom = {}
    for (const room of rooms) {
        for (const device of room.devices || []) {
            if (device.kind === "vacuum_room") bindingByVacuumRoom[device.external_id] = { deviceId: device.id, roomId: room.id }
        }
    }

    async function rebind(vacuumRoom, roomId) {
        const current = bindingByVacuumRoom[String(vacuumRoom.id)]
        await run(async () => {
            if (current) await unbindDevice(current.deviceId)
            if (roomId) {
                await bindDevice(Number(roomId), {
                    kind: "vacuum_room", external_id: String(vacuumRoom.id), name: vacuumRoom.name,
                })
            }
            onChanged()
        })
    }

    return (
        <SettingsSection
            id="vacuum"
            title="yeedi / Ecovacs"
            chips={vacuum.connected
                ? <span className="home-chip home-chip-ok">verbunden</span>
                : <span className="home-chip">getrennt</span>}
            summary={settings.yeedi_account
                ? (vacuum.connected ? "Roboter erreichbar" : "Konto hinterlegt")
                : "Konto hinterlegen"}
        >
            <p className="home-empty">
                Der Roboter hängt an der Ecovacs-Cloud, nicht im LAN — dafür braucht der Dienst dein
                Konto. Das Passwort wird nur als MD5-Hash gespeichert, weil das Protokoll genau den
                verlangt; es verlässt den Pi nur Richtung Ecovacs.
            </p>

            <div className="home-form">
                <label className="home-field">Konto (E-Mail)
                    <input type="email" autoComplete="off" value={account}
                           onChange={e => setAccount(e.target.value)} />
                </label>
                <label className="home-field">Passwort
                    <input type="password" autoComplete="new-password" value={password}
                           placeholder={settings.yeedi_password_hash_set ? "gespeichert — zum Ändern eingeben" : ""}
                           onChange={e => setPassword(e.target.value)} />
                </label>
                <label className="home-field narrow">Land
                    <input value={country} maxLength={2}
                           onChange={e => setCountry(e.target.value.toUpperCase())} />
                </label>
                <label className="home-field">Ersatzprofil
                    <select value={fallback} onChange={e => setFallback(e.target.value)}>
                        <option value="">keins — nur unterstützte Geräte</option>
                        {(settings.fallback_classes || []).map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                </label>
                <div className="home-form-actions">
                    <button className="home-btn primary" disabled={busy || !account}
                            onClick={() => run(async () => {
                                await saveSettings({
                                    yeedi_account: account,
                                    yeedi_country: country,
                                    yeedi_fallback_class: fallback,
                                    ...(password ? { yeedi_password: password } : {}),
                                })
                                setPassword("")
                                await onSaved()
                            }, "Gespeichert.")}>Speichern</button>
                    <button className="home-btn" disabled={busy || !settings.yeedi_password_hash_set}
                            onClick={() => run(async () => { await connectVacuum(); onChanged() },
                                               "Verbindung wird aufgebaut — Status oben im Tab „Staubsauger“.")}>
                        Verbinden
                    </button>
                </div>
            </div>

            <p className="home-empty">
                Das Ersatzprofil ist nur nötig, wenn dein Gerät als „nicht unterstützt“ gemeldet wird:
                dann wird es mit dem Protokoll eines bekannten yeedi-Modells angesprochen.
            </p>

            {(vacuum.rooms || []).length > 0 && (
                <div className="home-section">
                    <h5 className="home-h4">Räume der Roboterkarte zuordnen</h5>
                    {vacuum.rooms.map(vacuumRoom => (
                        <div key={vacuumRoom.id} className="home-row">
                            <span className="home-row-title">{vacuumRoom.name || `Raum ${vacuumRoom.id}`}</span>
                            <span className="home-meta home-num">#{vacuumRoom.id}</span>
                            <select
                                className="set-room-select"
                                aria-label={`Wohnungsraum für Karten-Raum ${vacuumRoom.id}`}
                                value={(bindingByVacuumRoom[String(vacuumRoom.id)] || {}).roomId || ""}
                                disabled={busy}
                                onChange={e => rebind(vacuumRoom, e.target.value)}
                            >
                                <option value="">nicht zugeordnet</option>
                                {rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
                            </select>
                        </div>
                    ))}
                </div>
            )}

            {message && <p className="home-empty">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </SettingsSection>
    )
}
