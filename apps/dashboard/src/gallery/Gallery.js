import React from "react";
import "./gallery.css"
import { calcDelay } from "../helpers";
import { fetchGallery, imageSrc } from "./api";

class Gallery extends React.Component{
    constructor(props){
        super(props);
        this.state = {
            mouseX: 0,
            srcSet: [],
            srcIndex: 0,
            showElement: true,
        }
        this.setMousePos = this.setMousePos.bind(this)
        this.handleDrag = this.handleDrag.bind(this)
        this.changeImage = this.changeImage.bind(this)
        this.handleAutoSwitch = this.handleAutoSwitch.bind(this)
        this.checkTime = this.checkTime.bind(this)
        this.convertTimeToMinutes = this.convertTimeToMinutes.bind(this)
    }

    componentDidMount(){
        if (this.props.settings.galleryPauseAtNight){
            this.checkTime();
            this.timer = setInterval(this.checkTime, 60000);
        }
        if (this.props.settings.autoSwitch){
            this.handleAutoSwitch();
        }
        /* The pictures come from the profile service, which keeps uploads and
           links in one list. The static file is only a fallback for a service
           that cannot be reached - an empty list from a service that answered
           means the gallery is empty, which is a different thing and must not
           be papered over with whatever happens to be shipped. */
        fetchGallery()
            .then(data => this.setState({ srcSet: (data.entries || []).map(imageSrc) }))
            .catch(() => {
                fetch('/assets/images.json')
                    .then(response => response.json())
                    .then(data => this.setState({ srcSet: data.images || [] }))
                    .catch(() => this.setState({ srcSet: [] }));
            });
    }

    componentWillUnmount() {
        clearInterval(this.intervalId);
        clearInterval(this.timer);
    }

    checkTime() {
        const { galleryDisplayTimeStart, galleryDisplayTimeEnd } = this.props.settings;

        const now = new Date();
        const currentTime = (now.getHours() * 60) + now.getMinutes();

        const startTime = this.convertTimeToMinutes(galleryDisplayTimeStart)
        const endTime = this.convertTimeToMinutes(galleryDisplayTimeEnd)

        if (startTime <= currentTime && currentTime <= endTime) {
            if (!this.state.showElement) {
                this.setState({ showElement: true });
            }
        } else {
            if (this.state.showElement) {
                this.setState({ showElement: false });
            }
        }
    }

    convertTimeToMinutes(timeStr) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return (hours * 60) + minutes;
    }

    handleAutoSwitch(){
        let delay = calcDelay(this.props.settings.autoSwitchTime, this.props.settings.autoSwitchUnit)
        this.intervalId = setInterval(() => {
            this.changeImage();
        }, delay);
    }

    setMousePos(x){
        this.setState({
            mouseX: x,
        })
    }

    changeImage(next=true){
        if (next){
            this.setState({ 
                srcIndex: (this.state.srcIndex+1 === this.state.srcSet.length)?0:this.state.srcIndex+1
            })
        } else {
            this.setState({ 
                srcIndex: (this.state.srcIndex === 0)?this.state.srcSet.length-1:this.state.srcIndex-1
            })
        }
    }

    handleDrag(x){
        if(x>= this.state.mouseX){
            this.changeImage(false)
        } else {
            this.changeImage()
        }
    }

    render(){
        return(
            <div className="galleryWrapper" onClick={(e) => this.props.toggleDashboard()} onDragStart={(e) => this.setMousePos(e.clientX)} onTouchStart={(e) => this.setMousePos(e.clientX)} onDragEnd={(e) => this.handleDrag(e.clientX)} onTouchEnd={(e) => this.handleDrag(e.clientX)} draggable={true}>
                {(this.state.showElement)&&<img src={this.state.srcSet[this.state.srcIndex]} alt="Galeriebild" />}
            </div>
        )
    }
}

export default Gallery