import { describe, expect, it } from 'vitest';

import { genReqId } from '@/shared/plugins/index.js';

import type { RawRequestDefaultExpression } from 'fastify';

const makeReq = (headers: Record<string, string | string[]>): RawRequestDefaultExpression =>
  ({ headers }) as unknown as RawRequestDefaultExpression;

describe('genReqId', () => {
  it('пробрасывает валидный UUID из x-request-id', () => {
    const id = '018f2c3a-9c1e-7abc-8def-0123456789ab';

    expect(genReqId(makeReq({ 'x-request-id': id }))).toBe(id);
  });

  it('генерирует новый UUID без заголовка', () => {
    const id = genReqId(makeReq({}));

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('отбрасывает невалидное значение заголовка', () => {
    const id = genReqId(makeReq({ 'x-request-id': 'not-a-uuid' }));

    expect(id).not.toBe('not-a-uuid');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('генерирует разные UUID на разные вызовы', () => {
    expect(genReqId(makeReq({}))).not.toBe(genReqId(makeReq({})));
  });
});
