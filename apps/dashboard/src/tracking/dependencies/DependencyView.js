import { useState, useEffect } from "react"
import {
    fetchHierarchy, fetchDependencies, fetchDependencyChains, createDependency, deleteDependency,
} from "../api"
import DependencyGraph from "./DependencyGraph"
import "./dependencies.css"

const ENTITY_LABELS = { feature: "Feature", work_package: "Arbeitspaket" }
const VIEW_LABELS = { list: "Liste", graph: "Graph" }

function flattenOptions(milestones, entityType) {
    const options = []
    for (const m of milestones) {
        for (const f of m.features) {
            if (entityType === "feature") options.push({ id: f.id, title: f.title })
            if (entityType === "work_package") {
                for (const wp of f.work_packages) options.push({ id: wp.id, title: `${f.title} → ${wp.title}` })
            }
        }
    }
    return options
}

export default function DependencyView() {
    const [entityType, setEntityType] = useState("feature")
    const [view, setView] = useState("list")
    const [options, setOptions] = useState([])
    const [edges, setEdges] = useState([])
    const [chains, setChains] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    async function refresh() {
        try {
            const [hierarchy, edgeList, chainList] = await Promise.all([
                fetchHierarchy(), fetchDependencies(entityType), fetchDependencyChains(entityType),
            ])
            setOptions(flattenOptions(hierarchy, entityType))
            setEdges(edgeList)
            setChains(chainList)
            setError(false)
        } catch {
            setError(true)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { setLoading(true); refresh() }, [entityType])

    const titleOf = (id) => options.find(o => o.id === id)?.title || `#${id}`

    return (
        <div className="tracking-dependencies">
            <div className="dep-toggles">
                <div className="dep-type-toggle">
                    {Object.entries(ENTITY_LABELS).map(([key, label]) => (
                        <button key={key} className={key === entityType ? "active" : ""} onClick={() => setEntityType(key)}>{label}</button>
                    ))}
                </div>
                <div className="dep-type-toggle">
                    {Object.entries(VIEW_LABELS).map(([key, label]) => (
                        <button key={key} className={key === view ? "active" : ""} onClick={() => setView(key)}>{label}</button>
                    ))}
                </div>
            </div>

            {loading && <div className="tracking-status">Lädt…</div>}
            {!loading && error && <div className="tracking-status error">Tracking-Service nicht erreichbar.</div>}

            {!loading && !error && view === "graph" && (
                <DependencyGraph edges={edges.filter(e => e.blocking)} titleOf={titleOf} />
            )}

            {!loading && !error && view === "list" && (
                <>
                    <h4>Kritische Abhängigkeiten</h4>
                    {chains.length === 0 && <p className="tracking-description">Keine blockierenden Abhängigkeiten.</p>}
                    {chains.map(c => (
                        <ChainRow key={c.blocker_id} chain={c} />
                    ))}

                    <h4>Alle Abhängigkeiten</h4>
                    {edges.length === 0 && <p className="tracking-description">Noch keine Abhängigkeiten erfasst.</p>}
                    {edges.map(e => (
                        <div key={e.id} className="dep-edge-row">
                            <span>{titleOf(e.from_id)}</span>
                            <span className="dep-arrow">{e.blocking ? "hängt ab von / blockiert durch" : "bezieht sich auf"}</span>
                            <span>{titleOf(e.to_id)}</span>
                            {e.note && <span className="tracking-meta">{e.note}</span>}
                            <span className="tracking-delete-btn" onClick={() => deleteDependency(e.id).then(refresh)}>✕</span>
                        </div>
                    ))}

                    <AddDependencyForm entityType={entityType} options={options} refresh={refresh} />
                </>
            )}
        </div>
    )
}

function ChainRow({ chain }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="dep-chain-row">
            <div className="dep-chain-header" onClick={() => setOpen(!open)}>
                <strong>{chain.blocker_title}</strong>
                <span className="dep-chain-badge">blockiert {chain.affected_count} {chain.affected_count === 1 ? "Element" : "Elemente"}</span>
            </div>
            {open && (
                <ul className="dep-chain-affected">
                    {chain.affected.map(a => <li key={a.id}>{a.title}</li>)}
                </ul>
            )}
        </div>
    )
}

function AddDependencyForm({ entityType, options, refresh }) {
    const [open, setOpen] = useState(false)
    const [fromId, setFromId] = useState("")
    const [toId, setToId] = useState("")
    const [blocking, setBlocking] = useState(true)
    const [note, setNote] = useState("")

    async function submit() {
        if (!fromId || !toId || fromId === toId) return
        await createDependency({ entity_type: entityType, from_id: Number(fromId), to_id: Number(toId), blocking, note })
        setFromId(""); setToId(""); setNote(""); setBlocking(true); setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Abhängigkeit</button>
    return (
        <div className="tracking-form">
            <select value={fromId} onChange={e => setFromId(e.target.value)}>
                <option value="">… hängt ab von …</option>
                {options.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
            <select value={toId} onChange={e => setToId(e.target.value)}>
                <option value="">… diesem Element</option>
                {options.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
            </select>
            <label className="dep-blocking-checkbox">
                <input type="checkbox" checked={blocking} onChange={e => setBlocking(e.target.checked)} /> blockierend
            </label>
            <input placeholder="Notiz" value={note} onChange={e => setNote(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}
