import { useState } from "react"
import OverviewPage from "./overview/OverviewPage"
import ModuleList from "./modules/ModuleList"
import PlanView from "./plans/PlanView"
import CategoryList from "./categories/CategoryList"
import "./study.css"

const TABS = {
    overview: "Übersicht",
    modules: "Module",
    plans: "Planung",
    categories: "Fachrichtungen",
}

export function StudyPlanner() {
    const [tab, setTab] = useState("overview")

    return (
        <div className="study-module">
            <div className="study-tabs">
                {Object.entries(TABS).map(([key, label]) => (
                    <button key={key} className={key === tab ? "active" : ""} onClick={() => setTab(key)}>{label}</button>
                ))}
            </div>
            {tab === "overview" && <OverviewPage onNavigate={setTab}/>}
            {tab === "modules" && <ModuleList/>}
            {tab === "plans" && <PlanView/>}
            {tab === "categories" && <CategoryList/>}
        </div>
    )
}
