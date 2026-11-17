// Turns stdout chunks into JSON events. Works whether the shell plugin hands
// us whole lines (no "\n") or raw chunks that split a line in two.
export function createLineParser<T>(onValue: (v: T) => void, onBadLine: (line: string) => void) {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const line of parts) parseLine(line);
    if (buffer.trim()) {
      try {
        onValue(JSON.parse(buffer) as T);
        buffer = '';
      } catch {
        /* incomplete line: wait for more */
      }
    }
  };
  function parseLine(line: string) {
    if (!line.trim()) return;
    try {
      onValue(JSON.parse(line) as T);
    } catch {
      onBadLine(line);
    }
  }
}
