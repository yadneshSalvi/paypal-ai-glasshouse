import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OperationDocumentCodec } from '@fracture/paypal-core';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
export function equalDigest(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Private documents are bound to independent SQL identity, never to fields inside their ciphertext. */
export class PaymentSecrets {
  private readonly key: Buffer;
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32) throw new Error('A 32-byte Glasshouse payment storage key is required.');
  }
  seal(value: unknown, identity: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(identity));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }
  open<T>(value: string, identity: string): T {
    try {
      const [version, iv, tag, ciphertext, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext || extra !== undefined) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(identity));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as T;
    } catch { throw new Error('The private payment document could not be verified.'); }
  }
  operationCodec(): OperationDocumentCodec {
    const identity = (context: { scope: { tenantId: string; projectId: string }; operationId: string }) => canonicalJson({ kind: 'core-operation', ...context });
    return {
      encode: (plaintext, context) => this.seal(plaintext, identity(context)),
      decode: (ciphertext, context) => this.open<string>(ciphertext, identity(context)),
    };
  }
}

export function trustedOrigin(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || local && url.protocol === 'http:')) throw new Error('A trusted application origin is required.');
  return url.origin;
}
