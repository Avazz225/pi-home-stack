import { useState, useEffect, useCallback, useRef } from "react"
import { fetchOverview } from "./api"
import Floorplan from "./floorplan/Floorplan"
import RoomPanel from "./room/RoomPanel"
import VacuumView from "./vacuum/VacuumView"
import HomeSettings from "./settings/HomeSettings"
import "./home.css"

const TABS = {
    plan: "Grundriss",
    vacuum: "Staubsauger",
    settings: "Einstellungen",
}

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

    return (
        <div className="home-module">
            <div className="home-tabs">
                {Object.entries(TABS).map(([key, label]) => (
                    <button key={key} className={key === tab ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
                ))}
            </div>

            {error && <p className="home-error">Letzte Aktualisierung fehlgeschlagen: {error}</p>}

            {tab === "plan" && (
                <div className="home-view">
                    <div className="home-split">
                        <div className="home-card">
                            <Floorplan
                                rooms={data.rooms}
                                selected={selectedRoomId ? [selectedRoomId] : []}
                                onSelect={room => setSelectedRoomId(room.id === selectedRoomId ? null : room.id)}
                            />
                        </div>
                        <RoomPanel room={selectedRoom} hue={data.hue} vacuum={data.vacuum} onChanged={refresh} />
                    </div>
                </div>
            )}

            {tab === "vacuum" && (
                <VacuumView rooms={data.rooms} vacuum={data.vacuum} onChanged={refresh} />
            )}

            {tab === "settings" && (
                <HomeSettings rooms={data.rooms} hue={data.hue} vacuum={data.vacuum} onChanged={refresh} />
            )}
        </div>
    )
}
