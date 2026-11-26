import Hint from "../common/Hint"
import "./energy.css"

/* The flat's electricity, in one line above the plan.
 *
 * Two numbers and a week. What is being drawn right now answers "did I leave
 * something on", what today has cost answers "is this month going to hurt",
 * and the week behind them is what makes either number mean anything - 3,4 kWh
 * is only high or low next to the six days before it.
 *
 * Deliberately not a page of its own. The question is asked in passing, on the
 * way to something else, and a figure behind a tab is a figure nobody checks.
 */

const DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]

function fmtKwh(wh) {
    if (wh == null) return "—"
    if (wh < 1000) return `${Math.round(wh)} Wh`
    return `${(wh / 1000).toFixed(1).replace(".", ",")} kWh`
}

function fmtWatt(value) {
    return value == null ? "—" : `${Math.round(value)} W`
}

export default function EnergyStrip({ energy }) {
    /* Nothing to show before the first socket exists. An empty strip saying
       "0 W" would be a measurement nobody made. */
    if (!energy || !energy.configured) return null

    const days = energy.days || []
    /* The tallest day sets the scale. Against a fixed ceiling a quiet week
       would be seven stumps and a heavy one would clip. */
    const peak = Math.max(1, ...days.map(d => d.energy_wh || 0))
    const today = new Date().toISOString().slice(0, 10)

    return (
        <div className="es-strip">
            <div className="es-figure">
                <span className="home-meta">Gerade</span>
                <span className="es-value">{fmtWatt(energy.power_w)}</span>
            </div>
            <div className="es-figure">
                <span className="home-meta">
                    Heute
                    <Hint>
                        Summe über alle eingebundenen Steckdosen seit Mitternacht — nicht
                        der Verbrauch der Wohnung. Was nicht an einer Dose hängt (Herd,
                        Licht, Heizung) ist hier nicht enthalten. Gezählt wird die
                        Differenz der Lebensdauerzähler; nach einem Werksreset einer Dose
                        fehlt deshalb für einen Tag ein Stück.
                    </Hint>
                </span>
                <span className="es-value">{fmtKwh(energy.today_wh)}</span>
            </div>

            {days.length > 1 && (
                <div className="es-week" role="img"
                     aria-label={`Verbrauch der letzten ${days.length} Tage`}>
                    {days.map(day => (
                        <span key={day.day} className="es-bar-slot"
                              title={`${day.day}: ${fmtKwh(day.energy_wh)}`}>
                            <span className="es-bar" data-today={day.day === today || undefined}
                                  style={{ height: `${Math.max(4, (day.energy_wh / peak) * 100)}%` }} />
                            <span className="es-bar-label">
                                {DAY_NAMES[new Date(`${day.day}T12:00:00Z`).getUTCDay()]}
                            </span>
                        </span>
                    ))}
                </div>
            )}

            <span className="fps-spacer" />

            {/* A socket that has stopped answering is why a number is lower
                than it should be, so it is said here rather than only in the
                room it belongs to. */}
            {(energy.quiet || []).length > 0 && (
                <span className="home-meta nb-error">
                    {energy.quiet.length === 1
                        ? `${energy.quiet[0]} meldet sich nicht`
                        : `${energy.quiet.length} Steckdosen melden sich nicht`}
                </span>
            )}
            {(energy.unbound || []).length > 0 && (
                <span className="home-meta">
                    {energy.unbound.length} Steckdose(n) keinem Raum zugeordnet
                </span>
            )}
        </div>
    )
}
