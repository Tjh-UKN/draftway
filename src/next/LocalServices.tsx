import {useEffect, useState} from 'react';
import {Channel, invoke} from '@tauri-apps/api/core';
import {ChevronRight, Globe} from 'lucide-react';
import {Dialog} from './ui';

export interface LocalService {
  title: string;
  url: string;
}

export function LocalServices({onOpen, onClose}: {
  onOpen: (service: LocalService) => void;
  onClose: () => void;
}) {
  const [services, setServices] = useState<LocalService[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const onService = new Channel<LocalService>();
      onService.onmessage = service => {
        if (!active) return;
        setServices(current => {
          const list = current ?? [];
          const known = list.find(item => item.url === service.url);
          if (!known) return [...list, service];
          return known.title === service.title ? list : list.map(item => item.url === service.url ? service : item);
        });
      };
      try {
        const found = await invoke<LocalService[]>('local_web_services', {onService});
        if (active) {
          setServices(current => {
            const latest = new Map(found.map(service => [service.url, service]));
            const ordered = (current || []).flatMap(service => {
              const updated = latest.get(service.url);
              latest.delete(service.url);
              return updated ? [updated] : [];
            });
            return [...ordered, ...latest.values()];
          });
          setError('');
        }
      } catch (error) {
        if (active) setError(String(error));
      } finally {
        if (active) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  return <Dialog title="本地服务" onClose={onClose}>
    {error ? <p className="tool-error" role="alert">{error}</p> : services?.length
      ? <div className="view-library">{services.map(service => <button key={service.url} type="button" onClick={() => onOpen(service)}>
          <Globe size={16}/><span><strong>{service.title}</strong><small>{service.url}</small></span><ChevronRight size={15}/>
        </button>)}</div>
      : <p className="quiet-note" role="status">{services ? '暂未发现运行中的本地网页服务。' : '正在检测本地网页服务…'}</p>}
  </Dialog>;
}
