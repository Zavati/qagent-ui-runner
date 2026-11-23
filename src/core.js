import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const VERSION = '0.1.0';
export const MODES = ['UI_REPLAY', 'UI_LIVE'];
export class RunnerError extends Error {
  constructor(code, details = {}, options) { super(code, options); this.name = 'RunnerError'; this.code = code; this.details = details; }
}
export function insist(test, code, details) { if (!test) throw new RunnerError(code, details); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  throw new RunnerError('UI_RUNNER_NON_JSON_VALUE');
}
export const digest = value => sha256(canonical(value));
export const same = (a, b) => canonical(a) === canonical(b);
export const codeOf = (error, fallback = 'UI_RUNNER_TECHNICAL_ERROR') => /^[A-Z0-9_]{1,128}$/.test(error?.code ?? '') ? error.code : fallback;
export const sorted = values => [...new Set(values)].sort();
export const escapePointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
export function getPointer(object, pointer) {
  if (!pointer) return object;
  return pointer.slice(1).split('/').reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], object);
}
export function* leaves(value, pointer = '') {
  if (value === null || typeof value !== 'object') { yield { pointer, value }; return; }
  const entries = Object.entries(value);
  if (!entries.length) yield { pointer, value };
  else for (const [key, child] of entries) yield* leaves(child, pointer + '/' + escapePointer(key));
}
export function summarized(value) {
  if (value === undefined) return null;
  const text = canonical(value);
  return Buffer.byteLength(text) <= 1024 ? value : { representation: 'CANONICAL_JSON_SHA256', sha256: sha256(text), byteLength: Buffer.byteLength(text) };
}
export function checkAbort(signal) { if (signal?.aborted) throw signal.reason ?? new RunnerError('UI_RUNNER_CANCELLED'); }
export async function sleep(ms, signal) { checkAbort(signal); await delay(ms, undefined, { signal }); }
export async function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new RunnerError('UI_RUNNER_CANCELLED')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export function validOrigin(value) {
  const url = new URL(value);
  insist(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, 'UI_RUNNER_ORIGIN_INVALID');
  insist(url.origin === value, 'UI_RUNNER_ORIGIN_INVALID');
  return url.origin;
}
export class OriginBinding {
  constructor(profile, entryUrl) {
    const target = new URL(profile.targetBaseUrl), source = new URL(entryUrl);
    insist(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && !target.search && !target.hash, 'UI_RUNNER_TARGET_INVALID');
    this.allowed = new Set(profile.allowedOrigins.map(validOrigin));
    insist(this.allowed.has(target.origin), 'UI_RUNNER_TARGET_NOT_ALLOWED');
    this.map = new Map(Object.entries(profile.originMap ?? {}).map(([a, b]) => [validOrigin(a), validOrigin(b)]));
    if (!this.map.has(source.origin)) this.map.set(source.origin, target.origin);
    insist(this.map.get(source.origin) === target.origin, 'UI_RUNNER_TARGET_BINDING_MISMATCH');
    this.reverse = new Map();
    for (const [from, to] of this.map) {
      insist(this.allowed.has(to), 'UI_RUNNER_MAPPED_ORIGIN_NOT_ALLOWED');
      insist(!this.reverse.has(to) || this.reverse.get(to) === from, 'UI_RUNNER_ORIGIN_MAPPING_AMBIGUOUS');
      this.reverse.set(to, from);
    }
    this.entryOrigin = source.origin;
    this.targetOrigin = target.origin;
    // Origin mapping preserves paths and ordered query pairs; no implicit base-path rewrite.
    insist(target.pathname === '/' || target.pathname === source.pathname, 'UI_RUNNER_TARGET_PATH_MAPPING_UNSUPPORTED');
  }
  toTarget(value) {
    const u = new URL(value);
    insist(!u.username && !u.password && ['http:', 'https:'].includes(u.protocol), 'UI_RUNNER_URL_INVALID');
    const mapped = this.map.get(u.origin) ?? (this.allowed.has(u.origin) ? u.origin : null);
    insist(mapped, 'UI_RUNNER_SOURCE_ORIGIN_UNMAPPED', { origin: u.origin });
    return mapped + u.pathname + u.search + u.hash;
  }
  toSource(value) {
    const u = new URL(value);
    insist(this.allowed.has(u.origin), 'UI_RUNNER_ORIGIN_NOT_ALLOWED', { origin: u.origin });
    return (this.reverse.get(u.origin) ?? u.origin) + u.pathname + u.search + u.hash;
  }
  permits(value) { try { const u = new URL(value); return !u.username && !u.password && this.allowed.has(u.origin); } catch { return false; } }
}
