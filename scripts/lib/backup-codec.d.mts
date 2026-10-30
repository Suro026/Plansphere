export type Encoded = null | string | boolean | Encoded[] | { [key: string]: Encoded };

export function encodeValue(value: unknown): Encoded;
export function decodeValue(value: unknown, db: { doc(path: string): unknown }): unknown;
export function validateEncoded(value: unknown, path?: string): string[];
export function encodeData(data: Record<string, unknown>): Record<string, Encoded>;
export function decodeData(data: Record<string, unknown>, db: { doc(path: string): unknown }): Record<string, unknown>;
export function canonicalize(value: unknown): string;
export function diffFields(a: unknown, b: unknown, path?: string): string[];
