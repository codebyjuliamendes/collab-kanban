'use strict';

const { z } = require('zod');

/**
 * Board operations: the only way clients change a board. Every operation
 * carries a client-generated `opId`, which makes retries (offline queue,
 * reconnects) idempotent.
 */

const LIMITS = Object.freeze({
  boardTitle: 120,
  columnTitle: 100,
  cardTitle: 300,
  cardDescription: 5000,
  opsPerBatch: 100,
  columnsPerBoard: 100,
  cardsPerBoard: 5000,
});

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 characters of [A-Za-z0-9_-]');

// Control characters (except tab/newline) are stripped; titles are single line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const singleLine = (max) =>
  z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, 'must not be empty').max(max));
const multiLine = (max) =>
  z
    .string()
    .transform((value) => value.replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n'))
    .pipe(z.string().max(max));

const base = { opId: id };
// `afterId`: null = place first, omitted = place last. `beforeId` is the
// fallback anchor used when `afterId` no longer exists in the target list.
const placement = { afterId: id.nullable().optional(), beforeId: id.nullable().optional() };
const baseVersion = z.number().int().min(1);

const opSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('column.create'),
    id,
    title: singleLine(LIMITS.columnTitle),
    ...placement,
  }),
  z.strictObject({ ...base, type: z.literal('column.update'), id, baseVersion, title: singleLine(LIMITS.columnTitle) }),
  z.strictObject({ ...base, type: z.literal('column.move'), id, ...placement }),
  z.strictObject({ ...base, type: z.literal('column.delete'), id, baseVersion: baseVersion.optional() }),
  z.strictObject({
    ...base,
    type: z.literal('card.create'),
    id,
    columnId: id,
    title: singleLine(LIMITS.cardTitle),
    description: multiLine(LIMITS.cardDescription).optional(),
    ...placement,
  }),
  z
    .strictObject({
      ...base,
      type: z.literal('card.update'),
      id,
      baseVersion,
      title: singleLine(LIMITS.cardTitle).optional(),
      description: multiLine(LIMITS.cardDescription).optional(),
    })
    .refine((op) => op.title !== undefined || op.description !== undefined, 'title or description is required'),
  z.strictObject({ ...base, type: z.literal('card.move'), id, columnId: id, ...placement }),
  z.strictObject({ ...base, type: z.literal('card.delete'), id, baseVersion: baseVersion.optional() }),
]);

/**
 * Validates one operation.
 * @param {unknown} raw
 * @returns {{ ok: true, op: object } | { ok: false, opId: string|null, error: string }}
 */
function parseOp(raw) {
  const result = opSchema.safeParse(raw);
  if (result.success) return { ok: true, op: result.data };
  const opId = raw && typeof raw === 'object' && id.safeParse(raw.opId).success ? raw.opId : null;
  const error = result.error.issues.map((issue) => `${issue.path.join('.') || 'op'}: ${issue.message}`).join('; ');
  return { ok: false, opId, error };
}

const batchSchema = z.array(z.unknown()).min(1).max(LIMITS.opsPerBatch);
const boardTitleSchema = singleLine(LIMITS.boardTitle);

module.exports = { parseOp, batchSchema, boardTitleSchema, idSchema: id, LIMITS };
