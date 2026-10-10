import React, { useState, useEffect, useRef } from "react";
import { loadQuicklinks, saveQuicklinks, generateId } from "../../helpers";
import "./quicklinks.css";

export default function QuickLinks() {
    const [categories, setCategories] = useState([]);
    const [editMode, setEditMode] = useState(false);
    const [dragOverCat, setDragOverCat] = useState(null);

    useEffect(() => {
        setCategories(loadQuicklinks());
    }, []);

    function updateCategories(updated) {
        setCategories(updated);
        saveQuicklinks(updated);
    }

    function addCategory() {
        const cat = { id: generateId(), name: "Neue Kategorie", colSpan: 2, links: [] };
        updateCategories([...categories, cat]);
    }

    function renameCategory(id, name) {
        updateCategories(categories.map(c => c.id === id ? { ...c, name } : c));
    }

    function resizeCategory(id, colSpan) {
        updateCategories(categories.map(c => c.id === id ? { ...c, colSpan } : c));
    }

    function removeCategory(id) {
        updateCategories(categories.filter(c => c.id !== id));
    }

    function addLink(catId) {
        const link = { id: generateId(), label: "Neuer Link", url: "https://", image: "" };
        updateCategories(categories.map(c =>
            c.id === catId ? { ...c, links: [...c.links, link] } : c
        ));
    }

    function updateLink(catId, linkId, field, value) {
        updateCategories(categories.map(c =>
            c.id === catId ? {
                ...c,
                links: c.links.map(l => l.id === linkId ? { ...l, [field]: value } : l)
            } : c
        ));
    }

    function removeLink(catId, linkId) {
        updateCategories(categories.map(c =>
            c.id === catId ? { ...c, links: c.links.filter(l => l.id !== linkId) } : c
        ));
    }

    function reorderCategories(sourceId, targetId) {
        if (sourceId === targetId) return;
        const list = [...categories];
        const from = list.findIndex(c => c.id === sourceId);
        const to = list.findIndex(c => c.id === targetId);
        list.splice(to, 0, list.splice(from, 1)[0]);
        updateCategories(list);
    }

    function reorderLinks(catId, newLinks) {
        updateCategories(categories.map(c => c.id === catId ? { ...c, links: newLinks } : c));
    }

    return (
        <div className="quicklinks">
            <SearchBar />
            <div className="ql-toolbar">
                <button
                    className={"ql-edit-btn" + (editMode ? " active" : "")}
                    onClick={() => setEditMode(!editMode)}
                >
                    {editMode ? "Fertig" : "Bearbeiten"}
                </button>
            </div>

            <div className="ql-grid-wrapper" data-editing={editMode}>
                {editMode && (
                    <div className="ql-grid-bg" aria-hidden="true">
                        <div /><div /><div /><div />
                    </div>
                )}
                <div className="ql-sections">
                    {categories.map(cat => (
                        <Section
                            key={cat.id}
                            category={cat}
                            editMode={editMode}
                            onRename={renameCategory}
                            onResize={resizeCategory}
                            onRemove={removeCategory}
                            onAddLink={addLink}
                            onUpdateLink={updateLink}
                            onRemoveLink={removeLink}
                            onReorderCat={reorderCategories}
                            onReorderLinks={reorderLinks}
                            dragOver={dragOverCat === cat.id}
                            onDragOverChange={setDragOverCat}
                        />
                    ))}
                    {editMode && (
                        <button className="ql-add-category" onClick={addCategory}>
                            + Kategorie
                        </button>
                    )}
                </div>
            </div>

            {categories.length === 0 && !editMode && (
                <p className="ql-empty-hint">
                    Keine Links vorhanden.<br />Klicke auf „Bearbeiten" um Kategorien und Kacheln anzulegen.
                </p>
            )}
        </div>
    );
}

function Section({ category, editMode, onRename, onResize, onRemove, onAddLink, onUpdateLink, onRemoveLink, onReorderCat, onReorderLinks, dragOver, onDragOverChange }) {
    const [dragOverLink, setDragOverLink] = useState(null);
    const colSpan = category.colSpan || 2;

    function moveLinkTo(sourceId, targetId) {
        if (sourceId === targetId) return;
        const links = [...category.links];
        const from = links.findIndex(l => l.id === sourceId);
        const to = links.findIndex(l => l.id === targetId);
        links.splice(to, 0, links.splice(from, 1)[0]);
        onReorderLinks(category.id, links);
    }

    return (
        <div
            className={"ql-section" + (editMode && dragOver ? " ql-cat-drag-over" : "")}
            style={{ "--col-span": colSpan }}
            onDragOver={editMode ? (e) => { e.preventDefault(); onDragOverChange(category.id); } : undefined}
            onDrop={editMode ? (e) => {
                e.preventDefault();
                const sourceId = e.dataTransfer.getData("catId");
                if (sourceId) onReorderCat(sourceId, category.id);
                onDragOverChange(null);
            } : undefined}
            onDragLeave={editMode ? (e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) onDragOverChange(null);
            } : undefined}
        >
            <div
                className="ql-section-header"
                draggable={editMode || undefined}
                onDragStart={editMode ? (e) => {
                    e.dataTransfer.setData("catId", category.id);
                    e.dataTransfer.effectAllowed = "move";
                } : undefined}
            >
                {editMode ? (
                    <>
                        <span className="ql-drag-handle">⠿</span>
                        <input
                            className="ql-section-name-input"
                            value={category.name}
                            onChange={e => onRename(category.id, e.target.value)}
                        />
                        <ColPicker value={colSpan} onChange={n => onResize(category.id, n)} />
                        <button className="ql-remove-btn" onClick={() => onRemove(category.id)}>✕</button>
                    </>
                ) : (
                    <h2 className="ql-section-title">{category.name}</h2>
                )}
            </div>
            <div className="ql-tiles">
                {category.links.map(link =>
                    editMode ? (
                        <TileEditor
                            key={link.id}
                            link={link}
                            catId={category.id}
                            onUpdate={onUpdateLink}
                            onRemove={onRemoveLink}
                            dragOver={dragOverLink === link.id}
                            onDragOver={setDragOverLink}
                            onDrop={moveLinkTo}
                        />
                    ) : (
                        <Tile key={link.id} link={link} />
                    )
                )}
                {editMode && (
                    <button className="ql-add-tile" onClick={() => onAddLink(category.id)}>+</button>
                )}
            </div>
        </div>
    );
}

async function fetchSuggestions(query) {
    const q = encodeURIComponent(query)
    const endpoints = [
        `https://suggestqueries.google.com/complete/search?client=firefox&q=${q}`,
        `https://duckduckgo.com/ac/?q=${q}&type=list`,
    ]
    for (const url of endpoints) {
        try {
            const r = await fetch(url)
            if (!r.ok) continue
            const data = await r.json()
            const results = data[1]
            if (Array.isArray(results) && results.length > 0) return results
        } catch { /* try next */ }
    }
    return []
}

const SEARCH_ICON = (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="22" y2="22" />
    </svg>
);

function SearchBar() {
    const [query, setQuery]           = useState("")
    const [suggestions, setSuggestions] = useState([])
    const [open, setOpen]             = useState(false)
    const [activeIdx, setActiveIdx]   = useState(-1)
    const inputRef = useRef(null)

    useEffect(() => {
        if (query.trim().length < 2) { setSuggestions([]); return }
        const timer = setTimeout(() => fetchSuggestions(query).then(s => {
            setSuggestions(s.slice(0, 8))
            setActiveIdx(-1)
        }), 200)
        return () => clearTimeout(timer)
    }, [query])

    function go(value) {
        window.location.href = `https://www.google.com/search?q=${encodeURIComponent(value)}`
    }

    function handleKeyDown(e) {
        if (!open || suggestions.length === 0) return
        if (e.key === "ArrowDown") {
            e.preventDefault()
            setActiveIdx(i => Math.min(i + 1, suggestions.length - 1))
        } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setActiveIdx(i => Math.max(i - 1, -1))
        } else if (e.key === "Escape") {
            setOpen(false)
        }
    }

    function handleSubmit(e) {
        e.preventDefault()
        const q = activeIdx >= 0 ? suggestions[activeIdx] : query
        if (q.trim()) go(q)
    }

    const showDropdown = open && suggestions.length > 0

    return (
        <div className={"ql-search-wrapper" + (showDropdown ? " has-suggestions" : "")}>
            <form onSubmit={handleSubmit}>
                <div className="ql-search-bar">
                    <span className="ql-search-icon">{SEARCH_ICON}</span>
                    <input
                        ref={inputRef}
                        className="ql-search-input"
                        value={query}
                        onChange={e => { setQuery(e.target.value); setOpen(true) }}
                        onFocus={() => setOpen(true)}
                        onBlur={() => setTimeout(() => setOpen(false), 150)}
                        onKeyDown={handleKeyDown}
                        placeholder="Google suchen …"
                        autoComplete="off"
                    />
                </div>
            </form>
            {showDropdown && (
                <ul className="ql-suggestions">
                    {suggestions.map((s, i) => (
                        <li
                            key={i}
                            className={"ql-suggestion" + (i === activeIdx ? " active" : "")}
                            onMouseDown={() => go(s)}
                        >
                            <span className="ql-suggestion-icon">{SEARCH_ICON}</span>
                            {s}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function ColPicker({ value, onChange }) {
    return (
        <div className="ql-col-picker">
            {[1, 2, 3, 4].map(n => (
                <button
                    key={n}
                    className={"ql-col-btn" + (value === n ? " active" : "")}
                    onClick={() => onChange(n)}
                    title={`${n} Spalte${n > 1 ? "n" : ""}`}
                >
                    <ColIcon cols={n} />
                </button>
            ))}
        </div>
    );
}

function ColIcon({ cols }) {
    // The button carries the color (muted, or the accent when active); the bars
    // beyond the selected count are the same hue at a lower opacity.
    return (
        <svg viewBox="0 0 16 10" width="22" height="14" aria-hidden="true" fill="currentColor">
            {[0, 1, 2, 3].map(i => (
                <rect
                    key={i}
                    x={i * 4 + 0.5}
                    y={0.5}
                    width={3}
                    height={9}
                    rx={1}
                    opacity={i < cols ? 1 : 0.25}
                />
            ))}
        </svg>
    );
}

function Tile({ link }) {
    const hasImage = !!link.image;
    return (
        <a
            className="ql-tile"
            href={link.url}
            target="_blank"
            rel="noreferrer"
            style={hasImage ? { backgroundImage: `url(${link.image})` } : {}}
        >
            {hasImage && <div className="ql-tile-overlay" />}
            <span className="ql-tile-label">{link.label}</span>
        </a>
    );
}

function TileEditor({ link, catId, onUpdate, onRemove, dragOver, onDragOver, onDrop }) {
    return (
        <div
            className={"ql-tile-editor" + (dragOver ? " ql-tile-drag-over" : "")}
            draggable
            onDragStart={e => {
                e.dataTransfer.setData("linkId", link.id);
                e.dataTransfer.setData("linkCatId", catId);
                e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); onDragOver(link.id); }}
            onDrop={e => {
                e.preventDefault();
                e.stopPropagation();
                onDrop(e.dataTransfer.getData("linkId"), link.id);
                onDragOver(null);
            }}
            onDragLeave={e => {
                if (!e.currentTarget.contains(e.relatedTarget)) onDragOver(null);
            }}
        >
            <div className="ql-tile-editor-header">
                <span className="ql-drag-handle">⠿</span>
                <div
                    className="ql-tile-preview"
                    style={link.image ? { backgroundImage: `url(${link.image})`, backgroundSize: "cover", backgroundPosition: "center" } : {}}
                >
                    {!link.image && <span className="ql-tile-preview-icon">🔗</span>}
                </div>
                <button className="ql-remove-btn" onClick={() => onRemove(catId, link.id)}>✕</button>
            </div>
            <input
                className="ql-input"
                value={link.label}
                placeholder="Label"
                onChange={e => onUpdate(catId, link.id, "label", e.target.value)}
            />
            <input
                className="ql-input"
                value={link.url}
                placeholder="https://..."
                onChange={e => onUpdate(catId, link.id, "url", e.target.value)}
            />
            <input
                className="ql-input ql-image-input"
                value={link.image || ""}
                placeholder="Bild-URL (optional)"
                onChange={e => onUpdate(catId, link.id, "image", e.target.value)}
            />
        </div>
    );
}
