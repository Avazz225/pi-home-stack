import { useCallback, useEffect, useState } from "react"
import { fetchHeatingModel, forgetHeatingModel, saveSettings } from "../api"
import SettingsSection from "./Section"
import Hint from "../../common/Hint"
import "./adaptive.css"

/* Heating that starts late enough to be cheap and early enough to be warm.
 *
 * The block exists mostly to be read. The adaptive part changes when somebody's
 * morning starts, and a system that does that without saying why is one people
 * switch off - so everything it decided is on screen next to what it decided it
 * from, and there is a button to throw the whole lot away.
 */

const fmt = (value, digits = 1, unit = "") =>
    value == null ? "–" : `${Number(value).toFixed(digits).replace(".", ",")}${unit}`

/* A rate in degrees per minute is unreadable; the same number per hour is the
   one people have an opinion about. */
const perHour = (rate) => rate == null ? "–" : `${(rate * 60).toFixed(1).replace(".", ",")} K/h`

export default function AdaptiveSettings({ settings, onSaved }) {
    const [model, setModel] = useState(null)
    const [lat, setLat] = useState(settings.latitude || "")
    const [lon, setLon] = useState(settings.longitude || "")
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")

    const refresh = useCallback(async () => {
        try {
            setModel(await fetchHeatingModel())
            setError("")
        } catch (e) {
            setError(e.message)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    async function run(action, note) {
        setBusy(true)
        try {
            await action()
            await refresh()
            if (onSaved) await onSaved()
            setError("")
            setMessage(note || "")
        } catch (e) {
            setError(e.message)
            setMessage("")
        } finally {
            setBusy(false)
        }
    }

    const learning = settings.adaptive_learning === "1"
    const weather = settings.adaptive_weather === "1"
    const entries = (model && model.entries) || []
    const shifted = entries.filter(e => e.preheat_minutes > 0)

    return (
        <SettingsSection
            id="adaptive"
            title="Adaptive Heizung"
            chips={<Hint>
                Der Plan sagt, wann es warm sein soll. Wie lange der Raum dafür braucht,
                misst das System selbst — und schiebt den Heizungsstart entsprechend nach
                vorn. Die Zeiten liegen weiterhin im Gateway, die Heizung läuft also auch
                dann nach Plan, wenn der Pi aus ist.
            </Hint>}
            summary={learning ? `${shifted.length} Zeiten verschoben` : "aus"}
        >
            <div className="fps-grid">
                <label className="fps-inline">
                    <input type="checkbox" checked={learning} disabled={busy}
                           onChange={e => run(() => saveSettings(
                               { adaptive_learning: e.target.checked ? "1" : "0" }),
                               e.target.checked ? "Lernmodus an." : "Lernmodus aus.")} />
                    Lernmodus
                </label>
                <label className="fps-inline">
                    <input type="checkbox" checked={weather} disabled={busy || !learning}
                           onChange={e => run(() => saveSettings(
                               { adaptive_weather: e.target.checked ? "1" : "0" }),
                               "Gespeichert.")} />
                    Wettervorhersage einbeziehen
                </label>
            </div>

            <div className="home-section">
                <div className="home-card-header">
                    <h5 className="home-h4">Standort</h5>
                    <Hint>
                        Nur für die Vorhersage: wie kalt es draußen wird und wie viel Sonne
                        auf die Fenster fällt. Die Koordinaten bleiben in der Datenbank
                        dieses Pi, die außerhalb des Repos liegt — geteilt wird nichts
                        außer der Abfrage bei Open-Meteo, die keinen Schlüssel und kein
                        Konto braucht. Ohne Koordinaten rechnet das System mit neutralen
                        Werten weiter.
                    </Hint>
                </div>
                <div className="fps-grid">
                    {/* Berlin, as a shape to copy rather than a place to use.
                        A placeholder is read by everyone who opens this screen,
                        so it has to be somewhere nobody lives in particular. */}
                    <label className="home-field">Breitengrad
                        <input type="number" step="0.0001" value={lat} placeholder="52.5200"
                               onChange={e => setLat(e.target.value)} />
                    </label>
                    <label className="home-field">Längengrad
                        <input type="number" step="0.0001" value={lon} placeholder="13.4050"
                               onChange={e => setLon(e.target.value)} />
                    </label>
                    <div className="home-form-actions fps-extent">
                        <button className="home-btn primary" disabled={busy}
                                onClick={() => run(() => saveSettings(
                                    { latitude: lat, longitude: lon }), "Standort gespeichert.")}>
                            Speichern
                        </button>
                    </div>
                </div>
                {model && model.forecast && (
                    <p className="home-empty">
                        Vorhersage: {model.forecast.source === "open-meteo"
                            ? `Open-Meteo, gerade ${fmt(model.forecast.now?.[0])} °C und `
                              + `${fmt(model.forecast.now?.[1], 0)} W/m²`
                            : model.forecast.error || "aus — es wird mit neutralen Werten gerechnet"}
                    </p>
                )}
            </div>

            {learning && (
                <div className="home-section">
                    <div className="home-card-header">
                        <h5 className="home-h4">Was gelernt wurde</h5>
                        {model && <span className="home-meta">{model.samples} Messpunkte</span>}
                    </div>
                    {entries.length === 0 && (
                        <p className="home-empty">
                            Noch kein Heizplan mit Ventilen — ohne den gibt es nichts zu
                            verschieben.
                        </p>
                    )}
                    <div className="ad-list">
                        {entries.map((entry, index) => (
                            <div key={index} className="home-row">
                                <span className="home-row-title">{entry.room}</span>
                                <span className="home-meta home-num">
                                    {entry.time} → {fmt(entry.target, 1, " °C")}
                                </span>
                                <span className="fps-spacer" />
                                {entry.preheat_minutes > 0 ? (
                                    <span className="ad-shift">
                                        startet {entry.starts_at}
                                        <span className="home-meta">
                                            {" "}({entry.preheat_minutes} min Vorlauf
                                            {entry.rise ? `, ${fmt(entry.rise)} K` : ""})
                                        </span>
                                    </span>
                                ) : (
                                    <span className="home-meta">unverändert</span>
                                )}
                                {entry.valve_target != null
                                    && entry.valve_target !== entry.target && (
                                    <span className="home-meta">
                                        Ventil {fmt(entry.valve_target, 1, " °C")}
                                    </span>
                                )}
                                <span className="home-meta ad-learned">
                                    {entry.heat_rate_samples
                                        ? `${perHour(entry.heat_rate)} aus ${entry.heat_rate_samples}`
                                        : "noch nichts gemessen"}
                                    {entry.overshoot_samples
                                        ? ` · Nachlauf ${fmt(entry.overshoot)} K`
                                        : ""}
                                </span>
                            </div>
                        ))}
                    </div>

                    {entries.some(e => !e.heat_rate_samples) && (
                        <p className="home-empty">
                            Bis zur ersten Messung wird mit einem Standardwert gerechnet. Eine
                            Messung entsteht, wenn ein Raum einen Sollwertsprung tatsächlich
                            erreicht — das dauert ein paar Tage.
                        </p>
                    )}

                    <div className="home-form-actions">
                        <button className="home-btn danger" disabled={busy}
                                onClick={() => run(forgetHeatingModel, "Gelerntes verworfen.")}>
                            Gelerntes verwerfen
                        </button>
                    </div>
                </div>
            )}

            {message && <p className="home-empty">{message}</p>}
            {error && <p className="home-error">{error}</p>}
        </SettingsSection>
    )
}
