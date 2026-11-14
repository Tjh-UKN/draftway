import {describe,it,expect} from 'vitest';
import {installEmbeddedBridge} from './embedded-bridge';
describe('trusted business frame bridge',()=>{
  it('shares the existing bridge only with a declared same-origin business page',()=>{
    const host={location:{origin:'http://tauri.localhost',pathname:'/next.html'},__TAURI_INTERNALS__:{invoke:()=>{}}};const child={parent:host,location:{origin:'http://tauri.localhost',search:'?embed=tasks'}};
    installEmbeddedBridge(child as unknown as Window);expect((child as unknown as Record<string,unknown>).__TAURI_INTERNALS__).toBe(host.__TAURI_INTERNALS__);
    for(const frame of [{parent:host,location:{origin:'https://remote.example',search:'?embed=tasks'}},{parent:host,location:{origin:'http://tauri.localhost',search:'?embed=untrusted'}}]){installEmbeddedBridge(frame as unknown as Window);expect(frame).not.toHaveProperty('__TAURI_INTERNALS__');}
  });
});
