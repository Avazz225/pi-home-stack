import React, { useState } from "react";
import { loadTodos, saveTodos, apiFetchTodos, apiSaveTodos } from "../../helpers";
import { currentUserId } from "../../common/user";
import "./todo.css"

export default class ToDoList extends React.Component{
    constructor(){
        super();
        this.state = {
            data: [],
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

    appendItem(){
        let newItem = {"done": false, "content": "neuer Punkt"}
        let temp = [...this.state.data, newItem]
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
                <div className="todo-list">
                    <p className="todo-nouser">
                        Kein Benutzer gewählt — oben rechts einen auswählen oder anlegen.
                        Die Liste gehört dann ihm.
                    </p>
                </div>
            )
        }
        return(
            <div className="todo-list">
                <Items
                    todos={this.state.data}
                    updateValue={this.updateValue}
                    removeItem={this.removeItem}
                />
                <div className="append-item-btn">
                    <span className="plus-sign" onClick={() => this.appendItem()}>+</span>
                </div>
            </div>
        )
    }
}

function cleanContent(html) {
    html = html.replace(/^(<(?!br\s*\/?>)[^>]*>|\s|<br\s*\/?>)+/g, "");
    html = html.replace(/(<(?!br\s*\/?>)[^>]*>|\s|<br\s*\/?>)+$/g, "");
    return html;
}

function Items({todos, updateValue, removeItem}){
    return todos.map((todo, index) =>
        <Item key={index} todo={todo} index={index} updateValue={updateValue} removeItem={removeItem}/>
    )
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
            {(todo.done) && (
                <span
                    className="x-sign"
                    onClick={() => { setMark(false); removeItem(index) }}
                    onMouseEnter={() => setMark(true)}
                    onMouseLeave={() => setMark(false)}
                >x</span>
            )}
        </div>
    )
}
