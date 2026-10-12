import { useState, useEffect } from "react"
import { fetchHierarchy } from "../api"
import "./timeline.css"

function toDays(dateStr) {
    return new Date(dateStr).getTime() / 86400000
}

function fmtShort(dateStr) {
    const d = new Date(dateStr)
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" })
}

export default function TimelineView() {
    const [milestones, setMilestones] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    useEffect(() => {
        fetchHierarchy().then(setMilestones).catch(() => setError(true)).finally(() => setLoading(false))
    }, [])

    if (loading) return <div className="tracking-status">Lädt…</div>
    if (error) return <div className="tracking-status error">Tracking-Service nicht erreichbar.</div>

    const dated = []
    for (const m of milestones) {
        if (m.target_date) dated.push(toDays(m.target_date))
        if (m.forecast_date) dated.push(toDays(m.forecast_date))
        for (const f of m.features) {
            if (f.target_date) dated.push(toDays(f.target_date))
            if (f.forecast_date) dated.push(toDays(f.forecast_date))
        }
    }
    const todayStr = new Date().toISOString().slice(0, 10)
    dated.push(toDays(todayStr))

    if (dated.length <= 1) {
        return <div className="tracking-status">Keine Termine erfasst — Timeline benötigt mindestens einen Zieltermin.</div>
    }

    let min = Math.min(...dated)
    let max = Math.max(...dated)
    if (min === max) { min -= 5; max += 5 }
    const pad = (max - min) * 0.08
    min -= pad; max += pad

    const pos = (dateStr) => ((toDays(dateStr) - min) / (max - min)) * 100
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => new Date((min + f * (max - min)) * 86400000))
    const todayPos = pos(todayStr)

    return (
        <div className="timeline-view">
            <div className="timeline-axis">
                {ticks.map((t, i) => <span key={i} style={{ left: `${i * 25}%` }}>{fmtShort(t)}</span>)}
                <span className="timeline-axis-today" style={{ left: `${todayPos}%` }}>Heute</span>
            </div>
            {milestones.map(m => (
                <TimelineRow key={m.id} label={m.title} item={m} features={m.features} pos={pos} todayPos={todayPos} />
            ))}
            <div className="timeline-legend">
                <span><span className="timeline-marker timeline-milestone status-gruen" /> Milestone (Ziel)</span>
                <span><span className="timeline-marker timeline-feature status-gruen" /> Feature (Ziel)</span>
                <span><span className="timeline-marker timeline-forecast" /> Forecast (wenn abweichend)</span>
                <span><span className="timeline-today-swatch" /> Heute</span>
            </div>
        </div>
    )
}

function TimelineRow({ label, item, features, pos, todayPos }) {
    return (
        <div className="timeline-row">
            <div className="timeline-row-label">{label}</div>
            <div className="timeline-track">
                <div className="timeline-track-line" />
                <div className="timeline-today-line" style={{ left: `${todayPos}%` }} />
                {item.target_date && (
                    <Marker
                        shape="milestone"
                        status={item.status}
                        pos={pos(item.target_date)}
                        label={`Ziel: ${fmtShort(item.target_date)}`}
                        title={`${item.title} — Ziel: ${item.target_date}`}
                    />
                )}
                {item.forecast_date && item.forecast_date !== item.target_date && (
                    <>
                        <Connector from={pos(item.target_date ?? item.forecast_date)} to={pos(item.forecast_date)} />
                        <Marker
                            shape="milestone" forecast
                            pos={pos(item.forecast_date)}
                            label={`Forecast: ${fmtShort(item.forecast_date)}`}
                            title={`${item.title} — Forecast: ${item.forecast_date} (${item.forecast_confidence || "Vertrauen unbekannt"})`}
                        />
                    </>
                )}
                {features.filter(f => f.target_date).map(f => (
                    <Marker
                        key={f.id}
                        shape="feature"
                        status={f.status}
                        pos={pos(f.target_date)}
                        label={f.title}
                        title={`${f.title} — Ziel: ${f.target_date}`}
                    />
                ))}
                {features.filter(f => f.forecast_date && f.forecast_date !== f.target_date).map(f => (
                    <span key={`fc-${f.id}`}>
                        <Connector from={pos(f.target_date ?? f.forecast_date)} to={pos(f.forecast_date)} small />
                        <Marker
                            shape="feature" forecast
                            pos={pos(f.forecast_date)}
                            label={`${f.title} (Forecast)`}
                            title={`${f.title} — Forecast: ${f.forecast_date} (${f.forecast_confidence || "Vertrauen unbekannt"})`}
                        />
                    </span>
                ))}
            </div>
        </div>
    )
}

function Marker({ shape, status, pos, label, title, forecast }) {
    const cls = [
        "timeline-marker",
        shape === "milestone" ? "timeline-milestone" : "timeline-feature",
        forecast ? "timeline-forecast" : `status-${status}`,
    ].join(" ")
    return (
        <div className="timeline-marker-wrap" style={{ left: `${pos}%` }} title={title}>
            <div className={cls} />
            <div className="timeline-marker-label">{label}</div>
        </div>
    )
}

function Connector({ from, to, small }) {
    const left = Math.min(from, to)
    const width = Math.abs(to - from)
    return <div className={`timeline-connector ${small ? "timeline-connector-small" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} />
}
