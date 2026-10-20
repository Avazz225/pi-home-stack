import { useEffect, useMemo, useState } from "react"
import { startScene, stopScene } from "../api"
import "./scenes.css"

/* The scenes, as tiles you press.
 *
 * One tile per scene, because that is how several of them stay usable - a list
 * of rows with buttons reads as administration, a grid of tiles reads as
 * switches. Pressing a running one stops it.
 *
 * The countdown runs locally between polls. The server sends the seconds left
 * rather than an end time, so a tablet whose clock is off by a minute still
 * counts down to the right moment - and what is counted here is only the time
 * since that answer arrived, measured with the same clock that measures it.
 */

function fmtLeft(seconds) {
    if (seconds == null) return "ohne Ende"
    if (seconds <= 0) return "gleich"
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return m > 0 ? `noch ${m}:${String(s).padStart(2, "0")}` : `noch ${s} s`
}

function fmtDuration(seconds) {
    if (!seconds) return "ohne Ende"
    if (seconds % 3600 === 0) return `${seconds / 3600} h`
    if (seconds % 60 === 0) return `${seconds / 60} min`
    return `${seconds} s`
}

export default function SceneTiles({ scenes, hue, onChanged }) {
    const [busy, setBusy] = useState(null)
    const [error, setError] = useState("")
    const [now, setNow] = useState(() => Date.now())

    /* When this answer arrived. Recomputed whenever the scenes do, which is
       what makes the countdown restart from the server's number instead of
       drifting away from it. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const since = useMemo(() => Date.now(), [scenes])

    const anyRunning = (scenes || []).some(s => s.running && s.running.remaining_s != null)
    useEffect(() => {
        if (!anyRunning) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [anyRunning])

    if (!scenes || scenes.length === 0) return null

    async function toggle(scene) {
        setBusy(scene.id)
        try {
            const result = scene.running
                ? await stopScene(scene.id)
                : await startScene(scene.id)
            setError((result.problems || []).join(" · "))
            onChanged()
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="home-card">
            <div className="home-card-header">
                <h4>Szenen</h4>
                {hue && !hue.configured &&
                    <span className="home-chip">Hue nicht eingerichtet</span>}
            </div>
            <div className="scene-grid">
                {scenes.map(scene => {
                    const run = scene.running
                    const left = run && run.remaining_s != null
                        ? Math.max(0, run.remaining_s - Math.floor((now - since) / 1000))
                        : null
                    return (
                        <button key={scene.id} className="scene-tile"
                                data-on={!!run} data-fading={!!(run && run.fading)}
                                disabled={busy === scene.id}
                                onClick={() => toggle(scene)}>
                            <span className="scene-name">{scene.name}</span>
                            <span className="scene-meta">
                                {run
                                    ? (run.remaining_s == null ? "läuft" : fmtLeft(left))
                                    : fmtDuration(scene.duration_s)}
                            </span>
                            <span className="scene-lamps">
                                {scene.lights.length} Lampe{scene.lights.length === 1 ? "" : "n"}
                                {scene.fade_s > 0 && " · dimmt aus"}
                            </span>
                        </button>
                    )
                })}
            </div>
            {error && <p className="home-error">{error}</p>}
        </div>
    )
}
