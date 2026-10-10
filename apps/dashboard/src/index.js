import React from 'react';
import ReactDOM from 'react-dom/client';
import './theme.css';
import './index.css';
import Controller from './Controller';
import { useFullScreenHandle } from "react-full-screen";
import { useTheme } from './theme';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App/>
  </React.StrictMode>
);

function App(){
  const handle = useFullScreenHandle();
  const theme = useTheme();
  return(
    <Controller handle={handle} theme={theme}/>
  )
}

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
