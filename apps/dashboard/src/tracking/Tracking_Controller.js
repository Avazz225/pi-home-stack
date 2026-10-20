import { useState } from "react";
import { useUser } from "../common/user"
import NoUser from "../common/NoUser"
import StartPage from "./startpage/StartPage";
import HierarchyView from "./hierarchy/HierarchyView";
import TimelineView from "./timeline/TimelineView";
import DependencyView from "./dependencies/DependencyView";
import RiskList from "./risks/RiskList";
import RiskHeatmap from "./risks/RiskHeatmap";
import LessonsView from "./lessons/LessonsView";
import "./tracking.css";

const TABS = {
    startpage: "Startseite", hierarchy: "Hierarchie", timeline: "Timeline",
    dependencies: "Abhängigkeiten", risks: "Risiken", heatmap: "Risiko-Heatmap",
    lessons: "Lessons Learned",
}

export function FeatureTracking(){
    const [tab, setTab] = useState("startpage")
    const { userId } = useUser()

    // Checked before the tabs, not inside each view: every one of them would
    // otherwise fetch and fail the same way.
    if (!userId) return <NoUser what="Das Feature-Tracking" />

    return(
        <div className="tracking-module">
            <div className="tracking-tabs">
                {Object.entries(TABS).map(([key, label]) => (
                    <button key={key} className={key === tab ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
                ))}
            </div>
            {tab === "startpage" && <StartPage/>}
            {tab === "hierarchy" && <HierarchyView/>}
            {tab === "timeline" && <TimelineView/>}
            {tab === "dependencies" && <DependencyView/>}
            {tab === "risks" && <RiskList/>}
            {tab === "heatmap" && <RiskHeatmap/>}
            {tab === "lessons" && <LessonsView/>}
        </div>
    )
}
