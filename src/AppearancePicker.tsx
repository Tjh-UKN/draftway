import {useId} from 'react';
import {appearanceChoices, type AppearanceChoice} from './appearance';

const labels: Record<AppearanceChoice, string> = {
  light: '浅色',
  warm: '暖白',
  dark: '深色',
  system: '跟随系统',
};

export function AppearancePicker({value, onChange}: {
  value: AppearanceChoice;
  onChange: (choice: AppearanceChoice) => void;
}) {
  const group = useId();
  return <fieldset className="appearance-picker">
    <legend>外观主题</legend>
    <div className="appearance-options">
      {appearanceChoices.map(choice => <label className="appearance-option" key={choice}>
        <input type="radio" name={group} value={choice} checked={choice === value} onChange={() => onChange(choice)}/>
        <span className="appearance-option-body">
          <span className="appearance-preview" data-preview={choice} aria-hidden="true"><i/><b/></span>
          <span>{labels[choice]}</span>
        </span>
      </label>)}
    </div>
  </fieldset>;
}
