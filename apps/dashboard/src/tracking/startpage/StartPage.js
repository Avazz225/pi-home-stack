import { useState, useEffect } from "react"
import { fetchDashboardSummary } from "../api"
import "./startpage.css"

export default function StartPage() {
    const [summary, setSummary] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    useEffect(() => {
        fetchDashboardSummary()
            .then(setSummary)
            .catch(() => setError(true))
            .finally(() => setLoading(false))
    }, [])

    if (loading) return <div className="tracking-status">Lädt…</div>
    if (error || !summary) return <div className="tracking-status error">Tracking-Service nicht erreichbar.</div>

    const overdueCount = summary.overdue.milestones.length + summary.overdue.features.length + summary.overdue.work_packages.length

    return (
        <div className="startpage-grid">
            <Widget title="Terminprognose">
                <ForecastCounts counts={summary.forecast_counts} />
            </Widget>

            <Widget title="Gefährdete Features">
                {summary.endangered_features.length === 0 && <Empty text="Keine gefährdeten Features." />}
                {summary.endangered_features.map(f => (
                    <div key={f.id} className="sp-row">
                        <span className={`status-dot status-${f.status}`} />
                        <span className="sp-row-title">{f.title}</span>
                        <span className="tracking-meta">{f.owner}</span>
                        <span className="tracking-meta">Ziel: {f.target_date || "–"}</span>
                        {f.forecast_date && <span className="tracking-meta">Forecast: {f.forecast_date}</span>}
                        {f.reasons.length > 0 && <span className="sp-reasons">{f.reasons.join(" · ")}</span>}
                    </div>
                ))}
            </Widget>

            <Widget title="Offene Risiken">
                {summary.open_risks.length === 0 && <Empty text="Keine offenen Risiken." />}
                {summary.open_risks.map(r => (
                    <div key={r.id} className="sp-row">
                        <span className={`level-tag level-${r.impact}`}>{r.impact}</span>
                        <span className={`level-tag level-${r.probability}`}>{r.probability}</span>
                        <span className="sp-row-title">{r.title}</span>
                        {!!r.escalation_required && <span className="escalation-tag">Eskalation</span>}
                    </div>
                ))}
            </Widget>

            <Widget title="Blockierte Arbeitspakete">
                {summary.blocked_work_packages.length === 0 && <Empty text="Keine blockierten Arbeitspakete." />}
                {summary.blocked_work_packages.map(wp => (
                    <div key={wp.id} className="sp-row">
                        <span className="sp-row-title">{wp.title}</span>
                        <span className="tracking-meta">{wp.feature_title}</span>
                        <span className="tracking-meta">blockiert seit {fmtDate(wp.blocked_since)}</span>
                        {wp.affected_features.length > 0 && (
                            <span className="sp-reasons">betrifft: {wp.affected_features.join(", ")}</span>
                        )}
                    </div>
                ))}
            </Widget>

            <Widget title="Milestones der nächsten 90 Tage">
                {summary.upcoming_milestones.length === 0 && <Empty text="Keine Milestones in den nächsten 90 Tagen." />}
                {summary.upcoming_milestones.map(m => (
                    <div key={m.id} className="sp-row">
                        <span className={`status-dot status-${m.status}`} />
                        <span className="sp-row-title">{m.title}</span>
                        <span className="tracking-meta">Ziel: {m.target_date}</span>
                        {m.forecast_date && <span className="tracking-meta">Forecast: {m.forecast_date}</span>}
                    </div>
                ))}
            </Widget>

            <Widget title="Überfällige Elemente">
                {overdueCount === 0 && <Empty text="Nichts überfällig." />}
                {summary.overdue.milestones.map(m => <OverdueRow key={`m${m.id}`} type="Milestone" item={m} />)}
                {summary.overdue.features.map(f => <OverdueRow key={`f${f.id}`} type="Feature" item={f} />)}
                {summary.overdue.work_packages.map(wp => <OverdueRow key={`w${wp.id}`} type="Arbeitspaket" item={wp} dateField="planned_end" />)}
            </Widget>

            <Widget title="Kritische Abhängigkeiten">
                {summary.critical_chains.length === 0 && <Empty text="Keine blockierenden Abhängigkeiten." />}
                {summary.critical_chains.map(c => (
                    <div key={`${c.entity_type}-${c.blocker_id}`} className="sp-row">
                        <span className="sp-row-title">{c.blocker_title}</span>
                        <span className="dep-chain-badge">blockiert {c.affected_count} {c.affected_count === 1 ? "Element" : "Elemente"}</span>
                    </div>
                ))}
            </Widget>

            <Widget title="Letzte Lessons Learned">
                <Empty text="Lessons-Learned-Modul folgt in Phase 4." />
            </Widget>
        </div>
    )
}

function Widget({ title, children }) {
    return (
        <div className="tracking-card sp-widget">
            <h4>{title}</h4>
            {children}
        </div>
    )
}

function Empty({ text }) {
    return <p className="tracking-description">{text}</p>
}

function ForecastCounts({ counts }) {
    return (
        <div className="sp-forecast-counts">
            <div><span className="sp-count">{counts.on_track}</span><span className="tracking-meta">Im Plan</span></div>
            <div><span className="sp-count sp-count-warn">{counts.endangered}</span><span className="tracking-meta">Gefährdet</span></div>
            <div><span className="sp-count sp-count-warn">{counts.low_confidence}</span><span className="tracking-meta">Niedriges Vertrauen</span></div>
        </div>
    )
}

function OverdueRow({ type, item, dateField = "target_date" }) {
    return (
        <div className="sp-row">
            <span className="sp-type-tag">{type}</span>
            <span className="sp-row-title">{item.title}</span>
            <span className="tracking-meta">{item[dateField]}</span>
        </div>
    )
}

function fmtDate(iso) {
    if (!iso) return ""
    return iso.slice(0, 10)
}
