import type {ComponentType, ReactNode} from 'react';
import type {LucideIcon} from 'lucide-react';
import type {Page} from '../workbench';
import type {WidgetInstance} from '../workspace-layout';

export interface WidgetSettingsProps {
  config: WidgetInstance['config'];
  onChange: (config: WidgetInstance['config']) => void;
}

export interface WidgetDefinition {
  type: string;
  version: number;
  title: string;
  description: string;
  icon: LucideIcon;
  page?: Page;
  defaultSize: {columns: number; height: number};
  minSize: {columns: number; height: number};
  defaultConfig: WidgetInstance['config'];
  render: (config: WidgetInstance['config']) => ReactNode;
  fullView?: (config: WidgetInstance['config']) => ReactNode;
  Settings?: ComponentType<WidgetSettingsProps>;
}
