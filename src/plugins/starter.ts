import manifest from '../../examples/plugins/note-tools/northstar-plugin.json';
import main from '../../examples/plugins/note-tools/main.js?raw';
import panel from '../../examples/plugins/note-tools/panel.html?raw';
import {parsePlugin} from './manifest';
export const noteToolsPlugin=()=>parsePlugin({manifest,files:{'main.js':main,'panel.html':panel},enabled:false});
