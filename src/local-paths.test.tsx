import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import MarkdownView from './MarkdownView';
import Markdown from 'react-markdown';
import {localPath,localPathUrl,remarkLocalPaths} from './local-paths';
const path=String.raw`C:\Users\admin\My Reports\PR 检视报告.html`;
const render=(value:string,enabled=true)=>renderToStaticMarkup(<MarkdownView value={value} onOpenLocalPath={enabled?()=>{}:undefined} codeActions/>);
describe('local paths in agent replies',()=>{
  it('recognizes drive paths, encoded file URLs and WSL drive mounts without changing spaces or Chinese',()=>{
    expect(localPath(path)).toBe(path);expect(localPath(localPathUrl(path))).toBe(path);
    expect(localPath('file:///C:/Users/admin/My%20Reports/PR%20%E6%A3%80%E8%A7%86%E6%8A%A5%E5%91%8A.html')).toBe(path);
    expect(localPath('/mnt/c/reports/report.html')).toBe(String.raw`C:\reports\report.html`);
    for(const value of ['https://example.com/C:/a','javascript:alert(1)','C:relative','report.html','C:\\file.html:stream','file:///C:/a%00.html',localPathUrl(localPathUrl(path))])expect(localPath(value)).toBeNull();
  });
  it('recognizes absolute POSIX paths under user and temporary roots on macOS and Linux only',()=>{
    const mac='/Users/admin/My Reports/report.html';
    expect(localPath(mac,'posix')).toBe(mac);expect(localPath(localPathUrl(mac),'posix')).toBe(mac);
    expect(localPath('file:///Users/admin/My%20Reports/report.html','posix')).toBe(mac);
    expect(localPath('/tmp/out/report.html','posix')).toBe('/tmp/out/report.html');
    for(const value of ['/api/users','/Users/admin/../../etc/passwd','and/or','/users/admin/a.html'])expect(localPath(value,'posix')).toBeNull();
    expect(localPath(mac,'windows')).toBeNull();
    expect(localPath(path,'posix')).toBe(path);
  });
  it('links POSIX paths in replies without linking URL paths',()=>{
    const posix=(value:string)=>renderToStaticMarkup(<Markdown remarkPlugins={[[remarkLocalPaths,'posix']]} urlTransform={url=>url}>{value}</Markdown>);
    expect(posix('文件：/Users/admin/report.html。')).toContain('href="northstar-local:%2FUsers%2Fadmin%2Freport.html"');
    expect(posix('see https://example.com/Users/admin')).not.toContain('northstar-local:');
  });
  it('opens inline code, fenced paths, plain paths and Markdown file links through one local action',()=>{
    const sources=['`'+path+'`','```text\n'+path+'\n```',path,'[检视报告](file:///C:/reports/report.html)','文件：C:\\reports\\report.html。'];
    for(const value of sources){const html=render(value);expect(html).toContain('class="local-file-link"');expect(html).toContain('type="button"');expect(html).not.toContain('href="file:');expect(html).not.toContain('href="northstar-local:');}
    expect(render('```text\n'+path+'\n```')).toContain('复制代码');
    expect(render('C:\\reports\\report.html。')).toContain('>C:\\reports\\report.html</button>。');
    expect(render('文件：C:\\reports\\report.html，点击打开')).toContain('>C:\\reports\\report.html</button>，点击打开');
  });
  it('does not turn code examples into links or put buttons inside file-link buttons',()=>{
    expect(render('```js\nconst path = "C:\\\\reports\\\\a.html";\n```')).not.toContain('class="local-file-link"');
    const html=render('[`'+path+'`](file:///C:/reports/report.html)');
    expect(html.match(/class="local-file-link"/g)).toHaveLength(1);
  });
  it('keeps ordinary Markdown safety and leaves local paths inert outside the conversation',()=>{
    expect(render('`'+path+'`',false)).not.toContain('class="local-file-link"');
    expect(render('[不执行](javascript:alert)')).not.toContain('href="javascript:');
    expect(render('[网站](https://example.com)')).toContain('href="https://example.com/"');
    expect(render('![本地](file:///C:/private.png)')).not.toContain('<img');
  });
});
