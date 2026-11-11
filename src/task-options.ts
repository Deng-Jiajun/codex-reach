import type { ModelChoice, TurnOptions } from './types';

export function updateThinking(
  modelSelect: HTMLSelectElement, thinkingSelect: HTMLSelectElement,
  models: ModelChoice[], requested?: string,
): void {
  thinkingSelect.replaceChildren();
  thinkingSelect.setCustomValidity('');
  const model = models.find(item => item.model === modelSelect.value);
  thinkingSelect.disabled = !model;
  if (!model) {
    thinkingSelect.add(new Option('沿用设置', ''));
    return;
  }
  for (const effort of model.supportedReasoningEfforts) {
    thinkingSelect.add(new Option(effort.reasoningEffort, effort.reasoningEffort));
  }
  const selected = requested ?? model.defaultReasoningEffort;
  if (!model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === selected)) {
    const unavailable = new Option(`${selected}（不可用）`, selected);
    unavailable.disabled = true;
    thinkingSelect.add(unavailable);
    thinkingSelect.setCustomValidity('该模型不支持此思考深度，请重新选择');
  }
  thinkingSelect.value = selected;
}

export function populateParameters(
  modelSelect: HTMLSelectElement, thinkingSelect: HTMLSelectElement,
  models: ModelChoice[], options: TurnOptions, inheritLabel: string,
): void {
  modelSelect.replaceChildren(new Option(inheritLabel, ''));
  modelSelect.setCustomValidity('');
  for (const model of models) modelSelect.add(new Option(model.displayName, model.model));
  if (options.model && !models.some(model => model.model === options.model)) {
    const unavailable = new Option(`${options.model}（不可用）`, options.model);
    unavailable.disabled = true;
    modelSelect.add(unavailable);
    modelSelect.setCustomValidity('所选模型当前不可用，请重新选择');
  }
  modelSelect.value = options.model ?? '';
  updateThinking(modelSelect, thinkingSelect, models, options.thinking);
}

export function selectedParameters(model: HTMLSelectElement, thinking: HTMLSelectElement): TurnOptions {
  return model.value ? { model: model.value, thinking: thinking.value } : {};
}
