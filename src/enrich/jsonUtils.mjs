// Tolerant JSON extraction for model responses that wrap JSON in markdown
// fences or surrounding prose (common with local models).

export function parseJsonContent(content) {
  const text = stripMarkdownFence(String(content).trim());
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw error;
    }
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Model response JSON was not an object');
  }
  return parsed;
}

export function stripMarkdownFence(text) {
  if (!text.startsWith('```')) {
    return text;
  }
  const lines = text.split('\n');
  if (lines.length >= 3 && lines[lines.length - 1].trim() === '```') {
    return lines.slice(1, -1).join('\n').trim();
  }
  return text;
}
