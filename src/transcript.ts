import type { Message } from './types';

export type MessageGroup = { process: boolean; messages: Message[] };

export function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of messages) {
    const process = !message.questions?.length && !message.attachments?.length && !message.responseAnnotations?.length
      && (message.kind === 'tool' || message.kind === 'reasoning'
        || (message.kind === 'assistant' && message.phase === 'commentary'));
    const previous = groups.at(-1);
    if (process && previous?.process) previous.messages.push(message);
    else groups.push({ process, messages: [message] });
  }
  return groups;
}
