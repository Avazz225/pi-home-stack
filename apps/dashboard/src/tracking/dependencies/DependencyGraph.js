import "./graph.css"

const NODE_W = 160
const NODE_H = 40
const COL_GAP = 90
const ROW_GAP = 16

// Layering per Kahn-Topologie: level(blocked) = max(level(blocker)) + 1.
// edges hier: from_id hängt ab von to_id → to_id (Blocker) zeigt auf from_id (Blockiertes).
function computeLayout(edges, titleOf) {
    const nodeIds = new Set()
    edges.forEach(e => { nodeIds.add(e.from_id); nodeIds.add(e.to_id) })

    const outgoing = new Map() // blocker -> [blockiert, ...]
    const indegree = new Map()
    nodeIds.forEach(id => { outgoing.set(id, []); indegree.set(id, 0) })
    edges.forEach(e => {
        outgoing.get(e.to_id).push(e.from_id)
        indegree.set(e.from_id, indegree.get(e.from_id) + 1)
    })

    const level = new Map()
    const queue = [...nodeIds].filter(id => indegree.get(id) === 0)
    queue.forEach(id => level.set(id, 0))
    const indegreeCopy = new Map(indegree)
    let i = 0
    let guard = nodeIds.size * nodeIds.size + 10 // Schutz gegen Zyklen
    while (i < queue.length && guard-- > 0) {
        const node = queue[i++]
        for (const next of outgoing.get(node)) {
            level.set(next, Math.max(level.get(next) ?? 0, level.get(node) + 1))
            indegreeCopy.set(next, indegreeCopy.get(next) - 1)
            if (indegreeCopy.get(next) === 0 && !queue.includes(next)) queue.push(next)
        }
    }
    // Falls ein Zyklus existiert, bleiben Knoten ohne Level – sicherheitshalber auf 0 setzen.
    nodeIds.forEach(id => { if (!level.has(id)) level.set(id, 0) })

    const columns = new Map()
    nodeIds.forEach(id => {
        const lvl = level.get(id)
        if (!columns.has(lvl)) columns.set(lvl, [])
        columns.get(lvl).push(id)
    })

    const positions = new Map()
    const maxLevel = Math.max(...columns.keys())
    for (const [lvl, ids] of columns) {
        ids.forEach((id, idx) => {
            positions.set(id, {
                x: lvl * (NODE_W + COL_GAP),
                y: idx * (NODE_H + ROW_GAP),
                level: lvl,
            })
        })
    }
    const maxRows = Math.max(...[...columns.values()].map(ids => ids.length))

    return {
        nodes: [...nodeIds].map(id => ({ id, title: titleOf(id), ...positions.get(id) })),
        width: (maxLevel + 1) * (NODE_W + COL_GAP) - COL_GAP,
        height: Math.max(maxRows, 1) * (NODE_H + ROW_GAP) - ROW_GAP,
        positions,
    }
}

export default function DependencyGraph({ edges, titleOf }) {
    if (edges.length === 0) {
        return <p className="tracking-description">Keine blockierenden Abhängigkeiten zum Visualisieren.</p>
    }
    const { nodes, width, height, positions } = computeLayout(edges, titleOf)

    return (
        <div className="dependency-graph-scroll">
            <svg width={width + NODE_W} height={height + NODE_H} className="dependency-graph-svg">
                <defs>
                    <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M0,0 L10,5 L0,10 z" className="graph-arrow-head" />
                    </marker>
                </defs>
                {edges.map((e, i) => {
                    const from = positions.get(e.to_id)   // Blocker
                    const to = positions.get(e.from_id)   // Blockiertes
                    if (!from || !to) return null
                    const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2
                    const x2 = to.x, y2 = to.y + NODE_H / 2
                    const midX = (x1 + x2) / 2
                    return (
                        <path
                            key={i}
                            d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                            className="graph-edge" markerEnd="url(#dep-arrow)"
                        />
                    )
                })}
                {nodes.map(n => (
                    <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
                        <rect width={NODE_W} height={NODE_H} rx="8" className="graph-node-rect" />
                        <title>{n.title}</title>
                        <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" className="graph-node-text">
                            {n.title.length > 20 ? n.title.slice(0, 19) + "…" : n.title}
                        </text>
                    </g>
                ))}
            </svg>
        </div>
    )
}
