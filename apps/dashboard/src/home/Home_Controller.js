import { useState, useEffect, useCallback, useRef } from "react"
import { fetchOverview } from "./api"
import Floorplan from "./floorplan/Floorplan"
import RoomPanel from "./room/RoomPanel"
import VacuumView from "./vacuum/VacuumView"
import HomeSettings from "./settings/HomeSettings"
import "./home.css"

/* available: whether there is anything to do in there right now. The robot tab
   needs an actually reachable robot - everything in it operates the machine, and
   a page of disabled buttons is worse than no page. Connecting lives under
   Settings -> yeedi, which is reachable either way, so nothing is locked away.
   The plan and the settings are always there. */
const TABS = [
    { id: "plan", label: "Grundriss" },
    { id: "vacuum", label: "Staubsauger", available: d => !!(d.vacuum && d.vacuum.connected) },
    { id: "settings", label: "Einstellungen" },
]

/* Lamps get switched from phones, wall switches and the Hue app as well, so the
   plan would drift out of date without a poll. */
const POLL_MS = 15000

export function Home() {
    const [tab, setTab] = useState("plan")
    const [data, setData] = useState(null)
    const [error, setError] = useState("")
    const [selectedRoomId, setSelectedRoomId] = useState(null)
    const loading = useRef(false)

    const refresh = useCallback(async () => {
        if (loading.current) return
        loading.current = true
        try {
            setData(await fetchOverview())
            setError("")
        } catch (e) {
            setError(e.message)
        } finally {
            loading.current = false
        }
    }, [])

    useEffect(() => {
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => clearInterval(timer)
    }, [refresh])

    // A failed poll keeps the last good picture on screen instead of blanking it
    if (!data) {
        if (error) return <div className="home-status error">Wohnungs-Service nicht erreichbar.</div>
        return <div className="home-status">Lädt…</div>
    }

    const selectedRoom = data.rooms.find(r => r.id === selectedRoomId) || null
    const tabs = TABS.filter(t => !t.available || t.available(data))
    // A tab that disappears while it is open must not leave an empty view.
    const current = tabs.some(t => t.id === tab) ? tab : tabs[0].id

    return (
        <div className="home-module">
            <div className="home-tabs">
                {tabs.map(({ id, label }) => (
                    <button key={id} className={id === current ? "active" : ""}
                            onClick={() => setTab(id)}>{label}</button>
                ))}
            </div>

            {error && <p className="home-error">Letzte Aktualisierung fehlgeschlagen: {error}</p>}

            {/* The tab is gone while the robot does not answer. Said out loud,
                because a tab that silently disappears for a device one owns
                looks like a defect - and the way back is not where it was. */}
            {data.vacuum && data.vacuum.configured && !data.vacuum.connected && (
                <p className="home-meta">
                    Saugroboter eingerichtet, aber nicht erreichbar — unter „Einstellungen“
                    verbinden.
                </p>
            )}

            {current === "plan" && (
                <div className="home-view">
                    <div className="home-split">
                        <div className="home-card">
                            <Floorplan
                                walls={data.walls}
                                rooms={data.rooms}
                                selected={selectedRoomId ? [selectedRoomId] : []}
                                onSelect={room => setSelectedRoomId(room.id === selectedRoomId ? null : room.id)}
                            />
                        </div>
                        <RoomPanel room={selectedRoom} hue={data.hue} shelly={data.shelly}
                                   vacuum={data.vacuum} layout={data.layout}
                                   onChanged={refresh} />
                    </div>
                </div>
            )}

            {current === "vacuum" && (
                <VacuumView rooms={data.rooms} vacuum={data.vacuum} onChanged={refresh} />
            )}

            {current === "settings" && (
                <HomeSettings rooms={data.rooms} hue={data.hue} shelly={data.shelly}
                              vacuum={data.vacuum} onChanged={refresh} />
            )}
        </div>
    )
}
