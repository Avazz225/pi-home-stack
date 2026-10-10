import React, { useState } from "react";
import MdiImageMultipleOutline from "./icons/ImageMultiple";
import Gallery from "./gallery/Gallery";
import { FullScreen } from "react-full-screen";
import MdiFullscreen from "./icons/FullScreen";
import MdiFullscreenExit from "./icons/FullScreenExit";
import { calcDelay, loadSettings, updateSettings } from "./helpers";
import MdiSettings from "./icons/Settings";
import Settings from "./settings/Settings";
import { NetworkSpeed } from "./dashboard/Dashboard_Controller";
import MdiArrow from "./icons/arrow";
import ToDoList from "./dashboard/toDoList/ToDoList";
import QuickLinks from "./dashboard/quicklinks/QuickLinks";
import { FeatureTracking } from "./tracking/Tracking_Controller";
import { Backup } from "./backup/Backup_Controller";
import { StudyPlanner } from "./study/Study_Controller";
import { Home } from "./home/Home_Controller";
import MdiThemeMode from "./icons/ThemeMode";
import { THEME_MODES } from "./theme";


export default class Controller extends React.Component{
    constructor(props){
        super(props);
        this.state = {
            dashBoardVisible: true,
            settings: {},
            settingsVisible: false,
        }
        this.toggleDashboard = this.toggleDashboard.bind(this)
        this.toggleSettings = this.toggleSettings.bind(this)
        this.updateSettings = this.updateSettings.bind(this)
    }

    componentDidMount(){
        this.setState({
            settings: loadSettings()
        })
    }

    toggleDashboard(){
        let new_state = !this.state.dashBoardVisible
        this.setState({
            dashBoardVisible: new_state
        })

        if (new_state && this.state.settings.dashSwitch) {
            let delay = calcDelay(this.state.dashSwitchTime, this.state.dashSwitchUnit)
            
            setTimeout(() => {
                if (this.state.settings.dashSwitch){this.setState({dashBoardVisible:false})}
            }, delay);
        }
    }

    toggleSettings(){
        this.setState({
            settingsVisible: !this.state.settingsVisible
        })
    }

    updateSettings(key, value){
        let settings = this.state.settings
        settings[key] = value
        this.setState({
            settings: settings
        })
        updateSettings(settings)
    }

    render(){
        return(
            <FullScreen handle={this.props.handle}>
                {(this.state.dashBoardVisible)?
                    <Dashboard toggleDashboard={this.toggleDashboard} handle={this.props.handle} settings={this.state.settings}  toggleSettings={this.toggleSettings} settingsVisible={this.state.settingsVisible} updateSettings={this.updateSettings} theme={this.props.theme} />
                    :
                    <Gallery toggleDashboard={this.toggleDashboard} settings={this.state.settings} />
                }
            </FullScreen>
        )
    }
}


function Dashboard({toggleDashboard, handle, settings, toggleSettings, settingsVisible, updateSettings, theme}){
    const options = {"network_speed": "Netzwerkgeschwindigkeit", "home": "Wohnung", "to_do_list": "ToDo Liste", "quick_links": "Quicklinks", "feature_tracking": "Feature-Tracking", "backup": "NAS-Backup", "study": "Modulplanung"}
    /* The dropdown is ordered by what it shows, not by the order the panes were
       added over time. localeCompare so Umlaute sort where German expects them. */
    const sortedKeys = Object.keys(options).sort((a, b) => options[a].localeCompare(options[b], "de"))
    const [option, setOption] = useState(() => {
        const queryOption = new URLSearchParams(window.location.search).get("p")
        if (queryOption && options[queryOption]) return queryOption
        return localStorage.getItem("lastOption") || "network_speed"
    })
    const [dropdown, setDropdown] = useState(false)

    function selectOption(key) {
        setOption(key);
        localStorage.setItem("lastOption", key);
    }

    return(
        <div className="dashboard">
            {settingsVisible &&
                <Settings settings={settings} updateSettings={updateSettings} toggleSettings={toggleSettings} theme={theme} />
            }
            <div className="dash-header">
                <span className="inline" onClick={() => setDropdown(!dropdown)}>
                    <h1>{options[option]}</h1>
                    <MdiArrow upsideDown={dropdown}/>
                </span>
                <div className="dash-toolbar">
                    <ThemeToggle theme={theme}/>
                    <button className="invisibleBtn" onClick={toggleSettings} disabled={settingsVisible}>
                        <MdiSettings/>
                    </button>
                    {handle.active ?
                        <button className="invisibleBtn" onClick={handle.exit}>
                            <MdiFullscreenExit/>
                        </button>
                        :
                        <button className="invisibleBtn" onClick={handle.enter}>
                            <MdiFullscreen/>
                        </button>
                    }
                    <button className="invisibleBtn" onClick={toggleDashboard}>
                        <MdiImageMultipleOutline/>
                    </button>
                </div>
            </div>
            <DashboardDropdown
                options={options}
                sortedKeys={sortedKeys}
                option={option}
                dropdown={dropdown}
                setOption={selectOption}
                setDropdown={setDropdown}
            />
            <div className="paneGrid">
                {
                    {
                        "network_speed": <NetworkSpeed/>,
                        "home": <Home/>,
                        "to_do_list": <ToDoList/>,
                        "quick_links": <QuickLinks/>,
                        "feature_tracking": <FeatureTracking/>,
                        "backup": <Backup/>,
                        "study": <StudyPlanner/>
                    }[option]
                }
            </div>
        </div>
    )
}

/* Cycles hell → dunkel → automatisch. The full picker lives in the settings pane. */
function ThemeToggle({theme}){
    if (!theme) return null
    const label = THEME_MODES.find(m => m.key === theme.mode)?.label ?? ""
    return(
        <button className="invisibleBtn" onClick={theme.cycleMode} title={`Darstellung: ${label}`} aria-label={`Darstellung: ${label}`}>
            <MdiThemeMode mode={theme.mode}/>
        </button>
    )
}

function DashboardDropdown({options, sortedKeys, option, dropdown, setOption, setDropdown}){
    return(
        <div className="optionList" data-visible={dropdown} style={{"--data-count": sortedKeys.length - 1}}>
            {sortedKeys.map((key) => (
                (key !== option) && <div key={key} onClick={() => { setOption(key); setDropdown(false) }}>{options[key]}</div>
            ))}
        </div>
    )
}