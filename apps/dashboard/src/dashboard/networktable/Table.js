import React from "react";
import "./table.css"


const MaxPresets = [40, 120, 240, "Alle"]
export default class Table extends React.Component{
    constructor(){
        super();
        this.state = {
            data: [],
            limit: 40,
            disconnected:false,
            sortColumn: null,
            sortOrder: 'asc'
        }

        this.sortData = this.sortData.bind(this)
        this.updateMax = this.updateMax.bind(this)
        this.fetchData = this.fetchData.bind(this)
    }

    componentDidMount(){
        this.fetchData()
    }

    fetchData(){
        fetch(process.env.REACT_APP_NW_API_ENDPOINT+'/speed-test-results'+(this.state.limit!== "Alle"?("?limit="+this.state.limit):""))
        .then(response => {
            if (!response.ok) {
                throw new Error("Network response was not ok");
            }
            return response.json();
        })
        .then(data => {
            this.setState({
                data: data,
            })
        })
        .catch(error => {
            this.setState({disconnected: true})
        });
    }

    updateMax(num){
        this.setState({
            limit: num
        }, () => {
            this.fetchData()
        })
    }

    sortData(columnIndex) {
        const { data, sortColumn, sortOrder } = this.state;

        let newSortOrder = 'asc';
        if (sortColumn === columnIndex && sortOrder === 'asc') {
            newSortOrder = 'desc'; // Wenn bereits aufsteigend, dann absteigend
        }

        const sortedData = [...data].sort((a, b) => {
            const aValue = a[columnIndex];
            const bValue = b[columnIndex];

            if (aValue < bValue) return newSortOrder === 'asc' ? -1 : 1;
            if (aValue > bValue) return newSortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        this.setState({
            data: sortedData,
            sortColumn: columnIndex,
            sortOrder: newSortOrder
        });
    }

    render(){
        return(
            <div>
                <SelectMaxEntries currentVal={this.state.limit} updateMax={this.updateMax} />
                <div className="tableWrapper">
                    <table className="networkTable">
                        <TableHead 
                            onSort={this.sortData.bind(this)} 
                            sortColumn={this.state.sortColumn} 
                            sortOrder={this.state.sortOrder}
                        />
                        <TableData entries={this.state.data}/>
                    </table>
                </div>
            </div>
        )
    }
}

function SelectMaxEntries({updateMax, currentVal}){
    return(
        <div className="btnWrapper">
            Maximale Einträge: &nbsp;
            {MaxPresets.map((num) => <>{<button className={(currentVal === num)?"multiSelectBtn active":"multiSelectBtn"} onClick={() => updateMax(num)}>{num}</button>}</>)}
        </div>
    )
}

function TableData({entries}){
    return(
        <tbody>
            {entries.map((entry, index) => 
            <tr className={(entry[5] === 1)?"good":"bad"}>
                <td>{formatDate(entry[0])}</td>
                <td>{entry[3]} MBit/s ({entry[4]} %)</td>
                <td>{entry[1]} MBit/s ({entry[2]} %)</td>
            </tr>
            )}
        </tbody>
    )
}

function TableHead({ onSort, sortColumn, sortOrder }) {
    return (
        <thead>
            <tr>
                <th onClick={() => onSort(0)}>
                    Datum / Uhrzeit {sortColumn === 0 ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th onClick={() => onSort(3)}>
                    Download {sortColumn === 3 ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                </th>
                <th onClick={() => onSort(1)}>
                    Upload {sortColumn === 1 ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                </th>
            </tr>
        </thead>
    );
}

function formatDate(dateString) {
    const date = new Date(dateString);

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${day}.${month}.${year} um ${hours}:${minutes}`;
}