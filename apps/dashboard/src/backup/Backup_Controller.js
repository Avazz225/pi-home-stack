import { useState } from "react"
import FolderTree from "./folders/FolderTree"
import TargetList from "./targets/TargetList"
import BackupSettings from "./settings/BackupSettings"
import BackupStatus from "./status/BackupStatus"
import "./backup.css"

const TABS = {
    status: "Status",
    folders: "Ordner",
    targets: "Ziele",
    settings: "Einstellungen",
}

export function Backup() {
    const [tab, setTab] = useState("status")

    return (
        <div className="backup-module">
            <div className="backup-tabs">
                {Object.entries(TABS).map(([key, label]) => (
                    <button key={key} className={key === tab ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
                ))}
            </div>
            {tab === "status" && <BackupStatus/>}
            {tab === "folders" && <FolderTree/>}
            {tab === "targets" && <TargetList/>}
            {tab === "settings" && <BackupSettings/>}
        </div>
    )
}
