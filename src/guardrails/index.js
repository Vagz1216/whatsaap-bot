const MAX_INPUT_CHARS = 600;
const MAX_DRAFT_WORDS = 220;

const INPUT_BLOCK_PATTERNS = [
  /ignore (all )?(previous|prior) instructions/i,
  /disregard (the )?(system|developer|previous) (prompt|instructions)/i,
  /reveal (your )?(system prompt|developer message|hidden instructions)/i,
  /print (your )?(system prompt|developer message|hidden instructions)/i,
  /__import__/i,
  /os\.system/i,
  /;\s*drop\s+table/i
];

const OUTPUT_BLOCK_PATTERNS = [
  /\b(api[_-]?key|secret|password|token)\s*[:=]\s*[A-Za-z0-9_.-]{12,}/i,
  /\b(system prompt|developer message|hidden instruction|tool credentials)\b/i,
  /ignore (all )?(previous|prior) instructions/i
];

export class GuardrailError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'GuardrailError';
    this.reason = reason;
  }
}

export const validateInboundMessage = (text) => {
  const value = String(text || '').trim();

  if (!value) {
    throw new GuardrailError('empty_message');
  }

  if (value.length > MAX_INPUT_CHARS) {
    throw new GuardrailError('input_too_long');
  }

  for (const pattern of INPUT_BLOCK_PATTERNS) {
    if (pattern.test(value)) {
      throw new GuardrailError('prompt_injection_detected');
    }
  }

  return value;
};

export const validateDraftMessage = (text) => {
  const value = String(text || '').trim();

  if (!value) {
    throw new GuardrailError('empty_draft');
  }

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > MAX_DRAFT_WORDS) {
    throw new GuardrailError('draft_too_long');
  }

  for (const pattern of OUTPUT_BLOCK_PATTERNS) {
    if (pattern.test(value)) {
      throw new GuardrailError('sensitive_or_internal_output_detected');
    }
  }

  return value;
};

