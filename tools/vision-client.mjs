// FluteBand AI — общий клиент мультимодальной модели: «посмотреть на картинку и ответить».
//
// Используется двумя инструментами: tools/vision-probe.mjs (ручной вопрос про один снимок) и
// tools/real-bench.mjs (перекрёстная проверка настоящих сканов). Держим в одном месте, чтобы
// ключ и разбор ответа не разъезжались.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENDPOINT = 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/chat/completions';
export const MODEL_CANDIDATES = ['qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'glm-5.3', 'deepseek-v4-pro', 'auto'];

export function apiKey() {
  if (process.env.QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY) return process.env.QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY;
  const file = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', '.credentials.yaml');
  if (!existsSync(file)) throw new Error(`Нет ключа: ${file}`);
  const match = readFileSync(file, 'utf8').match(/QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY:\s*"?([^"\r\n]+)"?/);
  if (!match) throw new Error('В файле ключей нет QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY');
  return match[1].trim();
}

/** Тип картинки по первым байтам: сервис принимает PNG и JPEG, ярлык должен совпадать с содержимым. */
export function imageMime(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length > 7 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.length > 11 && buffer.toString('ascii', 0, 4) === 'RIFF') return 'image/webp';
  return 'image/png';
}

/** Спросить у модели, что видно на картинке. Возвращает {ok, answer, model, usage} или {ok:false, error}. */
export async function askImage(imagePath, question, model = MODEL_CANDIDATES[0], { maxTokens = 400 } = {}) {
  const buffer = readFileSync(imagePath);
  const mime = imageMime(buffer);
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
      ],
    }],
    max_tokens: maxTokens,
  };
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: text.slice(0, 400) };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, error: text.slice(0, 400) };
  }
  const message = parsed.choices?.[0]?.message;
  const answer = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => part.text || part.image_url?.url || '').join(' ').trim()
      : '';
  if (!answer) return { ok: false, status: response.status, error: `пустой ответ: ${text.slice(0, 300)}` };
  return { ok: true, model, answer, usage: parsed.usage || null };
}