import { useState, useEffect } from "react"
import { fetchHierarchy, fetchLessons, createLesson, deleteLesson, createLessonLink, deleteLessonLink } from "../api"
import "./lessons.css"

function flattenEntities(milestones) {
    const options = []
    for (const m of milestones) {
        options.push({ entity_type: "milestone", entity_id: m.id, title: `Milestone: ${m.title}` })
        for (const f of m.features) {
            options.push({ entity_type: "feature", entity_id: f.id, title: `Feature: ${f.title}` })
        }
    }
    return options
}

export default function LessonsView() {
    const [lessons, setLessons] = useState([])
    const [entityOptions, setEntityOptions] = useState([])
    const [search, setSearch] = useState("")
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    async function refresh() {
        try {
            const [lessonList, hierarchy] = await Promise.all([fetchLessons(search ? { search } : {}), fetchHierarchy()])
            setLessons(lessonList)
            setEntityOptions(flattenEntities(hierarchy))
            setError(false)
        } catch {
            setError(true)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => { refresh() }, [search])

    return (
        <div className="tracking-lessons">
            <input
                className="lessons-search"
                placeholder="Suche nach Titel, Kategorie, Beschreibung, Empfehlung…"
                value={search}
                onChange={e => setSearch(e.target.value)}
            />

            {loading && <div className="tracking-status">Lädt…</div>}
            {!loading && error && <div className="tracking-status error">Tracking-Service nicht erreichbar.</div>}

            {!loading && !error && (
                <>
                    {lessons.length === 0 && <p className="tracking-description">Keine Lessons Learned gefunden.</p>}
                    {lessons.map(l => <LessonCard key={l.id} lesson={l} entityOptions={entityOptions} refresh={refresh} />)}
                    <AddLessonForm refresh={refresh} />
                </>
            )}
        </div>
    )
}

function LessonCard({ lesson, entityOptions, refresh }) {
    const tags = (lesson.tags || "").split(",").map(t => t.trim()).filter(Boolean)
    return (
        <div className="tracking-card lesson-card">
            <div className="lesson-card-header">
                <h4>{lesson.title}</h4>
                {lesson.category && <span className="tracking-meta">{lesson.category}</span>}
                {lesson.date && <span className="tracking-meta">{lesson.date}</span>}
                <span className="tracking-delete-btn" onClick={() => deleteLesson(lesson.id).then(refresh)}>✕</span>
            </div>
            {lesson.description && <p className="tracking-description">{lesson.description}</p>}
            {lesson.recommendation && <p className="tracking-description"><strong>Empfehlung:</strong> {lesson.recommendation}</p>}
            {tags.length > 0 && (
                <div className="lesson-tags">{tags.map(t => <span key={t} className="lesson-tag">{t}</span>)}</div>
            )}
            <div className="risk-links">
                {lesson.links.map(l => (
                    <span key={l.id} className="risk-link-tag">
                        {l.entity_title || `#${l.entity_id}`}
                        <span className="tracking-delete-btn" onClick={() => deleteLessonLink(l.id).then(refresh)}>✕</span>
                    </span>
                ))}
            </div>
            <AddLessonLinkForm lessonId={lesson.id} entityOptions={entityOptions} refresh={refresh} />
        </div>
    )
}

function AddLessonLinkForm({ lessonId, entityOptions, refresh }) {
    const [open, setOpen] = useState(false)
    const [selected, setSelected] = useState("")

    async function submit() {
        if (!selected) return
        const [entity_type, entity_id] = selected.split(":")
        await createLessonLink(lessonId, { entity_type, entity_id: Number(entity_id) })
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

function AddLessonForm({ refresh }) {
    const [open, setOpen] = useState(false)
    const [title, setTitle] = useState("")
    const [category, setCategory] = useState("")
    const [date, setDate] = useState("")
    const [description, setDescription] = useState("")
    const [recommendation, setRecommendation] = useState("")
    const [tags, setTags] = useState("")

    async function submit() {
        if (!title.trim()) return
        await createLesson({ title, category, date: date || null, description, recommendation, tags })
        setTitle(""); setCategory(""); setDate(""); setDescription(""); setRecommendation(""); setTags("")
        setOpen(false)
        refresh()
    }

    if (!open) return <button className="tracking-add-btn" onClick={() => setOpen(true)}>+ Neue Lesson Learned</button>
    return (
        <div className="tracking-form lesson-form">
            <input placeholder="Titel" value={title} onChange={e => setTitle(e.target.value)} />
            <input placeholder="Kategorie (z. B. Release, Migration)" value={category} onChange={e => setCategory(e.target.value)} />
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
            <input placeholder="Beschreibung" value={description} onChange={e => setDescription(e.target.value)} />
            <input placeholder="Empfehlung für zukünftige Vorhaben" value={recommendation} onChange={e => setRecommendation(e.target.value)} />
            <input placeholder="Tags (kommagetrennt)" value={tags} onChange={e => setTags(e.target.value)} />
            <button onClick={submit}>Speichern</button>
            <button onClick={() => setOpen(false)}>Abbrechen</button>
        </div>
    )
}
