import type {AgentModelOptions} from './NativeAgents';
import './agent-composer-options.css';

export interface AgentComposerOptionsProps {
  provider: string;
  options?: AgentModelOptions;
  error?: string;
  model?: string;
  effort?: string;
  effectiveModel?: string;
  effectiveEffort?: string;
  disabled: boolean;
  onSelect: (model: string | undefined, effort: string | undefined) => void;
  onRetry: () => void;
}

const effortNames: Readonly<Record<string, string>> = {
  off: '关闭', none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高',
};
const effortName = (effort: string) => Object.hasOwn(effortNames, effort) ? effortNames[effort] : effort;

export function AgentComposerOptions({provider, options, error, model, effort, effectiveModel, effectiveEffort, disabled, onSelect, onRetry}: AgentComposerOptionsProps) {
  const configuredModel = options?.model ?? undefined;
  const selectedModel = model ?? effectiveModel ?? configuredModel;
  const selectedEffort = effort ??
    (selectedModel === effectiveModel ? effectiveEffort : undefined) ??
    (selectedModel === configuredModel ? options?.effort : undefined);
  if (!options) return <div className="agent-composer-options">
    {selectedModel && <span>模型 {selectedModel}</span>}
    {selectedEffort && <span>推理强度 {effortName(selectedEffort)}</span>}
    <span role="status" title={error}>{error ? '未获取可选项' : '正在读取模型选项…'}</span>
    {error && <button type="button" disabled={disabled} onClick={onRetry}>重试</button>}
  </div>;

  const {models} = options;
  const current = models.find(option => option.model === selectedModel);
  const efforts = current?.supportedReasoningEfforts ?? [];
  const listedEffort = efforts.some(option => option.reasoningEffort === selectedEffort);

  function selectModel(value: string) {
    const nextModel = models.find(option => option.model === value);
    const supports = (candidate?: string | null) =>
      nextModel?.supportedReasoningEfforts.some(option => option.reasoningEffort === candidate);
    const nextEffort = supports(effort) ? effort :
      supports(nextModel?.defaultReasoningEffort) ? nextModel?.defaultReasoningEffort ?? undefined : undefined;
    onSelect(value, nextEffort);
  }

  return <div className="agent-composer-options">
    <label>
      <span>模型</span>
      <select aria-label="模型" title={selectedModel ?? undefined} value={selectedModel || ''} disabled={disabled || !models.length}
        onChange={event => selectModel(event.target.value)}>
        {!selectedModel && <option value="" disabled>使用 {provider} 默认</option>}
        {selectedModel && !current && <option value={selectedModel} disabled>{selectedModel}</option>}
        {models.map(option => <option key={option.id} value={option.model}>{option.displayName || option.model}</option>)}
      </select>
    </label>
    <label>
      <span>推理强度</span>
      <select aria-label="推理强度" title={selectedEffort ?? undefined} value={selectedEffort || ''} disabled={disabled || !efforts.length}
        onChange={event => onSelect(selectedModel, event.target.value)}>
        {!selectedEffort && <option value="" disabled>使用 {provider} 默认</option>}
        {selectedEffort && !listedEffort && <option value={selectedEffort} disabled>{effortName(selectedEffort)}</option>}
        {efforts.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort} title={option.description}>{effortName(option.reasoningEffort)}</option>)}
      </select>
    </label>
  </div>;
}
