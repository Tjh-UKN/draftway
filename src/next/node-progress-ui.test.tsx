import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {NodeOverview,TasksView} from './Graph';
import {initialWorkbench} from './core';

describe('node information without task progress UI',()=>{
  const space=initialWorkbench().spaces[0];
  space.nodes=space.nodes.map((node,i)=>({...node,title:`节点${i}`,body:`正文${i}`,task:true,progress:100}));
  it('shows child links and dates without a percentage, progress control or completion checkbox',()=>{
    const node=space.nodes.find(n=>n.id==='act')!;
    const html=renderToStaticMarkup(<NodeOverview space={space} node={node} onDue={()=>{}} onOpen={()=>{}} onAdd={()=>{}}/>);
    expect(html).toContain('添加子任务');expect(html).toContain('计划完成日期');
    expect(html).not.toContain('进度');expect(html).not.toContain('%');expect(html).not.toContain('checkbox');expect(html).not.toContain('range');
    expect(node.progress).toBe(100);
  });
  it('does not expose task percentages in the workspace event list',()=>{
    const html=renderToStaticMarkup(<TasksView space={space} onOpen={()=>{}}/>);
    expect(html).toContain('正文');expect(html).not.toContain('%');expect(html).not.toContain('进度');expect(html).not.toContain('checkbox');
  });
});
