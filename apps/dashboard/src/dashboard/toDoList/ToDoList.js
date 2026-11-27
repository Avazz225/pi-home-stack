import React, { useState } from "react";
import { loadTodos, saveTodos, apiFetchTodos, apiSaveTodos } from "../../helpers";
import { currentUserId } from "../../common/user";
import { Pill, Empty } from "../../common/ui";
import "./todo.css"

/* What is still to do in the flat.
 *
 * This pane used to be one card floating in the middle of an otherwise empty
 * screen: no count, done items left in place with a strikethrough so a list
 * of ten with four done read as ten things to do, a bare green plus centred
 * under the last row as the only way to add anything, and a delete control -
 * a lowercase red "x" - that appeared only on done rows, which is the one
 * place it is least needed.
 *
 * Now: a line that says how many are open with the done ones behind a chip,
 * typing at the head of the list as the way to add, and a delete on every
 * row that is always visible, because this runs on a screen screwed to a
 * wall where there is no pointer to hover with.
 */

export default class ToDoList extends React.Component{
    constructor(){
        super();
        this.state = {
            data: [],
            showDone: false,
        }

        this.updateValue = this.updateValue.bind(this)
        this.appendItem = this.appendItem.bind(this)
        this.removeItem = this.removeItem.bind(this)
    }

    componentDidMount(){
        /* The local copy is this browser's last state, which belongs to
           whoever was chosen then. Shown first so the list is not empty for a
           moment, and replaced by the server's answer for the user who is
           chosen now. Without a user there is nobody to ask. */
        this.setState({ data: loadTodos() })
        if (!currentUserId()) {
            this.setState({ noUser: true })
            return
        }
        apiFetchTodos()
            .then(serverData => {
                this.setState({ data: serverData, noUser: false })
                saveTodos(serverData)
            })
            .catch(() => {})
    }

    saveData(data){
        saveTodos(data)
        if (currentUserId()) apiSaveTodos(data).catch(() => {})
    }

    updateValue(index, value, key){
        let temp = [...this.state.data]
        temp[index][key] = value
        this.setState({ data: temp })
        this.saveData(temp)
    }

    /* Appending takes the text with it, so the field at the head of the list
       can hand over what was typed instead of making a blank row that then
       has to be found and filled in. */
    appendItem(content){
        const text = (content || "").trim()
        if (!text) return
        let temp = [...this.state.data, { done: false, content: text }]
        this.setState({ data: temp })
        this.saveData(temp)
    }

    removeItem(index){
        let temp = [...this.state.data]
        temp.splice(index, 1)
        this.setState({ data: temp })
        this.saveData(temp)
    }

    render(){
        /* Said once, where the list would be: the panes that belong to someone
           are empty without one, and an empty list looks like an empty list. */
        if (this.state.noUser) {
            return (
                <div className="todo-view">
                    <Empty>
                        Kein Benutzer gewählt — oben rechts einen auswählen oder anlegen.
                        Die Liste gehört dann ihm.
                    </Empty>
                </div>
            )
        }

        /* The indices are the ones in the stored array, because every edit
           addresses a row by its position there. Splitting the list for
           display must not renumber it. */
        const rows = this.state.data.map((todo, index) => ({ todo, index }))
        const open = rows.filter(r => !r.todo.done)
        const done = rows.filter(r => r.todo.done)

        return (
            <div className="todo-view">
                {/* How many are open, before the list. The old pane made you
                    count, and counted the done ones in with the rest. */}
                <div className="todo-head">
                    <span className="todo-count">{open.length}</span>
                    <span className="todo-count-label">
                        {open.length === 1 ? "offen" : "offen"}
                    </span>
                    {done.length > 0 && (
                        <button type="button" className="todo-donechip"
                                aria-expanded={this.state.showDone}
                                onClick={() => this.setState({ showDone: !this.state.showDone })}>
                            <Pill>{done.length} erledigt</Pill>
                        </button>
                    )}
                </div>

                <div className="todo-list">
                    {/* Typing is how you add. A plus you have to find first is
                        one step in front of the thought the pane was opened to
                        keep. */}
                    <NewItem onAdd={this.appendItem} />

                    {open.length === 0 && done.length === 0 && (
                        <Empty>Nichts offen.</Empty>
                    )}

                    {open.map(({ todo, index }) => (
                        <Item key={index} todo={todo} index={index}
                              updateValue={this.updateValue} removeItem={this.removeItem} />
                    ))}

                    {/* Done items are kept - this is a flat's list, not a
                        sprint - but folded, so they stop being the first thing
                        the eye counts. */}
                    {this.state.showDone && done.map(({ todo, index }) => (
                        <Item key={index} todo={todo} index={index}
                              updateValue={this.updateValue} removeItem={this.removeItem} />
                    ))}
                </div>
            </div>
        )
    }
}

/* The field at the head of the list. Enter files the item and clears the
   field, so several can be typed one after another without reaching for the
   mouse between them. */
function NewItem({ onAdd }){
    const [text, setText] = useState("")
    const submit = () => {
        onAdd(text)
        setText("")
    }
    return (
        <div className="todo-new">
            <span className="todo-new-plus" aria-hidden>+</span>
            <input
                type="text"
                className="todo-new-input"
                value={text}
                placeholder="Neuer Punkt …"
                aria-label="Neuer Punkt"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit() }}
                onBlur={submit}
            />
        </div>
    )
}

function cleanContent(html) {
    html = html.replace(/^(<(?!br\s*\/?>)[^>]*>|\s|<br\s*\/?>)+/g, "");
    html = html.replace(/(<(?!br\s*\/?>)[^>]*>|\s|<br\s*\/?>)+$/g, "");
    return html;
}

function Item({todo, index, updateValue, removeItem}){
    const [marked, setMark] = useState(false)
    return(
        <div className="todo-item" data-done={todo.done}>
            <div className="checkbox-wrapper-13">
                <input id={"c-" + index} type="checkbox" checked={todo.done} onClick={() => updateValue(index, !todo.done, "done")}/>
            </div>
            <div
                className={(marked) ? "todo-text mark" : "todo-text"}
                contentEditable={!todo.done}
                suppressContentEditableWarning
                onInput={(e) => {
                    if (!e.shiftKey && e.key === "Enter") e.preventDefault();
                }}
                onKeyUp={(e) => {
                    if (!e.shiftKey && e.key === "Enter") {
                        e.preventDefault();
                        updateValue(index, cleanContent(e.target.innerHTML), "content");
                        e.target.blur();
                    }
                }}
                onBlur={(e) => {
                    updateValue(index, cleanContent(e.target.innerHTML), "content");
                }}
                dangerouslySetInnerHTML={{ __html: cleanContent(todo.content) }}
            />
            {/* On every row, not only the done ones, and always visible: the
                dashboard runs on a wall panel that has no hover. */}
            <button
                type="button"
                className="todo-del"
                aria-label="Punkt entfernen"
                title="Entfernen"
                onClick={() => { setMark(false); removeItem(index) }}
                onMouseEnter={() => setMark(true)}
                onMouseLeave={() => setMark(false)}
            >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                     stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                     strokeLinejoin="round" aria-hidden>
                    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>
                </svg>
            </button>
        </div>
    )
}
