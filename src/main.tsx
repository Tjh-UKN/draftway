import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
// Configure assets before the lazy Excalidraw module registers any font faces.
window.EXCALIDRAW_ASSET_PATH=new URL('excalidraw/',document.baseURI).href;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
