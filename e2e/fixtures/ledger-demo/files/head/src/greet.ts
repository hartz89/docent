export function greet(name: string, excited = false): string {
  return `Hello, ${name}${excited ? '!' : '.'}`;
}
