import json
from pathlib import Path
root=Path(__file__).resolve().parent.parent
lock=json.loads((root/'package-lock.json').read_text(encoding='utf-8'))
parts=['Northstar: open-source JavaScript notices\n']
for name,entry in sorted(lock.get('packages',{}).items()):
    if not name.startswith('node_modules/') or entry.get('dev'):continue
    folder=root/name
    manifest=folder/'package.json'
    if not manifest.is_file():continue
    package=json.loads(manifest.read_text(encoding='utf-8'))
    header=f"{package.get('name',name)} {package.get('version','')}\nLicense: {package.get('license','See upstream package')}\n"
    licenses=[p for p in folder.iterdir() if p.is_file() and (p.name.lower().startswith('license') or p.name.lower().startswith('licence'))]
    parts.append(header+'\n'.join(p.read_text(encoding='utf-8',errors='replace') for p in licenses))
(root/'public'/'third-party-notices.txt').write_text('\n\n'+'\n\n' .join(parts),encoding='utf-8')
print(f'Included notices for {len(parts)-1} production JavaScript packages.')
