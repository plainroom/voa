export function createMockUIStoreState(overrides: Record<string, unknown> = {}) {
  return { isOnline: true, ...overrides };
}
