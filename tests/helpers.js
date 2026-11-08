import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VALID_OUTPUT = {
  prompt_en: 'A girl walking in the rain, no umbrella.',
  translation_zh: '一个女孩在雨中行走，没有伞。',
  notes: '',
};
