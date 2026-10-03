/** WeChat may already decode route values; literal '%' is also valid input. */
export function routeValue(value: unknown): string {
  const text = String(value || '')
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}
