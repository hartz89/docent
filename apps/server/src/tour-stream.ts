// Reads the tour's JSON while the model is still writing it, and hands back each stop the moment
// its object closes. It only finds the boundaries: every stop it returns is still raw model output,
// and goes through the same checks as a finished tour before anyone sees it.

/** Finds complete stops in the top-level `stops` array of a growing JSON text. */
export class StopScanner {
  #text = '';
  #at = 0;
  #depth = 0;
  #inString = false;
  #escaped = false;
  #stringStart = -1;
  /** The last string closed at the top level: the key of the value that follows. */
  #key = '';
  #inStops = false;
  #stopsDone = false;
  #stopStart = -1;
  #started = 0;
  #broken = false;

  /** How many stops the model has begun writing so far. */
  get started(): number {
    return this.#started;
  }

  /**
   * Takes the whole output so far, and returns the stops completed since the last call, each as
   * parsed JSON (or `undefined` if it didn't parse). Returns null, now and from then on, if the
   * text doesn't continue the last one: the model started its output over.
   */
  push(text: string): unknown[] | null {
    if (this.#broken || !text.startsWith(this.#text)) {
      this.#broken = true;
      return null;
    }
    this.#text = text;
    const found: unknown[] = [];
    for (; this.#at < text.length; this.#at++) {
      const ch = text[this.#at];
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (ch === '\\') this.#escaped = true;
        else if (ch === '"') {
          this.#inString = false;
          if (this.#depth === 1) this.#key = text.slice(this.#stringStart + 1, this.#at);
        }
        continue;
      }
      if (ch === '"') {
        this.#inString = true;
        this.#stringStart = this.#at;
      } else if (ch === '{' || ch === '[') {
        if (ch === '[' && this.#depth === 1 && this.#key === 'stops' && !this.#stopsDone) {
          this.#inStops = true;
        } else if (ch === '{' && this.#inStops && this.#depth === 2) {
          this.#stopStart = this.#at;
          this.#started++;
        }
        this.#depth++;
      } else if (ch === '}' || ch === ']') {
        this.#depth--;
        if (this.#inStops && this.#depth === 2 && ch === '}' && this.#stopStart >= 0) {
          found.push(parse(text.slice(this.#stopStart, this.#at + 1)));
          this.#stopStart = -1;
        } else if (this.#inStops && this.#depth === 1 && ch === ']') {
          this.#inStops = false;
          this.#stopsDone = true;
        }
      }
    }
    return found;
  }
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
