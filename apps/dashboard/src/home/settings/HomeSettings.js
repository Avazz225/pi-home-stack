import { useState, useEffect, useCallback } from "react"
import {
    discoverHue, pairHue, forgetHue, fetchHueLights, automapHue,
    bindDevice, unbindDevice, fetchSettings, saveSettings, connectVacuum,
} from "../api"
import "./settings.css"

export default function HomeSettings({ rooms, hue, vacuum, onChanged }) {
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
            <HueSettings rooms={rooms} hue={hue} onChanged={onChanged} />
            <VacuumSettings rooms={rooms} vacuum={vacuum} settings={settings}
                            onSaved={async () => { await refresh(); onChanged() }} onChanged={onChanged} />
            <div className="home-card">
                <h4 className="home-h4">Shelly</h4>
                <p className="home-empty">
                    Datenmodell und Oberfläche stehen: Temperatur, Luftfeuchte, Fensterstatus und
                    Soll-Temperatur sind je Raum vorgesehen, der Heizplan funktioniert schon. Der
                    Adapter zu den Geräten folgt, sobald welche da sind.
                </p>
            </div>
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

    return (
        <div className="home-card">
            <div className="home-card-header">
                <h4>Philips Hue</h4>
                {hue.configured
                    ? <span className={`home-chip ${hue.reachable ? "home-chip-ok" : "home-chip-danger"}`}>
                          {hue.reachable ? "verbunden" : "nicht erreichbar"}
                      </span>
                    : <span className="home-chip">nicht eingerichtet</span>}
                {hue.bridge_ip && <span className="home-meta home-num">{hue.bridge_ip}</span>}
            </div>

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
        </div>
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
        <div className="home-card">
            <div className="home-card-header">
                <h4>yeedi / Ecovacs</h4>
                {vacuum.connected
                    ? <span className="home-chip home-chip-ok">verbunden</span>
                    : <span className="home-chip">getrennt</span>}
            </div>
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
        </div>
    )
}
