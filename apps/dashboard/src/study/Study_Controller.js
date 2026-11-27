import { useState } from "react"
import { Tabs } from "../common/ui"
import "../common/ui/ui.css"
import { useUser } from "../common/user"
import NoUser from "../common/NoUser"
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
    const { userId } = useUser()
    const [tab, setTab] = useState("overview")

    // After the hooks, never before: an early return above them would change
    // how many hooks run between renders, which React forbids for good reason.
    // Checked here rather than in every view below, which would each fetch and
    // fail the same way.
    if (!userId) return <NoUser what="Die Modulplanung" />

    return (
        <div className="ui-module">
            <Tabs items={Object.entries(TABS).map(([id, label]) => ({ id, label }))}
                  value={tab} onChange={setTab} />
            {tab === "overview" && <OverviewPage onNavigate={setTab}/>}
            {tab === "modules" && <ModuleList/>}
            {tab === "plans" && <PlanView/>}
            {tab === "categories" && <CategoryList/>}
        </div>
    )
}
