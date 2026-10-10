import { useState, useEffect, useCallback } from "react"
import { fetchTree, fetchRules, setRule } from "../api"
import "./folders.css"

const ROOT = ""

/** Mirrors RuleSet in the backend: the nearest ancestor with an explicit rule wins,
 *  and without one nothing is backed up. Resolving locally lets a toggle update the
 *  whole visible tree without refetching it. */
function effectiveMode(rules, path) {
    let current = path
    for (;;) {
        if (rules[current] !== undefined) return rules[current]
        if (current === "") return "exclude"
        const cut = current.lastIndexOf("/")
        current = cut === -1 ? "" : current.slice(0, cut)
    }
}

export default function FolderTree() {
    const [rules, setRules] = useState({})
    const [nodes, setNodes] = useState({})        // path -> {loading, error, entries}
    const [expanded, setExpanded] = useState({ [ROOT]: true })
    const [rootInfo, setRootInfo] = useState(null)
    const [error, setError] = useState("")

    const loadNode = useCallback(async (path) => {
        setNodes(prev => ({ ...prev, [path]: { ...(prev[path] || {}), loading: true } }))
        try {
            const data = await fetchTree(path)
            if (path === ROOT) setRootInfo(data)
            setNodes(prev => ({
                ...prev,
                [path]: { loading: false, entries: data.entries, truncated: data.truncated },
            }))
        } catch (e) {
            setNodes(prev => ({ ...prev, [path]: { loading: false, error: e.message } }))
        }
    }, [])

    useEffect(() => {
        (async () => {
            try {
                const list = await fetchRules()
                setRules(Object.fromEntries(list.map(r => [r.path, r.mode])))
            } catch (e) {
                setError(e.message)
                return
            }
            loadNode(ROOT)
        })()
    }, [loadNode])

    function toggleExpand(path) {
        const open = !expanded[path]
        setExpanded(prev => ({ ...prev, [path]: open }))
        if (open && !nodes[path]) loadNode(path)
    }

    async function applyRule(path, mode) {
        const previous = rules
        // Optimistic: the tree re-resolves immediately, the request only confirms.
        setRules(prev => {
            const next = { ...prev }
            if (mode === "inherit") delete next[path]
            else next[path] = mode
            return next
        })
        try {
            await setRule(path, mode)
            setError("")
        } catch (e) {
            setRules(previous)
            setError(`Konnte nicht gespeichert werden: ${e.message}`)
        }
    }

    if (error && !rootInfo) return <div className="backup-status error">{error}</div>
    if (!rootInfo && !nodes[ROOT]?.error) return <div className="backup-status">Ordnerstruktur wird geladen…</div>

    return (
        <div className="backup-folders">
            <p className="backup-hint">
                Standard ist <strong>keine Sicherung</strong>. Ein auf „Sichern“ gesetzter Ordner
                schließt alle Unterordner und Dateien ein — bis ein Unterordner ausdrücklich auf
                „Nicht sichern“ gesetzt wird.
            </p>

            {error && <div className="backup-status error">{error}</div>}

            <div className="folder-tree">
                <FolderRow
                    label={rootInfo?.name || "NAS"}
                    path={ROOT}
                    depth={0}
                    isRoot
                    hasChildren
                    rules={rules}
                    expanded={!!expanded[ROOT]}
                    onToggle={toggleExpand}
                    onRule={applyRule}
                />
                <FolderChildren
                    path={ROOT}
                    depth={1}
                    nodes={nodes}
                    rules={rules}
                    expanded={expanded}
                    onToggle={toggleExpand}
                    onRule={applyRule}
                />
            </div>

            <RuleSummary rules={rules} onRule={applyRule} />
        </div>
    )
}

function FolderChildren({ path, depth, nodes, rules, expanded, onToggle, onRule }) {
    const node = nodes[path]
    if (!expanded[path]) return null
    if (!node || node.loading) return <div className="folder-note" style={indent(depth)}>Lädt…</div>
    if (node.error) return <div className="folder-note error" style={indent(depth)}>{node.error}</div>
    if (!node.entries.length) return <div className="folder-note" style={indent(depth)}>Keine Unterordner</div>

    const rows = node.entries.map(entry => (
        <div key={entry.path}>
            <FolderRow
                label={entry.name}
                path={entry.path}
                depth={depth}
                hasChildren={entry.hasChildren}
                rules={rules}
                expanded={!!expanded[entry.path]}
                onToggle={onToggle}
                onRule={onRule}
            />
            {entry.hasChildren && (
                <FolderChildren
                    path={entry.path}
                    depth={depth + 1}
                    nodes={nodes}
                    rules={rules}
                    expanded={expanded}
                    onToggle={onToggle}
                    onRule={onRule}
                />
            )}
        </div>
    ))

    // The API caps how many directory entries it scans — say so rather than
    // quietly showing an incomplete folder list.
    if (!node.truncated) return rows
    return [...rows, (
        <div key="__truncated" className="folder-note error" style={indent(depth)}>
            Ordner zu groß — die Liste ist unvollständig.
        </div>
    )]
}

function indent(depth) {
    return { paddingLeft: `${depth * 1.25}em` }
}

function FolderRow({ label, path, depth, hasChildren, isRoot, rules, expanded, onToggle, onRule }) {
    const explicit = rules[path]
    const effective = effectiveMode(rules, path)
    const included = effective === "include"

    return (
        <div className={`folder-row ${included ? "included" : ""}`} style={indent(depth)}>
            <button
                className={`folder-caret ${hasChildren ? "" : "empty"}`}
                onClick={() => hasChildren && onToggle(path)}
                disabled={!hasChildren}
                aria-label={expanded ? "Zuklappen" : "Aufklappen"}
            >
                {hasChildren ? (expanded ? "▾" : "▸") : "·"}
            </button>

            <span className="folder-name" onClick={() => hasChildren && onToggle(path)}>
                {isRoot ? `${label} (alles)` : label}
            </span>

            <span className={`folder-badge ${included ? "on" : "off"}`}>
                {included ? "gesichert" : "nicht gesichert"}
                {!explicit && <em> · geerbt</em>}
            </span>

            <span className="folder-actions">
                <button
                    className={explicit === "include" ? "active" : ""}
                    onClick={() => onRule(path, "include")}
                    title="Diesen Ordner samt Unterordnern sichern"
                >Sichern</button>
                <button
                    className={explicit === "exclude" ? "active" : ""}
                    onClick={() => onRule(path, "exclude")}
                    title="Diesen Ordner samt Unterordnern nicht sichern"
                >Nicht sichern</button>
                {explicit && (
                    <button
                        className="reset"
                        onClick={() => onRule(path, "inherit")}
                        title="Einstellung entfernen, wieder vom übergeordneten Ordner erben"
                    >↺</button>
                )}
            </span>
        </div>
    )
}

function RuleSummary({ rules, onRule }) {
    const entries = Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))
    if (!entries.length) {
        return (
            <div className="backup-status">
                Noch kein Ordner ausgewählt — es wird nichts gesichert.
            </div>
        )
    }
    return (
        <div className="rule-summary">
            <h4>Gesetzte Regeln ({entries.length})</h4>
            {entries.map(([path, mode]) => (
                <div key={path} className={`rule-item ${mode}`}>
                    <span className="rule-mode">{mode === "include" ? "Sichern" : "Nicht sichern"}</span>
                    <span className="rule-path">/{path}</span>
                    <button onClick={() => onRule(path, "inherit")} title="Regel entfernen">×</button>
                </div>
            ))}
        </div>
    )
}
