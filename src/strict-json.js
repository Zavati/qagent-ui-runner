import { RunnerError } from './core.js';

/** No duplicate-key overwrite, replacement UTF-8, aggregate node ceiling or unbounded recursion. */
export function parseStrictJson(bytes) {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let pos = 0;
  const fail = () => { throw new RunnerError('UI_RUNNER_ARTIFACT_JSON_INVALID'); };
  const ws = () => { while (/[\x20\t\r\n]/.test(text[pos] ?? '!')) pos++; };
  function string() {
    const start = pos++; let escaped = false;
    for (; pos < text.length; pos++) {
      const char = text[pos];
      if (char === '"' && !escaped) { pos++; return JSON.parse(text.slice(start, pos)); }
      if (char === '\\' && !escaped) escaped = true; else escaped = false;
    }
    fail();
  }
  function value(depth) {
    if (depth > 256) fail(); ws(); const char = text[pos];
    if (char === '"') return string();
    if (char === '{') {
      pos++; const object = Object.create(null); ws(); if (text[pos] === '}') { pos++; return object; }
      while (pos < text.length) {
        ws(); if (text[pos] !== '"') fail(); const key = string(); if (Object.hasOwn(object, key)) fail();
        ws(); if (text[pos++] !== ':') fail(); object[key] = value(depth + 1); ws(); const end = text[pos++];
        if (end === '}') return object; if (end !== ',') fail();
      }
      fail();
    }
    if (char === '[') {
      pos++; const array = []; ws(); if (text[pos] === ']') { pos++; return array; }
      while (pos < text.length) { array.push(value(depth + 1)); ws(); const end = text[pos++]; if (end === ']') return array; if (end !== ',') fail(); }
      fail();
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) if (text.slice(pos, pos + token.length) === token) { pos += token.length; return result; }
    const number = text.slice(pos).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) fail(); pos += number[0].length; const parsed = Number(number[0]); if (!Number.isFinite(parsed)) fail(); return parsed;
  }
  try { const result = value(0); ws(); if (pos !== text.length) fail(); return result; }
  catch (error) { if (error instanceof RunnerError) throw error; throw new RunnerError('UI_RUNNER_ARTIFACT_JSON_INVALID', {}, { cause: error }); }
}
