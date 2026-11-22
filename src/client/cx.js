export function cx(...parts) {
  return parts.filter(part => typeof part === 'string' && part !== '').join(' ')
}
