import { useState, useEffect } from "react"
import {
    fetchHierarchy, fetchRisks, createRisk, deleteRisk, createRiskLink, deleteRiskLink,
} from "../api"
import "./risks.css"

const LEVEL_LABELS = { niedrig: "Niedrig", mittel: "Mittel", hoch: "Hoch" }
const LEVEL_ORDER = { hoch: 2, mittel: 1, niedrig: 0 }
const STATUS_LABELS = { offen: "Offen", beobachtet: "Beobachtet", erledigt: "Erledigt" }

function flattenEntities(milestones) {
    const options = []
    for (const m of milestones) {
        options.push({ entity_type: "milestone", entity_id: m.id, title: `Milestone: ${m.title}` })
        for (const f of m.features) {
            options.push({ entity_type: "feature", entity_id: f.id, title: `Feature: ${f.title}` })
            for (const wp of f.work_packages) {
                options.push({ entity_type: "work_package", entity_id: wp.id, title: `Arbeitspaket: ${wp.title}` })
            }
        }
    }
    return options
}

export default function RiskList() {
    const [risks, setRisks] = useState([])
    const [entityOptions, setEntityOptions] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    async function refresh() {
        try {
            const [riskList, hierarchy] = await Promise.all([fetchRisks(), fetchHierarchy()])
            const sorted = [...riskList].sort((a, b) =>
                (LEVEL_ORDER[b.impact] ?? -1) - (LEVEL_ORDER[a.impact] ?? -1) ||
                (LEVEL_ORDER[b.probability] ?? -1) - (LEVEL_ORDER[a.probability] ?? -1)
            )
            setRisks(sorted)
            setEntityOptions(flattenEntities(hierarchy))
            setError(false)
        } catch {
            setError(true)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { refresh() }, [])

    if (loading) return <div className="tracking-status">Lädt…</div>
    if (error) return <div className="tracking-status error">Tracking-Service nicht erreichbar.</div>

    return (
        <div className="tracking-risks">
            {risks.map(r => <RiskCard key={r.id} risk={r} entityOptions={entityOptions} refresh={refresh} />)}
            <AddRiskForm refresh={refresh} />
        </div>
    )
}

function RiskCard({ risk, entityOptions, refresh }) {
    return (
        <div className="tracking-card risk-card">
            <div className="risk-card-header">
                <span className={`level-tag level-${risk.impact}`}>Auswirkung: {LEVEL_LABELS[risk.impact] || "–"}</span>
                <span className={`level-tag level-${risk.probability}`}>Wahrsch.: {LEVEL_LABELS[risk.probability] || "–"}</span>
                <h4>{risk.title}</h4>
                <span className={`risk-status-tag risk-status-${risk.status}`}>{STATUS_LABELS[risk.status]}</span>
                {!!risk.escalation_required && <span className="escalation-tag">Eskalation{risk.escalation_date ? ` bis ${risk.escalation_date}` : ""}</span>}
                <span className="tracking-delete-btn" onClick={() => deleteRisk(risk.id).then(refresh)}>✕</span>
            </div>
            {risk.description && <p className="tracking-description">{risk.description}</p>}
            {risk.mitigation && <p className="tracking-description"><strong>Gegenmaßnahme:</strong> {risk.mitigation}</p>}
            <div className="risk-links">
                {risk.links.map(l => (
                    <span key={l.id} className="risk-link-tag">
                        {l.entity_title || `#${l.entity_id}`}
                        <span className="tracking-delete-btn" onClick={() => deleteRiskLink(l.id).then(refresh)}>✕</span>
                    </span>
                ))}
            </div>
            <AddRiskLinkForm riskId={risk.id} entityOptions={entityOptions} refresh={refresh} />
        </div>
    )
}

function AddRiskLinkForm({ riskId, entityOptions, refresh }) {
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState("")

    async function submit() {
        if (!selected) return
        const [entity_type, entity_id] = selected.split(":")
        await createRiskLink(riskId, { entity_type, entity_id: Number(entity_id) })
        setSelected(""); setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Verknüpfen</button>
    return (
        <div className="tracking-form">
            <select value={selected} onChange={e => setSelected(e.target.value)}>
                <option value="">Element wählen…</option>
                {entityOptions.map(o => (
                    <option key={`${o.entity_type}:${o.entity_id}`} value={`${o.entity_type}:${o.entity_id}`}>{o.title}</option>
                ))}
            </select>
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}

function AddRiskForm({ refresh }) {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState("")
    const [description, setDescription] = useState("")
    const [probability, setProbability] = useState("mittel")
    const [impact, setImpact] = useState("mittel")
    const [mitigation, setMitigation] = useState("")
    const [status, setStatus] = useState("offen")
    const [escalationRequired, setEscalationRequired] = useState(false)
    const [escalationDate, setEscalationDate] = useState("")

    async function submit() {
        if (!title.trim()) return
        await createRisk({
            title, description, probability, impact, mitigation, status,
            escalation_required: escalationRequired, escalation_date: escalationDate || null,
        })
        setTitle(""); setDescription(""); setMitigation(""); setEscalationDate("")
        setProbability("mittel"); setImpact("mittel"); setStatus("offen"); setEscalationRequired(false)
        setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Neues Risiko</button>
    return (
        <div className="tracking-form risk-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <input placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />
            <select value={probability} onChange={e => setProbability(e.target.value)}>
                {Object.entries(LEVEL_LABELS).map(([k, l]) => <option key={k} value={k}>Wahrsch.: {l}</option>)}
            </select>
            <select value={impact} onChange={e => setImpact(e.target.value)}>
                {Object.entries(LEVEL_LABELS).map(([k, l]) => <option key={k} value={k}>Auswirkung: {l}</option>)}
            </select>
            <input placeholder="Gegenmaßnahme" value={mitigation} onChange={e => setMitigation(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <label className="dep-blocking-checkbox">
                <input type="checkbox" checked={escalationRequired} onChange={e => setEscalationRequired(e.target.checked)} /> Eskalation nötig
            </label>
            {escalationRequired && <input type="date" value={escalationDate} onChange={e => setEscalationDate(e.target.value)} />}
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}
