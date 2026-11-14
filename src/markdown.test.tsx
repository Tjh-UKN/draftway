import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import MarkdownView from './MarkdownView';
import {insertMarkdown,markdownUrl} from './markdown';
describe('Markdown notes',()=>{
 it('renders headings, emphasis, code, quotations and GFM tables/tasks',()=>{const html=renderToStaticMarkup(<MarkdownView value={'# 记录\n\n**重点**与*强调*\n\n> 一段引用\n\n- [x] 已完成\n- [ ] 待办\n\n```ts\nconst done = true;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 首页 | 完成 |'}/>);expect(html).toContain('<h1>记录</h1>');expect(html).toContain('<strong>重点</strong>');expect(html).toContain('<em>强调</em>');expect(html).toContain('<blockquote>');expect(html).toContain('type="checkbox"');expect(html).toContain('language-ts');expect(html).toContain('<table>');});
 it('preserves visible line breaks in legacy plain-text notes',()=>{const html=renderToStaticMarkup(<MarkdownView value={'旧笔记第一行\n旧笔记第二行'}/>);expect(html).toContain('旧笔记第一行<br/>');expect(html).toContain('旧笔记第二行');});
 it('does not create executable HTML or unsafe image/link targets',()=>{const html=renderToStaticMarkup(<MarkdownView value={'<script>alert(1)</script>\n\n[执行](javascript:alert(1))\n\n![图片](data:text/html;base64,abcd)'}/>);expect(html).not.toContain('<script');expect(html).not.toContain('href="javascript:');expect(html).not.toContain('src="data:text/html');expect(markdownUrl('file:///C:/test.txt')).toBe('');expect(markdownUrl('https://user:password@example.com')).toBe('');});
 it('keeps web/mail/anchor links and only approved image schemes',()=>{expect(markdownUrl('https://example.com/docs')).toBe('https://example.com/docs');expect(markdownUrl('mailto:reader@example.com')).toBe('mailto:reader@example.com');expect(markdownUrl('#section')).toBe('#section');expect(markdownUrl('https://example.com/photo.png',true)).toBe('https://example.com/photo.png');expect(markdownUrl('http://example.com/photo.png',true)).toBe('');});
 it('wraps selected text without destroying the surrounding draft',()=>{const result=insertMarkdown('前文 重点 后文',3,5,'bold');expect(result.value).toBe('前文 **重点** 后文');expect(result.value.slice(result.start,result.end)).toBe('重点');const code=insertMarkdown('已有内容',4,4,'code');expect(code.value).toContain('已有内容\n```text\n代码内容\n```');});
});

it('does not load remote tracking images in AI content',()=>{const html=renderToStaticMarkup(<MarkdownView value="![image](https://example.com/tracker.png)" allowRemoteImages={false}/>);expect(html).not.toContain('<img');});
