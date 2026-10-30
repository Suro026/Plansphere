export const ENV_TEMPLATE_DEFAULTS: Map<string, string>;
export const ENV_TEMPLATE_FILE: RegExp;
export function envTemplateProblems(text: string): { line: number; name: string }[];
