import {useEffect,useState} from 'react';
import {dateKey} from './domain';
export function useToday(){const [today,setToday]=useState(dateKey());useEffect(()=>{const update=()=>setToday(dateKey());const timer=setInterval(update,30000);window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);return()=>{clearInterval(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};},[]);return today;}
