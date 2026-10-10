import { useState, useEffect } from "react"
import { fetchRisks } from "../api"
import "./heatmap.css"

const LEVELS = ["niedrig", "mittel", "hoch"]
const LEVEL_LABELS = { niedrig: "Niedrig", mittel: "Mittel", hoch: "Hoch" }

export default function RiskHeatmap() {
    const [risks, setRisks] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    useEffect(() => {
        fetchRisks().then(setRisks).catch(() => setError(true)).finally(() => setLoading(false))
    }, [])

    if (loading) return <div className="tracking-status">Lädt…</div>
    if (error) return <div className="tracking-status error">Tracking-Service nicht erreichbar.</div>

    const openRisks = risks.filter(r => r.status !== "erledigt")
    const cellRisks = (impact, probability) => openRisks.filter(r => r.impact === impact && r.probability === probability)

    return (
        <div className="heatmap-view">
            <div className="heatmap-grid">
                <div className="heatmap-corner" />
                {LEVELS.map(p => <div key={p} className="heatmap-axis-label">{LEVEL_LABELS[p]}</div>)}
                {[...LEVELS].reverse().map(impact => (
                    <RowFragment key={impact} impact={impact} cellRisks={cellRisks} />
                ))}
            </div>
            <div className="heatmap-axis-titles">
                <span className="heatmap-y-title">Auswirkung ↑</span>
                <span className="heatmap-x-title">Wahrscheinlichkeit →</span>
            </div>
            {openRisks.length === 0 && <p className="tracking-description">Keine offenen Risiken.</p>}
        </div>
    )
}

function RowFragment({ impact, cellRisks }) {
    return (
        <>
            <div className="heatmap-axis-label">{LEVEL_LABELS[impact]}</div>
            {LEVELS.map(probability => {
                const risks = cellRisks(impact, probability)
                return (
                    <div key={probability} className={`heatmap-cell severity-${severity(impact, probability)}`}>
                        {risks.map(r => <div key={r.id} className="heatmap-risk-chip" title={r.description || ""}>{r.title}</div>)}
                    </div>
                )
            })}
        </>
    )
}

function severity(impact, probability) {
    const score = LEVELS.indexOf(impact) + LEVELS.indexOf(probability)
    if (score >= 3) return "high"
    if (score >= 1) return "medium"
    return "low"
}
