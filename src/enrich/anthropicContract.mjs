// Direct Claude API contract, checked against platform.claude.com/docs.
// Shared by environment configuration and the Settings baseline; owners can override it.
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_API_VERSION = '2026-10-21';
export const ANTHROPIC_MAX_TOKENS = 8192;
// 10 MB base64-encoded is exactly 7.5 MB of raw image bytes.
export const ANTHROPIC_MAX_IMAGE_BYTES = 7_500_000;

export function anthropicThinking(model) {
  switch (model) {
    case 'claude-haiku-5-5': return { type: 'disabled' };
    case 'claude-sonnet-5-5': return { type: 'between_tools' };
    case 'claude-opus-5-5':
    case 'claude-fable-5-2': return { type: 'adaptive', display: 'omitted' };
    // Older models may reject adaptive thinking. Do not guess from a prefix.
    default: return null;
  }
}

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const LIMITS = new Set(['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

// This is deliberately the vocabulary of Pictaria's three current schemas,
// not a general JSON Schema implementation. Fail before dispatch if it grows.
// Project generation only; the original schema remains the acceptance contract.
export function anthropicJsonSchema(schema) {
  let nodes = 0;
  function project(value, depth = 0) {
    if (++nodes > 10000 || depth > 32 || !value || typeof value !== 'object' || Array.isArray(value)
        || !TYPES.has(value.type) || Object.keys(value).some(key => !KEYWORDS.has(key))) {
      throw new Error('Claude does not support this Pictaria response schema.');
    }
    if (value.type === 'object' && (value.additionalProperties !== false || !value.properties)) {
      throw new Error('Claude requires a response schema with closed objects.');
    }
    const result = {}, hints = [];
    for (const [key, item] of Object.entries(value)) {
      if (LIMITS.has(key) || (key === 'minItems' && item > 1)) {
        hints.push(`${key}: ${item}`);
      } else if (key === 'properties') {
        result.properties = Object.fromEntries(Object.entries(item).map(([name, child]) => [name, project(child, depth + 1)]));
      } else if (key === 'items') result.items = project(item, depth + 1);
      else result[key] = structuredClone(item);
    }
    if (hints.length) result.description = [result.description, `Required limits: ${hints.join('; ')}.`].filter(Boolean).join(' ');
    return result;
  }
  return project(schema);
}

// Enrich's domain validator still applies its UTF-8 byte, taxonomy and
// contradiction checks. This also covers the released referee, whose legacy
// normalizer can fill missing entries and is not itself a schema validator.
export function validateAnthropicOutput(value, schema) {
  function valid(output, rule) {
    if (rule.enum && !rule.enum.includes(output)) return false;
    switch (rule.type) {
      case 'object':
        return output !== null && typeof output === 'object' && !Array.isArray(output)
          && (rule.required ?? []).every(key => Object.hasOwn(output, key))
          && Object.entries(output).every(([key, item]) => Object.hasOwn(rule.properties, key) && valid(item, rule.properties[key]));
      case 'array':
        return Array.isArray(output) && output.length >= (rule.minItems ?? 0)
          && output.length <= (rule.maxItems ?? Infinity) && output.every(item => valid(item, rule.items));
      case 'string': {
        if (typeof output !== 'string') return false;
        const length = [...output].length;
        return length >= (rule.minLength ?? 0) && length <= (rule.maxLength ?? Infinity);
      }
      case 'integer':
      case 'number':
        return typeof output === 'number' && Number.isFinite(output)
          && (rule.type !== 'integer' || Number.isInteger(output))
          && output >= (rule.minimum ?? -Infinity) && output <= (rule.maximum ?? Infinity);
      case 'boolean': return typeof output === 'boolean';
      case 'null': return output === null;
      default: return false;
    }
  }
  if (!valid(value, schema)) throw new Error('Claude returned an answer that did not match the requested schema.');
  return value;
}
