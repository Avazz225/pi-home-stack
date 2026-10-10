import { useState, useEffect } from "react"
import {
    fetchHierarchy, createMilestone, createFeature, createWorkPackage, createCard,
    updateMilestone, updateFeature, updateWorkPackage,
    deleteMilestone, deleteFeature, deleteWorkPackage, deleteCard,
    fetchLessons, fetchConversations, createConversation, deleteConversation,
} from "../api"
import "./hierarchy.css"

const STATUS_LABELS = { gruen: "Grün", gelb: "Gelb", rot: "Rot" }
const WP_STATUS_LABELS = { offen: "Offen", in_arbeit: "In Arbeit", blockiert: "Blockiert", abgeschlossen: "Abgeschlossen" }
const CONFIDENCE_LABELS = { hoch: "Hoch", mittel: "Mittel", niedrig: "Niedrig" }
const RISK_LEVEL_LABELS = { niedrig: "Niedrig", mittel: "Mittel", hoch: "Hoch" }
const TRISTATE_LABELS = { "": "Unbekannt", "1": "Ja", "0": "Nein" }

const CONVERSATION_QUESTIONS = [
    ["blockers_text", "Gibt es Blocker?"],
    ["deadline_realistic_text", "Ist der Termin realistisch?"],
    ["risks_text", "Welche Risiken siehst du?"],
    ["support_needed_text", "Benötigst du Unterstützung?"],
    ["assumptions_changed_text", "Haben sich Annahmen geändert?"],
]

export default function HierarchyView() {
    const [milestones, setMilestones] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    async function refresh() {
        try {
            setMilestones(await fetchHierarchy())
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
        <div className="tracking-hierarchy">
            {milestones.map(m => <MilestoneCard key={m.id} milestone={m} refresh={refresh} />)}
            <AddMilestoneForm refresh={refresh} />
        </div>
    )
}

function StatusDot({ status }) {
    return <span className={`status-dot status-${status}`} title={STATUS_LABELS[status] || status} />
}

function MilestoneCard({ milestone, refresh }) {
    const [open, setOpen] = useState(true)
    const [editing, setEditing] = useState(false)
    return (
        <div className="tracking-card milestone-card">
            <div className="tracking-card-header" onClick={() => setOpen(!open)}>
                <StatusDot status={milestone.status} />
                <h3>{milestone.title}</h3>
                <span className="tracking-meta">{milestone.owner}</span>
                <span className="tracking-meta">Ziel: {milestone.target_date || "–"}</span>
                {milestone.forecast_date && <span className="tracking-meta">Forecast: {milestone.forecast_date}</span>}
                <EditBtn onClick={() => { setEditing(true); setOpen(true) }} />
                <DeleteBtn onClick={() => deleteMilestone(milestone.id).then(refresh)} />
            </div>
            {open && (
                <div className="tracking-card-body">
                    {editing ? (
                        <MilestoneEditForm
                            milestone={milestone}
                            onSaved={() => { setEditing(false); refresh() }}
                            onCancel={() => setEditing(false)}
                        />
                    ) : (
                        milestone.description && <p className="tracking-description">{milestone.description}</p>
                    )}
                    {milestone.features.map(f => <FeatureCard key={f.id} feature={f} refresh={refresh} />)}
                    <AddFeatureForm milestoneId={milestone.id} refresh={refresh} />
                </div>
            )}
        </div>
    )
}

function MilestoneEditForm({ milestone, onSaved, onCancel }) {
    const [title, setTitle] = useState(milestone.title)
    const [description, setDescription] = useState(milestone.description || "")
    const [targetDate, setTargetDate] = useState(milestone.target_date || "")
    const [status, setStatus] = useState(milestone.status)
    const [owner, setOwner] = useState(milestone.owner || "")
    const [mgmtComment, setMgmtComment] = useState(milestone.mgmt_comment || "")
    const [forecastDate, setForecastDate] = useState(milestone.forecast_date || "")
    const [forecastConfidence, setForecastConfidence] = useState(milestone.forecast_confidence || "")
    const [dateAchievable, setDateAchievable] = useState(toTriState(milestone.date_achievable))

    async function submit() {
        if (!title.trim()) return
        await updateMilestone(milestone.id, {
            title, description, target_date: targetDate || null, status, owner,
            mgmt_comment: mgmtComment, forecast_date: forecastDate || null,
            forecast_confidence: forecastConfidence || null, date_achievable: fromTriState(dateAchievable),
        })
        onSaved()
    }

    return (
        <div className="tracking-form edit-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input placeholder="Verantwortlicher" value={owner} onChange={e => setOwner(e.target.value)} />
            <textarea rows={2} placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />
            <Labeled label="Zieltermin"><input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></Labeled>
            <Labeled label="Forecast-Termin"><input type="date" value={forecastDate} onChange={e => setForecastDate(e.target.value)} /></Labeled>
            <Labeled label="Vertrauen">
                <select value={forecastConfidence} onChange={e => setForecastConfidence(e.target.value)}>
                    <option value="">–</option>
                    {Object.entries(CONFIDENCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>
            <Labeled label="Termin erreichbar">
                <select value={dateAchievable} onChange={e => setDateAchievable(e.target.value)}>
                    {Object.entries(TRISTATE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>
            <textarea rows={2} placeholder="Management-Kommentar" value={mgmtComment} onChange={e => setMgmtComment(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={onCancel}>Abbrechen</button>
        </div>
    )
}

function toTriState(value) {
    if (value === 1 || value === true) return "1"
    if (value === 0 || value === false) return "0"
    return ""
}

function fromTriState(value) {
    if (value === "1") return true
    if (value === "0") return false
    return null
}

function Labeled({ label, children }) {
    return (
        <label className="edit-field">
            <span className="tracking-meta">{label}</span>
            {children}
        </label>
    )
}

function FeatureCard({ feature, refresh }) {
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState(false)
    return (
        <div className="tracking-card feature-card">
            <div className="tracking-card-header" onClick={() => setOpen(!open)}>
                <StatusDot status={feature.status} />
                <h4>{feature.title}</h4>
                <span className="tracking-meta">{feature.owner}</span>
                <span className="tracking-meta">Ziel: {feature.target_date || "–"}</span>
                {feature.risk_level && <span className={`risk-tag risk-${feature.risk_level}`}>{feature.risk_level}</span>}
                <EditBtn onClick={() => { setEditing(true); setOpen(true) }} />
                <DeleteBtn onClick={() => deleteFeature(feature.id).then(refresh)} />
            </div>
            {open && (
                <div className="tracking-card-body">
                    {editing ? (
                        <FeatureEditForm
                            feature={feature}
                            onSaved={() => { setEditing(false); refresh() }}
                            onCancel={() => setEditing(false)}
                        />
                    ) : (
                        feature.description && <p className="tracking-description">{feature.description}</p>
                    )}
                    {feature.work_packages.map(wp => <WorkPackageRow key={wp.id} workPackage={wp} refresh={refresh} />)}
                    <AddWorkPackageForm featureId={feature.id} refresh={refresh} />
                    <ConversationsPanel featureId={feature.id} />
                </div>
            )}
        </div>
    )
}

function FeatureEditForm({ feature, onSaved, onCancel }) {
    const [title, setTitle] = useState(feature.title)
    const [description, setDescription] = useState(feature.description || "")
    const [businessValue, setBusinessValue] = useState(feature.business_value || "")
    const [targetDate, setTargetDate] = useState(feature.target_date || "")
    const [owner, setOwner] = useState(feature.owner || "")
    const [status, setStatus] = useState(feature.status)
    const [riskLevel, setRiskLevel] = useState(feature.risk_level || "")
    const [progress, setProgress] = useState(feature.progress ?? "")
    const [doneCriteria, setDoneCriteria] = useState(feature.done_criteria || "")
    const [forecastDate, setForecastDate] = useState(feature.forecast_date || "")
    const [forecastConfidence, setForecastConfidence] = useState(feature.forecast_confidence || "")
    const [dateAchievable, setDateAchievable] = useState(toTriState(feature.date_achievable))
    const [mgmtStatus, setMgmtStatus] = useState(feature.mgmt_status || "")
    const [mgmtStatusReason, setMgmtStatusReason] = useState(feature.mgmt_status_reason || "")
    const [techStatus, setTechStatus] = useState(feature.tech_status || "")
    const [techStatusReason, setTechStatusReason] = useState(feature.tech_status_reason || "")

    async function submit() {
        if (!title.trim()) return
        await updateFeature(feature.id, {
            title, description, business_value: businessValue, target_date: targetDate || null, owner, status,
            risk_level: riskLevel || null, progress: progress === "" ? null : Number(progress), done_criteria: doneCriteria,
            forecast_date: forecastDate || null, forecast_confidence: forecastConfidence || null,
            date_achievable: fromTriState(dateAchievable),
            mgmt_status: mgmtStatus || null, mgmt_status_reason: mgmtStatusReason,
            tech_status: techStatus || null, tech_status_reason: techStatusReason,
        })
        onSaved()
    }

    return (
        <div className="tracking-form edit-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input placeholder="Verantwortlicher" value={owner} onChange={e => setOwner(e.target.value)} />
            <textarea rows={2} placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />
            <textarea rows={2} placeholder="Business-Nutzen" value={businessValue} onChange={e => setBusinessValue(e.target.value)} />
            <textarea rows={2} placeholder="Fertig-Kriterien" value={doneCriteria} onChange={e => setDoneCriteria(e.target.value)} />

            <Labeled label="Zieltermin"><input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} /></Labeled>
            <Labeled label="Risiko-Level">
                <select value={riskLevel} onChange={e => setRiskLevel(e.target.value)}>
                    <option value="">–</option>
                    {Object.entries(RISK_LEVEL_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>
            <Labeled label="Fortschritt (%)">
                <input type="number" min="0" max="100" value={progress} onChange={e => setProgress(e.target.value)} />
            </Labeled>

            <Labeled label="Forecast-Termin"><input type="date" value={forecastDate} onChange={e => setForecastDate(e.target.value)} /></Labeled>
            <Labeled label="Vertrauen">
                <select value={forecastConfidence} onChange={e => setForecastConfidence(e.target.value)}>
                    <option value="">–</option>
                    {Object.entries(CONFIDENCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>
            <Labeled label="Termin erreichbar">
                <select value={dateAchievable} onChange={e => setDateAchievable(e.target.value)}>
                    {Object.entries(TRISTATE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>

            <Labeled label="Management-Status">
                <select value={mgmtStatus} onChange={e => setMgmtStatus(e.target.value)}>
                    <option value="">– (folgt techn. Status)</option>
                    {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>
            <input placeholder="Begründung Management-Einschätzung" value={mgmtStatusReason} onChange={e => setMgmtStatusReason(e.target.value)} />
            <Labeled label="Technische Einschätzung">
                <select value={techStatus} onChange={e => setTechStatus(e.target.value)}>
                    <option value="">–</option>
                    {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </Labeled>
            <input placeholder="Begründung technische Einschätzung" value={techStatusReason} onChange={e => setTechStatusReason(e.target.value)} />

            <button onClick={submit}>Speichern</button>
            <button onClick={onCancel}>Abbrechen</button>
        </div>
    )
}

function ConversationsPanel({ featureId }) {
    const [open, setOpen] = useState(false)
    const [conversations, setConversations] = useState([])
    const [showForm, setShowForm] = useState(false)

    async function refresh() {
        setConversations(await fetchConversations(featureId))
    }

    useEffect(() => { if (open) refresh() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="conversations-panel">
            <button className="tracking-add-btn" onClick={() => setOpen(!open)}>
                {open ? "Gespräche ausblenden" : `Gespräche (${conversations.length || ""})`}
            </button>
            {open && (
                <div className="tracking-card-body">
                    {conversations.length === 0 && <p className="tracking-description">Noch keine Gespräche erfasst.</p>}
                    {conversations.map(c => <ConversationRow key={c.id} conversation={c} refresh={refresh} />)}
                    {!showForm && <button className="tracking-add-btn" onClick={() => setShowForm(true)}>+ Gespräch erfassen</button>}
                    {showForm && (
                        <AddConversationForm
                            featureId={featureId}
                            refresh={() => { refresh(); setShowForm(false) }}
                            onCancel={() => setShowForm(false)}
                        />
                    )}
                </div>
            )}
        </div>
    )
}

function ConversationRow({ conversation, refresh }) {
    const [expanded, setExpanded] = useState(false)
    return (
        <div className="conversation-row">
            <div className="tracking-card-header" onClick={() => setExpanded(!expanded)}>
                <span className="tracking-meta">{conversation.date}</span>
                <span className="sp-row-title">{conversation.participants}</span>
                {conversation.followup_date && <span className="tracking-meta">Wiedervorlage: {conversation.followup_date}</span>}
                <DeleteBtn onClick={() => deleteConversation(conversation.id).then(refresh)} />
            </div>
            {expanded && (
                <div className="conversation-detail">
                    {CONVERSATION_QUESTIONS.map(([key]) => conversation[key] && (
                        <p key={key} className="tracking-description">{conversation[key]}</p>
                    ))}
                    {conversation.agreed_actions && <p className="tracking-description"><strong>Maßnahmen:</strong> {conversation.agreed_actions}</p>}
                </div>
            )}
        </div>
    )
}

function AddConversationForm({ featureId, refresh, onCancel }) {
    const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
    const [participants, setParticipants] = useState("")
    const [answers, setAnswers] = useState(() =>
        Object.fromEntries(CONVERSATION_QUESTIONS.map(([key, question]) => [key, question + "\n"]))
    )
    const [agreedActions, setAgreedActions] = useState("")
    const [followupDate, setFollowupDate] = useState("")

    async function submit() {
        await createConversation(featureId, { date, participants, ...answers, agreed_actions: agreedActions, followup_date: followupDate || null })
        refresh()
    }

    return (
        <div className="tracking-form conversation-form">
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            <input placeholder="Teilnehmer" value={participants} onChange={e => setParticipants(e.target.value)} />
            {CONVERSATION_QUESTIONS.map(([key, question]) => (
                <textarea
                    key={key}
                    rows={2}
                    title={question}
                    value={answers[key]}
                    onChange={e => setAnswers({ ...answers, [key]: e.target.value })}
                />
            ))}
            <textarea rows={2} placeholder="Vereinbarte Maßnahmen" value={agreedActions} onChange={e => setAgreedActions(e.target.value)} />
            <label className="dep-blocking-checkbox">
                Wiedervorlage <input type="date" value={followupDate} onChange={e => setFollowupDate(e.target.value)} />
            </label>
            <button onClick={submit}>Speichern</button>
            <button onClick={onCancel}>Abbrechen</button>
        </div>
    )
}

function WorkPackageRow({ workPackage, refresh }) {
    const [open, setOpen] = useState(false)
    const [editing, setEditing] = useState(false)
    return (
        <div className="tracking-card workpackage-card">
            <div className="tracking-card-header" onClick={() => setOpen(!open)}>
                <span className={`wp-status-tag wp-status-${workPackage.status}`}>{WP_STATUS_LABELS[workPackage.status]}</span>
                <h5>{workPackage.title}</h5>
                <span className="tracking-meta">{workPackage.owner}</span>
                <EditBtn onClick={() => { setEditing(true); setOpen(true) }} />
                <DeleteBtn onClick={() => deleteWorkPackage(workPackage.id).then(refresh)} />
            </div>
            {open && (
                <div className="tracking-card-body">
                    {editing && (
                        <WorkPackageEditForm
                            workPackage={workPackage}
                            onSaved={() => { setEditing(false); refresh() }}
                            onCancel={() => setEditing(false)}
                        />
                    )}
                    <div className="card-ref-list">
                        {workPackage.cards.map(c => (
                            <div key={c.id} className="card-ref-item">
                                {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.card_id}</a> : <span>{c.card_id}</span>}
                                {c.card_name && <span className="tracking-meta">{c.card_name}</span>}
                                <DeleteBtn onClick={() => deleteCard(c.id).then(refresh)} />
                            </div>
                        ))}
                    </div>
                    <AddCardForm workPackageId={workPackage.id} refresh={refresh} />
                </div>
            )}
        </div>
    )
}

function WorkPackageEditForm({ workPackage, onSaved, onCancel }) {
    const [title, setTitle] = useState(workPackage.title)
    const [description, setDescription] = useState(workPackage.description || "")
    const [owner, setOwner] = useState(workPackage.owner || "")
    const [status, setStatus] = useState(workPackage.status)
    const [plannedStart, setPlannedStart] = useState(workPackage.planned_start || "")
    const [plannedEnd, setPlannedEnd] = useState(workPackage.planned_end || "")
    const [actualStart, setActualStart] = useState(workPackage.actual_start || "")
    const [actualEnd, setActualEnd] = useState(workPackage.actual_end || "")
    const [scheduleRisk, setScheduleRisk] = useState(workPackage.schedule_risk || "")
    const [expectedCompletion, setExpectedCompletion] = useState(workPackage.expected_completion_date || "")

    async function submit() {
        if (!title.trim()) return
        await updateWorkPackage(workPackage.id, {
            title, description, owner, status,
            planned_start: plannedStart || null, planned_end: plannedEnd || null,
            actual_start: actualStart || null, actual_end: actualEnd || null,
            schedule_risk: scheduleRisk, expected_completion_date: expectedCompletion || null,
        })
        onSaved()
    }

    return (
        <div className="tracking-form edit-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(WP_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input placeholder="Verantwortlicher" value={owner} onChange={e => setOwner(e.target.value)} />
            <textarea rows={2} placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />

            <Labeled label="Geplanter Start"><input type="date" value={plannedStart} onChange={e => setPlannedStart(e.target.value)} /></Labeled>
            <Labeled label="Geplantes Ende"><input type="date" value={plannedEnd} onChange={e => setPlannedEnd(e.target.value)} /></Labeled>
            <Labeled label="Tatsächlicher Start"><input type="date" value={actualStart} onChange={e => setActualStart(e.target.value)} /></Labeled>
            <Labeled label="Tatsächliches Ende"><input type="date" value={actualEnd} onChange={e => setActualEnd(e.target.value)} /></Labeled>
            <Labeled label="Erwartetes Abschlussdatum"><input type="date" value={expectedCompletion} onChange={e => setExpectedCompletion(e.target.value)} /></Labeled>
            <input placeholder="Terminrisiko" value={scheduleRisk} onChange={e => setScheduleRisk(e.target.value)} />

            <button onClick={submit}>Speichern</button>
            <button onClick={onCancel}>Abbrechen</button>
        </div>
    )
}

function DeleteBtn({ onClick }) {
    return <span className="tracking-delete-btn" onClick={(e) => { e.stopPropagation(); onClick() }}>✕</span>
}

function EditBtn({ onClick }) {
    return <span className="tracking-edit-btn" onClick={(e) => { e.stopPropagation(); onClick() }}>✎</span>
}

function AddMilestoneForm({ refresh }) {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState("")
    const [targetDate, setTargetDate] = useState("")
    const [status, setStatus] = useState("gruen")
    const [owner, setOwner] = useState("")

    async function submit() {
        if (!title.trim()) return
        await createMilestone({ title, target_date: targetDate || null, status, owner })
        setTitle(""); setTargetDate(""); setOwner(""); setStatus("gruen"); setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Neuer Milestone</button>
    return (
        <div className="tracking-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input placeholder="Verantwortlicher" value={owner} onChange={e => setOwner(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}

function AddFeatureForm({ milestoneId, refresh }) {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState("")
    const [targetDate, setTargetDate] = useState("")
    const [status, setStatus] = useState("gruen")
    const [owner, setOwner] = useState("")

    async function submit() {
        if (!title.trim()) return
        await createFeature({ title, milestone_id: milestoneId, target_date: targetDate || null, status, owner })
        setTitle(""); setTargetDate(""); setOwner(""); setStatus("gruen"); setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Feature</button>
    return (
        <div className="tracking-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input placeholder="Verantwortlicher" value={owner} onChange={e => setOwner(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
            <SimilarLessons searchTerm={title} />
        </div>
    )
}

function SimilarLessons({ searchTerm }) {
    const [lessons, setLessons] = useState([])

    useEffect(() => {
        if (searchTerm.trim().length < 3) { setLessons([]); return }
        const timer = setTimeout(() => {
            fetchLessons({ search: searchTerm.trim() }).then(setLessons).catch(() => {})
        }, 400)
        return () => clearTimeout(timer)
    }, [searchTerm])

    if (lessons.length === 0) return null
    return (
        <div className="similar-lessons">
            <span className="tracking-meta">Ähnliche Lessons Learned:</span>
            <ul>
                {lessons.map(l => <li key={l.id}>{l.title}{l.recommendation && ` — ${l.recommendation}`}</li>)}
            </ul>
        </div>
    )
}

function AddWorkPackageForm({ featureId, refresh }) {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState("")
    const [status, setStatus] = useState("offen")
    const [owner, setOwner] = useState("")

    async function submit() {
        if (!title.trim()) return
        await createWorkPackage({ title, feature_id: featureId, status, owner })
        setTitle(""); setOwner(""); setStatus("offen"); setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Arbeitspaket</button>
    return (
        <div className="tracking-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <select value={status} onChange={e => setStatus(e.target.value)}>
                {Object.entries(WP_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <input placeholder="Verantwortlicher" value={owner} onChange={e => setOwner(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}

function AddCardForm({ workPackageId, refresh }) {
    const [open, setOpen] = useState(false)
    const [cardId, setCardId] = useState("")
    const [cardName, setCardName] = useState("")
    const [url, setUrl] = useState("")

    async function submit() {
        if (!cardId.trim()) return
        await createCard(workPackageId, { card_id: cardId, card_name: cardName, url })
        setCardId(""); setCardName(""); setUrl(""); setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Kartenreferenz</button>
    return (
        <div className="tracking-form">
            <input placeholder="Karten-ID" value={cardId} onChange={e => setCardId(e.target.value)} />
            <input placeholder="Kartenname" value={cardName} onChange={e => setCardName(e.target.value)} />
            <input placeholder="URL" value={url} onChange={e => setUrl(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}
