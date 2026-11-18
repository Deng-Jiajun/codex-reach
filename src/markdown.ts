import { Marked } from 'marked';

export const markdown = new Marked();
// Accept Chinese punctuation at a strong closing boundary adjacent to Chinese text.
markdown.use({ extensions: [{
  name: 'chineseStrong', level: 'inline',
  start(source) { return source.indexOf('**'); },
  tokenizer(source) {
    const match = /^\*\*(?=\S)((?:`[^`\n]*`|[^*`\n])+[\p{P}])\*\*(?=[\p{Script=Han}])/u.exec(source);
    if (match) return { type: 'strong', raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
  },
}] });
