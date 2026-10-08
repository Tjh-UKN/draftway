import hashlib,json,sqlite3,os
from pathlib import Path
root=Path(__file__).resolve().parent.parent
database=Path(os.environ['APPDATA'])/'com.northstar.workbench'/'northstar.sqlite3'
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
result={'database':str(database),'records':[],'attachments':[]}
if database.exists():
    with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True) as db:
        result['schema']=db.execute('PRAGMA user_version').fetchone()[0]
        for (raw,) in db.execute('SELECT data FROM entities ORDER BY id'):
            value=json.loads(raw);result['records'].append({'id':value['id'],'keys':sorted(value.keys()),'digest':digest(value)})
        for (raw,) in db.execute('SELECT data FROM attachments ORDER BY id'):
            value=json.loads(raw);result['attachments'].append({'id':value['id'],'keys':sorted(value.keys()),'digest':digest(value)})
        raw=db.execute('SELECT data FROM settings WHERE id=1').fetchone()
        if raw:result['settingsDigest']=digest(json.loads(raw[0]))
(root/'artifacts'/'pre-upgrade-metadata.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'schema':result.get('schema'),'records':len(result['records']),'attachments':len(result['attachments'])}))
