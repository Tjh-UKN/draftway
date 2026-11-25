import {useId, useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronDown, Grid2X2, Image, Mountain, Stars} from 'lucide-react';
import {mapBackgroundNames, type MapBackground} from './graph-state';
import {ManagementMenu} from './ManagementMenu';

const icons = {grid: Grid2X2, stars: Stars, 'mountain-sea': Mountain};

export function MapBackgroundPicker({value, onChange}: {value: MapBackground; onChange: (value: MapBackground) => void}) {
  const id = useId();
  const [menu, setMenu] = useState<{trigger: HTMLButtonElement; x: number; y: number; keyboard: boolean} | null>(null);
  return <>
    <button type="button" className="text-button map-background-button" id={id} aria-label="地图背景"
      title={'地图背景 · ' + mapBackgroundNames[value]} aria-haspopup="menu" aria-expanded={!!menu}
      onClick={event => {
        const trigger = event.currentTarget;
        const bounds = trigger.getBoundingClientRect();
        setMenu(menu ? null : {trigger, x: bounds.left, y: bounds.bottom + 5, keyboard: event.detail === 0});
      }}><Image size={15}/><span>背景</span><ChevronDown size={12}/></button>
    {menu && createPortal(<ManagementMenu {...menu} onClose={() => setMenu(null)}
      actions={(Object.keys(mapBackgroundNames) as MapBackground[]).map(choice => ({
        label: mapBackgroundNames[choice], icon: icons[choice], checked: choice === value, run: () => onChange(choice),
      }))}/>, document.body)}
  </>;
}
