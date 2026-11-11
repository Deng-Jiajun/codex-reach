export type PendingRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  completed?: boolean;
  changes?: unknown;
  item?: Record<string, unknown>;
  desktopRequired?: boolean | string;
};

export type RequestResponse = Record<string, unknown>;
export type RequestRenderOptions = {
  disabled: boolean;
  canResolve?: boolean;
  pending?: Record<string, { status: string; error?: string }>;
  onSubmit: (request: PendingRequest, response: RequestResponse) => void | Promise<void>;
  onResolve?: (request: PendingRequest) => void;
};

export type AsyncQuestion = { id: string; title: string; options?: string[] | null; answer?: string; draft?: string };
export type AsyncReply = { questionItemId: string; question: string; answer: string };

type Card = {
  request: PendingRequest;
  signature: string;
  root: HTMLElement;
  form: HTMLFormElement;
  fields: HTMLFieldSetElement;
  status: HTMLElement;
  resolve: HTMLButtonElement;
  options: RequestRenderOptions;
  busy: boolean;
  error: string;
  update?: () => void;
};
type RecordValue = Record<string, unknown>;
type FieldReader = { validate: () => boolean; read: () => unknown; omitted: () => boolean };
const cardsByContainer = new WeakMap<HTMLElement, Map<string, Card>>();
let nextFieldId = 0;

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function onlyKeys(value: RecordValue, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function detail(parent: HTMLElement, label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  const block = element('div', '', 'request-detail');
  block.append(element('strong', label), element('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  parent.append(block);
}

function desktopOnly(card: Card, reason: string): void {
  card.fields.replaceChildren(element('p', reason + ' 请在电脑端处理。', 'request-desktop'));
  const labels: Record<string, string> = { serverName: '服务', title: '事项', description: '说明', message: '请求内容', reason: '原因', command: '命令', cwd: '工作目录' };
  for (const [key, label] of Object.entries(labels)) {
    const value = card.request.params[key];
    if (typeof value === 'string') detail(card.fields, label, value);
  }
}

function updateCard(card: Card): void {
  const pending = card.options.pending?.[JSON.stringify(card.request.id)];
  card.fields.disabled = card.options.disabled || card.busy || Boolean(pending);
  card.status.textContent = pending?.error || card.error || (pending?.status === 'unknown'
    ? '处理结果待确认，请先核对电脑端状态。'
    : pending?.status === 'accepted' ? '已提交，等待桌面更新。' : pending || card.busy ? '正在提交…' : '');
  card.status.hidden = !card.status.textContent;
  card.resolve.hidden = pending?.status !== 'unknown' || !card.options.onResolve;
  card.resolve.disabled = !(card.options.canResolve ?? !card.options.disabled) || card.busy;
  card.update?.();
}

async function submit(card: Card, response: RequestResponse): Promise<void> {
  if (card.fields.disabled || card.busy) return;
  card.busy = true;
  card.error = '';
  updateCard(card);
  try { await card.options.onSubmit(card.request, response); }
  catch (error) { card.error = error instanceof Error ? error.message : String(error); }
  finally { card.busy = false; updateCard(card); }
}

function action(card: Card, text: string, response: RequestResponse, primary = false): HTMLButtonElement {
  const button = element('button', text, primary ? 'primary request-action' : 'quiet request-action');
  button.type = 'button';
  button.addEventListener('click', () => void submit(card, response));
  card.fields.append(button);
  return button;
}

function permissionSummary(value: unknown): string[] | null {
  if (!record(value) || !onlyKeys(value, ['network', 'fileSystem'])) return null;
  const lines: string[] = [];
  if (value.network !== undefined && value.network !== null) {
    if (!record(value.network) || !onlyKeys(value.network, ['enabled'])) return null;
    if (![true, false, null].includes(value.network.enabled as boolean | null)) return null;
    lines.push(`网络访问 ${value.network.enabled === true ? '启用' : value.network.enabled === false ? '禁用' : '沿用现有设置'}`);
  }
  if (value.fileSystem !== undefined && value.fileSystem !== null) {
    const fs = value.fileSystem;
    if (!record(fs) || !onlyKeys(fs, ['read', 'write', 'entries', 'globScanMaxDepth'])) return null;
    for (const name of ['read', 'write']) {
      if (fs[name] === undefined || fs[name] === null) continue;
      if (!strings(fs[name])) return null;
      for (const path of fs[name]) lines.push(`${name === 'read' ? '读取' : '写入'} ${path}`);
    }
    if (fs.globScanMaxDepth !== undefined) {
      if (typeof fs.globScanMaxDepth !== 'number' || !Number.isInteger(fs.globScanMaxDepth)) return null;
      lines.push(`通配路径扫描深度 ${fs.globScanMaxDepth}`);
    }
    if (fs.entries !== undefined) {
      if (!Array.isArray(fs.entries)) return null;
      for (const entry of fs.entries) {
        if (!record(entry) || !onlyKeys(entry, ['path', 'access']) || !['read', 'write', 'deny'].includes(String(entry.access)) || !record(entry.path)) return null;
        const path = entry.path;
        let description: string;
        if (path.type === 'path' && typeof path.path === 'string' && onlyKeys(path, ['type', 'path'])) description = path.path;
        else if (path.type === 'glob_pattern' && typeof path.pattern === 'string' && onlyKeys(path, ['type', 'pattern'])) description = `通配路径 ${path.pattern}`;
        else if (path.type === 'special' && onlyKeys(path, ['type', 'value']) && record(path.value)) {
          const special = path.value;
          const names: Record<string, string> = { root: '文件系统根目录', minimal: '系统定义的最小运行范围', project_roots: '项目根目录', tmpdir: '系统临时目录', slash_tmp: '/tmp' };
          if (special.kind === 'unknown') {
            if (!onlyKeys(special, ['kind', 'path', 'subpath']) || typeof special.path !== 'string') return null;
            description = `声明路径 ${special.path}`;
          } else {
            if (!Object.hasOwn(names, String(special.kind)) || !onlyKeys(special, special.kind === 'project_roots' ? ['kind', 'subpath'] : ['kind'])) return null;
            description = names[String(special.kind)];
          }
          if (special.subpath !== undefined && special.subpath !== null) {
            if (typeof special.subpath !== 'string') return null;
            description += `，子路径 ${special.subpath}`;
          }
        } else return null;
        const accesses: Record<string, string> = { read: '读取', write: '写入', deny: '禁止访问' };
        lines.push(`${accesses[String(entry.access)]} ${description}`);
      }
    }
  }
  return lines;
}

function decisionLabel(decision: unknown): string | null {
  const labels: Record<string, string> = { accept: '本次允许', acceptForSession: '本会话允许', decline: '拒绝', cancel: '取消操作' };
  if (typeof decision === 'string') return labels[decision] ?? null;
  if (!record(decision)) return null;
  if (onlyKeys(decision, ['acceptWithExecpolicyAmendment']) && record(decision.acceptWithExecpolicyAmendment)
    && onlyKeys(decision.acceptWithExecpolicyAmendment, ['execpolicy_amendment']) && strings(decision.acceptWithExecpolicyAmendment.execpolicy_amendment)) return '允许并保存命令规则';
  if (onlyKeys(decision, ['applyNetworkPolicyAmendment']) && record(decision.applyNetworkPolicyAmendment)
    && onlyKeys(decision.applyNetworkPolicyAmendment, ['network_policy_amendment'])) {
    const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
    if (record(rule) && onlyKeys(rule, ['host', 'action']) && typeof rule.host === 'string' && ['allow', 'deny'].includes(String(rule.action))) {
      return rule.action === 'allow' ? '允许并保存网络规则' : '拒绝并保存网络规则';
    }
  }
  return null;
}

function approval(card: Card, fileChange: boolean): void {
  const params = card.request.params;
  const body = element('div');
  detail(body, '原因', params.reason);
  if (fileChange) {
    const changes = card.request.changes ?? card.request.item?.changes;
    if (!Array.isArray(changes) || !changes.length || changes.some(change => !record(change) || typeof change.path !== 'string' || typeof change.diff !== 'string' || !record(change.kind) || !['add', 'delete', 'update'].includes(String(change.kind.type)))) {
      desktopOnly(card, '文件修改详情不完整，需要核对文件及差异。');
      return;
    }
    detail(body, '申请写入根目录（本会话）', params.grantRoot);
    for (const change of changes as RecordValue[]) {
      const kind = change.kind as RecordValue;
      const operations: Record<string, string> = { add: '新增', delete: '删除', update: '修改' };
      detail(body, `${operations[String(kind.type)]} ${change.path}`, change.diff || '差异为空');
      detail(body, '移动目标', kind.move_path);
    }
  } else {
    if (params.kind !== undefined && !['command', 'humanCommand', 'writeStdin'].includes(String(params.kind))) {
      desktopOnly(card, '当前命令审批类型需要电脑端确认。');
      return;
    }
    if (typeof params.command !== 'string' || !params.command.trim()) {
      desktopOnly(card, '缺少可核对的命令或终端输入。');
      return;
    }
    detail(body, params.kind === 'writeStdin' ? '将发送到终端的输入' : '命令', params.command);
    detail(body, '工作目录', params.cwd);
    detail(body, '执行环境', params.environmentId);
    detail(body, '网络访问申请', params.networkApprovalContext);
    if (params.additionalPermissions !== undefined && params.additionalPermissions !== null) {
      const permissions = permissionSummary(params.additionalPermissions);
      if (!permissions) { desktopOnly(card, '附加权限包含当前页面无法完整展示的类型。'); return; }
      detail(body, '附加权限', permissions.join('\n'));
    }
  }
  const decisions = fileChange ? ['accept', 'acceptForSession', 'decline', 'cancel']
    : params.availableDecisions ?? ['accept', 'decline', 'cancel'];
  if (!Array.isArray(decisions) || !decisions.length || decisions.some(decision => !decisionLabel(decision))) {
    desktopOnly(card, '该审批包含当前页面无法完整表达的选项。');
    return;
  }
  card.fields.append(body);
  for (const decision of decisions) {
    if (record(decision)) detail(card.fields, '将保存的规则', decision);
    action(card, decisionLabel(decision)!, { decision }, decision === 'accept');
  }
}

function permissions(card: Card): void {
  const params = card.request.params;
  const summary = permissionSummary(params.permissions);
  if (!summary) { desktopOnly(card, '请求中包含当前页面无法完整展示的权限。'); return; }
  detail(card.fields, '原因', params.reason);
  detail(card.fields, '工作目录', params.cwd);
  detail(card.fields, '执行环境', params.environmentId);
  detail(card.fields, '申请权限', summary.length ? summary.join('\n') : '没有附加权限项');
  action(card, '仅本轮允许', { permissions: structuredClone(params.permissions), scope: 'turn' }, true);
  action(card, '本会话允许', { permissions: structuredClone(params.permissions), scope: 'session' });
  action(card, '拒绝', { permissions: {}, scope: 'turn' });
}

function questionInput(parent: HTMLElement, question: RecordValue, answer?: string, showTitle = true): (() => string | null) | null {
  if (typeof question.id !== 'string' || typeof question.question !== 'string') return null;
  const choices = question.options;
  if (choices !== null && choices !== undefined && (!Array.isArray(choices) || choices.some(choice => !record(choice) || typeof choice.label !== 'string' || typeof choice.description !== 'string'))) return null;
  const group = element('fieldset', '', 'request-question');
  if (showTitle) group.append(element('legend', question.question));
  else group.setAttribute('aria-label', question.question);
  const name = `request-question-${++nextFieldId}`;
  const optionList = Array.isArray(choices) ? choices as RecordValue[] : [];
  const allowText = !optionList.length || question.isOther === true;
  const radios: HTMLInputElement[] = [];
  for (const [index, choice] of optionList.entries()) {
    const label = element('label', '', 'request-choice');
    const radio = element('input');
    radio.type = 'radio'; radio.name = name; radio.value = String(index); radio.required = true;
    radio.checked = answer === choice.label;
    radios.push(radio);
    label.append(radio, element('span', String(choice.label)), element('small', String(choice.description)));
    group.append(label);
  }
  let input: HTMLInputElement | HTMLTextAreaElement | undefined;
  let custom: HTMLInputElement | undefined;
  if (allowText) {
    if (optionList.length) {
      const label = element('label', '', 'request-choice');
      custom = element('input'); custom.type = 'radio'; custom.name = name; custom.value = 'custom'; custom.required = true;
      custom.checked = answer !== undefined && !radios.some(radio => radio.checked);
      label.append(custom, element('span', '自定义回答'));
      group.append(label);
    }
    input = question.isSecret === true ? element('input') : element('textarea');
    if (input instanceof HTMLInputElement) { input.type = 'password'; input.autocomplete = 'off'; }
    input.setAttribute('aria-label', optionList.length ? '自定义回答' : question.question);
    input.value = answer !== undefined && !radios.some(radio => radio.checked) ? answer : '';
    input.required = true;
    input.disabled = Boolean(custom && !custom.checked);
    group.append(input);
    group.addEventListener('change', () => { if (input) { input.disabled = Boolean(custom && !custom.checked); input.setCustomValidity(''); } });
    input.addEventListener('input', () => input!.setCustomValidity(''));
  }
  parent.append(group);
  return () => {
    if (!custom || custom.checked) {
      if (input) {
        const value = input.value;
        input.setCustomValidity(value.trim() ? '' : '请填写回答');
        return value.trim() ? value : null;
      }
    }
    const checked = radios.find(radio => radio.checked);
    return checked ? String(optionList[Number(checked.value)].label) : null;
  };
}

function questions(card: Card, asyncQuestion = false): void {
  const list = card.request.params.questions;
  if (!Array.isArray(list) || !list.length || list.some(question => !record(question))) {
    desktopOnly(card, '问题格式无法在此页面完整展示。'); return;
  }
  const section = asyncQuestion && typeof card.request.params.answer === 'string' ? element('details') : element('div');
  if (section instanceof HTMLDetailsElement) {
    card.fields.append(element('p', String((list[0] as RecordValue).question), 'request-question-title'));
    card.fields.append(element('p', `已回答 ${card.request.params.answer}`, 'request-answer'));
    section.append(element('summary', '修改回答'));
    section.open = typeof card.request.params.draft === 'string';
  }
  const answers: { id: string; read: () => string | null }[] = [];
  for (const question of list as RecordValue[]) {
    const read = questionInput(section, question, asyncQuestion ? (card.request.params.draft ?? card.request.params.answer) as string | undefined : undefined, !(section instanceof HTMLDetailsElement));
    if (!read || answers.some(answer => answer.id === question.id)) { desktopOnly(card, '问题或选项格式无法完整展示。'); return; }
    answers.push({ id: String(question.id), read });
  }
  const button = element('button', asyncQuestion ? '提交回答' : '提交全部回答', 'primary request-action');
  button.type = 'submit';
  section.append(button);
  card.fields.append(section);
  card.form.addEventListener('submit', event => {
    event.preventDefault();
    const result: Record<string, { answers: string[] }> = Object.create(null);
    let valid = true;
    for (const answer of answers) {
      const value = answer.read();
      if (value === null) valid = false;
      else result[answer.id] = { answers: [value] };
    }
    if (card.form.reportValidity() && valid) void submit(card, { answers: result });
  });
}

function enumChoices(schema: RecordValue): { value: string; label: string }[] | null {
  if (['enum', 'oneOf', 'anyOf'].filter(key => schema[key] !== undefined).length !== 1) return null;
  if (strings(schema.enum) && schema.enum.length) {
    if (schema.enumNames !== undefined && (!strings(schema.enumNames) || schema.enumNames.length !== schema.enum.length)) return null;
    return schema.enum.map((value, index) => ({ value, label: (schema.enumNames as string[] | undefined)?.[index] ?? value }));
  }
  const choices = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(choices) || !choices.length || choices.some(choice => !record(choice) || !onlyKeys(choice, ['const', 'title']) || typeof choice.const !== 'string' || typeof choice.title !== 'string')) return null;
  return choices.map(choice => ({ value: choice.const, label: choice.title }));
}

function formField(parent: HTMLElement, name: string, schema: RecordValue, required: boolean): FieldReader | null {
  const common = ['type', 'title', 'description', 'default'];
  const label = element('label', `${typeof schema.title === 'string' ? schema.title : name}${required ? '（必填）' : ''}`, 'request-field-label');
  const wrapper = element('div', '', 'request-field');
  const id = `request-field-${++nextFieldId}`;
  label.htmlFor = id;
  wrapper.append(label);
  if (typeof schema.description === 'string') wrapper.append(element('small', schema.description));
  let touched = false;
  let control: HTMLInputElement | HTMLSelectElement;
  let read: () => unknown;
  let validateExtra = () => '';
  if (schema.type === 'array') {
    if (!onlyKeys(schema, [...common, 'items', 'minItems', 'maxItems']) || !record(schema.items)) return null;
    if (!onlyKeys(schema.items, ['type', 'enum', 'anyOf']) || (schema.items.type !== undefined && schema.items.type !== 'string')) return null;
    const choices = enumChoices(schema.items);
    if (!choices || new Set(choices.map(choice => choice.value)).size !== choices.length) return null;
    if (schema.default !== undefined && (!strings(schema.default) || schema.default.some(value => !choices.some(choice => choice.value === value)))) return null;
    if (['minItems', 'maxItems'].some(key => schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0))) return null;
    const select = element('select'); select.multiple = true;
    for (const [index, choice] of choices.entries()) select.add(new Option(choice.label, String(index), false, (schema.default as string[] | undefined)?.includes(choice.value) ?? false));
    control = select;
    read = () => [...select.selectedOptions].map(option => choices[Number(option.value)].value);
    validateExtra = () => {
      const count = select.selectedOptions.length;
      if (schema.minItems !== undefined && count < Number(schema.minItems)) return `至少选择 ${schema.minItems} 项`;
      if (schema.maxItems !== undefined && count > Number(schema.maxItems)) return `最多选择 ${schema.maxItems} 项`;
      return '';
    };
  } else if (schema.type === 'boolean') {
    if (!onlyKeys(schema, common) || (schema.default !== undefined && typeof schema.default !== 'boolean')) return null;
    const select = element('select'); select.required = required;
    select.add(new Option('请选择', '')); select.add(new Option('是', 'true')); select.add(new Option('否', 'false'));
    if (schema.default !== undefined) select.value = String(schema.default);
    control = select; read = () => select.value === 'true';
  } else if (schema.type === 'string' && (schema.enum !== undefined || schema.oneOf !== undefined)) {
    if (!onlyKeys(schema, [...common, 'enum', 'enumNames', 'oneOf'])) return null;
    const choices = enumChoices(schema);
    if (!choices || new Set(choices.map(choice => choice.value)).size !== choices.length) return null;
    if (schema.default !== undefined && !choices.some(choice => choice.value === schema.default)) return null;
    const select = element('select'); select.required = required;
    select.add(new Option('请选择', ''));
    for (const [index, choice] of choices.entries()) select.add(new Option(choice.label, String(index), false, choice.value === schema.default));
    control = select; read = () => choices[Number(select.value)].value;
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!onlyKeys(schema, [...common, 'minimum', 'maximum'])) return null;
    if (['minimum', 'maximum', 'default'].some(key => schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])))) return null;
    const input = element('input'); input.type = 'number'; input.required = required;
    input.step = schema.type === 'integer' ? '1' : 'any';
    if (schema.minimum !== undefined) input.min = String(schema.minimum);
    if (schema.maximum !== undefined) input.max = String(schema.maximum);
    if (schema.default !== undefined) input.value = String(schema.default);
    control = input; read = () => Number(input.value);
  } else if (schema.type === 'string') {
    if (!onlyKeys(schema, [...common, 'minLength', 'maxLength', 'format'])) return null;
    if (schema.default !== undefined && typeof schema.default !== 'string') return null;
    if (['minLength', 'maxLength'].some(key => schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0))) return null;
    if (schema.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(schema.format))) return null;
    const input = element('input');
    input.type = schema.format === 'email' ? 'email' : schema.format === 'date' ? 'date' : 'text';
    if (schema.default !== undefined) input.value = String(schema.default);
    if (schema.format === 'date-time') input.placeholder = '2026-01-01T12:00:00+08:00';
    control = input; read = () => input.value;
    validateExtra = () => {
      const value = input.value;
      const length = [...value].length;
      if (schema.minLength !== undefined && length < Number(schema.minLength)) return `至少输入 ${schema.minLength} 个字符`;
      if (schema.maxLength !== undefined && length > Number(schema.maxLength)) return `最多输入 ${schema.maxLength} 个字符`;
      if (schema.format === 'email' && !value) return '请输入有效邮箱地址';
      if (schema.format === 'uri') { try { new URL(value); } catch { return '请输入完整 URI'; } }
      if (schema.format === 'date-time') {
        const date = value.slice(0, 10);
        const parsedDate = new Date(`${date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
          || !Number.isFinite(Date.parse(value)) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) return '请输入包含时区的有效完整日期时间';
      }
      if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '请输入有效日期';
      return '';
    };
  } else return null;
  control.id = id;
  control.addEventListener('input', () => { touched = true; control.setCustomValidity(''); });
  control.addEventListener('change', () => { touched = true; control.setCustomValidity(''); });
  wrapper.append(control); parent.append(wrapper);
  const omitted = () => {
    if (required) return false;
    if ((control instanceof HTMLSelectElement && !control.multiple) || (control instanceof HTMLInputElement && control.type === 'number')) return control.value === '';
    return schema.default === undefined && !touched && (control instanceof HTMLSelectElement && control.multiple ? control.selectedOptions.length === 0 : control.value === '');
  };
  return {
    omitted,
    read,
    validate: () => {
      control.setCustomValidity(omitted() ? '' : validateExtra());
      return control.checkValidity();
    },
  };
}

function elicitation(card: Card): void {
  const params = card.request.params;
  detail(card.fields, '服务', params.serverName);
  if (typeof params.message === 'string') card.fields.append(element('p', params.message));
  if (params.mode === 'url') {
    let url: URL;
    try { url = new URL(String(params.url)); } catch { desktopOnly(card, '验证地址无效。'); return; }
    if (url.protocol !== 'https:' || url.username || url.password) { desktopOnly(card, '验证页面需要使用 HTTPS 且地址中不得包含凭据。'); return; }
    const link = element('a', '打开验证页面', 'request-link');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    detail(card.fields, '验证地址', url.href);
    card.fields.append(link);
    let opened = false;
    const proceed = action(card, '已完成，继续', { action: 'accept', content: {}, _meta: null }, true);
    link.addEventListener('click', event => {
      if (card.fields.disabled) { event.preventDefault(); return; }
      opened = true;
      updateCard(card);
    });
    card.update = () => { proceed.disabled = !opened || card.fields.disabled; link.setAttribute('aria-disabled', String(card.fields.disabled)); };
  } else if (params.mode === 'form') {
    const schema = params.requestedSchema;
    if (!record(schema) || schema.type !== 'object' || !record(schema.properties) || !onlyKeys(schema, ['$schema', 'type', 'properties', 'required'])) {
      desktopOnly(card, '表单结构无法在此页面完整表达。'); return;
    }
    if (schema.required !== undefined && (!strings(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties as object, key)))) {
      desktopOnly(card, '表单必填字段定义无法完整表达。'); return;
    }
    const fields: { name: string; field: FieldReader }[] = [];
    const controls = element('div');
    for (const [name, definition] of Object.entries(schema.properties)) {
      const field = record(definition) ? formField(controls, name, definition, (schema.required as string[] | undefined)?.includes(name) ?? false) : null;
      if (!field) { desktopOnly(card, `字段「${name}」包含当前页面不支持的结构或约束。`); return; }
      fields.push({ name, field });
    }
    card.fields.append(controls);
    const button = element('button', '提交', 'primary request-action'); button.type = 'submit'; card.fields.append(button);
    card.form.addEventListener('submit', event => {
      event.preventDefault();
      const valid = fields.map(({ field }) => field.validate()).every(Boolean);
      if (!valid || !card.form.reportValidity()) { card.form.reportValidity(); return; }
      const content: RecordValue = Object.create(null);
      for (const { name, field } of fields) if (!field.omitted()) content[name] = field.read();
      void submit(card, { action: 'accept', content, _meta: null });
    });
  } else { desktopOnly(card, params.mode === 'openai/userVerification' ? '此请求需要桌面身份验证。' : '此 MCP 请求需要电脑端表单处理。'); return; }
  action(card, '拒绝', { action: 'decline', content: null, _meta: null });
  action(card, '取消', { action: 'cancel', content: null, _meta: null });
}

function makeCard(request: PendingRequest, options: RequestRenderOptions, signature: string): Card {
  const root = element('article', '', 'request-card');
  root.dataset.requestId = JSON.stringify(request.id);
  const form = element('form');
  const fields = element('fieldset', '', 'request-fields');
  const status = element('p', '', 'request-status'); status.setAttribute('role', 'status');
  const resolve = element('button', '已核对，重新处理', 'quiet'); resolve.type = 'button';
  const card: Card = { request, signature, root, form, fields, status, resolve, options, busy: false, error: '' };
  const titles: Record<string, string> = {
    'item/commandExecution/requestApproval': '命令执行确认',
    'item/fileChange/requestApproval': '文件修改确认',
    'item/permissions/requestApproval': '附加权限申请',
    'item/tool/requestUserInput': '需要补充信息',
    'mcpServer/elicitation/request': '外部服务请求',
    'reach/asyncQuestion': '补充问题',
  };
  if (request.method !== 'reach/asyncQuestion') root.append(element('h3', titles[request.method] ?? '待处理请求'));
  form.append(fields); root.append(form, status, resolve);
  resolve.addEventListener('click', () => card.options.onResolve?.(card.request));
  if (request.desktopRequired) desktopOnly(card, typeof request.desktopRequired === 'string' ? request.desktopRequired : '此请求需要桌面端能力。');
  else if (request.method === 'item/commandExecution/requestApproval') approval(card, false);
  else if (request.method === 'item/fileChange/requestApproval') approval(card, true);
  else if (request.method === 'item/permissions/requestApproval') permissions(card);
  else if (request.method === 'item/tool/requestUserInput') questions(card);
  else if (request.method === 'reach/asyncQuestion') questions(card, true);
  else if (request.method === 'mcpServer/elicitation/request') elicitation(card);
  else desktopOnly(card, `当前请求类型「${request.method}」需要电脑端支持。`);
  return card;
}

export function renderRequests(container: HTMLElement, requests: PendingRequest[], options: RequestRenderOptions): void {
  const cards = cardsByContainer.get(container) ?? new Map<string, Card>();
  cardsByContainer.set(container, cards);
  const visible = requests.filter(request => !request.completed);
  const keys = new Set(visible.map(request => JSON.stringify(request.id)));
  for (const [key, card] of cards) if (!keys.has(key)) { card.root.remove(); cards.delete(key); }
  for (const [index, request] of visible.entries()) {
    const key = JSON.stringify(request.id);
    const signature = JSON.stringify([request.method, request.params, request.changes ?? request.item?.changes, request.desktopRequired]);
    let card = cards.get(key);
    if (!card || card.signature !== signature) {
      card?.root.remove();
      card = makeCard(request, options, signature);
      cards.set(key, card);
    }
    card.options = options;
    card.request = request;
    updateCard(card);
    if (container.children[index] !== card.root) container.insertBefore(card.root, container.children[index] ?? null);
  }
  container.hidden = visible.length === 0;
}

export function renderAsyncQuestions(container: HTMLElement, questions: AsyncQuestion[], options: {
  disabled: boolean;
  onSubmit: (replies: AsyncReply[]) => void | Promise<void>;
}): void {
  const requests = questions.map(question => ({
    id: question.id, method: 'reach/asyncQuestion', params: {
      answer: question.answer,
      draft: question.draft,
      questions: [{ id: question.id, question: question.title, isOther: true, isSecret: false,
        options: question.options?.map(label => ({ label, description: '' })) ?? null }],
    },
  }));
  renderRequests(container, requests, {
    disabled: options.disabled,
    onSubmit: (request, response) => {
      const question = questions.find(item => item.id === request.id)!;
      const answers = response.answers as Record<string, { answers: string[] }>;
      return options.onSubmit([{ questionItemId: question.id, question: question.title, answer: answers[question.id].answers[0] }]);
    },
  });
}
