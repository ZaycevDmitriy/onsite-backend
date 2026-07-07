import { describe, expect, it } from 'vitest';

import {
  ASSIGNABLE_STATUSES,
  ServiceOrderStatusEnum,
  canAssign,
  canTransition,
} from '../domain.js';

// Полная матрица переходов статусов (FR-07): все 16 упорядоченных пар 4 статусов.
const EXPECTED_TRANSITIONS: Record<string, boolean> = {
  'New->New': false,
  'New->InProgress': true,
  'New->Done': false,
  'New->Cancelled': true,
  'InProgress->New': false,
  'InProgress->InProgress': false,
  'InProgress->Done': true,
  'InProgress->Cancelled': true,
  'Done->New': false,
  'Done->InProgress': false,
  'Done->Done': false,
  'Done->Cancelled': false,
  'Cancelled->New': false,
  'Cancelled->InProgress': false,
  'Cancelled->Done': false,
  'Cancelled->Cancelled': false,
};

const ALL_STATUSES = Object.values(ServiceOrderStatusEnum);

describe('canTransition', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const key = `${from}->${to}`;
      const expected = EXPECTED_TRANSITIONS[key];

      it(`${key} → ${expected ? 'разрешён' : 'запрещён'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it('полная матрица покрывает все 16 пар', () => {
    expect(Object.keys(EXPECTED_TRANSITIONS)).toHaveLength(16);
  });
});

describe('canAssign', () => {
  const EXPECTED_ASSIGNABLE: Record<string, boolean> = {
    New: true,
    InProgress: true,
    Done: false,
    Cancelled: false,
  };

  for (const status of ALL_STATUSES) {
    const expected = EXPECTED_ASSIGNABLE[status];

    it(`${status} → назначение ${expected ? 'разрешено' : 'запрещено'}`, () => {
      expect(canAssign(status)).toBe(expected);
    });
  }

  it('покрывает все 4 статуса назначения', () => {
    expect(Object.keys(EXPECTED_ASSIGNABLE)).toHaveLength(4);
    expect(ASSIGNABLE_STATUSES).toEqual([
      ServiceOrderStatusEnum.New,
      ServiceOrderStatusEnum.InProgress,
    ]);
  });
});
